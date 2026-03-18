/**
 * Phase 35 — Tenant Health Analytics
 *
 * Reads tenant list, usage pressure, anomaly events, webhook failures, job failures.
 * Risk score derived from multiple signals.
 *
 * All functions are read-only and fail-open.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface TenantHealthRow {
  tenantId: string;
  name: string;
  status: string;
  anomalyCount: number;
  failedWebhooks: number;
  failedJobs: number;
  alertCount: number;
  riskScore: number;
  riskLevel: RiskLevel;
}

export interface TenantHealthSummary {
  totalTenants: number;
  activeTenants: number;
  suspendedTenants: number;
  highRiskCount: number;
  criticalRiskCount: number;
  topRiskTenants: TenantHealthRow[];
  retrievedAt: string;
  windowHours: number;
}

export interface TenantHealthTrend {
  points: { bucket: string; newAnomalies: number; newAlerts: number; failedWebhooks: number }[];
  windowHours: number;
}

function riskLevel(score: number): RiskLevel {
  if (score >= 80) return "critical";
  if (score >= 50) return "high";
  if (score >= 20) return "medium";
  return "low";
}

function riskScore(anomalies: number, failedWebhooks: number, failedJobs: number, alerts: number): number {
  return Math.min(100,
    anomalies * 15 +
    failedWebhooks * 5 +
    failedJobs * 8 +
    alerts * 10,
  );
}

export async function getTenantHealthSummary(
  windowHours = 24,
  limit = 50,
): Promise<TenantHealthSummary> {
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

  const [tenantRow, anomalyRows, alertRows, webhookRows, jobRows] = await Promise.all([
    db.execute<any>(sql`
      SELECT
        COUNT(*)::int                                             AS total,
        COUNT(*) FILTER (WHERE lifecycle_status = 'active')::int AS active,
        COUNT(*) FILTER (WHERE lifecycle_status = 'suspended')::int AS suspended
      FROM tenants
    `),
    db.execute<any>(sql`
      SELECT tenant_id, COUNT(*)::int AS cnt
      FROM gov_anomaly_events
      WHERE created_at >= ${since}::timestamptz
      GROUP BY tenant_id
    `),
    db.execute<any>(sql`
      SELECT tenant_id, COUNT(*)::int AS cnt
      FROM ai_usage_alerts
      WHERE triggered_at >= ${since}::timestamptz
      GROUP BY tenant_id
    `),
    db.execute<any>(sql`
      SELECT tenant_id, COUNT(*) FILTER (WHERE status='failed')::int AS cnt
      FROM webhook_deliveries
      WHERE created_at >= ${since}::timestamptz
      GROUP BY tenant_id
    `),
    db.execute<any>(sql`
      SELECT tenant_id, COUNT(*) FILTER (WHERE status='failed')::int AS cnt
      FROM jobs
      WHERE created_at >= ${since}::timestamptz AND tenant_id IS NOT NULL
      GROUP BY tenant_id
    `),
  ]);

  const anomalyMap = new Map((anomalyRows.rows as any[]).map(r => [r.tenant_id, Number(r.cnt)]));
  const alertMap   = new Map((alertRows.rows   as any[]).map(r => [r.tenant_id, Number(r.cnt)]));
  const whMap      = new Map((webhookRows.rows  as any[]).map(r => [r.tenant_id, Number(r.cnt)]));
  const jobMap     = new Map((jobRows.rows      as any[]).map(r => [r.tenant_id, Number(r.cnt)]));

  const tenantIds = Array.from(new Set([
    ...Array.from(anomalyMap.keys()),
    ...Array.from(alertMap.keys()),
    ...Array.from(whMap.keys()),
    ...Array.from(jobMap.keys()),
  ]));

  const rows: TenantHealthRow[] = tenantIds.map(id => {
    const anomalies = anomalyMap.get(id) ?? 0;
    const failedWebhooks = whMap.get(id) ?? 0;
    const failedJobs = jobMap.get(id) ?? 0;
    const alerts = alertMap.get(id) ?? 0;
    const score = riskScore(anomalies, failedWebhooks, failedJobs, alerts);
    return {
      tenantId: id,
      name: id,
      status: "active",
      anomalyCount: anomalies,
      failedWebhooks,
      failedJobs,
      alertCount: alerts,
      riskScore: score,
      riskLevel: riskLevel(score),
    };
  }).sort((a, b) => b.riskScore - a.riskScore).slice(0, limit);

  const t = tenantRow.rows[0] ?? {};
  const highRisk     = rows.filter(r => r.riskLevel === "high" || r.riskLevel === "critical").length;
  const criticalRisk = rows.filter(r => r.riskLevel === "critical").length;

  return {
    totalTenants: Number(t.total ?? 0),
    activeTenants: Number(t.active ?? 0),
    suspendedTenants: Number(t.suspended ?? 0),
    highRiskCount: highRisk,
    criticalRiskCount: criticalRisk,
    topRiskTenants: rows,
    retrievedAt: new Date().toISOString(),
    windowHours,
  };
}

export async function getTenantHealthTrend(
  windowHours = 24,
): Promise<TenantHealthTrend> {
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

  const [anomalyTrend, alertTrend, webhookTrend] = await Promise.all([
    db.execute<any>(sql`
      SELECT TO_CHAR(DATE_TRUNC('hour', created_at), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
             COUNT(*)::int AS cnt
      FROM gov_anomaly_events
      WHERE created_at >= ${since}::timestamptz
      GROUP BY 1 ORDER BY 1
    `),
    db.execute<any>(sql`
      SELECT TO_CHAR(DATE_TRUNC('hour', triggered_at), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
             COUNT(*)::int AS cnt
      FROM ai_usage_alerts
      WHERE triggered_at >= ${since}::timestamptz
      GROUP BY 1 ORDER BY 1
    `),
    db.execute<any>(sql`
      SELECT TO_CHAR(DATE_TRUNC('hour', created_at), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
             COUNT(*) FILTER (WHERE status = 'failed')::int AS cnt
      FROM webhook_deliveries
      WHERE created_at >= ${since}::timestamptz
      GROUP BY 1 ORDER BY 1
    `),
  ]);

  const aMap = new Map((anomalyTrend.rows as any[]).map(r => [r.bucket, Number(r.cnt)]));
  const lMap = new Map((alertTrend.rows   as any[]).map(r => [r.bucket, Number(r.cnt)]));
  const wMap = new Map((webhookTrend.rows as any[]).map(r => [r.bucket, Number(r.cnt)]));

  const buckets = Array.from(new Set([
    ...Array.from(aMap.keys()),
    ...Array.from(lMap.keys()),
    ...Array.from(wMap.keys()),
  ])).sort();

  return {
    points: buckets.map(b => ({
      bucket: b,
      newAnomalies:   aMap.get(b) ?? 0,
      newAlerts:      lMap.get(b) ?? 0,
      failedWebhooks: wMap.get(b) ?? 0,
    })),
    windowHours,
  };
}

export function explainTenantHealth(summary: TenantHealthSummary): {
  summary: string; issues: string[]; recommendations: string[];
} {
  const issues: string[] = [];
  const recs: string[]   = [];

  if (summary.criticalRiskCount > 0)
    issues.push(`${summary.criticalRiskCount} tenant(s) at critical risk`);
  if (summary.highRiskCount > 0)
    issues.push(`${summary.highRiskCount} tenant(s) at high risk`);
  if (summary.suspendedTenants > 0)
    issues.push(`${summary.suspendedTenants} tenant(s) currently suspended`);

  if (summary.criticalRiskCount > 0) recs.push("Review critical tenants immediately");
  if (summary.highRiskCount > 0) recs.push("Check high-risk tenants for anomaly spikes");
  if (issues.length === 0) recs.push("Tenant population is healthy");

  return {
    summary: issues.length === 0
      ? "All tenants operating normally"
      : `Tenant health has ${issues.length} concern(s)`,
    issues,
    recommendations: recs,
  };
}
