/**
 * Phase 35 — Platform Health Analytics
 *
 * Aggregates system-wide health signals from:
 *   jobs, webhook_deliveries, obs_ai_latency_metrics,
 *   security_events, obs_system_metrics, tenants
 *
 * All functions are read-only and fail-open.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

export type HealthStatus = "healthy" | "degraded" | "critical" | "unknown";

export interface PlatformHealthSummary {
  overallStatus: HealthStatus;
  jobsHealth: {
    total: number;
    failed: number;
    stalled: number;
    failureRate: number;
  };
  webhookHealth: {
    total: number;
    failed: number;
    pending: number;
    failureRate: number;
  };
  latencyHealth: {
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    sampleCount: number;
  };
  securityHealth: {
    violations: number;
    recentEvents: number;
  };
  tenantHealth: {
    total: number;
    active: number;
    suspended: number;
  };
  queueDepth: number;
  retrievedAt: string;
  windowHours: number;
}

export interface PlatformHealthTrend {
  points: { bucket: string; failedJobs: number; failedWebhooks: number; avgLatencyMs: number }[];
  windowHours: number;
}

export interface PlatformHealthExplanation {
  summary: string;
  issues: string[];
  recommendations: string[];
  status: HealthStatus;
}

function deriveStatus(
  jobFailureRate: number,
  webhookFailureRate: number,
  p95Ms: number,
): HealthStatus {
  if (jobFailureRate > 0.3 || webhookFailureRate > 0.3 || p95Ms > 10000) return "critical";
  if (jobFailureRate > 0.1 || webhookFailureRate > 0.1 || p95Ms > 5000) return "degraded";
  return "healthy";
}

export async function getPlatformHealthSummary(
  windowHours = 24,
): Promise<PlatformHealthSummary> {
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

  const [jobsRow, webhookRow, latencyRow, securityRow, tenantRow] = await Promise.all([
    db.execute<any>(sql`
      SELECT
        COUNT(*)::int                                           AS total,
        COUNT(*) FILTER (WHERE status = 'failed')::int         AS failed,
        COUNT(*) FILTER (WHERE status IN ('pending','running')
          AND created_at < NOW() - INTERVAL '2 hours')::int   AS stalled
      FROM jobs
      WHERE created_at >= ${since}::timestamptz
    `),
    db.execute<any>(sql`
      SELECT
        COUNT(*)::int                                        AS total,
        COUNT(*) FILTER (WHERE status = 'failed')::int      AS failed,
        COUNT(*) FILTER (WHERE status = 'pending')::int     AS pending
      FROM webhook_deliveries
      WHERE created_at >= ${since}::timestamptz
    `),
    db.execute<any>(sql`
      SELECT
        PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY latency_ms)::float AS p50,
        PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)::float AS p95,
        PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY latency_ms)::float AS p99,
        COUNT(*)::int AS cnt
      FROM obs_ai_latency_metrics
      WHERE created_at >= ${since}::timestamp
    `),
    db.execute<any>(sql`
      SELECT
        COUNT(*) FILTER (WHERE event_type ILIKE '%violation%'
          OR event_type ILIKE '%block%')::int AS violations,
        COUNT(*)::int                          AS total
      FROM security_events
      WHERE created_at >= ${since}::timestamp
    `),
    db.execute<any>(sql`
      SELECT
        COUNT(*)::int                                             AS total,
        COUNT(*) FILTER (WHERE lifecycle_status = 'active')::int AS active,
        COUNT(*) FILTER (WHERE lifecycle_status = 'suspended')::int AS suspended
      FROM tenants
    `),
  ]);

  const j = jobsRow.rows[0] ?? {};
  const w = webhookRow.rows[0] ?? {};
  const l = latencyRow.rows[0] ?? {};
  const s = securityRow.rows[0] ?? {};
  const t = tenantRow.rows[0] ?? {};

  const jobTotal = Number(j.total ?? 0);
  const jobFailed = Number(j.failed ?? 0);
  const jobFailureRate = jobTotal > 0 ? jobFailed / jobTotal : 0;

  const whTotal = Number(w.total ?? 0);
  const whFailed = Number(w.failed ?? 0);
  const whFailureRate = whTotal > 0 ? whFailed / whTotal : 0;

  const p95 = Number(l.p95 ?? 0);

  return {
    overallStatus: deriveStatus(jobFailureRate, whFailureRate, p95),
    jobsHealth: {
      total: jobTotal,
      failed: jobFailed,
      stalled: Number(j.stalled ?? 0),
      failureRate: Math.round(jobFailureRate * 10000) / 100,
    },
    webhookHealth: {
      total: whTotal,
      failed: whFailed,
      pending: Number(w.pending ?? 0),
      failureRate: Math.round(whFailureRate * 10000) / 100,
    },
    latencyHealth: {
      p50Ms: Math.round(Number(l.p50 ?? 0)),
      p95Ms: Math.round(Number(l.p95 ?? 0)),
      p99Ms: Math.round(Number(l.p99 ?? 0)),
      sampleCount: Number(l.cnt ?? 0),
    },
    securityHealth: {
      violations: Number(s.violations ?? 0),
      recentEvents: Number(s.total ?? 0),
    },
    tenantHealth: {
      total: Number(t.total ?? 0),
      active: Number(t.active ?? 0),
      suspended: Number(t.suspended ?? 0),
    },
    queueDepth: Number(j.stalled ?? 0) + Number(w.pending ?? 0),
    retrievedAt: new Date().toISOString(),
    windowHours,
  };
}

export async function getPlatformHealthTrend(
  windowHours = 24,
  buckets = 12,
): Promise<PlatformHealthTrend> {
  const bucketMinutes = Math.floor((windowHours * 60) / buckets);
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

  const [jobTrend, webhookTrend, latencyTrend] = await Promise.all([
    db.execute<any>(sql`
      SELECT
        TO_CHAR(DATE_TRUNC('hour', created_at +
          (EXTRACT(MINUTE FROM created_at)::int / ${bucketMinutes}) * INTERVAL '1 minute' * ${bucketMinutes},
          'UTC'), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM jobs
      WHERE created_at >= ${since}::timestamptz
      GROUP BY 1 ORDER BY 1
    `),
    db.execute<any>(sql`
      SELECT
        TO_CHAR(DATE_TRUNC('hour', created_at), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM webhook_deliveries
      WHERE created_at >= ${since}::timestamptz
      GROUP BY 1 ORDER BY 1
    `),
    db.execute<any>(sql`
      SELECT
        TO_CHAR(DATE_TRUNC('hour', created_at), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
        AVG(latency_ms)::float AS avg_latency
      FROM obs_ai_latency_metrics
      WHERE created_at >= ${since}::timestamp
      GROUP BY 1 ORDER BY 1
    `),
  ]);

  const jobMap = new Map((jobTrend.rows as any[]).map(r => [r.bucket, Number(r.failed)]));
  const whMap  = new Map((webhookTrend.rows as any[]).map(r => [r.bucket, Number(r.failed)]));
  const latMap = new Map((latencyTrend.rows as any[]).map(r => [r.bucket, Number(r.avg_latency)]));

  const allBuckets = Array.from(new Set([
    ...Array.from(jobMap.keys()),
    ...Array.from(whMap.keys()),
    ...Array.from(latMap.keys()),
  ])).sort();

  return {
    points: allBuckets.map(b => ({
      bucket: b,
      failedJobs:     jobMap.get(b) ?? 0,
      failedWebhooks: whMap.get(b)  ?? 0,
      avgLatencyMs:   Math.round(latMap.get(b) ?? 0),
    })),
    windowHours,
  };
}

export function explainPlatformHealth(summary: PlatformHealthSummary): PlatformHealthExplanation {
  const issues: string[] = [];
  const recs: string[]   = [];

  if (summary.jobsHealth.failureRate > 10)
    issues.push(`Job failure rate is ${summary.jobsHealth.failureRate.toFixed(1)}% — above 10% threshold`);
  if (summary.jobsHealth.stalled > 0)
    issues.push(`${summary.jobsHealth.stalled} stalled job(s) detected`);
  if (summary.webhookHealth.failureRate > 10)
    issues.push(`Webhook failure rate is ${summary.webhookHealth.failureRate.toFixed(1)}% — above 10%`);
  if (summary.latencyHealth.p95Ms > 5000)
    issues.push(`p95 latency is ${summary.latencyHealth.p95Ms}ms — above 5s threshold`);
  if (summary.securityHealth.violations > 0)
    issues.push(`${summary.securityHealth.violations} security violation(s) in window`);

  if (summary.jobsHealth.stalled > 0) recs.push("Investigate stalled jobs and clear queue");
  if (summary.webhookHealth.failureRate > 5) recs.push("Review failing webhook endpoints");
  if (summary.latencyHealth.p95Ms > 3000) recs.push("Check AI provider latency or rate limits");
  if (issues.length === 0) recs.push("System operating within normal parameters");

  return {
    summary: issues.length === 0
      ? "Platform is operating normally"
      : `Platform has ${issues.length} active issue(s) requiring attention`,
    issues,
    recommendations: recs,
    status: summary.overallStatus,
  };
}
