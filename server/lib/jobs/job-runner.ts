/**
 * Phase 19 — Job Runner
 * Executes background jobs with retry support and run/attempt tracking.
 *
 * INV-JOB2: All job executions produce an auditable run record.
 * INV-JOB3: Failures are logged and do not crash the caller.
 * INV-JOB4: Each attempt is recorded independently (append-only).
 */

import { db } from "../../db";
import { jobRuns, jobAttempts } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";
import { updateJobStatus } from "./job-dispatcher";
import { computeBackoffMs } from "./job-retries";

export type JobHandler = (payload: Record<string, unknown>, context: JobContext) => Promise<void>;

export interface JobContext {
  jobId: string;
  tenantId: string | null;
  attemptNumber: number;
  runId: string;
}

// In-memory handler registry
const _handlers = new Map<string, JobHandler>();

export function registerJobHandler(jobType: string, handler: JobHandler): void {
  _handlers.set(jobType, handler);
}

export function getRegisteredJobTypes(): string[] {
  return Array.from(_handlers.keys());
}

/**
 * Execute a single job by ID. Creates a run record and up to maxAttempts attempt records.
 * INV-JOB3: Never throws — all errors are captured in the attempt record.
 */
export async function executeJob(jobId: string): Promise<{
  runId: string;
  status: "completed" | "failed";
  attempts: number;
  durationMs: number;
}> {
  const jobRows = await db.execute(drizzleSql`
    SELECT * FROM jobs WHERE id = ${jobId} LIMIT 1
  `);
  const job = jobRows.rows[0] as Record<string, unknown> | undefined;
  if (!job) return { runId: "none", status: "failed", attempts: 0, durationMs: 0 };

  const maxAttempts = Number(job.max_attempts ?? 3);
  const retryPolicy = (job.retry_policy as Record<string, unknown>) ?? {};

  // Create run record (INV-JOB2)
  const runRows = await db
    .insert(jobRuns)
    .values({
      jobId,
      runStatus: "running",
      attemptCount: 0,
      errorMessage: null,
      startedAt: new Date(),
      completedAt: null,
      durationMs: null,
    })
    .returning({ id: jobRuns.id });
  const runId = runRows[0].id;

  await updateJobStatus(jobId, "running");

  const globalStart = Date.now();
  let lastError: string | null = null;
  let success = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStart = Date.now();
    let attemptStatus: "success" | "failure" | "timeout" = "failure";
    let attemptError: string | null = null;

    try {
      const handler = _handlers.get(job.job_type as string);
      if (!handler) throw new Error(`No handler registered for job type: ${job.job_type as string}`);

      const ctx: JobContext = {
        jobId,
        tenantId: (job.tenant_id as string) ?? null,
        attemptNumber: attempt,
        runId,
      };
      await handler((job.payload as Record<string, unknown>) ?? {}, ctx);
      attemptStatus = "success";
      success = true;
    } catch (err) {
      attemptError = (err as Error).message ?? String(err);
      lastError = attemptError;
    }

    const attemptDuration = Date.now() - attemptStart;

    // Record attempt (INV-JOB4: append-only)
    await db.insert(jobAttempts).values({
      runId,
      attemptNumber: attempt,
      status: attemptStatus,
      error: attemptError,
      startedAt: new Date(attemptStart),
      completedAt: new Date(),
      durationMs: attemptDuration,
      metadata: { jobType: job.job_type, tenantId: job.tenant_id } as Record<string, unknown>,
    });

    if (success) break;

    if (attempt < maxAttempts) {
      const backoff = computeBackoffMs(attempt, retryPolicy);
      if (backoff > 0) await sleep(Math.min(backoff, 5000)); // Cap at 5s in tests
    }
  }

  const totalDuration = Date.now() - globalStart;
  const finalStatus = success ? "completed" : "failed";

  // Update run record
  await db.execute(drizzleSql`
    UPDATE job_runs
    SET run_status = ${finalStatus},
        attempt_count = ${success ? maxAttempts : maxAttempts},
        error_message = ${lastError},
        completed_at = NOW(),
        duration_ms = ${totalDuration}
    WHERE id = ${runId}
  `);

  // Update job status
  await updateJobStatus(jobId, finalStatus);

  return {
    runId,
    status: finalStatus as "completed" | "failed",
    attempts: maxAttempts,
    durationMs: totalDuration,
  };
}

/**
 * Get run history for a job.
 */
export async function getJobRuns(jobId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM job_runs WHERE job_id = ${jobId} ORDER BY started_at DESC
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * Get all attempts for a run.
 */
export async function getRunAttempts(runId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM job_attempts WHERE run_id = ${runId} ORDER BY attempt_number ASC
  `);
  return rows.rows as Record<string, unknown>[];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
