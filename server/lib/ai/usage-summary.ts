/**
 * AI Usage Summary
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Returns a normalized usage summary for a tenant, suitable for future
 * customer/admin UI consumption.
 *
 * Design rules:
 *   - Customer-facing usage is expressed as percentage + state, not raw dollars
 *   - Raw USD values are included for admin/internal use only
 *   - If no limit is configured, percentage and state are null/"normal"
 *   - Never throws — returns a safe summary even on partial DB failures
 *
 * Phase 3G
 */

import {
  loadUsageLimit,
  getCurrentAiUsageForPeriod,
  evaluateAiUsageState,
  type AiUsageState,
} from "./guards";

// ── Summary contract ──────────────────────────────────────────────────────────

/**
 * Normalized AI usage summary for a tenant.
 *
 * Customer-facing UI should display aiUsagePercent + aiUsageState.
 * Admin/internal tooling may also use aiUsageUsd + aiBudgetUsd.
 */
export interface AiUsageSummary {
  tenantId: string;
  /** Current period AI usage in USD (admin/internal) */
  aiUsageUsd: number;
  /** Configured monthly budget in USD — null if no limit configured (admin/internal) */
  aiBudgetUsd: number | null;
  /** Percent of budget used — null if no budget configured (customer-facing) */
  aiUsagePercent: number | null;
  /** Current guardrail state (customer-facing) */
  aiUsageState: AiUsageState;
  /** Percent at which budget_mode is entered — null if no limit configured */
  warningThresholdPercent: number | null;
  /** Percent at which AI access is blocked — null if no limit configured */
  hardLimitPercent: number | null;
}

// ── Summary builder ───────────────────────────────────────────────────────────

/**
 * Build the AI usage summary for a tenant.
 *
 * Queries usage limit and current period usage in parallel for speed.
 * Safe fallback: returns "normal" state with null budget values if no
 * limit row exists or if DB queries fail.
 *
 * Never throws.
 */
export async function getAiUsageSummary(tenantId: string): Promise<AiUsageSummary> {
  const [limit, currentUsageUsd] = await Promise.all([
    loadUsageLimit(tenantId),
    getCurrentAiUsageForPeriod(tenantId),
  ]);

  if (!limit) {
    return {
      tenantId,
      aiUsageUsd: currentUsageUsd,
      aiBudgetUsd: null,
      aiUsagePercent: null,
      aiUsageState: "normal",
      warningThresholdPercent: null,
      hardLimitPercent: null,
    };
  }

  const budgetUsd = Number(limit.monthlyAiBudgetUsd);
  const state = evaluateAiUsageState({ currentUsageUsd, limit });

  const rawPercent = budgetUsd > 0 ? (currentUsageUsd / budgetUsd) * 100 : null;
  const aiUsagePercent =
    rawPercent != null ? Math.round(rawPercent * 100) / 100 : null;

  return {
    tenantId,
    aiUsageUsd: currentUsageUsd,
    aiBudgetUsd: budgetUsd,
    aiUsagePercent,
    aiUsageState: state,
    warningThresholdPercent: limit.warningThresholdPercent,
    hardLimitPercent: limit.hardLimitPercent,
  };
}
