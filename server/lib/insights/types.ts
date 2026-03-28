/**
 * server/lib/insights/types.ts
 * Phase 2.2 — Tenant Insights Engine
 *
 * Canonical enums and types for the insights system.
 * Machine-readable codes + i18n-key model (no hardcoded UI text here).
 */

// ── Canonical enums ───────────────────────────────────────────────────────────

export type InsightSeverity = "low" | "moderate" | "high";
export type InsightCategory  = "security" | "performance" | "cost" | "configuration" | "retrieval";
export type InsightStatus    = "active" | "dismissed" | "resolved";

// ── Stable insight codes ──────────────────────────────────────────────────────
// Codes are immutable once shipped. Never rename a code — add a new one.

export const INSIGHT_CODES = {
  BUDGET_WARNING_80:          "budget_warning_80",
  MISSING_RATE_LIMIT:         "missing_rate_limit",
  LOW_RETRIEVAL_CONFIDENCE:   "low_retrieval_confidence",
  HIGH_AI_ERROR_RATE:         "high_ai_error_rate",
  SLOW_AI_RESPONSE_P95:       "slow_ai_response_p95",
} as const;

export type InsightCode = (typeof INSIGHT_CODES)[keyof typeof INSIGHT_CODES];

// ── Tenant context — signals gathered before rule evaluation ──────────────────

export interface TenantInsightContext {
  tenantId: string;
  /** 0-100 percentage of budget consumed, or null if no budget configured */
  budgetUsagePct:          number | null;
  /** Warning threshold from budget config (default 80) */
  budgetWarningThresholdPct: number;
  /** Whether an active rate limit row exists for this tenant */
  hasRateLimit:            boolean;
  /** p95 AI latency (ms) over last 24h, or null if insufficient data */
  recentLatencyP95Ms:      number | null;
  /** Error rate 0-100 over last 7 days, or null if no data */
  recentErrorRatePct:      number | null;
  /** Ratio of low-confidence retrievals over last 7 days, or null if no data */
  recentLowConfidenceRatio: number | null;
}

// ── Rule interface ─────────────────────────────────────────────────────────────

export interface InsightMatch {
  titleKey:          string;
  descriptionKey:    string;
  recommendationKey: string;
  metadata:          Record<string, unknown>;
}

export interface InsightRule {
  code:     InsightCode;
  category: InsightCategory;
  severity: InsightSeverity;
  /** Returns InsightMatch if rule fires, null if it does not */
  evaluate: (ctx: TenantInsightContext) => Promise<InsightMatch | null>;
}

// ── Runner result ─────────────────────────────────────────────────────────────

export interface InsightRunResult {
  tenantId:  string;
  created:   number;
  updated:   number;
  resolved:  number;
  skipped:   number;
  durationMs: number;
}
