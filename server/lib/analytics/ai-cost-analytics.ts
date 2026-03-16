/**
 * Phase 35 — AI & Cost Analytics
 *
 * Aggregates AI usage, cost, anomalies, alerts and budget pressure.
 * Sources: ai_usage, tenant_ai_usage_snapshots, ai_usage_alerts,
 *          gov_anomaly_events, tenant_ai_budgets, obs_ai_latency_metrics
 *
 * All functions are read-only and fail-open.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

export interface AiCostSummary {
  totalRequests: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  avgCostPerRequest: number;
  alertCount: number;
  anomalyCount: number;
  topSpendersByTenant: { tenantId: string; costUsd: number; requests: number }[];
  topSpendersByModel: { model: string; requests: number; totalTokens: number; costUsd: number }[];
  budgetPressure: { tenantId: string; usagePercent: number; alertType: string }[];
  retrievedAt: string;
  windowHours: number;
}

export interface AiCostTrend {
  points: {
    bucket: string;
    requests: number;
    tokensTotal: number;
    costUsd: number;
    anomalies: number;
  }[];
  windowHours: number;
}

export async function getAiCostSummary(windowHours = 24): Promise<AiCostSummary> {
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

  const [usageRow, tenantSpend, modelSpend, alertRows, anomalyRow] = await Promise.all([
    db.execute<any>(sql`
      SELECT
        COUNT(*)::int                           AS total_requests,
        COALESCE(SUM(prompt_tokens),0)::bigint  AS tokens_in,
        COALESCE(SUM(completion_tokens),0)::bigint AS tokens_out,
        COALESCE(SUM(estimated_cost_usd),0)     AS total_cost
      FROM ai_usage
      WHERE created_at >= ${since}::timestamp
        AND status = 'success'
    `),
    db.execute<any>(sql`
      SELECT tenant_id,
             COALESCE(SUM(estimated_cost_usd),0)::float AS cost_usd,
             COUNT(*)::int AS requests
      FROM ai_usage
      WHERE created_at >= ${since}::timestamp
        AND status = 'success'
        AND tenant_id IS NOT NULL
      GROUP BY tenant_id
      ORDER BY cost_usd DESC
      LIMIT 10
    `),
    db.execute<any>(sql`
      SELECT model,
             COUNT(*)::int AS requests,
             COALESCE(SUM(total_tokens),0)::bigint AS total_tokens,
             COALESCE(SUM(estimated_cost_usd),0)::float AS cost_usd
      FROM ai_usage
      WHERE created_at >= ${since}::timestamp
        AND status = 'success'
      GROUP BY model
      ORDER BY cost_usd DESC
      LIMIT 10
    `),
    db.execute<any>(sql`
      SELECT tenant_id, alert_type,
             MAX(usage_percent)::float AS usage_percent
      FROM ai_usage_alerts
      WHERE triggered_at >= ${since}::timestamptz
      GROUP BY tenant_id, alert_type
      ORDER BY usage_percent DESC
      LIMIT 20
    `),
    db.execute<any>(sql`
      SELECT COUNT(*)::int AS cnt
      FROM gov_anomaly_events
      WHERE created_at >= ${since}::timestamptz
    `),
  ]);

  const u = usageRow.rows[0] ?? {};
  const totalCost     = Number(u.total_cost ?? 0);
  const totalRequests = Number(u.total_requests ?? 0);

  return {
    totalRequests,
    totalTokensIn:  Number(u.tokens_in  ?? 0),
    totalTokensOut: Number(u.tokens_out ?? 0),
    totalCostUsd:   Math.round(totalCost * 10000) / 10000,
    avgCostPerRequest: totalRequests > 0
      ? Math.round((totalCost / totalRequests) * 1000000) / 1000000 : 0,
    alertCount:   Number(alertRows.rows.length),
    anomalyCount: Number(anomalyRow.rows[0]?.cnt ?? 0),
    topSpendersByTenant: (tenantSpend.rows as any[]).map(r => ({
      tenantId: r.tenant_id,
      costUsd:  Math.round(Number(r.cost_usd) * 10000) / 10000,
      requests: Number(r.requests),
    })),
    topSpendersByModel: (modelSpend.rows as any[]).map(r => ({
      model:       r.model,
      requests:    Number(r.requests),
      totalTokens: Number(r.total_tokens),
      costUsd:     Math.round(Number(r.cost_usd) * 10000) / 10000,
    })),
    budgetPressure: (alertRows.rows as any[])
      .filter(r => r.tenant_id != null && Number.isFinite(Number(r.usage_percent)))
      .map(r => ({
        tenantId:     r.tenant_id,
        usagePercent: Math.round(Number(r.usage_percent) * 100) / 100,
        alertType:    r.alert_type ?? "unknown",
      })),
    retrievedAt: new Date().toISOString(),
    windowHours,
  };
}

export async function getAiCostTrend(windowHours = 24): Promise<AiCostTrend> {
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

  const [usageTrend, anomalyTrend] = await Promise.all([
    db.execute<any>(sql`
      SELECT
        TO_CHAR(DATE_TRUNC('hour', created_at), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
        COUNT(*)::int                                     AS requests,
        COALESCE(SUM(total_tokens),0)::bigint             AS tokens_total,
        COALESCE(SUM(estimated_cost_usd),0)::float        AS cost_usd
      FROM ai_usage
      WHERE created_at >= ${since}::timestamp
        AND status = 'success'
      GROUP BY 1 ORDER BY 1
    `),
    db.execute<any>(sql`
      SELECT
        TO_CHAR(DATE_TRUNC('hour', created_at), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
        COUNT(*)::int AS anomalies
      FROM gov_anomaly_events
      WHERE created_at >= ${since}::timestamptz
      GROUP BY 1 ORDER BY 1
    `),
  ]);

  const aMap = new Map((anomalyTrend.rows as any[]).map(r => [r.bucket, Number(r.anomalies)]));

  return {
    points: (usageTrend.rows as any[]).map(r => ({
      bucket:      r.bucket,
      requests:    Number(r.requests),
      tokensTotal: Number(r.tokens_total),
      costUsd:     Math.round(Number(r.cost_usd) * 1000000) / 1000000,
      anomalies:   aMap.get(r.bucket) ?? 0,
    })),
    windowHours,
  };
}

export function explainAiCost(summary: AiCostSummary): {
  summary: string; issues: string[]; recommendations: string[];
} {
  const issues: string[] = [];
  const recs: string[]   = [];

  if (summary.anomalyCount > 0)
    issues.push(`${summary.anomalyCount} cost anomaly event(s) detected`);
  if (summary.alertCount > 0)
    issues.push(`${summary.alertCount} budget alert(s) triggered`);
  if (summary.budgetPressure.some(b => b.usagePercent >= 90))
    issues.push("One or more tenants at 90%+ budget utilization");

  if (summary.anomalyCount > 0) recs.push("Review anomaly events for runaway agents");
  if (summary.alertCount > 0) recs.push("Investigate triggered budget alerts per tenant");
  if (summary.budgetPressure.length > 0) recs.push("Consider raising budget limits for high-pressure tenants");
  if (recs.length === 0) recs.push("AI cost metrics within normal parameters");

  return {
    summary: `${summary.totalRequests} AI requests totaling $${summary.totalCostUsd.toFixed(4)} USD`,
    issues,
    recommendations: recs,
  };
}
