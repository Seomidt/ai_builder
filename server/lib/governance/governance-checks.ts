/**
 * Phase 24 — Governance Checks
 * Unified AI request flow: policy → model allowlist → prompt scan → output moderation.
 * This is the single entry point for all AI governance in Phase 24.
 */

import { db } from "../../db";
import { tenantAiSettings } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";
import { runPolicyChecks } from "./policy-engine";
import { checkModelAccess } from "./model-allowlist";
import { scanPrompt, hashPrompt } from "./prompt-scanner";
import { moderateOutput, logModerationEvent } from "./output-moderation";

// ── Tenant AI Settings CRUD ───────────────────────────────────────────────────

/**
 * Get tenant AI settings (with defaults).
 */
export async function getTenantAiSettings(tenantId: string): Promise<Record<string, unknown>> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM tenant_ai_settings WHERE tenant_id = ${tenantId} LIMIT 1
  `);
  if (rows.rows.length > 0) return rows.rows[0] as Record<string, unknown>;

  // Return defaults
  return {
    tenant_id: tenantId,
    max_tokens: 4096,
    allowed_models: [],
    moderation_enabled: true,
    prompt_scanning_enabled: true,
    max_prompts_per_minute: 60,
    blocked_topics: [],
    sensitivity_level: "medium",
  };
}

/**
 * Upsert tenant AI settings.
 */
export async function upsertTenantAiSettings(params: {
  tenantId: string;
  maxTokens?: number;
  allowedModels?: string[];
  moderationEnabled?: boolean;
  promptScanningEnabled?: boolean;
  maxPromptsPerMinute?: number;
  blockedTopics?: string[];
  sensitivityLevel?: string;
}): Promise<{ updated: boolean }> {
  await db.execute(drizzleSql`
    INSERT INTO tenant_ai_settings (
      tenant_id, max_tokens, allowed_models, moderation_enabled,
      prompt_scanning_enabled, max_prompts_per_minute, blocked_topics, sensitivity_level, updated_at
    ) VALUES (
      ${params.tenantId},
      ${params.maxTokens ?? 4096},
      ${`{${(params.allowedModels ?? []).join(",")}}`},
      ${params.moderationEnabled ?? true},
      ${params.promptScanningEnabled ?? true},
      ${params.maxPromptsPerMinute ?? 60},
      ${`{${(params.blockedTopics ?? []).join(",")}}`},
      ${params.sensitivityLevel ?? "medium"},
      NOW()
    )
    ON CONFLICT (tenant_id) DO UPDATE SET
      max_tokens = EXCLUDED.max_tokens,
      allowed_models = EXCLUDED.allowed_models,
      moderation_enabled = EXCLUDED.moderation_enabled,
      prompt_scanning_enabled = EXCLUDED.prompt_scanning_enabled,
      max_prompts_per_minute = EXCLUDED.max_prompts_per_minute,
      blocked_topics = EXCLUDED.blocked_topics,
      sensitivity_level = EXCLUDED.sensitivity_level,
      updated_at = NOW()
  `);
  return { updated: true };
}

/**
 * List all tenant AI settings.
 */
export async function listTenantAiSettings(limit: number = 100): Promise<Array<Record<string, unknown>>> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM tenant_ai_settings ORDER BY tenant_id ASC LIMIT ${limit}
  `);
  return rows.rows as Record<string, unknown>[];
}

// ── Full AI request governance check ─────────────────────────────────────────

export interface GovernanceCheckRequest {
  tenantId: string;
  modelName: string;
  prompt: string;
  tokenCount?: number;
}

export interface GovernanceCheckResult {
  allowed: boolean;
  blockedAt?: "policy" | "model_allowlist" | "prompt_scan";
  reason?: string;
  policyViolations?: Array<{ policyKey: string; reason: string }>;
  promptScanScore?: number;
  piiDetected?: string[];
  logged: boolean;
}

/**
 * Run the full governance check pipeline for an AI request.
 * Step 1: Policy checks
 * Step 2: Model allowlist
 * Step 3: Prompt safety scan
 *
 * Logs moderation events for all blocked/flagged requests.
 */
export async function runGovernanceChecks(request: GovernanceCheckRequest): Promise<GovernanceCheckResult> {
  const settings = await getTenantAiSettings(request.tenantId);
  const promptHash = hashPrompt(request.prompt);
  const allowedModels = (settings.allowed_models as string[]) ?? [];
  const blockedTopics = (settings.blocked_topics as string[]) ?? [];
  const sensitivityLevel = (settings.sensitivity_level as "low" | "medium" | "high") ?? "medium";
  const moderationEnabled = settings.moderation_enabled !== false;
  const promptScanningEnabled = settings.prompt_scanning_enabled !== false;

  // ── Step 1: Policy checks ────────────────────────────────────────────────
  const policyResult = await runPolicyChecks({
    tenantId: request.tenantId,
    modelName: request.modelName,
    prompt: request.prompt,
    tokenCount: request.tokenCount,
    maxTokens: settings.max_tokens as number,
    blockedTopics,
  });

  if (!policyResult.allowed) {
    if (moderationEnabled) {
      await logModerationEvent({
        tenantId: request.tenantId,
        eventType: "policy_violation",
        promptHash,
        modelName: request.modelName,
        policyKey: policyResult.violations[0]?.policyKey,
        result: "blocked",
        reason: policyResult.violations.map(v => v.reason).join("; "),
      });
    }
    return {
      allowed: false,
      blockedAt: "policy",
      reason: policyResult.violations.map(v => v.reason).join("; "),
      policyViolations: policyResult.violations.map(v => ({ policyKey: v.policyKey, reason: v.reason ?? "" })),
      logged: moderationEnabled,
    };
  }

  // ── Step 2: Model allowlist ───────────────────────────────────────────────
  const modelCheck = await checkModelAccess({
    modelName: request.modelName,
    tenantAllowedModels: allowedModels,
  });

  if (!modelCheck.allowed) {
    if (moderationEnabled) {
      await logModerationEvent({
        tenantId: request.tenantId,
        eventType: "model_denied",
        promptHash,
        modelName: request.modelName,
        result: "blocked",
        reason: modelCheck.reason,
      });
    }
    return {
      allowed: false,
      blockedAt: "model_allowlist",
      reason: modelCheck.reason,
      logged: moderationEnabled,
    };
  }

  // ── Step 3: Prompt safety scan ────────────────────────────────────────────
  if (promptScanningEnabled) {
    const scanResult = scanPrompt(request.prompt, { sensitivityLevel });

    if (scanResult.recommendation === "block") {
      if (moderationEnabled) {
        await logModerationEvent({
          tenantId: request.tenantId,
          eventType: "prompt_blocked",
          promptHash,
          modelName: request.modelName,
          result: "blocked",
          reason: scanResult.threats.map(t => t.detail).join("; "),
          metadata: { score: scanResult.score, threats: scanResult.threats.map(t => t.category) },
        });
      }
      return {
        allowed: false,
        blockedAt: "prompt_scan",
        reason: `Prompt blocked: ${scanResult.threats.map(t => t.category).join(", ")}`,
        promptScanScore: scanResult.score,
        piiDetected: scanResult.piiTypes,
        logged: moderationEnabled,
      };
    }

    if (scanResult.recommendation === "flag") {
      if (moderationEnabled) {
        await logModerationEvent({
          tenantId: request.tenantId,
          eventType: "prompt_flagged",
          promptHash,
          modelName: request.modelName,
          result: "flagged",
          reason: `Flagged: ${scanResult.piiTypes.join(", ")}`,
        });
      }
    }

    // Log allowed with PII warning
    if (moderationEnabled) {
      await logModerationEvent({
        tenantId: request.tenantId,
        eventType: "prompt_allowed",
        promptHash,
        modelName: request.modelName,
        result: "allowed",
        metadata: { piiTypes: scanResult.piiTypes, score: scanResult.score },
      });
    }

    return {
      allowed: true,
      promptScanScore: scanResult.score,
      piiDetected: scanResult.piiTypes,
      logged: moderationEnabled,
    };
  }

  // No prompt scanning — log allowed
  if (moderationEnabled) {
    await logModerationEvent({
      tenantId: request.tenantId,
      eventType: "prompt_allowed",
      promptHash,
      modelName: request.modelName,
      result: "allowed",
    });
  }

  return { allowed: true, logged: moderationEnabled };
}

/**
 * Run output moderation after AI response.
 */
export async function runOutputModeration(params: {
  tenantId: string;
  modelName: string;
  output: string;
  autoRedact?: boolean;
}): Promise<{
  safe: boolean;
  recommendation: string;
  flagCount: number;
  redactedOutput?: string;
  logged: boolean;
}> {
  const settings = await getTenantAiSettings(params.tenantId);
  const moderationEnabled = settings.moderation_enabled !== false;

  const result = moderateOutput(params.output, { autoRedact: params.autoRedact });

  if (moderationEnabled && !result.safe) {
    await logModerationEvent({
      tenantId: params.tenantId,
      eventType: "output_flagged",
      modelName: params.modelName,
      result: result.recommendation === "block" ? "blocked" : "flagged",
      reason: result.flags.map(f => f.flag).join(", "),
      metadata: { score: result.score },
    });
  }

  return {
    safe: result.safe,
    recommendation: result.recommendation,
    flagCount: result.flags.length,
    redactedOutput: result.redactedOutput,
    logged: moderationEnabled && !result.safe,
  };
}

/**
 * Get full governance observability stats for a tenant.
 */
export async function getGovernanceStats(tenantId?: string): Promise<{
  totalChecks: number;
  blocked: number;
  flagged: number;
  allowed: number;
  blockRate: number;
  topBlockReasons: Array<{ reason: string; count: number }>;
}> {
  const clause = tenantId ? drizzleSql`WHERE tenant_id = ${tenantId}` : drizzleSql``;
  const summary = await db.execute(drizzleSql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE result = 'blocked') AS blocked,
      COUNT(*) FILTER (WHERE result = 'flagged') AS flagged,
      COUNT(*) FILTER (WHERE result = 'allowed') AS allowed
    FROM moderation_events ${clause}
  `);
  const r = summary.rows[0] as Record<string, unknown>;
  const total = Number(r.total ?? 0);
  const blocked = Number(r.blocked ?? 0);

  const tenantClause2 = tenantId ? drizzleSql`AND tenant_id = ${tenantId}` : drizzleSql``;
  const reasons = await db.execute(drizzleSql`
    SELECT event_type, COUNT(*) AS cnt FROM moderation_events
    WHERE result = 'blocked' ${tenantClause2}
    GROUP BY event_type ORDER BY cnt DESC LIMIT 5
  `);

  return {
    totalChecks: total,
    blocked,
    flagged: Number(r.flagged ?? 0),
    allowed: Number(r.allowed ?? 0),
    blockRate: total > 0 ? parseFloat((blocked / total * 100).toFixed(2)) : 0,
    topBlockReasons: reasons.rows.map(row => ({
      reason: (row as Record<string, unknown>).event_type as string,
      count: Number((row as Record<string, unknown>).cnt),
    })),
  };
}
