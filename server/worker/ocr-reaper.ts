/**
 * ocr-reaper.ts — Cleans up stuck OCR jobs that have missed their heartbeat deadline.
 *
 * Phase 5X: Runs inside the railway-worker process on a separate interval.
 *
 * A job is considered "stuck" if:
 * - status = 'processing'
 * - last_heartbeat_at < now() - STALE_THRESHOLD_MINUTES
 *
 * Stuck jobs are reset to 'retryable_failed' so the worker can pick them up again.
 * If they've exceeded max_attempts, they go to 'dead_letter'.
 */

import { Client as PgClient } from "pg";
import { resolveDbUrl } from "../lib/jobs/job-queue";
import { getSupabaseSslConfig } from "../lib/jobs/ssl-config";
import { calculateNextRetryAt } from "../lib/ocr/ocr-retry-policy";

const STALE_THRESHOLD_MINUTES = parseInt(process.env.OCR_STALE_THRESHOLD_MINUTES ?? "5", 10);
const REAPER_INTERVAL_MS      = parseInt(process.env.OCR_REAPER_INTERVAL_MS ?? "60000", 10);

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "ocr-reaper", event, ...fields }));
}

async function reapStuckJobs(): Promise<void> {
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  await client.connect();
  try {
    // Find all jobs stuck in 'processing' with a stale heartbeat
    const stuckRes = await client.query<{
      id: string;
      tenant_id: string;
      attempt_count: number;
      max_attempts: number;
    }>(
      `SELECT id, tenant_id, attempt_count, max_attempts
       FROM chat_ocr_tasks
       WHERE status = 'processing'
         AND (
           last_heartbeat_at IS NULL
           OR last_heartbeat_at < now() - ($1 || ' minutes')::interval
         )`,
      [STALE_THRESHOLD_MINUTES]
    );

    if (stuckRes.rows.length === 0) return;

    log("reaper_found_stuck_jobs", { count: stuckRes.rows.length });

    for (const job of stuckRes.rows) {
      const isDead = job.attempt_count >= job.max_attempts;
      const nextRetry = isDead ? null : calculateNextRetryAt(job.attempt_count);

      await client.query(
        `UPDATE chat_ocr_tasks
         SET    status             = $1,
                stage              = NULL,
                last_error_code    = 'WORKER_HEARTBEAT_TIMEOUT',
                last_error_message = 'Worker stopped sending heartbeats — job reset by reaper',
                failure_category   = 'timeout',
                last_error_at      = now(),
                next_retry_at      = $2,
                dead_lettered_at   = $3,
                updated_at         = now()
         WHERE  id = $4`,
        [
          isDead ? "dead_letter" : "retryable_failed",
          nextRetry,
          isDead ? new Date() : null,
          job.id,
        ]
      );

      log("reaper_reset_job", {
        jobId:        job.id,
        tenantId:     job.tenant_id,
        attemptCount: job.attempt_count,
        maxAttempts:  job.max_attempts,
        newStatus:    isDead ? "dead_letter" : "retryable_failed",
      });
    }
  } finally {
    await client.end().catch(() => {});
  }
}

export function startReaper(): void {
  log("reaper_started", { staleThresholdMinutes: STALE_THRESHOLD_MINUTES, intervalMs: REAPER_INTERVAL_MS });

  // Run immediately on start
  reapStuckJobs().catch(err => log("reaper_error", { error: err?.message }));

  // Then run on interval
  setInterval(() => {
    reapStuckJobs().catch(err => log("reaper_error", { error: err?.message }));
  }, REAPER_INTERVAL_MS);
}
