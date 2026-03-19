/**
 * Phase 18 — Rollout Observability
 * Privacy-safe metrics aggregation for feature flags and experiments.
 *
 * INV-FLAG11: Observability output must remain privacy-safe.
 * INV-FLAG7: Resolution events must be explainable.
 */

import { db } from "../../db";
import { sql as drizzleSql } from "drizzle-orm";

export interface RolloutMetrics {
  flagKey: string;
  totalResolutions: number;
  bySource: Record<string, number>;
  enabledCount: number;
  disabledCount: number;
  variantCounts: Record<string, number>;
}

export interface RolloutSummary {
  totalFlags: number;
  activeExperiments: number;
  pausedExperiments: number;
  completedExperiments: number;
  totalResolutionEvents: number;
  sourceDistribution: Record<string, number>;
}

export async function getRolloutMetrics(options?: {
  flagKey?: string;
  tenantId?: string;
  since?: Date;
  limit?: number;
}): Promise<RolloutMetrics[]> {
  const sinceClause = options?.since
    ? drizzleSql`AND created_at >= ${options.since.toISOString()}`
    : drizzleSql``;
  const tenantClause = options?.tenantId
    ? drizzleSql`AND tenant_id = ${options.tenantId}`
    : drizzleSql``;
  const flagClause = options?.flagKey
    ? drizzleSql`AND flag_key = ${options.flagKey}`
    : drizzleSql``;
  const limit = Math.min(options?.limit ?? 50, 200);

  const rows = await db.execute(drizzleSql`
    SELECT
      flag_key,
      COUNT(*) AS total,
      resolution_source,
      SUM(CASE WHEN enabled = true THEN 1 ELSE 0 END) AS enabled_cnt,
      SUM(CASE WHEN enabled = false THEN 1 ELSE 0 END) AS disabled_cnt,
      resolved_variant
    FROM feature_resolution_events
    WHERE 1=1 ${flagClause} ${tenantClause} ${sinceClause}
    GROUP BY flag_key, resolution_source, resolved_variant
    ORDER BY flag_key, total DESC
    LIMIT ${limit}
  `);

  const metricsMap = new Map<string, RolloutMetrics>();
  for (const r of rows.rows as Record<string, unknown>[]) {
    const key = r.flag_key as string;
    if (!metricsMap.has(key)) {
      metricsMap.set(key, {
        flagKey: key,
        totalResolutions: 0,
        bySource: {},
        enabledCount: 0,
        disabledCount: 0,
        variantCounts: {},
      });
    }
    const m = metricsMap.get(key)!;
    const cnt = Number(r.total ?? 0);
    m.totalResolutions += cnt;
    const src = r.resolution_source as string;
    m.bySource[src] = (m.bySource[src] ?? 0) + cnt;
    m.enabledCount += Number(r.enabled_cnt ?? 0);
    m.disabledCount += Number(r.disabled_cnt ?? 0);
    const variant = r.resolved_variant as string | null;
    if (variant) {
      m.variantCounts[variant] = (m.variantCounts[variant] ?? 0) + cnt;
    }
  }
  return Array.from(metricsMap.values());
}

export async function summarizeRolloutMetrics(options?: {
  tenantId?: string;
}): Promise<RolloutSummary> {
  const tenantClause = options?.tenantId
    ? drizzleSql`AND tenant_id = ${options.tenantId}`
    : drizzleSql``;

  const [flagCountRows, expRows, evtRows, srcRows] = await Promise.all([
    db.execute(drizzleSql`SELECT COUNT(*) AS cnt FROM feature_flags WHERE lifecycle_status = 'active'`),
    db.execute(drizzleSql`
      SELECT lifecycle_status, COUNT(*) AS cnt
      FROM experiments GROUP BY lifecycle_status
    `),
    db.execute(drizzleSql`
      SELECT COUNT(*) AS cnt FROM feature_resolution_events WHERE 1=1 ${tenantClause}
    `),
    db.execute(drizzleSql`
      SELECT resolution_source, COUNT(*) AS cnt
      FROM feature_resolution_events WHERE 1=1 ${tenantClause}
      GROUP BY resolution_source
    `),
  ]);

  const expMap: Record<string, number> = {};
  for (const r of expRows.rows as Record<string, unknown>[]) {
    expMap[r.lifecycle_status as string] = Number(r.cnt ?? 0);
  }

  const sourceDistribution: Record<string, number> = {};
  for (const r of srcRows.rows as Record<string, unknown>[]) {
    sourceDistribution[r.resolution_source as string] = Number(r.cnt ?? 0);
  }

  return {
    totalFlags: Number((flagCountRows.rows[0] as Record<string, unknown>)?.cnt ?? 0),
    activeExperiments: expMap["active"] ?? 0,
    pausedExperiments: expMap["paused"] ?? 0,
    completedExperiments: expMap["completed"] ?? 0,
    totalResolutionEvents: Number((evtRows.rows[0] as Record<string, unknown>)?.cnt ?? 0),
    sourceDistribution,
  };
}

export async function listRecentResolutions(options?: {
  tenantId?: string;
  flagKey?: string;
  limit?: number;
}): Promise<Array<{
  id: string;
  flagKey: string;
  resolutionSource: string;
  enabled: boolean | null;
  resolvedVariant: string | null;
  tenantId: string | null;
  createdAt: Date;
}>> {
  const limit = Math.min(options?.limit ?? 50, 500);
  const tenantClause = options?.tenantId
    ? drizzleSql`AND tenant_id = ${options.tenantId}`
    : drizzleSql``;
  const flagClause = options?.flagKey
    ? drizzleSql`AND flag_key = ${options.flagKey}`
    : drizzleSql``;

  const rows = await db.execute(drizzleSql`
    SELECT id, flag_key, resolution_source, enabled, resolved_variant, tenant_id, created_at
    FROM feature_resolution_events
    WHERE 1=1 ${tenantClause} ${flagClause}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `);

  return rows.rows.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    flagKey: r.flag_key as string,
    resolutionSource: r.resolution_source as string,
    enabled: r.enabled !== null ? Boolean(r.enabled) : null,
    resolvedVariant: (r.resolved_variant as string) ?? null,
    tenantId: (r.tenant_id as string) ?? null,
    createdAt: new Date(r.created_at as string),
  }));
}
