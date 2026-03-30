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
import { db } from "../../db.ts";
import { aiUsage, tenantAiUsagePeriods } from "@shared/schema";
import { getCurrentPeriod } from "./usage-periods.ts";
import { runAnomalyDetection } from "./anomaly-detector.ts";
import { maybeRecordAiBillingUsage } from "./billing.ts";
import { recordUsageRecordedEvent } from "./billing-events.ts";

export interface LogAiUsagePayload {
  tenantId?: string | null;
  userId?: string | null;
  /** HTTP request ID — ties this AI call back to its origin request for tracing */
  requestId?: string | null;
  /** Feature or agent key that made the call (e.g. "planner_agent", "summarize") */
  feature: string;
  /**
   * Logical route key resolved by the AI router (e.g. "expert.chat", "ops.analysis").
   * Should be set to the AiModelKey used in the runAiCall context.
   */
  routeKey?: string | null;
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
   * Actual USD cost derived from provider-returned token counts × active pricing config.
   * Set after the provider responds. Preferred for billing. Null on failure or unknown pricing.
   */
  actualCostUsd?: number | null;
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
 * Phase 13.1 hardening: usage insert and period aggregate are wrapped in a single
 * Drizzle transaction. Billing events and anomaly detection remain fire-and-forget.
 */
/**
 * Insert a row into ai_usage and, on success, atomically upsert the period aggregate.
 *
 * Phase 13.1 hardening — Billing Atomicity:
 *   The usage insert and period aggregate upsert are wrapped in a single Drizzle
 *   transaction so they either both commit or both roll back. This prevents partial
 *   writes where an ai_usage row exists without an updated period aggregate.
 *
 *   Billing event (maybeRecordAiBillingUsage) and anomaly detection remain
 *   fire-and-forget outside the transaction — they are best-effort and must not
 *   block or roll back the core usage write.
 */
export async function logAiUsage(payload: LogAiUsagePayload): Promise<void> {
  let insertedId: string | null = null;

  try {
    // Phase 13.1: wrap usage insert + period aggregate in a single transaction
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(aiUsage)
        .values({
          tenantId: payload.tenantId ?? null,
          userId: payload.userId ?? null,
          requestId: payload.requestId ?? null,
          feature: payload.feature,
          routeKey: payload.routeKey ?? null,
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
          // actualCostUsd: only included when explicitly set (column may not exist before migration)
          ...(payload.actualCostUsd !== undefined ? {
            actualCostUsd: payload.actualCostUsd != null
              ? String(payload.actualCostUsd)
              : (payload.estimatedCostUsd != null ? String(payload.estimatedCostUsd) : null),
          } : {}),
          pricingSource: payload.pricingSource ?? null,
          pricingVersion: payload.pricingVersion ?? null,
          inputTokensBillable: payload.inputTokensBillable ?? null,
          outputTokensBillable: payload.outputTokensBillable ?? null,
          cachedInputTokens: payload.cachedInputTokens ?? 0,
          reasoningTokens: payload.reasoningTokens ?? 0,
        })
        .onConflictDoNothing()
        .returning({ id: aiUsage.id });

      // Duplicate request_id — skip aggregate (no double-count)
      if (inserted.length === 0) {
        console.warn(
          "[ai/usage] Duplicate request_id detected — skipping log:",
          payload.requestId,
          "tenant:", payload.tenantId,
        );
        return; // exits the transaction cleanly
      }

      insertedId = inserted[0].id;

      // Only aggregate successful calls with a known tenant — inside same transaction
      if (payload.status === "success" && payload.tenantId) {
        const { periodStart, periodEnd } = getCurrentPeriod();
        // Prefer actual cost for period aggregate; fall back to estimated
        const cost = payload.actualCostUsd ?? payload.estimatedCostUsd ?? 0;
        const inputTokens = payload.promptTokens ?? 0;
        const outputTokens = payload.completionTokens ?? 0;
        const tokens = payload.totalTokens ?? 0;

        await tx
          .insert(tenantAiUsagePeriods)
          .values({
            tenantId: payload.tenantId,
            periodStart,
            periodEnd,
            totalCostUsd: String(cost),
            totalRequests: 1,
            totalInputTokens: inputTokens,
            totalOutputTokens: outputTokens,
            totalTokens: tokens,
            // reservedCostUsd starts at 0 for new rows — managed separately by reserveBudget/releaseBudgetReservation
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
              // NOTE: reservedCostUsd is NOT updated here — managed by budget-guard reservation
            },
          });
      }
    });
  } catch (err) {
    // Transaction rolled back — logging must never crash the application
    console.error("[ai/usage] Transaction failed — usage not logged:", err instanceof Error ? err.message : err);
    return;
  }

  if (!insertedId) return; // duplicate or rolled back

  // Phase 4F: fire usage_recorded billing event after committed transaction.
  // Best-effort — never blocks billing or runtime flow.
  if (payload.tenantId && payload.status === "success") {
    recordUsageRecordedEvent({
      tenantId: payload.tenantId,
      requestId: payload.requestId ?? null,
      usageId: insertedId,
      provider: payload.provider ?? null,
      model: payload.model,
      estimatedCostUsd: payload.estimatedCostUsd ?? null,
    });
  }

  // Only aggregate and bill successful calls with a known tenant.
  if (payload.status !== "success" || !payload.tenantId) return;

  // Phase 4A: billing write after confirmed committed transaction.
  // Fire-and-forget — billing failure must never break AI runtime.
  maybeRecordAiBillingUsage({
    usageId: insertedId,
    tenantId: payload.tenantId,
    requestId: payload.requestId ?? null,
    feature: payload.feature,
    routeKey: null,
    provider: payload.provider ?? null,
    model: payload.model,
    inputTokensBillable: payload.inputTokensBillable ?? payload.promptTokens ?? 0,
    outputTokensBillable: payload.outputTokensBillable ?? payload.completionTokens ?? 0,
    totalTokensBillable: payload.totalTokens ?? 0,
    providerCostUsd: payload.estimatedCostUsd ?? 0,
  }).catch((err) => {
    console.error(
      "[ai/usage] Billing write error (suppressed):",
      err instanceof Error ? err.message : err,
    );
  });

  // Phase 3K: anomaly detection after confirmed committed transaction.
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
