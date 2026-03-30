/**
 * AI Usage Guardrails
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Central source of truth for AI budget checking. No feature code may
 * perform its own budget math — all guardrail decisions go through here.
 *
 * Guardrail states:
 *   normal      — 0% to below warning threshold — full AI access
 *   budget_mode — warning threshold to below hard limit — verbosity reduced
 *   blocked     — hard limit and above — included AI access exhausted
 *
 * All functions catch DB errors internally and fail safe (never throw to callers).
 *
 * Phase 3G
 */

import { and, eq, gte, isNull, lt, sum } from "drizzle-orm";
import { db } from "../../db.ts";
import {
  aiUsage,
  aiUsageLimits,
  tenantAiUsagePeriods,
  usageThresholdEvents,
  type AiUsageLimit,
} from "@shared/schema";
import { getCurrentPeriod } from "./usage-periods.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

export type AiUsageState = "normal" | "budget_mode" | "blocked";

// ── Budget mode policy ────────────────────────────────────────────────────────

/**
 * Applied by runner.ts when usage state is "budget_mode".
 *
 * Rules:
 *   - No provider/model switch — same routing as normal
 *   - maxOutputTokens caps the model response length
 *   - conciseMode triggers a system prompt prefix to reduce verbosity
 *
 * Centralised here so it never needs to be duplicated in feature code.
 */
export const BUDGET_MODE_POLICY = {
  maxOutputTokens: 512,
  conciseMode: true,
  systemPromptPrefix: "Be concise and direct. Keep your response brief.\n\n",
} as const;

// ── Usage limit loader ────────────────────────────────────────────────────────

/**
 * Load the tenant's configured AI usage limit from the database.
 *
 * Returns null if:
 *   - tenantId is empty/missing
 *   - no limit row exists for the tenant
 *   - DB query fails
 *
 * Null means no configured limit — treat as unlimited (normal state).
 * Never throws.
 */
export async function loadUsageLimit(tenantId: string): Promise<AiUsageLimit | null> {
  if (!tenantId) return null;
  try {
    const rows = await db
      .select()
      .from(aiUsageLimits)
      .where(eq(aiUsageLimits.tenantId, tenantId))
      .limit(1);
    return rows[0] ?? null;
  } catch (err) {
    console.warn(
      "[ai:guards] Failed to load usage limit for tenant",
      tenantId,
      ":",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

// ── Period usage calculator ───────────────────────────────────────────────────

/**
 * Return the tenant's current-period AI cost (USD).
 *
 * Aggregate-first: reads from tenant_ai_usage_periods for O(1) performance.
 * Fallback: if no aggregate row exists yet (e.g. first call of the period),
 *   computes from raw ai_usage — this is safe and self-healing because the
 *   next successful call will create the aggregate row.
 *
 * Returns 0 on any DB failure — conservative safe fallback (allows calls through).
 * Never throws.
 */
export async function getCurrentAiUsageForPeriod(tenantId: string): Promise<number> {
  if (!tenantId) return 0;
  const { periodStart, periodEnd } = getCurrentPeriod();

  // ── Aggregate-first path ────────────────────────────────────────────────────
  try {
    const rows = await db
      .select({ totalCostUsd: tenantAiUsagePeriods.totalCostUsd })
      .from(tenantAiUsagePeriods)
      .where(
        and(
          eq(tenantAiUsagePeriods.tenantId, tenantId),
          eq(tenantAiUsagePeriods.periodStart, periodStart),
          eq(tenantAiUsagePeriods.periodEnd, periodEnd),
        ),
      )
      .limit(1);

    if (rows.length > 0 && rows[0].totalCostUsd != null) {
      return Number(rows[0].totalCostUsd);
    }
  } catch (err) {
    console.warn(
      "[ai:guards] Aggregate period read failed for tenant",
      tenantId,
      "— falling back to raw sum:",
      err instanceof Error ? err.message : err,
    );
  }

  // ── Raw fallback path ───────────────────────────────────────────────────────
  // Used when no aggregate row exists yet (first call of a period).
  // Uses composite index: (tenant_id, status, created_at).
  try {
    const rawRows = await db
      .select({ total: sum(aiUsage.estimatedCostUsd) })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.tenantId, tenantId),
          eq(aiUsage.status, "success"),
          gte(aiUsage.createdAt, periodStart),
          lt(aiUsage.createdAt, periodEnd),
        ),
      );
    const raw = rawRows[0]?.total;
    return raw != null ? Number(raw) : 0;
  } catch (err) {
    console.warn(
      "[ai:guards] Raw usage fallback also failed for tenant",
      tenantId,
      ":",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

// ── State evaluator ───────────────────────────────────────────────────────────

/**
 * Evaluate the tenant's current AI usage state.
 *
 * Pure function — no DB calls, no side effects, never throws.
 *
 * Decision logic:
 *   usagePercent = (currentUsageUsd / monthlyAiBudgetUsd) × 100
 *   >= hardLimitPercent   AND hardStopEnabled   → "blocked"
 *   >= warningThreshold   AND budgetModeEnabled → "budget_mode"
 *   otherwise                                   → "normal"
 *
 * If budget is zero or negative, returns "normal" (not meaningful to enforce).
 */
export function evaluateAiUsageState(params: {
  currentUsageUsd: number;
  limit: AiUsageLimit;
}): AiUsageState {
  const { currentUsageUsd, limit } = params;
  const budgetUsd = Number(limit.monthlyAiBudgetUsd);

  if (budgetUsd <= 0) return "normal";

  const usagePercent = (currentUsageUsd / budgetUsd) * 100;

  if (limit.hardStopEnabled && usagePercent >= limit.hardLimitPercent) return "blocked";
  if (limit.budgetModeEnabled && usagePercent >= limit.warningThresholdPercent) return "budget_mode";
  return "normal";
}

// ── Threshold event recorder ──────────────────────────────────────────────────

/**
 * Record a threshold crossing event if one has not been recorded recently.
 *
 * Deduplication: skips insert if an unresolved event of the same type
 * exists for this tenant within the last 24 hours.
 *
 * Fire-and-forget safe: all errors are caught and logged only.
 * Never throws.
 */
export async function maybeRecordThresholdEvent(params: {
  tenantId: string;
  state: AiUsageState;
  currentUsageUsd: number;
  limit: AiUsageLimit;
  requestId?: string | null;
}): Promise<void> {
  const { tenantId, state, currentUsageUsd, limit, requestId } = params;

  if (state !== "budget_mode" && state !== "blocked") return;

  const eventType =
    state === "blocked" ? "hard_limit_reached" : "warning_threshold_reached";
  const thresholdPercent =
    state === "blocked" ? limit.hardLimitPercent : limit.warningThresholdPercent;
  const budgetUsd = Number(limit.monthlyAiBudgetUsd);

  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1_000);

    const existing = await db
      .select({ id: usageThresholdEvents.id })
      .from(usageThresholdEvents)
      .where(
        and(
          eq(usageThresholdEvents.tenantId, tenantId),
          eq(usageThresholdEvents.eventType, eventType),
          isNull(usageThresholdEvents.resolvedAt),
          gte(usageThresholdEvents.createdAt, cutoff),
        ),
      )
      .limit(1);

    if (existing.length > 0) return;

    await db.insert(usageThresholdEvents).values({
      tenantId,
      metricType: "ai",
      eventType,
      thresholdPercent,
      metricValue: String(currentUsageUsd),
      budgetValue: String(budgetUsd),
      requestId: requestId ?? null,
    });

    console.log(
      `[ai:guards] Threshold event recorded: ${eventType} tenant=${tenantId} usage=$${currentUsageUsd.toFixed(6)} budget=$${budgetUsd.toFixed(6)}`,
    );
  } catch (err) {
    console.error(
      "[ai:guards] Failed to record threshold event:",
      err instanceof Error ? err.message : err,
    );
  }
}
