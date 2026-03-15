/**
 * Phase 24 — Policy Engine
 * Evaluates platform-level AI governance policies for every AI request.
 */

import { db } from "../../db";
import { aiPolicies } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";

// ── Built-in platform policies ────────────────────────────────────────────────

export const BUILT_IN_POLICIES = [
  {
    policyKey: "max_token_limit",
    description: "Enforce maximum token limits per request",
    enabled: true,
    severity: "high",
    config: { defaultMax: 4096, absoluteMax: 32768 },
  },
  {
    policyKey: "prompt_injection_guard",
    description: "Detect and block prompt injection attacks",
    enabled: true,
    severity: "critical",
    config: { patterns: ["ignore previous", "system prompt", "jailbreak", "DAN", "developer mode"] },
  },
  {
    policyKey: "pii_detection",
    description: "Detect personally identifiable information in prompts",
    enabled: true,
    severity: "high",
    config: { blockOnDetect: false, flagOnDetect: true },
  },
  {
    policyKey: "harmful_content_filter",
    description: "Block requests containing harmful or dangerous content",
    enabled: true,
    severity: "critical",
    config: { categories: ["violence", "self_harm", "illegal_activities", "hate_speech"] },
  },
  {
    policyKey: "rate_limiting",
    description: "Enforce per-tenant prompt rate limits",
    enabled: true,
    severity: "medium",
    config: { windowMs: 60000, maxRequests: 60 },
  },
  {
    policyKey: "model_access_control",
    description: "Restrict model usage to allowlist",
    enabled: true,
    severity: "high",
    config: { enforceAllowlist: true },
  },
  {
    policyKey: "output_length_limit",
    description: "Limit output token count",
    enabled: true,
    severity: "low",
    config: { maxOutputTokens: 8192 },
  },
  {
    policyKey: "tenant_topic_restriction",
    description: "Block topics configured as off-limits per tenant",
    enabled: true,
    severity: "medium",
    config: {},
  },
] as const;

export type PolicySeverity = "low" | "medium" | "high" | "critical";

export interface PolicyResult {
  allowed: boolean;
  policyKey: string;
  reason?: string;
  severity: PolicySeverity;
}

export interface PolicyCheckRequest {
  tenantId: string;
  modelName?: string;
  prompt?: string;
  tokenCount?: number;
  maxTokens?: number;
}

// ── Policy CRUD ───────────────────────────────────────────────────────────────

export async function seedBuiltInPolicies(): Promise<{ seeded: number }> {
  let seeded = 0;
  for (const policy of BUILT_IN_POLICIES) {
    const existing = await db.execute(drizzleSql`
      SELECT id FROM ai_policies WHERE policy_key = ${policy.policyKey} LIMIT 1
    `);
    if (existing.rows.length === 0) {
      await db.insert(aiPolicies).values({
        policyKey: policy.policyKey,
        description: policy.description,
        enabled: policy.enabled,
        severity: policy.severity,
        config: policy.config,
      });
      seeded++;
    }
  }
  return { seeded };
}

export async function getPolicy(policyKey: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM ai_policies WHERE policy_key = ${policyKey} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

export async function listPolicies(params?: { enabledOnly?: boolean }): Promise<Array<Record<string, unknown>>> {
  const clause = params?.enabledOnly ? drizzleSql`WHERE enabled = true` : drizzleSql``;
  const rows = await db.execute(drizzleSql`
    SELECT * FROM ai_policies ${clause} ORDER BY severity DESC, policy_key ASC
  `);
  return rows.rows as Record<string, unknown>[];
}

export async function togglePolicy(policyKey: string, enabled: boolean): Promise<{ updated: boolean }> {
  await db.execute(drizzleSql`
    UPDATE ai_policies SET enabled = ${enabled}, updated_at = NOW()
    WHERE policy_key = ${policyKey}
  `);
  return { updated: true };
}

export async function updatePolicyConfig(policyKey: string, config: Record<string, unknown>): Promise<{ updated: boolean }> {
  await db.execute(drizzleSql`
    UPDATE ai_policies SET config = ${JSON.stringify(config)}, updated_at = NOW()
    WHERE policy_key = ${policyKey}
  `);
  return { updated: true };
}

// ── Policy evaluation ─────────────────────────────────────────────────────────

/**
 * Evaluate max_token_limit policy.
 */
export function evaluateTokenLimit(params: { tokenCount?: number; maxTokens?: number }): PolicyResult {
  const requested = params.tokenCount ?? 0;
  const limit = params.maxTokens ?? 4096;
  const absoluteMax = 32768;
  if (requested > absoluteMax) {
    return { allowed: false, policyKey: "max_token_limit", reason: `Token count ${requested} exceeds absolute max ${absoluteMax}`, severity: "high" };
  }
  if (requested > limit) {
    return { allowed: false, policyKey: "max_token_limit", reason: `Token count ${requested} exceeds tenant limit ${limit}`, severity: "high" };
  }
  return { allowed: true, policyKey: "max_token_limit", severity: "high" };
}

/**
 * Evaluate prompt_injection_guard policy.
 */
export function evaluatePromptInjection(prompt: string): PolicyResult {
  const lower = prompt.toLowerCase();
  const injectionPatterns = [
    "ignore previous instructions",
    "ignore all previous",
    "system prompt",
    "jailbreak",
    " dan ",
    "developer mode",
    "ignore your instructions",
    "disregard your training",
    "act as if you have no restrictions",
  ];
  for (const pattern of injectionPatterns) {
    if (lower.includes(pattern)) {
      return {
        allowed: false,
        policyKey: "prompt_injection_guard",
        reason: `Prompt injection pattern detected: "${pattern}"`,
        severity: "critical",
      };
    }
  }
  return { allowed: true, policyKey: "prompt_injection_guard", severity: "critical" };
}

/**
 * Evaluate harmful_content_filter policy.
 */
export function evaluateHarmfulContent(prompt: string): PolicyResult {
  const lower = prompt.toLowerCase();
  const harmfulPatterns: Record<string, string[]> = {
    violence: ["how to kill", "how to hurt", "how to harm", "bomb making", "weapon instructions"],
    self_harm: ["how to commit suicide", "self-harm methods", "ways to hurt myself"],
    illegal_activities: ["how to hack", "create malware", "how to steal", "drug synthesis", "counterfeit"],
    hate_speech: ["racial slur", "ethnic cleansing"],
  };
  for (const [category, patterns] of Object.entries(harmfulPatterns)) {
    for (const pattern of patterns) {
      if (lower.includes(pattern)) {
        return {
          allowed: false,
          policyKey: "harmful_content_filter",
          reason: `Harmful content detected (${category}): "${pattern}"`,
          severity: "critical",
        };
      }
    }
  }
  return { allowed: true, policyKey: "harmful_content_filter", severity: "critical" };
}

/**
 * Evaluate topic restriction policy (per-tenant blocked topics).
 */
export function evaluateTopicRestriction(prompt: string, blockedTopics: string[]): PolicyResult {
  if (!blockedTopics || blockedTopics.length === 0) {
    return { allowed: true, policyKey: "tenant_topic_restriction", severity: "medium" };
  }
  const lower = prompt.toLowerCase();
  for (const topic of blockedTopics) {
    if (lower.includes(topic.toLowerCase())) {
      return {
        allowed: false,
        policyKey: "tenant_topic_restriction",
        reason: `Topic "${topic}" is blocked for this tenant`,
        severity: "medium",
      };
    }
  }
  return { allowed: true, policyKey: "tenant_topic_restriction", severity: "medium" };
}

/**
 * Run all enabled policies for a given request.
 * Returns: { allowed, violations }
 */
export async function runPolicyChecks(request: PolicyCheckRequest & { blockedTopics?: string[] }): Promise<{
  allowed: boolean;
  violations: PolicyResult[];
  passed: PolicyResult[];
}> {
  const violations: PolicyResult[] = [];
  const passed: PolicyResult[] = [];

  const checks: PolicyResult[] = [
    evaluateTokenLimit({ tokenCount: request.tokenCount, maxTokens: request.maxTokens }),
    evaluatePromptInjection(request.prompt ?? ""),
    evaluateHarmfulContent(request.prompt ?? ""),
    evaluateTopicRestriction(request.prompt ?? "", request.blockedTopics ?? []),
  ];

  for (const result of checks) {
    if (!result.allowed) violations.push(result);
    else passed.push(result);
  }

  return { allowed: violations.length === 0, violations, passed };
}

/**
 * Detect PII in prompt (returns detected types, doesn't block by default).
 */
export function detectPii(prompt: string): { detected: boolean; types: string[] } {
  const types: string[] = [];
  // Email
  if (/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/.test(prompt)) types.push("email");
  // Phone (simple)
  if (/(\+?\d[\s\-.]?){7,15}/.test(prompt)) types.push("phone");
  // Credit card (simplified Luhn-like)
  if (/\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/.test(prompt)) types.push("credit_card");
  // SSN
  if (/\b\d{3}[\s\-]?\d{2}[\s\-]?\d{4}\b/.test(prompt)) types.push("ssn");
  return { detected: types.length > 0, types };
}

/**
 * Get policy violation stats for observability.
 */
export async function getPolicyViolationStats(tenantId?: string): Promise<{
  totalViolations: number;
  byPolicy: Record<string, number>;
  bySeverity: Record<string, number>;
}> {
  const tenantClause = tenantId ? drizzleSql`AND tenant_id = ${tenantId}` : drizzleSql``;
  const byPolicy = await db.execute(drizzleSql`
    SELECT policy_key, COUNT(*) AS cnt FROM moderation_events
    WHERE event_type = 'policy_violation' AND result = 'blocked' ${tenantClause}
    GROUP BY policy_key ORDER BY cnt DESC
  `);
  const total = byPolicy.rows.reduce((sum, r) => sum + Number((r as Record<string, unknown>).cnt), 0);

  const bySeverityRows = await db.execute(drizzleSql`
    SELECT ap.severity, COUNT(*) AS cnt FROM moderation_events me
    JOIN ai_policies ap ON ap.policy_key = me.policy_key
    WHERE me.event_type = 'policy_violation' ${tenantClause}
    GROUP BY ap.severity
  `);

  return {
    totalViolations: total,
    byPolicy: Object.fromEntries(byPolicy.rows.map(r => [(r as Record<string, unknown>).policy_key as string, Number((r as Record<string, unknown>).cnt)])),
    bySeverity: Object.fromEntries(bySeverityRows.rows.map(r => [(r as Record<string, unknown>).severity as string, Number((r as Record<string, unknown>).cnt)])),
  };
}
