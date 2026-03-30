/**
 * Phase 20 — Usage Tracker
 * Records and increments tenant usage counters for quota tracking.
 * Integrates with AI cost governance (Phase 16) and background jobs (Phase 19).
 */

import { db } from "../../db.ts";
import { usageCounters } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";

export type ResetPeriod = "daily" | "monthly" | "yearly" | "never";

/**
 * Compute the current period boundaries for a given reset period.
 */
export function computePeriod(
  resetPeriod: ResetPeriod,
  from: Date = new Date(),
): { periodStart: Date; periodEnd: Date } {
  const d = new Date(from);
  switch (resetPeriod) {
    case "daily": {
      const start = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
      const end = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
      return { periodStart: start, periodEnd: end };
    }
    case "monthly": {
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999);
      return { periodStart: start, periodEnd: end };
    }
    case "yearly": {
      const start = new Date(d.getFullYear(), 0, 1);
      const end = new Date(d.getFullYear(), 11, 31, 23, 59, 59, 999);
      return { periodStart: start, periodEnd: end };
    }
    case "never":
    default: {
      const start = new Date(0);
      const end = new Date("2099-12-31T23:59:59.999Z");
      return { periodStart: start, periodEnd: end };
    }
  }
}

/**
 * Increment a tenant's usage counter for a given quota key.
 * Creates or updates the counter for the current period.
 */
export async function incrementUsage(
  tenantId: string,
  quotaKey: string,
  amount: number = 1,
  resetPeriod: ResetPeriod = "monthly",
): Promise<{ used: number; quotaKey: string }> {
  const { periodStart, periodEnd } = computePeriod(resetPeriod);

  // Check if counter exists for this period
  const existing = await db.execute(drizzleSql`
    SELECT id, usage_value FROM usage_counters
    WHERE tenant_id = ${tenantId}
      AND quota_key = ${quotaKey}
      AND period_start = ${periodStart.toISOString()}
      AND period_end = ${periodEnd.toISOString()}
    LIMIT 1
  `);

  if (existing.rows.length > 0) {
    const row = existing.rows[0] as Record<string, unknown>;
    const newValue = Number(row.usage_value) + amount;
    await db.execute(drizzleSql`
      UPDATE usage_counters
      SET usage_value = ${newValue}, updated_at = NOW()
      WHERE id = ${row.id as string}
    `);
    return { used: newValue, quotaKey };
  } else {
    const rows = await db
      .insert(usageCounters)
      .values({
        tenantId,
        quotaKey,
        usageValue: amount,
        periodStart,
        periodEnd,
      })
      .returning({ usageValue: usageCounters.usageValue });
    return { used: rows[0].usageValue, quotaKey };
  }
}

/**
 * Get the current usage value for a tenant + quota key in the active period.
 */
export async function getCurrentUsage(
  tenantId: string,
  quotaKey: string,
): Promise<number> {
  const rows = await db.execute(drizzleSql`
    SELECT COALESCE(SUM(usage_value), 0) AS used
    FROM usage_counters
    WHERE tenant_id = ${tenantId}
      AND quota_key = ${quotaKey}
      AND period_start <= NOW()
      AND period_end >= NOW()
  `);
  return Number((rows.rows[0] as Record<string, unknown>)?.used ?? 0);
}

/**
 * Reset a tenant's usage counter for a quota key (e.g., at period rollover).
 */
export async function resetUsageCounter(
  tenantId: string,
  quotaKey: string,
): Promise<{ reset: boolean }> {
  await db.execute(drizzleSql`
    UPDATE usage_counters SET usage_value = 0, updated_at = NOW()
    WHERE tenant_id = ${tenantId} AND quota_key = ${quotaKey}
      AND period_start <= NOW() AND period_end >= NOW()
  `);
  return { reset: true };
}

/**
 * Get full usage history for a tenant.
 */
export async function getUsageHistory(
  tenantId: string,
  filter?: { quotaKey?: string; limit?: number },
): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(filter?.limit ?? 50, 200);
  const keyClause = filter?.quotaKey ? drizzleSql`AND quota_key = ${filter.quotaKey}` : drizzleSql``;
  const rows = await db.execute(drizzleSql`
    SELECT id, tenant_id, quota_key, usage_value, period_start, period_end, updated_at
    FROM usage_counters
    WHERE tenant_id = ${tenantId} ${keyClause}
    ORDER BY period_start DESC
    LIMIT ${limit}
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * Aggregate usage across all tenants for a quota key (admin-level view).
 * Privacy-safe: returns counts, not individual tenant data.
 */
export async function aggregateUsageByQuota(quotaKey: string): Promise<{
  quotaKey: string;
  totalTenants: number;
  totalUsage: number;
  avgUsage: number;
  maxUsage: number;
}> {
  const rows = await db.execute(drizzleSql`
    SELECT
      COUNT(DISTINCT tenant_id) AS tenant_count,
      SUM(usage_value) AS total,
      AVG(usage_value) AS avg,
      MAX(usage_value) AS max
    FROM usage_counters
    WHERE quota_key = ${quotaKey}
      AND period_start <= NOW() AND period_end >= NOW()
  `);
  const r = rows.rows[0] as Record<string, unknown>;
  return {
    quotaKey,
    totalTenants: Number(r?.tenant_count ?? 0),
    totalUsage: Number(r?.total ?? 0),
    avgUsage: Math.round(Number(r?.avg ?? 0)),
    maxUsage: Number(r?.max ?? 0),
  };
}
