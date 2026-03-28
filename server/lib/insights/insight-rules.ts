/**
 * server/lib/insights/insight-rules.ts
 * Phase 2.2 — Tenant Insights Engine
 *
 * Rule definitions. Each rule is deterministic and purely functional:
 * takes a TenantInsightContext, returns InsightMatch | null.
 *
 * Rules implemented (V1):
 *   1. budget_warning_80         — cost / moderate   (REAL: budget signals)
 *   2. missing_rate_limit        — configuration / moderate (REAL: rate limit table)
 *   3. low_retrieval_confidence  — retrieval / moderate  (REAL: quality signals)
 *   4. high_ai_error_rate        — performance / high    (REAL: usage snapshots)
 *   5. slow_ai_response_p95      — performance / moderate (REAL: latency metrics)
 */

import type { InsightRule, InsightMatch, TenantInsightContext } from "./types";
import { INSIGHT_CODES } from "./types";

// ── Rule 1: Budget warning at or above warning threshold ──────────────────────

const budgetWarning80: InsightRule = {
  code:     INSIGHT_CODES.BUDGET_WARNING_80,
  category: "cost",
  severity: "moderate",

  async evaluate(ctx: TenantInsightContext): Promise<InsightMatch | null> {
    if (ctx.budgetUsagePct === null) return null;
    if (ctx.budgetUsagePct < ctx.budgetWarningThresholdPct) return null;

    return {
      titleKey:          "insights.budget_warning_80.title",
      descriptionKey:    "insights.budget_warning_80.description",
      recommendationKey: "insights.budget_warning_80.recommendation",
      metadata: {
        usagePct:         Math.round(ctx.budgetUsagePct),
        warningThreshold: ctx.budgetWarningThresholdPct,
      },
    };
  },
};

// ── Rule 2: Missing rate limit configuration ──────────────────────────────────

const missingRateLimit: InsightRule = {
  code:     INSIGHT_CODES.MISSING_RATE_LIMIT,
  category: "configuration",
  severity: "moderate",

  async evaluate(ctx: TenantInsightContext): Promise<InsightMatch | null> {
    if (ctx.hasRateLimit) return null;

    return {
      titleKey:          "insights.missing_rate_limit.title",
      descriptionKey:    "insights.missing_rate_limit.description",
      recommendationKey: "insights.missing_rate_limit.recommendation",
      metadata: {},
    };
  },
};

// ── Rule 3: Low retrieval confidence ─────────────────────────────────────────
// Fires when more than 30% of recent retrievals are low-confidence.

const LOW_CONFIDENCE_THRESHOLD = 0.30;

const lowRetrievalConfidence: InsightRule = {
  code:     INSIGHT_CODES.LOW_RETRIEVAL_CONFIDENCE,
  category: "retrieval",
  severity: "moderate",

  async evaluate(ctx: TenantInsightContext): Promise<InsightMatch | null> {
    if (ctx.recentLowConfidenceRatio === null) return null;
    if (ctx.recentLowConfidenceRatio < LOW_CONFIDENCE_THRESHOLD) return null;

    return {
      titleKey:          "insights.low_retrieval_confidence.title",
      descriptionKey:    "insights.low_retrieval_confidence.description",
      recommendationKey: "insights.low_retrieval_confidence.recommendation",
      metadata: {
        lowConfidencePct: Math.round(ctx.recentLowConfidenceRatio * 100),
        threshold:        Math.round(LOW_CONFIDENCE_THRESHOLD * 100),
      },
    };
  },
};

// ── Rule 4: High AI error rate ────────────────────────────────────────────────
// Fires when error rate exceeds 10% over last 7 days.

const HIGH_ERROR_RATE_THRESHOLD = 10; // percent

const highAiErrorRate: InsightRule = {
  code:     INSIGHT_CODES.HIGH_AI_ERROR_RATE,
  category: "performance",
  severity: "high",

  async evaluate(ctx: TenantInsightContext): Promise<InsightMatch | null> {
    if (ctx.recentErrorRatePct === null) return null;
    if (ctx.recentErrorRatePct < HIGH_ERROR_RATE_THRESHOLD) return null;

    return {
      titleKey:          "insights.high_ai_error_rate.title",
      descriptionKey:    "insights.high_ai_error_rate.description",
      recommendationKey: "insights.high_ai_error_rate.recommendation",
      metadata: {
        errorRatePct: Math.round(ctx.recentErrorRatePct),
        threshold:    HIGH_ERROR_RATE_THRESHOLD,
      },
    };
  },
};

// ── Rule 5: Slow AI response p95 ──────────────────────────────────────────────
// Fires when p95 latency exceeds 8 seconds over last 24 hours.

const SLOW_P95_THRESHOLD_MS = 8_000;

const slowAiResponseP95: InsightRule = {
  code:     INSIGHT_CODES.SLOW_AI_RESPONSE_P95,
  category: "performance",
  severity: "moderate",

  async evaluate(ctx: TenantInsightContext): Promise<InsightMatch | null> {
    if (ctx.recentLatencyP95Ms === null) return null;
    if (ctx.recentLatencyP95Ms < SLOW_P95_THRESHOLD_MS) return null;

    return {
      titleKey:          "insights.slow_ai_response_p95.title",
      descriptionKey:    "insights.slow_ai_response_p95.description",
      recommendationKey: "insights.slow_ai_response_p95.recommendation",
      metadata: {
        p95LatencyMs:  Math.round(ctx.recentLatencyP95Ms),
        thresholdMs:   SLOW_P95_THRESHOLD_MS,
        p95LatencySec: (ctx.recentLatencyP95Ms / 1000).toFixed(1),
      },
    };
  },
};

// ── Exported rule registry ────────────────────────────────────────────────────

export const ALL_RULES: InsightRule[] = [
  budgetWarning80,
  missingRateLimit,
  lowRetrievalConfidence,
  highAiErrorRate,
  slowAiResponseP95,
];
