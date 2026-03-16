/**
 * Phase 35 — Job & Webhook Analytics
 *
 * Sources: jobs, webhook_deliveries, webhook_endpoints
 *
 * All functions are read-only and fail-open.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

export interface JobWebhookSummary {
  jobs: {
    total: number;
    pending: number;
    running: number;
    completed: number;
    failed: number;
    stalled: number;
    failureRate: number;
    queueBacklog: number;
  };
  webhooks: {
    total: number;
    delivered: number;
    failed: number;
    pending: number;
    deliveryRate: number;
    avgAttemptsOnFail: number;
  };
  topFailingJobTypes: { jobType: string; failed: number; total: number }[];
  topFailingEndpoints: { endpointId: string; failed: number; total: number }[];
  retrievedAt: string;
  windowHours: number;
}

export interface JobWebhookTrend {
  points: {
    bucket: string;
    jobsCreated: number;
    jobsFailed: number;
    webhooksDelivered: number;
    webhooksFailed: number;
  }[];
  windowHours: number;
}

export async function getJobWebhookSummary(
  windowHours = 24,
): Promise<JobWebhookSummary> {
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

  const [jobRow, jobTypeRow, webhookRow, endpointRow] = await Promise.all([
    db.execute<any>(sql`
      SELECT
        COUNT(*)::int                                                   AS total,
        COUNT(*) FILTER (WHERE status = 'pending')::int                 AS pending,
        COUNT(*) FILTER (WHERE status = 'running')::int                 AS running,
        COUNT(*) FILTER (WHERE status = 'completed')::int               AS completed,
        COUNT(*) FILTER (WHERE status = 'failed')::int                  AS failed,
        COUNT(*) FILTER (WHERE status IN ('pending','running')
          AND created_at < NOW() - INTERVAL '2 hours')::int             AS stalled,
        COUNT(*) FILTER (WHERE status IN ('pending','running'))::int     AS backlog
      FROM jobs
      WHERE created_at >= ${since}::timestamptz
    `),
    db.execute<any>(sql`
      SELECT job_type,
             COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
             COUNT(*)::int                                  AS total
      FROM jobs
      WHERE created_at >= ${since}::timestamptz
      GROUP BY job_type
      ORDER BY failed DESC
      LIMIT 10
    `),
    db.execute<any>(sql`
      SELECT
        COUNT(*)::int                                        AS total,
        COUNT(*) FILTER (WHERE status = 'delivered')::int   AS delivered,
        COUNT(*) FILTER (WHERE status = 'failed')::int      AS failed,
        COUNT(*) FILTER (WHERE status = 'pending')::int     AS pending,
        AVG(attempts) FILTER (WHERE status = 'failed')::float AS avg_attempts_fail
      FROM webhook_deliveries
      WHERE created_at >= ${since}::timestamptz
    `),
    db.execute<any>(sql`
      SELECT endpoint_id,
             COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
             COUNT(*)::int                                  AS total
      FROM webhook_deliveries
      WHERE created_at >= ${since}::timestamptz
      GROUP BY endpoint_id
      ORDER BY failed DESC
      LIMIT 10
    `),
  ]);

  const j  = jobRow.rows[0] ?? {};
  const w  = webhookRow.rows[0] ?? {};

  const total   = Number(j.total  ?? 0);
  const jFailed = Number(j.failed ?? 0);
  const wTotal  = Number(w.total  ?? 0);
  const wFailed = Number(w.failed ?? 0);

  return {
    jobs: {
      total,
      pending:     Number(j.pending   ?? 0),
      running:     Number(j.running   ?? 0),
      completed:   Number(j.completed ?? 0),
      failed:      jFailed,
      stalled:     Number(j.stalled   ?? 0),
      failureRate: total > 0 ? Math.round(jFailed / total * 10000) / 100 : 0,
      queueBacklog: Number(j.backlog  ?? 0),
    },
    webhooks: {
      total:     wTotal,
      delivered: Number(w.delivered ?? 0),
      failed:    wFailed,
      pending:   Number(w.pending   ?? 0),
      deliveryRate: wTotal > 0
        ? Math.round(Number(w.delivered ?? 0) / wTotal * 10000) / 100 : 100,
      avgAttemptsOnFail: Math.round(Number(w.avg_attempts_fail ?? 0) * 10) / 10,
    },
    topFailingJobTypes: (jobTypeRow.rows as any[])
      .filter(r => Number(r.failed) > 0)
      .map(r => ({ jobType: r.job_type, failed: Number(r.failed), total: Number(r.total) })),
    topFailingEndpoints: (endpointRow.rows as any[])
      .filter(r => Number(r.failed) > 0)
      .map(r => ({ endpointId: r.endpoint_id, failed: Number(r.failed), total: Number(r.total) })),
    retrievedAt: new Date().toISOString(),
    windowHours,
  };
}

export async function getJobWebhookTrend(
  windowHours = 24,
): Promise<JobWebhookTrend> {
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

  const [jobTrend, webhookTrend] = await Promise.all([
    db.execute<any>(sql`
      SELECT
        TO_CHAR(DATE_TRUNC('hour', created_at), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
        COUNT(*)::int                                    AS created,
        COUNT(*) FILTER (WHERE status = 'failed')::int  AS failed
      FROM jobs
      WHERE created_at >= ${since}::timestamptz
      GROUP BY 1 ORDER BY 1
    `),
    db.execute<any>(sql`
      SELECT
        TO_CHAR(DATE_TRUNC('hour', created_at), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
        COUNT(*) FILTER (WHERE status = 'delivered')::int AS delivered,
        COUNT(*) FILTER (WHERE status = 'failed')::int   AS failed
      FROM webhook_deliveries
      WHERE created_at >= ${since}::timestamptz
      GROUP BY 1 ORDER BY 1
    `),
  ]);

  const jMap = new Map((jobTrend.rows as any[]).map(r => [r.bucket, { c: Number(r.created), f: Number(r.failed) }]));
  const wMap = new Map((webhookTrend.rows as any[]).map(r => [r.bucket, { d: Number(r.delivered), f: Number(r.failed) }]));
  const buckets = Array.from(new Set([
    ...Array.from(jMap.keys()),
    ...Array.from(wMap.keys()),
  ])).sort();

  return {
    points: buckets.map(b => ({
      bucket:            b,
      jobsCreated:       jMap.get(b)?.c ?? 0,
      jobsFailed:        jMap.get(b)?.f ?? 0,
      webhooksDelivered: wMap.get(b)?.d ?? 0,
      webhooksFailed:    wMap.get(b)?.f ?? 0,
    })),
    windowHours,
  };
}

export function explainJobWebhook(summary: JobWebhookSummary): {
  summary: string; issues: string[]; recommendations: string[];
} {
  const issues: string[] = [];
  const recs: string[]   = [];

  if (summary.jobs.stalled > 0)
    issues.push(`${summary.jobs.stalled} stalled job(s) in queue`);
  if (summary.jobs.failureRate > 10)
    issues.push(`Job failure rate ${summary.jobs.failureRate}% exceeds 10% threshold`);
  if (summary.webhooks.deliveryRate < 90)
    issues.push(`Webhook delivery rate ${summary.webhooks.deliveryRate}% below 90%`);

  if (summary.jobs.stalled > 0) recs.push("Investigate and clear stalled jobs");
  if (summary.topFailingEndpoints.length > 0)
    recs.push(`Top failing endpoint: ${summary.topFailingEndpoints[0]?.endpointId}`);
  if (issues.length === 0) recs.push("Job and webhook execution is healthy");

  return {
    summary: `${summary.jobs.total} jobs, ${summary.webhooks.total} webhook deliveries in window`,
    issues,
    recommendations: recs,
  };
}
