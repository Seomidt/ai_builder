/**
 * Budget Guard — Phase X+1 (hardened X+1.1)
 *
 * Central budget enforcement layer.
 * Wraps the existing guards.ts infrastructure with the spec-required interface.
 *
 * Phase X+1.1 — Atomic Budget Enforcement:
 *   checkBudget()   — legacy read-based check (used for pre-flight reads, summary, UI)
 *   reserveBudget() — atomic DB UPDATE that increments reserved_cost_usd with a budget
 *                     WHERE-guard. Safe under concurrent requests: only succeeds if
 *                     (total_cost_usd + reserved_cost_usd + estimate) <= budget.
 *                     If 0 rows are updated, the budget would be exceeded → block.
 *   releaseBudgetReservation() — decrements reserved_cost_usd after logging (or on error).
 *
 * The reservation table/row used is tenant_ai_usage_periods.
 * Race conditions are prevented by the atomic WHERE-guarded UPDATE — PostgreSQL
 * serializes row-level writes, so concurrent reservations cannot both succeed if
 * the combined amount would exceed the budget.
 *
 * Fail-safe: every function catches errors and allows on DB failure.
 */

import {
  loadUsageLimit,
  getCurrentAiUsageForPeriod,
  evaluateAiUsageState,
  type AiUsageState,
} from "./guards";
import { getCurrentPeriod } from "./usage-periods.ts";
import { db } from "../../db.ts";
import { sql } from "drizzle-orm";
import { tenantAiUsagePeriods } from "../../../shared/schema.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface BudgetCheckResult {
  allowed:              boolean;
  usagePercent:         number;
  isSoftExceeded:       boolean;
  isHardExceeded:       boolean;
  usageState:           AiUsageState;
  currentCostUsd:       number;
  budgetUsd:            number | null;
  softLimitPercent:     number;
  hardLimitPercent:     number;
}

export interface BudgetReservation {
  /** Whether the budget allows this request to proceed */
  allowed:        boolean;
  /**
   * USD amount reserved against reserved_cost_usd.
   * 0 when blocked, or when no limit is configured.
   * Pass this to releaseBudgetReservation() after the call.
   */
  reservedAmount: number;
  /** true if the DB threw an error — request was allowed as fail-safe */
  failedSafe:     boolean;
}

// ── checkBudget ───────────────────────────────────────────────────────────────
// Read-based budget check. Used for pre-flight reads, summary endpoints, and UI.
// NOT atomic — for concurrent enforcement use reserveBudget() instead.

export async function checkBudget(tenantId: string): Promise<BudgetCheckResult> {
  const defaults: BudgetCheckResult = {
    allowed: true, usagePercent: 0, isSoftExceeded: false, isHardExceeded: false,
    usageState: "normal", currentCostUsd: 0, budgetUsd: null,
    softLimitPercent: 80, hardLimitPercent: 100,
  };

  if (!tenantId) return defaults;

  try {
    const limit = await loadUsageLimit(tenantId);
    if (!limit) return defaults;

    const currentCostUsd = await getCurrentAiUsageForPeriod(tenantId);
    const usageState     = evaluateAiUsageState({ currentUsageUsd: currentCostUsd, limit });

    const budgetUsd    = Number(limit.monthlyAiBudgetUsd) || null;
    const usagePercent = budgetUsd && budgetUsd > 0
      ? Math.round((currentCostUsd / budgetUsd) * 100)
      : 0;

    return {
      allowed:          usageState !== "blocked",
      usagePercent,
      isSoftExceeded:   usageState === "budget_mode",
      isHardExceeded:   usageState === "blocked",
      usageState,
      currentCostUsd,
      budgetUsd,
      softLimitPercent: limit.warningThresholdPercent ?? 80,
      hardLimitPercent: limit.hardLimitPercent ?? 100,
    };
  } catch (e) {
    console.warn("[budget-guard] checkBudget error (fail-safe allow):", (e instanceof Error ? e.message : e));
    return defaults;
  }
}

// ── reserveBudget ─────────────────────────────────────────────────────────────
//
// Atomically checks if the tenant has budget remaining and reserves `estimateUsd`
// against the current period's reserved_cost_usd column.
//
// Implementation:
//   1. Ensure a period row exists (INSERT ... ON CONFLICT DO NOTHING)
//   2. Atomic UPDATE with WHERE (total_cost_usd + reserved_cost_usd + estimate) <= budget
//      → if budget is exceeded, 0 rows are updated → block
//
// Table used: tenant_ai_usage_periods
// Race safety: PostgreSQL row-level write serialization ensures only one
//   concurrent call can increment reserved_cost_usd at a time.
//
// Fail-safe: if any DB operation fails, returns { allowed: true, failedSafe: true }
// so the system degrades gracefully rather than blocking all traffic.

export async function reserveBudget(
  tenantId: string,
  estimateUsd = 0.001,
): Promise<BudgetReservation> {
  if (!tenantId) {
    return { allowed: true, reservedAmount: 0, failedSafe: false };
  }

  try {
    const limit = await loadUsageLimit(tenantId);
    if (!limit) {
      // No limit configured — allow unconditionally, no reservation needed
      return { allowed: true, reservedAmount: 0, failedSafe: false };
    }

    const budgetUsd = Number(limit.monthlyAiBudgetUsd) || null;
    if (!budgetUsd || !limit.hardStopEnabled) {
      // No hard stop configured — allow, but don't reserve
      return { allowed: true, reservedAmount: 0, failedSafe: false };
    }

    const { periodStart, periodEnd } = getCurrentPeriod();

    // Step 1: Ensure period row exists with 0 initial values.
    // ON CONFLICT DO NOTHING skips silently if row already exists.
    await db
      .insert(tenantAiUsagePeriods)
      .values({
        tenantId,
        periodStart,
        periodEnd,
        totalCostUsd:    "0",
        totalRequests:   0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens:     0,
      })
      .onConflictDoNothing();

    // Step 2: Atomic reservation UPDATE with budget WHERE-guard.
    // Only updates the row if (total_cost_usd + reserved_cost_usd + estimate) <= budget.
    // PostgreSQL serializes the row-level write — concurrent calls cannot both succeed
    // if they would jointly exceed the budget.
    const rows = await db.execute(sql`
      UPDATE tenant_ai_usage_periods
      SET
        reserved_cost_usd = reserved_cost_usd + ${estimateUsd},
        updated_at = now()
      WHERE
        tenant_id   = ${tenantId}
        AND period_start = ${periodStart}
        AND period_end   = ${periodEnd}
        AND (total_cost_usd + reserved_cost_usd + ${estimateUsd}) <= ${budgetUsd}
      RETURNING id
    `);

    const updated = (rows as unknown as { rowCount?: number; rows?: unknown[] });
    const rowCount = updated.rowCount ?? (updated.rows?.length ?? 0);

    if (rowCount === 0) {
      // Budget would be exceeded — block
      return { allowed: false, reservedAmount: 0, failedSafe: false };
    }

    return { allowed: true, reservedAmount: estimateUsd, failedSafe: false };
  } catch (e) {
    console.warn("[budget-guard] reserveBudget error (fail-safe allow):", (e instanceof Error ? e.message : e));
    return { allowed: true, reservedAmount: 0, failedSafe: true };
  }
}

// ── releaseBudgetReservation ──────────────────────────────────────────────────
//
// Decrements reserved_cost_usd after the AI call completes (success or failure).
// Call this AFTER logAiUsage() so reserved + actual don't double-count briefly.
//
// On success: total_cost_usd is already updated by logAiUsage(). We only release the reservation.
// On error/blocked: reservedAmount was never logged → just release.
//
// Safe to call even if reservedAmount is 0 (no-op effectively, WHERE clamps to GREATEST 0).

export async function releaseBudgetReservation(
  tenantId: string,
  reservedAmount: number,
): Promise<void> {
  if (!tenantId || reservedAmount <= 0) return;

  try {
    const { periodStart, periodEnd } = getCurrentPeriod();

    await db.execute(sql`
      UPDATE tenant_ai_usage_periods
      SET
        reserved_cost_usd = GREATEST(0, reserved_cost_usd - ${reservedAmount}),
        updated_at = now()
      WHERE
        tenant_id    = ${tenantId}
        AND period_start = ${periodStart}
        AND period_end   = ${periodEnd}
    `);
  } catch (e) {
    // Non-fatal: reservation leaks are self-healing at period reset
    console.warn("[budget-guard] releaseBudgetReservation error (non-fatal):", (e instanceof Error ? e.message : e));
  }
}
