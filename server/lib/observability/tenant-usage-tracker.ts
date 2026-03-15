/**
 * Phase 15 — Tenant Usage Tracker
 * Aggregates per-tenant usage metrics (AI requests, tokens, agents, retrievals).
 * INV-OBS-2: No cross-tenant data exposure.
 * INV-OBS-5: Tenant isolation enforced.
 */

import { db } from "../../db";
import { obsTenantUsageMetrics } from "@shared/schema";
import { eq, and } from "drizzle-orm";

export type TenantMetricType =
  | "ai_requests"
  | "tokens_in"
  | "tokens_out"
  | "agents_executed"
  | "retrieval_queries"
  | "cost_usd";

/**
 * Increment a tenant usage metric for the current period.
 * Fire-and-forget: never throws.
 */
export async function incrementTenantUsage(params: {
  tenantId: string;
  metricType: TenantMetricType;
  value: number;
  period?: string;
}): Promise<void> {
  try {
    const period = params.period ?? getCurrentPeriod();
    await db.insert(obsTenantUsageMetrics).values({
      tenantId: params.tenantId,
      metricType: params.metricType,
      value: String(params.value),
      period,
    });
  } catch {
    // INV-OBS-1: Silently swallow
  }
}

/**
 * Get current usage period label (YYYY-MM).
 */
export function getCurrentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Aggregate tenant usage for a given period (summed across all inserts).
 * INV-OBS-5: Returns only data for the given tenant.
 */
export async function getTenantUsageSummary(params: {
  tenantId: string;
  period?: string;
}): Promise<Record<TenantMetricType, number> & { period: string; tenantId: string }> {
  const period = params.period ?? getCurrentPeriod();
  const { sql: drizzleSql } = await import("drizzle-orm");

  const qr = await db.execute<{ metric_type: string; total: string }>(drizzleSql`
    SELECT metric_type, SUM(value::numeric)::float AS total
    FROM obs_tenant_usage_metrics
    WHERE tenant_id = ${params.tenantId} AND period = ${period}
    GROUP BY metric_type
  `);

  const result: Record<string, number> = {};
  for (const row of qr.rows) {
    result[row.metric_type] = Number(row.total ?? 0);
  }

  return {
    tenantId: params.tenantId,
    period,
    ai_requests: result["ai_requests"] ?? 0,
    tokens_in: result["tokens_in"] ?? 0,
    tokens_out: result["tokens_out"] ?? 0,
    agents_executed: result["agents_executed"] ?? 0,
    retrieval_queries: result["retrieval_queries"] ?? 0,
    cost_usd: result["cost_usd"] ?? 0,
  };
}

/**
 * List all tenants with usage in a given period.
 * INV-OBS-2: Returns only aggregated counts — no raw data.
 */
export async function listActiveTenantsForPeriod(period?: string): Promise<{
  tenantIds: string[];
  count: number;
  period: string;
}> {
  const p = period ?? getCurrentPeriod();
  const { sql: drizzleSql } = await import("drizzle-orm");

  const qr = await db.execute<{ tenant_id: string }>(drizzleSql`
    SELECT DISTINCT tenant_id FROM obs_tenant_usage_metrics WHERE period = ${p}
  `);

  const tenantIds = qr.rows.map((r) => r.tenant_id);
  return { tenantIds, count: tenantIds.length, period: p };
}
