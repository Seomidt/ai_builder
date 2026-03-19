/**
 * Phase 29 — Job Recovery
 * Detects stalled jobs, requeues stuck work, and retries exhausted jobs.
 */

import { Client } from "pg";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StalledJob {
  id:              string;
  tenantId:        string;
  jobType:         string;
  status:          string;
  attemptCount:    number;
  maxAttempts:     number;
  startedAt:       string | null;
  stalledSeconds:  number;
  failureReason:   string | null;
}

export interface JobRecoveryResult {
  jobId:     string;
  action:    "requeued" | "marked_failed" | "skipped";
  reason:    string;
  success:   boolean;
}

export interface RetryResult {
  jobId:     string;
  success:   boolean;
  action:    "retried" | "skipped" | "exhausted";
  message:   string;
}

export interface JobRecoverySummary {
  stalledCount:    number;
  requeuedCount:   number;
  failedCount:     number;
  skippedCount:    number;
  results:         JobRecoveryResult[];
  checkedAt:       string;
}

export interface QueueHealthSnapshot {
  queued:      number;
  running:     number;
  stalled:     number;
  failed:      number;
  completed:   number;
  cancelled:   number;
  stalledJobs: StalledJob[];
  checkedAt:   string;
}

// ── DB helper ─────────────────────────────────────────────────────────────────

function getClient(): Client {
  return new Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ── Detect stalled jobs ───────────────────────────────────────────────────────

export async function detectStalledJobs(
  stallThresholdMinutes = 30,
  tenantId?: string,
): Promise<StalledJob[]> {
  const client    = getClient();
  await client.connect();
  const tFilter   = tenantId ? `AND tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";
  const cutoff    = new Date(Date.now() - stallThresholdMinutes * 60_000).toISOString();

  try {
    const res = await client.query<any>(`
      SELECT
        id,
        tenant_id,
        job_type,
        status,
        attempt_count,
        max_attempts,
        started_at::text  AS started_at,
        failure_reason,
        EXTRACT(EPOCH FROM (NOW() - started_at))::int AS stalled_seconds
      FROM knowledge_processing_jobs
      WHERE status = 'running'
        AND started_at IS NOT NULL
        AND started_at < '${cutoff}'
        ${tFilter}
      ORDER BY started_at ASC
      LIMIT 200
    `);

    return res.rows.map((r: any) => ({
      id:             r.id,
      tenantId:       r.tenant_id,
      jobType:        r.job_type,
      status:         r.status,
      attemptCount:   parseInt(r.attempt_count, 10),
      maxAttempts:    parseInt(r.max_attempts, 10),
      startedAt:      r.started_at ?? null,
      stalledSeconds: parseInt(r.stalled_seconds ?? "0", 10),
      failureReason:  r.failure_reason ?? null,
    }));
  } finally {
    await client.end();
  }
}

// ── Requeue a stalled job ─────────────────────────────────────────────────────

export async function requeueJob(
  jobId: string,
  dryRun = false,
): Promise<JobRecoveryResult> {
  const client = getClient();
  await client.connect();

  try {
    const r = await client.query<any>(
      `SELECT id, status, attempt_count, max_attempts FROM knowledge_processing_jobs WHERE id = $1`,
      [jobId],
    );

    if (!r.rows[0]) {
      return { jobId, action: "skipped", reason: "Job not found", success: false };
    }

    const { status, attempt_count, max_attempts } = r.rows[0];

    if (attempt_count >= max_attempts) {
      if (!dryRun) {
        await client.query(
          `UPDATE knowledge_processing_jobs
           SET status = 'failed', failure_reason = 'Max attempts reached during recovery'
           WHERE id = $1`,
          [jobId],
        );
      }
      return { jobId, action: "marked_failed", reason: `Attempts exhausted (${attempt_count}/${max_attempts})`, success: true };
    }

    if (status !== "running" && status !== "failed") {
      return { jobId, action: "skipped", reason: `Status '${status}' does not require recovery`, success: false };
    }

    if (!dryRun) {
      await client.query(
        `UPDATE knowledge_processing_jobs
         SET status = 'queued', started_at = NULL, failure_reason = 'Requeued by recovery'
         WHERE id = $1`,
        [jobId],
      );
    }

    return { jobId, action: "requeued", reason: `Requeued from '${status}' state (attempt ${attempt_count}/${max_attempts})`, success: true };
  } finally {
    await client.end();
  }
}

// ── Retry failed jobs ─────────────────────────────────────────────────────────

export async function retryFailedJobs(
  tenantId?: string,
  limitPerRun = 50,
  dryRun = false,
): Promise<RetryResult[]> {
  const client  = getClient();
  await client.connect();
  const tFilter = tenantId ? `AND tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";

  try {
    const res = await client.query<any>(`
      SELECT id, attempt_count, max_attempts, job_type
      FROM knowledge_processing_jobs
      WHERE status = 'failed'
        AND attempt_count < max_attempts
        ${tFilter}
      ORDER BY created_at ASC
      LIMIT ${limitPerRun}
    `);

    const results: RetryResult[] = [];
    for (const row of res.rows) {
      if (!dryRun) {
        await client.query(
          `UPDATE knowledge_processing_jobs
           SET status = 'queued', started_at = NULL,
               failure_reason = 'Retried by recovery agent'
           WHERE id = $1`,
          [row.id],
        );
      }
      results.push({
        jobId:   row.id,
        success: true,
        action:  "retried",
        message: `Queued for retry (${row.attempt_count}/${row.max_attempts} attempts)`,
      });
    }
    return results;
  } finally {
    await client.end();
  }
}

// ── Bulk recovery ─────────────────────────────────────────────────────────────

export async function runJobRecovery(
  stallThresholdMinutes = 30,
  dryRun = false,
): Promise<JobRecoverySummary> {
  const stalled = await detectStalledJobs(stallThresholdMinutes);
  const results: JobRecoveryResult[] = [];

  for (const job of stalled) {
    const r = await requeueJob(job.id, dryRun);
    results.push(r);
  }

  return {
    stalledCount:  stalled.length,
    requeuedCount: results.filter(r => r.action === "requeued").length,
    failedCount:   results.filter(r => r.action === "marked_failed").length,
    skippedCount:  results.filter(r => r.action === "skipped").length,
    results,
    checkedAt:     new Date().toISOString(),
  };
}

// ── Queue health snapshot ─────────────────────────────────────────────────────

export async function getQueueHealthSnapshot(
  stallThresholdMinutes = 30,
): Promise<QueueHealthSnapshot> {
  const client = getClient();
  await client.connect();

  try {
    const r = await client.query<any>(`
      SELECT
        COUNT(*) FILTER (WHERE status='queued')    AS queued,
        COUNT(*) FILTER (WHERE status='running')   AS running,
        COUNT(*) FILTER (WHERE status='failed')    AS failed,
        COUNT(*) FILTER (WHERE status='completed') AS completed,
        COUNT(*) FILTER (WHERE status='cancelled') AS cancelled
      FROM knowledge_processing_jobs
    `);

    const row     = r.rows[0] as any ?? {};
    const stalled = await detectStalledJobs(stallThresholdMinutes);

    return {
      queued:      parseInt(row.queued ?? "0", 10),
      running:     parseInt(row.running ?? "0", 10),
      stalled:     stalled.length,
      failed:      parseInt(row.failed ?? "0", 10),
      completed:   parseInt(row.completed ?? "0", 10),
      cancelled:   parseInt(row.cancelled ?? "0", 10),
      stalledJobs: stalled,
      checkedAt:   new Date().toISOString(),
    };
  } finally {
    await client.end();
  }
}

// ── Convenience wrappers for admin API ───────────────────────────────────────

export interface RequeueJobsOptions {
  jobIds?: string[];
  dryRun?: boolean;
}

export interface RequeueJobsResult {
  requested: number;
  requeued:  number;
  skipped:   number;
  dryRun:    boolean;
  jobIds:    string[];
}

export async function requeueJobs(opts: RequeueJobsOptions = {}): Promise<RequeueJobsResult> {
  const { jobIds, dryRun = true } = opts;

  if (!jobIds || jobIds.length === 0) {
    const stalled = await detectStalledJobs(30);
    if (stalled.length === 0) {
      return { requested: 0, requeued: 0, skipped: 0, dryRun, jobIds: [] };
    }
    const results = await Promise.all(stalled.map(j => requeueJob(j.id, dryRun)));
    const requeued = results.filter(r => r.action === "requeued").length;
    return {
      requested: stalled.length,
      requeued,
      skipped:   stalled.length - requeued,
      dryRun,
      jobIds:    stalled.map(j => j.id),
    };
  }

  const results = await Promise.all(jobIds.map(id => requeueJob(id, dryRun)));
  const requeued = results.filter(r => r.action === "requeued").length;
  return {
    requested: jobIds.length,
    requeued,
    skipped:   jobIds.length - requeued,
    dryRun,
    jobIds,
  };
}

export function explainJobRecoveryState(result: RequeueJobsResult | JobRecoverySummary): string {
  if ("requested" in result) {
    const r = result as RequeueJobsResult;
    if (r.requested === 0) return "No jobs required requeue. Queue is healthy.";
    const dryLabel = r.dryRun ? " (dry-run)" : "";
    return `Requeued ${r.requeued}/${r.requested} jobs${dryLabel}. Skipped: ${r.skipped}.`;
  }
  const s = result as JobRecoverySummary;
  return [
    `Job recovery complete.`,
    `Stalled: ${s.stalledCount}, Requeued: ${s.requeuedCount}, Failed: ${s.failedCount}, Skipped: ${s.skippedCount}.`,
  ].join(" ");
}
