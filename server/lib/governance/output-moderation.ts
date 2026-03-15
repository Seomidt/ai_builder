/**
 * Phase 24 — Output Moderation
 * Scans AI model outputs for safety issues before returning to users.
 */

import { db } from "../../db";
import { moderationEvents } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";

// ── Output moderation rules ────────────────────────────────────────────────────

export type OutputFlag =
  | "harmful_instructions"
  | "pii_in_output"
  | "hallucination_risk"
  | "bias_detected"
  | "confidential_data"
  | "inappropriate_content"
  | "none";

export interface OutputModerationResult {
  safe: boolean;
  flags: Array<{ flag: OutputFlag; confidence: number; detail: string }>;
  score: number;
  recommendation: "pass" | "flag" | "block";
  redactedOutput?: string;
}

const OUTPUT_RULES: Array<{
  flag: OutputFlag;
  patterns: RegExp[];
  confidence: number;
  autoBlock: boolean;
}> = [
  {
    flag: "harmful_instructions",
    patterns: [
      /step\s*\d+:\s*(add|mix|combine|heat)\s+.{0,50}(poison|explosive|drug|toxic)/i,
      /(to\s+make|to\s+create|to\s+build)\s+(a\s+)?(bomb|weapon|explosive|ransomware)/i,
    ],
    confidence: 0.95,
    autoBlock: true,
  },
  {
    flag: "inappropriate_content",
    patterns: [
      /explicit\s+sexual\s+content/i,
      /graphic\s+violence\s+description/i,
    ],
    confidence: 0.9,
    autoBlock: true,
  },
  {
    flag: "confidential_data",
    patterns: [
      /(?:password|api[_\s]?key|secret[_\s]?key|private[_\s]?key)\s*[:=]\s*[^\s]{8,}/i,
      /bearer\s+[a-zA-Z0-9\-._~+\/]+=*/i,
    ],
    confidence: 0.85,
    autoBlock: false,
  },
  {
    flag: "pii_in_output",
    patterns: [
      /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/,
      /\b\d{3}[\s\-]?\d{2}[\s\-]?\d{4}\b/, // SSN
    ],
    confidence: 0.7,
    autoBlock: false,
  },
];

// ── Moderation scoring ─────────────────────────────────────────────────────────

function computeOutputScore(flags: OutputModerationResult["flags"]): number {
  let score = 0;
  for (const f of flags) score += f.confidence * 50;
  return Math.min(Math.round(score), 100);
}

function getOutputRecommendation(score: number, hasAutoBlock: boolean): OutputModerationResult["recommendation"] {
  if (hasAutoBlock || score >= 70) return "block";
  if (score >= 25) return "flag";
  return "pass";
}

// ── Redaction ─────────────────────────────────────────────────────────────────

/**
 * Redact sensitive patterns from output.
 */
export function redactOutput(output: string): string {
  let redacted = output;
  // Redact API keys / secrets
  redacted = redacted.replace(/(?:password|api[_\s]?key|secret[_\s]?key)\s*[:=]\s*([^\s]{8,})/gi, (_, val) =>
    _.replace(val, "****" + val.slice(-4)));
  // Redact Bearer tokens
  redacted = redacted.replace(/(Bearer\s+)([a-zA-Z0-9\-._~+\/]+=*)/gi, "$1[REDACTED]");
  // Redact SSNs
  redacted = redacted.replace(/\b(\d{3})[\s\-]?(\d{2})[\s\-]?(\d{4})\b/g, "XXX-XX-XXXX");
  // Redact credit cards
  redacted = redacted.replace(/\b(\d{4})[\s\-]?(\d{4})[\s\-]?(\d{4})[\s\-]?(\d{4})\b/g, "XXXX-XXXX-XXXX-$4");
  return redacted;
}

// ── Main moderator ─────────────────────────────────────────────────────────────

/**
 * Moderate AI model output.
 */
export function moderateOutput(output: string, options?: {
  autoRedact?: boolean;
}): OutputModerationResult {
  const flags: OutputModerationResult["flags"] = [];
  let hasAutoBlock = false;

  for (const rule of OUTPUT_RULES) {
    for (const pattern of rule.patterns) {
      if (pattern.test(output)) {
        flags.push({
          flag: rule.flag,
          confidence: rule.confidence,
          detail: `Matched: ${pattern.source.slice(0, 60)}`,
        });
        if (rule.autoBlock) hasAutoBlock = true;
        break;
      }
    }
  }

  const score = computeOutputScore(flags);
  const recommendation = getOutputRecommendation(score, hasAutoBlock);

  const result: OutputModerationResult = {
    safe: flags.length === 0,
    flags,
    score,
    recommendation,
  };

  if (options?.autoRedact && flags.some(f => f.flag === "pii_in_output" || f.flag === "confidential_data")) {
    result.redactedOutput = redactOutput(output);
  }

  return result;
}

/**
 * Quick output safety check.
 */
export function isOutputSafe(output: string): boolean {
  return moderateOutput(output).recommendation !== "block";
}

// ── Moderation event logging ───────────────────────────────────────────────────

/**
 * Log a moderation event.
 */
export async function logModerationEvent(params: {
  tenantId: string;
  eventType: string;
  promptHash?: string;
  modelName?: string;
  policyKey?: string;
  result: "allowed" | "blocked" | "flagged";
  reason?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string }> {
  const rows = await db.insert(moderationEvents).values({
    tenantId: params.tenantId,
    eventType: params.eventType,
    promptHash: params.promptHash ?? null,
    modelName: params.modelName ?? null,
    policyKey: params.policyKey ?? null,
    result: params.result,
    reason: params.reason ?? null,
    metadata: params.metadata ?? null,
  }).returning({ id: moderationEvents.id });
  return { id: rows[0].id };
}

/**
 * Get moderation event by ID.
 */
export async function getModerationEvent(eventId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM moderation_events WHERE id = ${eventId} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

/**
 * List moderation events for a tenant.
 */
export async function listModerationEvents(tenantId: string, params?: {
  result?: string;
  eventType?: string;
  limit?: number;
}): Promise<Array<Record<string, unknown>>> {
  const resultClause = params?.result ? drizzleSql`AND result = ${params.result}` : drizzleSql``;
  const typeClause = params?.eventType ? drizzleSql`AND event_type = ${params.eventType}` : drizzleSql``;
  const limit = params?.limit ?? 50;
  const rows = await db.execute(drizzleSql`
    SELECT * FROM moderation_events
    WHERE tenant_id = ${tenantId} ${resultClause} ${typeClause}
    ORDER BY created_at DESC LIMIT ${limit}
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * Get moderation stats — blocked, flagged, allowed counts.
 */
export async function getModerationStats(tenantId?: string): Promise<{
  totalEvents: number;
  allowed: number;
  blocked: number;
  flagged: number;
  blockRate: number;
}> {
  const clause = tenantId ? drizzleSql`WHERE tenant_id = ${tenantId}` : drizzleSql``;
  const rows = await db.execute(drizzleSql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE result = 'allowed') AS allowed,
      COUNT(*) FILTER (WHERE result = 'blocked') AS blocked,
      COUNT(*) FILTER (WHERE result = 'flagged')  AS flagged
    FROM moderation_events ${clause}
  `);
  const r = rows.rows[0] as Record<string, unknown>;
  const total = Number(r.total ?? 0);
  const blocked = Number(r.blocked ?? 0);
  return {
    totalEvents: total,
    allowed: Number(r.allowed ?? 0),
    blocked,
    flagged: Number(r.flagged ?? 0),
    blockRate: total > 0 ? parseFloat((blocked / total * 100).toFixed(2)) : 0,
  };
}

/**
 * Get recent blocked prompts for observability.
 */
export async function getRecentBlockedPrompts(tenantId?: string, limit: number = 20): Promise<Array<Record<string, unknown>>> {
  const clause = tenantId ? drizzleSql`AND tenant_id = ${tenantId}` : drizzleSql``;
  const rows = await db.execute(drizzleSql`
    SELECT * FROM moderation_events
    WHERE result = 'blocked' ${clause}
    ORDER BY created_at DESC LIMIT ${limit}
  `);
  return rows.rows as Record<string, unknown>[];
}
