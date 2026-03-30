/**
 * Phase 16 — AI Cost Governance: Budget Checker
 *
 * Evaluates current AI spend against tenant budgets.
 * Returns a structured BudgetStatus without side-effects.
 * Callers (alert-generator, admin routes) decide what to do with the result.
 */

import { db } from "../../db.ts";
import { sql } from "drizzle-orm";

// ─── Types ────────────────────────────────────────────────────────────────────

export type BudgetStatus = "under_budget" | "warning" | "exceeded" | "no_budget";

export interface BudgetCheckResult {
  organizationId:       string;
  periodType:           string;
  status:               BudgetStatus;
  budgetUsdCents:       bigint;
  currentUsageUsdCents: bigint;
  utilizationPct:       number;
  warningThresholdPct:  number;
  hardLimitPct:         number;
  periodStart:          Date;
  periodEnd:            Date;
  checkedAt:            Date;
}

export interface BudgetCheckError {
  organizationId: string;
  error:          string;
}

// ─── Period helpers ───────────────────────────────────────────────────────────

export type PeriodType = "daily" | "weekly" | "monthly" | "annual";

export function currentPeriodBounds(periodType: PeriodType): { start: Date; end: Date } {
  const now = new Date();
  let start: Date;
  let end: Date;

  switch (periodType) {
    case "daily": {
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      end   = new Date(start.getTime() + 86_400_000);
      break;
    }
    case "weekly": {
      const dow = now.getUTCDay();
      const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - ((dow + 6) % 7)));
      start = monday;
      end   = new Date(monday.getTime() + 7 * 86_400_000);
      break;
    }
    case "monthly": {
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      end   = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      break;
    }
    case "annual": {
      start = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
      end   = new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1));
      break;
    }
  }

  return { start, end };
}

// ─── Core check ───────────────────────────────────────────────────────────────

/**
 * Check AI budget status for a single tenant.
 * Returns null if no active budget exists.
 */
export async function checkTenantBudget(
  organizationId: string,
  periodType: PeriodType = "monthly",
): Promise<BudgetCheckResult | null> {
  if (!organizationId?.trim()) return null;

  const budgetRows = await db.execute(sql`
    SELECT budget_usd_cents, warning_threshold_pct, hard_limit_pct
    FROM   tenant_ai_budgets
    WHERE  organization_id = ${organizationId}
      AND  period_type      = ${periodType}
      AND  is_active        = true
    LIMIT  1
  `);

  if (budgetRows.rows.length === 0) return null;

  const budget = budgetRows.rows[0] as {
    budget_usd_cents:      string | bigint;
    warning_threshold_pct: number;
    hard_limit_pct:        number;
  };

  const budgetUsdCents      = BigInt(budget.budget_usd_cents);
  const warningThresholdPct = Number(budget.warning_threshold_pct);
  const hardLimitPct        = Number(budget.hard_limit_pct);
  const { start, end }      = currentPeriodBounds(periodType);

  // Sum AI usage from usage snapshots for this period
  const usageRows = await db.execute(sql`
    SELECT COALESCE(SUM(total_cost_usd_cents), 0) AS total_cost
    FROM   tenant_ai_usage_snapshots
    WHERE  organization_id = ${organizationId}
      AND  period_type     = ${periodType}
      AND  period_start   >= ${start.toISOString()}
      AND  period_end     <= ${end.toISOString()}
  `);

  const usageRow           = usageRows.rows[0] as { total_cost: string | number | bigint };
  const currentUsageUsdCents = BigInt(usageRow.total_cost ?? 0);

  const utilizationPct = budgetUsdCents > 0n
    ? Number((currentUsageUsdCents * 10000n) / budgetUsdCents) / 100
    : 0;

  let status: BudgetStatus;
  if (utilizationPct >= hardLimitPct) {
    status = "exceeded";
  } else if (utilizationPct >= warningThresholdPct) {
    status = "warning";
  } else {
    status = "under_budget";
  }

  return {
    organizationId,
    periodType,
    status,
    budgetUsdCents,
    currentUsageUsdCents,
    utilizationPct,
    warningThresholdPct,
    hardLimitPct,
    periodStart:  start,
    periodEnd:    end,
    checkedAt:    new Date(),
  };
}

/**
 * Check budgets for all tenants with active monthly budgets.
 */
export async function checkAllTenantBudgets(
  periodType: PeriodType = "monthly",
): Promise<{ results: BudgetCheckResult[]; errors: BudgetCheckError[] }> {
  const orgRows = await db.execute(sql`
    SELECT DISTINCT organization_id
    FROM   tenant_ai_budgets
    WHERE  period_type = ${periodType}
      AND  is_active   = true
    ORDER  BY organization_id
  `);

  const results: BudgetCheckResult[] = [];
  const errors:  BudgetCheckError[]  = [];

  for (const row of orgRows.rows) {
    const orgId = (row as { organization_id: string }).organization_id;
    try {
      const result = await checkTenantBudget(orgId, periodType);
      if (result) results.push(result);
    } catch (err) {
      errors.push({
        organizationId: orgId,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return { results, errors };
}

/**
 * Pure utility: determine budget status from raw numbers (no DB).
 * Used in tests and the alert-generator.
 */
export function classifyBudgetStatus(
  currentUsageUsdCents: bigint,
  budgetUsdCents:       bigint,
  warningThresholdPct:  number,
  hardLimitPct:         number,
): { status: BudgetStatus; utilizationPct: number } {
  if (budgetUsdCents <= 0n) return { status: "no_budget", utilizationPct: 0 };

  const utilizationPct =
    Number((currentUsageUsdCents * 10000n) / budgetUsdCents) / 100;

  let status: BudgetStatus;
  if (utilizationPct >= hardLimitPct) {
    status = "exceeded";
  } else if (utilizationPct >= warningThresholdPct) {
    status = "warning";
  } else {
    status = "under_budget";
  }

  return { status, utilizationPct };
}
