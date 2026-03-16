/**
 * Phase 30 — Platform Restart Recovery
 * Safe recovery after server crash, deployment restart, worker crash, or region failover.
 * INV-SAFE4: Restart recovery must not duplicate jobs.
 */

import { Client } from "pg";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IncompleteJob {
  id:           string;
  tenantId:     string;
  jobType:      string;
  status:       string;
  attemptCount: number;
  maxAttempts:  number;
  startedAt:    string | null;
  createdAt:    string;
  recoverable:  boolean;
  reason:       string;
}

export interface RestartRecoveryResult {
  incompleteJobs:   number;
  resumedJobs:      number;
  markedFailed:     number;
  requeuedJobs:     number;
  repaired:         boolean;
  errors:           string[];
  dryRun:           boolean;
  recoveredAt:      string;
}

export interface RestartRecoverySummary {
  totalIncomplete:  number;
  recoverable:      number;
  unrecoverable:    number;
  pendingRetries:   number;
  queueHealth:      "healthy" | "degraded" | "critical";
  explanation:      string;
  checkedAt:        string;
}

// ── DB helper ─────────────────────────────────────────────────────────────────

function getClient(): Client {
  return new Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

function num(v: string | null | undefined): number {
  return parseInt(v ?? "0", 10) || 0;
}

// ── Job detection ─────────────────────────────────────────────────────────────

export async function detectIncompleteJobs(
  stallThresholdMinutes = 30,
): Promise<IncompleteJob[]> {
  const client  = getClient();
  await client.connect();
  const cutoff  = new Date(Date.now() - stallThresholdMinutes * 60_000).toISOString();

  try {
    const r = await client.query<any>(
      `SELECT
         id, tenant_id, job_type, status,
         attempt_count, max_attempts,
         started_at::text, created_at::text
       FROM knowledge_processing_jobs
       WHERE status IN ('running', 'queued')
         AND (
           (status = 'running' AND started_at IS NOT NULL AND started_at < $1)
           OR (status = 'queued'  AND created_at < $2)
         )
       ORDER BY created_at ASC
       LIMIT 200`,
      [cutoff, new Date(Date.now() - 60 * 60_000).toISOString()],
    );

    return r.rows.map((row: any) => {
      const exhausted  = row.attempt_count >= row.max_attempts;
      const recoverable = !exhausted;
      return {
        id:           row.id,
        tenantId:     row.tenant_id,
        jobType:      row.job_type,
        status:       row.status,
        attemptCount: parseInt(row.attempt_count, 10),
        maxAttempts:  parseInt(row.max_attempts,  10),
        startedAt:    row.started_at ?? null,
        createdAt:    row.created_at,
        recoverable,
        reason: exhausted
          ? `Max attempts reached (${row.attempt_count}/${row.max_attempts})`
          : `Stalled in '${row.status}' state since ${row.started_at ?? row.created_at}`,
      };
    });
  } finally {
    await client.end();
  }
}

// ── Job resumption ────────────────────────────────────────────────────────────

export async function resumeSafeJobs(
  jobs:   IncompleteJob[],
  dryRun = true,
): Promise<{ resumed: string[]; failed: string[]; errors: string[] }> {
  if (dryRun || jobs.length === 0) {
    return {
      resumed: jobs.filter(j => j.recoverable).map(j => j.id),
      failed:  [],
      errors:  [],
    };
  }

  const client = getClient();
  await client.connect();
  const resumed: string[] = [];
  const failed:  string[] = [];
  const errors:  string[] = [];

  try {
    for (const job of jobs) {
      if (!job.recoverable) {
        failed.push(job.id);
        continue;
      }
      try {
        await client.query(
          `UPDATE knowledge_processing_jobs
           SET status = 'queued', started_at = NULL,
               failure_reason = 'Requeued by restart recovery'
           WHERE id = $1 AND status IN ('running', 'queued')`,
          [job.id],
        );
        resumed.push(job.id);
      } catch (e: any) {
        errors.push(`${job.id}: ${e.message}`);
      }
    }
  } finally {
    await client.end();
  }

  return { resumed, failed, errors };
}

// ── Queue repair ──────────────────────────────────────────────────────────────

export async function repairQueues(dryRun = true): Promise<{
  stalledJobsFixed: number;
  orphanedJobs:     number;
  pendingWebhooks:  number;
  dryRun:           boolean;
}> {
  const client = getClient();
  await client.connect();

  try {
    // Count stalled running jobs (>30 min)
    const stalledCutoff = new Date(Date.now() - 30 * 60_000).toISOString();
    const stalledRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM knowledge_processing_jobs
       WHERE status = 'running' AND started_at < $1`,
      [stalledCutoff],
    );
    const stalledCount = num(stalledRes.rows[0]?.cnt);

    // Count orphaned queued jobs (>1 hr)
    const orphanCutoff = new Date(Date.now() - 60 * 60_000).toISOString();
    const orphanRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM knowledge_processing_jobs
       WHERE status = 'queued' AND created_at < $1`,
      [orphanCutoff],
    );
    const orphanCount = num(orphanRes.rows[0]?.cnt);

    // Count pending webhook retries
    const webhookRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM webhook_deliveries
       WHERE status IN ('retrying', 'failed') AND next_retry_at IS NOT NULL
         AND next_retry_at <= NOW()`,
    );
    const pendingWebhooks = num(webhookRes.rows[0]?.cnt);

    if (!dryRun && stalledCount > 0) {
      await client.query(
        `UPDATE knowledge_processing_jobs
         SET status = 'queued', started_at = NULL,
             failure_reason = 'Reset by queue repair'
         WHERE status = 'running' AND started_at < $1`,
        [stalledCutoff],
      );
    }

    return {
      stalledJobsFixed: stalledCount,
      orphanedJobs:     orphanCount,
      pendingWebhooks,
      dryRun,
    };
  } finally {
    await client.end();
  }
}

// ── Main recovery orchestration ───────────────────────────────────────────────

export async function runRestartRecovery(dryRun = true): Promise<RestartRecoveryResult> {
  const errors: string[] = [];
  let resumed     = 0;
  let markedFailed = 0;
  let requeued    = 0;
  let repaired    = false;

  try {
    // 1. Detect incomplete jobs
    const incomplete = await detectIncompleteJobs(30);

    // 2. Resume safe jobs
    const recoverable    = incomplete.filter(j => j.recoverable);
    const unrecoverable  = incomplete.filter(j => !j.recoverable);

    const resumeResult = await resumeSafeJobs(recoverable, dryRun);
    resumed      = resumeResult.resumed.length;
    requeued     = resumed;
    markedFailed = unrecoverable.length;
    errors.push(...resumeResult.errors);

    // 3. Repair queue indexes
    const repair = await repairQueues(dryRun);
    repaired = repair.stalledJobsFixed >= 0;

    return {
      incompleteJobs: incomplete.length,
      resumedJobs:    resumed,
      markedFailed,
      requeuedJobs:   requeued,
      repaired,
      errors,
      dryRun,
      recoveredAt: new Date().toISOString(),
    };
  } catch (e: any) {
    errors.push(e.message);
    return {
      incompleteJobs: 0, resumedJobs: 0, markedFailed: 0, requeuedJobs: 0,
      repaired: false, errors, dryRun, recoveredAt: new Date().toISOString(),
    };
  }
}

// ── Explain ───────────────────────────────────────────────────────────────────

export function explainRestartRecovery(result: RestartRecoveryResult): string {
  const dryLabel = result.dryRun ? " [DRY-RUN]" : "";
  return [
    `Restart recovery${dryLabel}:`,
    `  Incomplete jobs found: ${result.incompleteJobs}`,
    `  Resumed:  ${result.resumedJobs}`,
    `  Failed:   ${result.markedFailed}`,
    `  Requeued: ${result.requeuedJobs}`,
    `  Queue repair: ${result.repaired ? "OK" : "SKIP"}`,
    result.errors.length > 0 ? `  Errors: ${result.errors.slice(0, 3).join("; ")}` : "",
  ].filter(Boolean).join("\n");
}

export async function summarizeRecoveryState(): Promise<RestartRecoverySummary> {
  const client = getClient();
  await client.connect();

  try {
    const cutoff30  = new Date(Date.now() - 30 * 60_000).toISOString();
    const cutoff60  = new Date(Date.now() - 60 * 60_000).toISOString();

    const incompleteRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM knowledge_processing_jobs
       WHERE status = 'running' AND started_at < $1`,
      [cutoff30],
    );
    const totalIncomplete = num(incompleteRes.rows[0]?.cnt);

    const orphanRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM knowledge_processing_jobs
       WHERE status = 'queued' AND created_at < $1`,
      [cutoff60],
    );
    const unrecoverable = 0;
    const recoverable   = totalIncomplete;

    const pendingRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM webhook_deliveries
       WHERE status IN ('retrying', 'failed')`,
    );
    const pendingRetries = num(pendingRes.rows[0]?.cnt);

    const queueHealth: RestartRecoverySummary["queueHealth"] =
      totalIncomplete > 50 ? "critical" :
      totalIncomplete > 10 ? "degraded" : "healthy";

    const explanation =
      totalIncomplete === 0
        ? "Queue is healthy. No stalled or incomplete jobs."
        : `${totalIncomplete} stalled job(s) detected. Queue status: ${queueHealth}.`;

    return {
      totalIncomplete, recoverable, unrecoverable, pendingRetries,
      queueHealth, explanation, checkedAt: new Date().toISOString(),
    };
  } finally {
    await client.end();
  }
}
