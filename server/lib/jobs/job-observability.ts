/**
 * Phase 19 — Job Observability
 * Metrics, latency tracking, and failure analysis for the job queue.
 *
 * INV-JOB9: Observability output is privacy-safe (no payload exposure).
 * INV-JOB5: Tenant-safe metrics aggregation.
 * Integrates with Phase 15 observability platform.
 */

import { db } from "../../db";
import { sql as drizzleSql } from "drizzle-orm";

export interface JobMetrics {
  jobType: string;
  totalJobs: number;
  pendingCount: number;
  runningCount: number;
  completedCount: number;
  failedCount: number;
  cancelledCount: number;
  avgDurationMs: number | null;
  failureRate: number;
}

export interface QueueSummary {
  totalJobs: number;
  byStatus: Record<string, number>;
  byJobType: Record<string, number>;
  avgDurationMs: number | null;
  p99DurationMs: number | null;
  totalRetries: number;
  activeSchedules: number;
}

/**
 * Get per-job-type metrics. INV-JOB9: No payload or tenant-specific data exposed.
 */
export async function getJobMetrics(options?: {
  tenantId?: string;
  jobType?: string;
  since?: Date;
}): Promise<JobMetrics[]> {
  const tenantClause = options?.tenantId ? drizzleSql`AND j.tenant_id = ${options.tenantId}` : drizzleSql``;
  const typeClause = options?.jobType ? drizzleSql`AND j.job_type = ${options.jobType}` : drizzleSql``;
  const sinceClause = options?.since ? drizzleSql`AND j.created_at >= ${options.since.toISOString()}` : drizzleSql``;

  const rows = await db.execute(drizzleSql`
    SELECT
      j.job_type,
      COUNT(*) AS total,
      SUM(CASE WHEN j.status = 'pending'   THEN 1 ELSE 0 END) AS pending_cnt,
      SUM(CASE WHEN j.status = 'running'   THEN 1 ELSE 0 END) AS running_cnt,
      SUM(CASE WHEN j.status = 'completed' THEN 1 ELSE 0 END) AS completed_cnt,
      SUM(CASE WHEN j.status = 'failed'    THEN 1 ELSE 0 END) AS failed_cnt,
      SUM(CASE WHEN j.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_cnt,
      AVG(jr.duration_ms) AS avg_duration_ms
    FROM jobs j
    LEFT JOIN job_runs jr ON jr.job_id = j.id
    WHERE 1=1 ${tenantClause} ${typeClause} ${sinceClause}
    GROUP BY j.job_type
    ORDER BY total DESC
  `);

  return rows.rows.map((r: Record<string, unknown>) => {
    const total = Number(r.total ?? 0);
    const failed = Number(r.failed_cnt ?? 0);
    return {
      jobType: r.job_type as string,
      totalJobs: total,
      pendingCount: Number(r.pending_cnt ?? 0),
      runningCount: Number(r.running_cnt ?? 0),
      completedCount: Number(r.completed_cnt ?? 0),
      failedCount: failed,
      cancelledCount: Number(r.cancelled_cnt ?? 0),
      avgDurationMs: r.avg_duration_ms !== null ? Math.round(Number(r.avg_duration_ms)) : null,
      failureRate: total > 0 ? Math.round((failed / total) * 1000) / 10 : 0,
    };
  });
}

/**
 * Aggregate queue summary. INV-JOB9: Privacy-safe.
 */
export async function summarizeQueue(options?: { tenantId?: string }): Promise<QueueSummary> {
  const tenantClause = options?.tenantId ? drizzleSql`WHERE tenant_id = ${options.tenantId}` : drizzleSql``;
  const tenantJoinClause = options?.tenantId ? drizzleSql`AND j.tenant_id = ${options.tenantId}` : drizzleSql``;

  const [statusRows, typeRows, durationRows, retryRows, schedRows] = await Promise.all([
    db.execute(drizzleSql`
      SELECT status, COUNT(*) AS cnt FROM jobs ${tenantClause} GROUP BY status
    `),
    db.execute(drizzleSql`
      SELECT job_type, COUNT(*) AS cnt FROM jobs ${tenantClause} GROUP BY job_type
    `),
    db.execute(drizzleSql`
      SELECT AVG(jr.duration_ms) AS avg_ms,
             PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY jr.duration_ms) AS p99_ms
      FROM job_runs jr
      JOIN jobs j ON j.id = jr.job_id
      WHERE jr.duration_ms IS NOT NULL ${tenantJoinClause}
    `),
    db.execute(drizzleSql`
      SELECT SUM(attempt_count) AS total_retries FROM job_runs jr
      JOIN jobs j ON j.id = jr.job_id WHERE 1=1 ${tenantJoinClause}
    `),
    db.execute(drizzleSql`SELECT COUNT(*) AS cnt FROM job_schedules WHERE active = true`),
  ]);

  const byStatus: Record<string, number> = {};
  let total = 0;
  for (const r of statusRows.rows as Record<string, unknown>[]) {
    byStatus[r.status as string] = Number(r.cnt);
    total += Number(r.cnt);
  }

  const byJobType: Record<string, number> = {};
  for (const r of typeRows.rows as Record<string, unknown>[]) {
    byJobType[r.job_type as string] = Number(r.cnt);
  }

  const dur = durationRows.rows[0] as Record<string, unknown>;
  const retryRow = retryRows.rows[0] as Record<string, unknown>;

  return {
    totalJobs: total,
    byStatus,
    byJobType,
    avgDurationMs: dur?.avg_ms !== null && dur?.avg_ms !== undefined ? Math.round(Number(dur.avg_ms)) : null,
    p99DurationMs: dur?.p99_ms !== null && dur?.p99_ms !== undefined ? Math.round(Number(dur.p99_ms)) : null,
    totalRetries: Number(retryRow?.total_retries ?? 0),
    activeSchedules: Number((schedRows.rows[0] as Record<string, unknown>)?.cnt ?? 0),
  };
}

/**
 * List recent job failures with error context. INV-JOB9: No payload exposed.
 */
export async function listRecentFailures(options?: {
  tenantId?: string;
  jobType?: string;
  limit?: number;
}): Promise<Array<{
  jobId: string;
  jobType: string;
  runId: string;
  errorMessage: string | null;
  attemptCount: number;
  failedAt: Date;
}>> {
  const limit = Math.min(options?.limit ?? 50, 200);
  const tenantClause = options?.tenantId ? drizzleSql`AND j.tenant_id = ${options.tenantId}` : drizzleSql``;
  const typeClause = options?.jobType ? drizzleSql`AND j.job_type = ${options.jobType}` : drizzleSql``;

  const rows = await db.execute(drizzleSql`
    SELECT j.id AS job_id, j.job_type, jr.id AS run_id,
           jr.error_message, jr.attempt_count, jr.completed_at AS failed_at
    FROM jobs j
    JOIN job_runs jr ON jr.job_id = j.id
    WHERE j.status = 'failed' ${tenantClause} ${typeClause}
    ORDER BY jr.completed_at DESC
    LIMIT ${limit}
  `);

  return rows.rows.map((r: Record<string, unknown>) => ({
    jobId: r.job_id as string,
    jobType: r.job_type as string,
    runId: r.run_id as string,
    errorMessage: (r.error_message as string) ?? null,
    attemptCount: Number(r.attempt_count ?? 0),
    failedAt: new Date(r.failed_at as string),
  }));
}

/**
 * Get latency percentiles across all completed runs.
 */
export async function getLatencyPercentiles(options?: { tenantId?: string }): Promise<{
  p50: number | null;
  p95: number | null;
  p99: number | null;
  min: number | null;
  max: number | null;
}> {
  const tenantJoinClause = options?.tenantId ? drizzleSql`AND j.tenant_id = ${options.tenantId}` : drizzleSql``;

  const rows = await db.execute(drizzleSql`
    SELECT
      PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY jr.duration_ms) AS p50,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY jr.duration_ms) AS p95,
      PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY jr.duration_ms) AS p99,
      MIN(jr.duration_ms) AS min_ms,
      MAX(jr.duration_ms) AS max_ms
    FROM job_runs jr
    JOIN jobs j ON j.id = jr.job_id
    WHERE jr.duration_ms IS NOT NULL AND jr.run_status = 'completed'
    ${tenantJoinClause}
  `);

  const r = rows.rows[0] as Record<string, unknown> | undefined;
  return {
    p50: r?.p50 !== null && r?.p50 !== undefined ? Math.round(Number(r.p50)) : null,
    p95: r?.p95 !== null && r?.p95 !== undefined ? Math.round(Number(r.p95)) : null,
    p99: r?.p99 !== null && r?.p99 !== undefined ? Math.round(Number(r.p99)) : null,
    min: r?.min_ms !== null && r?.min_ms !== undefined ? Math.round(Number(r.min_ms)) : null,
    max: r?.max_ms !== null && r?.max_ms !== undefined ? Math.round(Number(r.max_ms)) : null,
  };
}

/**
 * Explain a job's full execution history (INV-JOB8: runtime explainability).
 */
export async function explainJob(jobId: string): Promise<{
  job: Record<string, unknown> | null;
  runs: Array<Record<string, unknown>>;
  attempts: Array<Record<string, unknown>>;
  totalAttempts: number;
  finalStatus: string | null;
}> {
  const jobRows = await db.execute(drizzleSql`SELECT id, job_type, status, tenant_id, priority, created_at FROM jobs WHERE id = ${jobId} LIMIT 1`);
  const job = (jobRows.rows[0] as Record<string, unknown>) ?? null;

  const runRows = await db.execute(drizzleSql`SELECT * FROM job_runs WHERE job_id = ${jobId} ORDER BY started_at DESC`);
  const runs = runRows.rows as Record<string, unknown>[];

  const allAttempts: Record<string, unknown>[] = [];
  for (const run of runs) {
    const attRows = await db.execute(drizzleSql`SELECT * FROM job_attempts WHERE run_id = ${run.id as string} ORDER BY attempt_number ASC`);
    allAttempts.push(...(attRows.rows as Record<string, unknown>[]));
  }

  return {
    job,
    runs,
    attempts: allAttempts,
    totalAttempts: allAttempts.length,
    finalStatus: (job?.status as string) ?? null,
  };
}
