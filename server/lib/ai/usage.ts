/**
 * AI Usage Logger
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 * Persists every LLM call to the ai_usage table for cost tracking and debugging.
 * On successful calls, also upserts the tenant_ai_usage_periods aggregate row.
 *
 * Design principles:
 * - Logging failures must NEVER crash the application flow (fire-and-forget)
 * - Idempotency: duplicate request_id per tenant is silently ignored via ON CONFLICT DO NOTHING
 * - If a duplicate is detected, the aggregate upsert is also skipped (no double-count)
 * - Aggregate update is synchronous within logAiUsage but safe from propagating errors
 * - Uses the same Drizzle db instance as the rest of the server
 * - Callers own the decision of when and whether to log
 *
 * Phase 3G.1: added provider field, aggregate period upsert
 * Hardening: idempotency via partial unique index on (tenant_id, request_id)
 * Final hardening: cost basis fields — pricing_source, pricing_version,
 *   input_tokens_billable, output_tokens_billable, cached_input_tokens, reasoning_tokens.
 *   Status "blocked" for guardrail hard-stop events (distinct from provider errors).
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";
import { aiUsage, tenantAiUsagePeriods } from "@shared/schema";
import { getCurrentPeriod } from "./usage-periods";
import { runAnomalyDetection } from "./anomaly-detector";

export interface LogAiUsagePayload {
  tenantId?: string | null;
  userId?: string | null;
  /** HTTP request ID — ties this AI call back to its origin request for tracing */
  requestId?: string | null;
  /** Feature or agent key that made the call (e.g. "planner_agent", "summarize") */
  feature: string;
  /** AI provider key — "openai" | "anthropic" | "google" */
  provider?: string | null;
  /** Concrete model identifier (e.g. "gpt-4.1-mini") */
  model: string;
  /** Normalized input token count reported by provider */
  promptTokens?: number | null;
  /** Normalized output token count reported by provider */
  completionTokens?: number | null;
  /** Normalized total token count reported by provider */
  totalTokens?: number | null;
  /** First N chars of user input for debugging — never store full prompts */
  inputPreview?: string | null;
  /**
   * "success" — provider call completed and returned a result
   * "error"   — provider call failed (network, timeout, quota, etc.)
   * "blocked" — call was stopped by a guardrail before reaching the provider
   */
  status: "success" | "error" | "blocked";
  errorMessage?: string | null;
  latencyMs?: number | null;
  /** Estimated USD cost from token usage × pricing — null if pricing unknown */
  estimatedCostUsd?: number | null;
  /**
   * Pricing source used for cost calculation.
   * "db_override"  — active row from ai_model_pricing table
   * "code_default" — fallback from AI_MODEL_PRICING_DEFAULTS in costs.ts
   * null           — no pricing found
   */
  pricingSource?: string | null;
  /**
   * Version identifier for the pricing used.
   * For "db_override": the ai_model_pricing row id
   * For "code_default" or not found: null
   */
  pricingVersion?: string | null;
  /**
   * Input tokens used as the billable basis for cost math.
   * Equals promptTokens in current formula. Null means not tracked (same as promptTokens).
   */
  inputTokensBillable?: number | null;
  /**
   * Output tokens used as the billable basis for cost math.
   * Equals completionTokens in current formula. Null means not tracked (same as completionTokens).
   */
  outputTokensBillable?: number | null;
  /**
   * Cached prompt/context tokens returned by the provider.
   * OpenAI: usage.input_token_details.cached_tokens — 0 if not reported or provider unsupported.
   */
  cachedInputTokens?: number | null;
  /**
   * Reasoning tokens returned by the provider.
   * OpenAI o-series: usage.output_token_details.reasoning_tokens — 0 if not reported.
   */
  reasoningTokens?: number | null;
}

/**
 * Insert a row into ai_usage, and on success also upsert the aggregate period row.
 *
 * Idempotency: uses ON CONFLICT DO NOTHING against the partial unique index
 * (tenant_id, request_id) WHERE request_id IS NOT NULL. If a duplicate is
 * detected (empty returning), the aggregate upsert is also skipped so no
 * double-counting occurs. Calls without a request_id are not deduplicated.
 *
 * Status discipline:
 *   "success" — provider call succeeded — aggregate is updated
 *   "error"   — provider call failed — aggregate is NOT updated
 *   "blocked" — guardrail hard-stop — aggregate is NOT updated (no provider usage occurred)
 *
 * Fire-and-forget: any database error is caught and logged to console only.
 * The calling code never sees a thrown error from this function.
 */
export async function logAiUsage(payload: LogAiUsagePayload): Promise<void> {
  let inserted: { id: string }[];

  try {
    inserted = await db
      .insert(aiUsage)
      .values({
        tenantId: payload.tenantId ?? null,
        userId: payload.userId ?? null,
        requestId: payload.requestId ?? null,
        feature: payload.feature,
        provider: payload.provider ?? null,
        model: payload.model,
        promptTokens: payload.promptTokens ?? 0,
        completionTokens: payload.completionTokens ?? 0,
        totalTokens: payload.totalTokens ?? 0,
        inputPreview: payload.inputPreview ?? null,
        status: payload.status,
        errorMessage: payload.errorMessage ?? null,
        latencyMs: payload.latencyMs ?? null,
        estimatedCostUsd: payload.estimatedCostUsd != null
          ? String(payload.estimatedCostUsd)
          : null,
        pricingSource: payload.pricingSource ?? null,
        pricingVersion: payload.pricingVersion ?? null,
        inputTokensBillable: payload.inputTokensBillable ?? null,
        outputTokensBillable: payload.outputTokensBillable ?? null,
        cachedInputTokens: payload.cachedInputTokens ?? 0,
        reasoningTokens: payload.reasoningTokens ?? 0,
      })
      .onConflictDoNothing()
      .returning({ id: aiUsage.id });
  } catch (err) {
    // Logging must never crash the application
    console.error("[ai/usage] Failed to log AI usage:", err instanceof Error ? err.message : err);
    return;
  }

  // Empty result means the insert was a no-op due to duplicate request_id
  if (inserted.length === 0) {
    console.warn(
      "[ai/usage] Duplicate request_id detected — skipping log:",
      payload.requestId,
      "tenant:", payload.tenantId,
    );
    return;
  }

  // Only aggregate successful calls with a known tenant.
  // "error" and "blocked" rows must not increment the aggregate — no provider usage occurred.
  if (payload.status !== "success" || !payload.tenantId) return;

  await upsertUsagePeriodAggregate(payload);

  // Phase 3K: anomaly detection after confirmed successful usage write.
  // Fire-and-forget — must never block or throw into the caller.
  runAnomalyDetection({
    tenantId: payload.tenantId,
    requestId: payload.requestId,
    feature: payload.feature,
    routeKey: null,
    provider: payload.provider,
    model: payload.model,
    estimatedCostUsd: payload.estimatedCostUsd,
    totalTokens: payload.totalTokens,
    completionTokens: payload.completionTokens,
    outputTokensBillable: payload.outputTokensBillable,
  }).catch((err) => {
    console.error(
      "[ai/usage] Anomaly detection error (suppressed):",
      err instanceof Error ? err.message : err,
    );
  });
}

/**
 * Upsert the tenant_ai_usage_periods aggregate row for the current period.
 *
 * Uses PostgreSQL ON CONFLICT DO UPDATE to atomically increment counters.
 * Treats null cost and null token counts as 0 so the aggregate math is always safe.
 *
 * Fire-and-forget safe: all errors are caught. Never throws.
 */
async function upsertUsagePeriodAggregate(payload: LogAiUsagePayload): Promise<void> {
  try {
    const { periodStart, periodEnd } = getCurrentPeriod();

    const cost = payload.estimatedCostUsd ?? 0;
    const inputTokens = payload.promptTokens ?? 0;
    const outputTokens = payload.completionTokens ?? 0;
    const tokens = payload.totalTokens ?? 0;

    await db
      .insert(tenantAiUsagePeriods)
      .values({
        tenantId: payload.tenantId!,
        periodStart,
        periodEnd,
        totalCostUsd: String(cost),
        totalRequests: 1,
        totalInputTokens: inputTokens,
        totalOutputTokens: outputTokens,
        totalTokens: tokens,
      })
      .onConflictDoUpdate({
        target: [
          tenantAiUsagePeriods.tenantId,
          tenantAiUsagePeriods.periodStart,
          tenantAiUsagePeriods.periodEnd,
        ],
        set: {
          totalCostUsd: sql`${tenantAiUsagePeriods.totalCostUsd} + excluded.total_cost_usd`,
          totalRequests: sql`${tenantAiUsagePeriods.totalRequests} + excluded.total_requests`,
          totalInputTokens: sql`${tenantAiUsagePeriods.totalInputTokens} + excluded.total_input_tokens`,
          totalOutputTokens: sql`${tenantAiUsagePeriods.totalOutputTokens} + excluded.total_output_tokens`,
          totalTokens: sql`${tenantAiUsagePeriods.totalTokens} + excluded.total_tokens`,
          updatedAt: sql`now()`,
        },
      });
  } catch (err) {
    // Aggregate update must never crash AI runtime
    console.error(
      "[ai/usage] Failed to upsert usage period aggregate:",
      err instanceof Error ? err.message : err,
    );
  }
}
