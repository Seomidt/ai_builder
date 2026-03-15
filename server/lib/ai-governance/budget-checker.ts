/**
 * Phase 16 — Budget Checker
 * Verifies tenant AI budgets before and after execution.
 *
 * INV-GOV-1: Never throws — fail open if DB is unavailable.
 * INV-GOV-2: Hard limit (>= hard_limit_percent of monthly budget) blocks execution.
 * INV-GOV-3: Soft limit (>= soft_limit_percent) warns only — execution proceeds.
 * INV-GOV-4: All budget data is strictly per-tenant.
 */

import { db } from "../../db";
import { tenantAiBudgets } from "@shared/schema";
import { eq } from "drizzle-orm";
import { sql as drizzleSql } from "drizzle-orm";

export type BudgetState = "no_budget" | "normal" | "soft_limit" | "hard_limit";

export interface BudgetCheckResult {
  allowed: boolean;
  state: BudgetState;
  usagePercent: number;
  monthlyBudgetUsd: number | null;
  currentMonthSpendUsd: number;
  dailyBudgetUsd: number | null;
  currentDaySpendUsd: number;
  reason?: string;
}

/**
 * Get current month's total AI spend for a tenant (from obs_ai_latency_metrics).
 * INV-GOV-1: Returns 0 on error.
 */
export async function getCurrentMonthSpend(tenantId: string): Promise<number> {
  try {
    const now = new Date();
    const monthStart = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const result = await db.execute<{ total: string }>(drizzleSql`
      SELECT COALESCE(SUM(cost_usd::numeric), 0)::float AS total
      FROM obs_ai_latency_metrics
      WHERE tenant_id = ${tenantId}
        AND created_at >= ${monthStart}
    `);
    return Number(result.rows[0]?.total ?? 0);
  } catch {
    return 0; // INV-GOV-1: fail open
  }
}

/**
 * Get current day's total AI spend for a tenant.
 * INV-GOV-1: Returns 0 on error.
 */
export async function getCurrentDaySpend(tenantId: string): Promise<number> {
  try {
    const now = new Date();
    const dayStart = new Date(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const result = await db.execute<{ total: string }>(drizzleSql`
      SELECT COALESCE(SUM(cost_usd::numeric), 0)::float AS total
      FROM obs_ai_latency_metrics
      WHERE tenant_id = ${tenantId}
        AND created_at >= ${dayStart}
    `);
    return Number(result.rows[0]?.total ?? 0);
  } catch {
    return 0; // INV-GOV-1: fail open
  }
}

/**
 * Get tenant budget configuration. Returns null if no budget is configured.
 */
export async function getTenantBudget(tenantId: string) {
  try {
    const rows = await db
      .select()
      .from(tenantAiBudgets)
      .where(eq(tenantAiBudgets.tenantId, tenantId))
      .limit(1);
    return rows[0] ?? null;
  } catch {
    return null; // INV-GOV-1: fail open
  }
}

/**
 * Upsert tenant budget configuration.
 */
export async function upsertTenantBudget(params: {
  tenantId: string;
  monthlyBudgetUsd?: number | null;
  dailyBudgetUsd?: number | null;
  softLimitPercent?: number;
  hardLimitPercent?: number;
}) {
  const existing = await getTenantBudget(params.tenantId);
  if (existing) {
    const [updated] = await db
      .update(tenantAiBudgets)
      .set({
        monthlyBudgetUsd: params.monthlyBudgetUsd != null ? String(params.monthlyBudgetUsd) : existing.monthlyBudgetUsd,
        dailyBudgetUsd: params.dailyBudgetUsd != null ? String(params.dailyBudgetUsd) : existing.dailyBudgetUsd,
        softLimitPercent: params.softLimitPercent != null ? String(params.softLimitPercent) : existing.softLimitPercent,
        hardLimitPercent: params.hardLimitPercent != null ? String(params.hardLimitPercent) : existing.hardLimitPercent,
        updatedAt: new Date(),
      })
      .where(eq(tenantAiBudgets.tenantId, params.tenantId))
      .returning();
    return updated;
  } else {
    const [created] = await db
      .insert(tenantAiBudgets)
      .values({
        tenantId: params.tenantId,
        monthlyBudgetUsd: params.monthlyBudgetUsd != null ? String(params.monthlyBudgetUsd) : null,
        dailyBudgetUsd: params.dailyBudgetUsd != null ? String(params.dailyBudgetUsd) : null,
        softLimitPercent: params.softLimitPercent != null ? String(params.softLimitPercent) : "80",
        hardLimitPercent: params.hardLimitPercent != null ? String(params.hardLimitPercent) : "100",
      })
      .returning();
    return created;
  }
}

/**
 * Check if a tenant can proceed with an AI call.
 * INV-GOV-1: Never throws — returns allowed=true on error (fail open).
 * INV-GOV-2: Blocks if monthly spend >= hard_limit_percent of monthly_budget_usd.
 * INV-GOV-3: Returns soft_limit state if >= soft_limit_percent (allows execution).
 */
export async function checkBudgetBeforeCall(
  tenantId: string,
  _estimatedCostUsd = 0,
): Promise<BudgetCheckResult> {
  try {
    const budget = await getTenantBudget(tenantId);

    if (!budget) {
      return {
        allowed: true,
        state: "no_budget",
        usagePercent: 0,
        monthlyBudgetUsd: null,
        currentMonthSpendUsd: 0,
        dailyBudgetUsd: null,
        currentDaySpendUsd: 0,
      };
    }

    const [monthSpend, daySpend] = await Promise.all([
      getCurrentMonthSpend(tenantId),
      getCurrentDaySpend(tenantId),
    ]);

    const monthlyBudget = budget.monthlyBudgetUsd != null ? Number(budget.monthlyBudgetUsd) : null;
    const dailyBudget = budget.dailyBudgetUsd != null ? Number(budget.dailyBudgetUsd) : null;
    const softPct = Number(budget.softLimitPercent ?? 80);
    const hardPct = Number(budget.hardLimitPercent ?? 100);

    // Check daily limit first
    if (dailyBudget != null && dailyBudget > 0) {
      const dayPct = (daySpend / dailyBudget) * 100;
      if (dayPct >= hardPct) {
        return {
          allowed: false,
          state: "hard_limit",
          usagePercent: dayPct,
          monthlyBudgetUsd: monthlyBudget,
          currentMonthSpendUsd: monthSpend,
          dailyBudgetUsd: dailyBudget,
          currentDaySpendUsd: daySpend,
          reason: `Daily hard limit reached: ${dayPct.toFixed(1)}% of daily budget used`,
        };
      }
    }

    // Check monthly limit
    if (monthlyBudget != null && monthlyBudget > 0) {
      const pct = (monthSpend / monthlyBudget) * 100;
      if (pct >= hardPct) {
        return {
          allowed: false,
          state: "hard_limit",
          usagePercent: pct,
          monthlyBudgetUsd: monthlyBudget,
          currentMonthSpendUsd: monthSpend,
          dailyBudgetUsd: dailyBudget,
          currentDaySpendUsd: daySpend,
          reason: `Monthly hard limit reached: ${pct.toFixed(1)}% of monthly budget used`,
        };
      }
      if (pct >= softPct) {
        return {
          allowed: true,
          state: "soft_limit",
          usagePercent: pct,
          monthlyBudgetUsd: monthlyBudget,
          currentMonthSpendUsd: monthSpend,
          dailyBudgetUsd: dailyBudget,
          currentDaySpendUsd: daySpend,
          reason: `Soft limit warning: ${pct.toFixed(1)}% of monthly budget used`,
        };
      }
      return {
        allowed: true,
        state: "normal",
        usagePercent: pct,
        monthlyBudgetUsd: monthlyBudget,
        currentMonthSpendUsd: monthSpend,
        dailyBudgetUsd: dailyBudget,
        currentDaySpendUsd: daySpend,
      };
    }

    return {
      allowed: true,
      state: "normal",
      usagePercent: 0,
      monthlyBudgetUsd: monthlyBudget,
      currentMonthSpendUsd: monthSpend,
      dailyBudgetUsd: dailyBudget,
      currentDaySpendUsd: daySpend,
    };
  } catch {
    // INV-GOV-1: Fail open — never block execution due to governance errors
    return {
      allowed: true,
      state: "no_budget",
      usagePercent: 0,
      monthlyBudgetUsd: null,
      currentMonthSpendUsd: 0,
      dailyBudgetUsd: null,
      currentDaySpendUsd: 0,
    };
  }
}

/**
 * List all tenant budgets (admin view).
 */
export async function listAllTenantBudgets() {
  try {
    return await db.select().from(tenantAiBudgets).orderBy(tenantAiBudgets.updatedAt);
  } catch {
    return [];
  }
}
