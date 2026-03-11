/**
 * AI Usage Logger
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 * Persists every LLM call to the ai_usage table for cost tracking and debugging.
 * On successful calls, also upserts the tenant_ai_usage_periods aggregate row.
 *
 * Design principles:
 * - Logging failures must NEVER crash the application flow (fire-and-forget)
 * - Aggregate update is synchronous within logAiUsage but safe from propagating errors
 * - Uses the same Drizzle db instance as the rest of the server
 * - Callers own the decision of when and whether to log
 *
 * Phase 3G.1: added provider field, aggregate period upsert
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";
import { aiUsage, tenantAiUsagePeriods } from "@shared/schema";
import { getCurrentPeriod } from "./usage-periods";

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
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  /** First N chars of user input for debugging — never store full prompts */
  inputPreview?: string | null;
  status: "success" | "error";
  errorMessage?: string | null;
  latencyMs?: number | null;
  /** Estimated USD cost from token usage × pricing — null if pricing unknown */
  estimatedCostUsd?: number | null;
}

/**
 * Insert a row into ai_usage, and on success also upsert the aggregate period row.
 *
 * Fire-and-forget: any database error is caught and logged to console only.
 * The calling code never sees a thrown error from this function.
 */
export async function logAiUsage(payload: LogAiUsagePayload): Promise<void> {
  try {
    await db.insert(aiUsage).values({
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
    });
  } catch (err) {
    // Logging must never crash the application
    console.error("[ai/usage] Failed to log AI usage:", err instanceof Error ? err.message : err);
    return;
  }

  // Only aggregate successful calls with a known tenant
  if (payload.status !== "success" || !payload.tenantId) return;

  await upsertUsagePeriodAggregate(payload);
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
