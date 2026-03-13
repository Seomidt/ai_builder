/**
 * Billing Operations Engine — Phase 4R
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Central execution engine for automated billing jobs.
 * Every job invocation goes through this module — no direct execution bypasses.
 *
 * Design rules:
 *   A) Every invocation creates a billing_job_runs row
 *   B) started → completed|failed|skipped|timed_out lifecycle is always explicit
 *   C) duration_ms is always recorded on terminal transition
 *   D) lock_acquired is always recorded
 *   E) singleton_mode enforced via billing-job-locks.ts
 *   F) retries increment attempt_number and create a new run row
 *   G) Failures are never hidden — error_message is always stored
 */

import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../../db";
import { billingJobRuns, billingJobDefinitions } from "@shared/schema";
import type { BillingJobDefinition, BillingJobRun } from "@shared/schema";
import { acquireBillingJobLock } from "./billing-job-locks";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TriggerType = "manual" | "scheduled" | "retry" | "system";
export type ScopeType = "global" | "tenant" | "billing_period";

export interface StartJobRunOptions {
  triggerType: TriggerType;
  scopeType?: ScopeType | null;
  scopeId?: string | null;
  attemptNumber?: number;
  metadata?: Record<string, unknown> | null;
}

export interface RunBillingJobOptions {
  triggerType?: TriggerType;
  scopeType?: ScopeType | null;
  scopeId?: string | null;
  metadata?: Record<string, unknown> | null;
  /** Internal: override attempt_number (used by retry logic) */
  _attemptNumber?: number;
}

export interface BillingJobRunResult {
  runId: string;
  jobKey: string;
  runStatus: string;
  lockAcquired: boolean;
  skipped: boolean;
  skipReason?: string;
  durationMs: number | null;
  resultSummary: Record<string, unknown> | null;
  errorMessage: string | null;
  attemptNumber: number;
}

// Job executor type — each job key maps to a function that performs the operation
export type JobExecutorFn = (
  run: BillingJobRun,
  definition: BillingJobDefinition,
) => Promise<Record<string, unknown>>;

// Global executor registry — populated by billing-jobs.ts
const JOB_EXECUTORS: Map<string, JobExecutorFn> = new Map();

export function registerJobExecutor(jobKey: string, fn: JobExecutorFn): void {
  JOB_EXECUTORS.set(jobKey, fn);
}

export function getJobExecutor(jobKey: string): JobExecutorFn | undefined {
  return JOB_EXECUTORS.get(jobKey);
}

// ─── Run Lifecycle ────────────────────────────────────────────────────────────

export async function startBillingJobRun(
  jobKey: string,
  options: StartJobRunOptions,
): Promise<BillingJobRun | null> {
  const def = await db
    .select()
    .from(billingJobDefinitions)
    .where(eq(billingJobDefinitions.jobKey, jobKey))
    .limit(1);

  if (def.length === 0) {
    throw new Error(`[billing-operations] No billing job definition found for key: ${jobKey}`);
  }

  const definition = def[0];

  const [run] = await db
    .insert(billingJobRuns)
    .values({
      billingJobDefinitionId: definition.id,
      jobKey,
      triggerType: options.triggerType,
      runStatus: "started",
      scopeType: options.scopeType ?? null,
      scopeId: options.scopeId ?? null,
      attemptNumber: options.attemptNumber ?? 1,
      lockAcquired: false,
      startedAt: new Date(),
      metadata: options.metadata ?? null,
    })
    .returning();

  return run;
}

export async function completeBillingJobRun(
  runId: string,
  resultSummary?: Record<string, unknown> | null,
): Promise<BillingJobRun> {
  const existing = await db
    .select({ startedAt: billingJobRuns.startedAt })
    .from(billingJobRuns)
    .where(eq(billingJobRuns.id, runId))
    .limit(1);

  const completedAt = new Date();
  const durationMs = existing[0]
    ? Math.max(0, completedAt.getTime() - new Date(existing[0].startedAt).getTime())
    : null;

  const [updated] = await db
    .update(billingJobRuns)
    .set({
      runStatus: "completed",
      completedAt,
      durationMs,
      resultSummary: resultSummary ?? null,
    })
    .where(eq(billingJobRuns.id, runId))
    .returning();

  return updated;
}

export async function failBillingJobRun(
  runId: string,
  error: Error | string,
): Promise<BillingJobRun> {
  const existing = await db
    .select({ startedAt: billingJobRuns.startedAt })
    .from(billingJobRuns)
    .where(eq(billingJobRuns.id, runId))
    .limit(1);

  const completedAt = new Date();
  const durationMs = existing[0]
    ? Math.max(0, completedAt.getTime() - new Date(existing[0].startedAt).getTime())
    : null;

  const errorMessage = error instanceof Error ? error.message : String(error);

  const [updated] = await db
    .update(billingJobRuns)
    .set({
      runStatus: "failed",
      completedAt,
      durationMs,
      errorMessage,
    })
    .where(eq(billingJobRuns.id, runId))
    .returning();

  return updated;
}

export async function skipBillingJobRun(
  runId: string,
  reason: string,
  resultSummary?: Record<string, unknown> | null,
): Promise<BillingJobRun> {
  const existing = await db
    .select({ startedAt: billingJobRuns.startedAt })
    .from(billingJobRuns)
    .where(eq(billingJobRuns.id, runId))
    .limit(1);

  const completedAt = new Date();
  const durationMs = existing[0]
    ? Math.max(0, completedAt.getTime() - new Date(existing[0].startedAt).getTime())
    : null;

  const [updated] = await db
    .update(billingJobRuns)
    .set({
      runStatus: "skipped",
      completedAt,
      durationMs,
      errorMessage: reason,
      resultSummary: resultSummary ?? null,
    })
    .where(eq(billingJobRuns.id, runId))
    .returning();

  return updated;
}

// ─── Central Job Runner ───────────────────────────────────────────────────────

/**
 * Core entry point for all automated billing job execution.
 * Enforces: definition lookup → singleton check → run row creation → execution → completion
 */
export async function runBillingJob(
  jobKey: string,
  options: RunBillingJobOptions = {},
): Promise<BillingJobRunResult> {
  const startMs = Date.now();

  const defs = await db
    .select()
    .from(billingJobDefinitions)
    .where(eq(billingJobDefinitions.jobKey, jobKey))
    .limit(1);

  if (defs.length === 0) {
    throw new Error(`[billing-operations] Job definition not found: ${jobKey}`);
  }

  const definition = defs[0];

  if (definition.status !== "active") {
    return {
      runId: "none",
      jobKey,
      runStatus: "skipped",
      lockAcquired: false,
      skipped: true,
      skipReason: `Job definition status is '${definition.status}' — not active`,
      durationMs: null,
      resultSummary: null,
      errorMessage: null,
      attemptNumber: 1,
    };
  }

  const triggerType = options.triggerType ?? "manual";
  const { scopeType, scopeId } = options;

  // Singleton lock check BEFORE creating any run row
  // This prevents the run row from appearing as a competing lock against itself
  if (definition.singletonMode) {
    const lockResult = await acquireBillingJobLock(
      jobKey,
      scopeType ?? null,
      scopeId ?? null,
      definition.timeoutSeconds,
    );

    if (!lockResult.acquired) {
      // Create a 'skipped' run row as an audit trail for the blocked attempt
      const [skippedRun] = await db
        .insert(billingJobRuns)
        .values({
          billingJobDefinitionId: definition.id,
          jobKey,
          triggerType,
          runStatus: "skipped",
          scopeType: scopeType ?? null,
          scopeId: scopeId ?? null,
          attemptNumber: 1,
          lockAcquired: false,
          startedAt: new Date(),
          errorMessage: lockResult.reason,
          resultSummary: {
            existingRunId: lockResult.existingRunId,
            lockKey: lockResult.lockKey,
          } as unknown,
          metadata: options.metadata ?? null,
        })
        .returning();

      await db
        .update(billingJobRuns)
        .set({ completedAt: new Date(), durationMs: 0 })
        .where(eq(billingJobRuns.id, skippedRun.id));

      return {
        runId: skippedRun.id,
        jobKey,
        runStatus: "skipped",
        lockAcquired: false,
        skipped: true,
        skipReason: lockResult.reason,
        durationMs: 0,
        resultSummary: null,
        errorMessage: lockResult.reason,
        attemptNumber: 1,
      };
    }
  }

  // Lock acquired (or non-singleton) — create the active run row
  const run = await startBillingJobRun(jobKey, {
    triggerType,
    scopeType,
    scopeId,
    attemptNumber: options._attemptNumber ?? 1,
    metadata: options.metadata,
  });

  if (!run) {
    throw new Error(`[billing-operations] Failed to create run row for job: ${jobKey}`);
  }

  // Mark lock acquired
  await db
    .update(billingJobRuns)
    .set({ lockAcquired: true })
    .where(eq(billingJobRuns.id, run.id));

  // Execute job
  const executor = JOB_EXECUTORS.get(jobKey);
  if (!executor) {
    const failedRun = await failBillingJobRun(
      run.id,
      `No executor registered for job key: ${jobKey}`,
    );
    return {
      runId: failedRun.id,
      jobKey,
      runStatus: "failed",
      lockAcquired: true,
      skipped: false,
      durationMs: failedRun.durationMs,
      resultSummary: null,
      errorMessage: failedRun.errorMessage,
      attemptNumber: failedRun.attemptNumber,
    };
  }

  try {
    const updatedRunRow = await db
      .select()
      .from(billingJobRuns)
      .where(eq(billingJobRuns.id, run.id))
      .limit(1);

    const resultSummary = await executor(updatedRunRow[0] ?? run, definition);
    const completedRun = await completeBillingJobRun(run.id, resultSummary);

    return {
      runId: completedRun.id,
      jobKey,
      runStatus: "completed",
      lockAcquired: true,
      skipped: false,
      durationMs: completedRun.durationMs,
      resultSummary: (completedRun.resultSummary as Record<string, unknown>) ?? null,
      errorMessage: null,
      attemptNumber: completedRun.attemptNumber,
    };
  } catch (err) {
    const failedRun = await failBillingJobRun(run.id, err instanceof Error ? err : String(err));

    return {
      runId: failedRun.id,
      jobKey,
      runStatus: "failed",
      lockAcquired: true,
      skipped: false,
      durationMs: failedRun.durationMs,
      resultSummary: null,
      errorMessage: failedRun.errorMessage,
      attemptNumber: failedRun.attemptNumber,
    };
  }
}

// ─── Retry ────────────────────────────────────────────────────────────────────

export async function retryBillingJobRun(
  runId: string,
): Promise<BillingJobRunResult> {
  const existingRows = await db
    .select()
    .from(billingJobRuns)
    .where(eq(billingJobRuns.id, runId))
    .limit(1);

  if (existingRows.length === 0) {
    throw new Error(`[billing-operations] Run not found: ${runId}`);
  }

  const existing = existingRows[0];

  if (existing.runStatus === "started") {
    throw new Error(`[billing-operations] Run ${runId} is still in 'started' state — cannot retry active run`);
  }

  // Check retry limit
  const def = await db
    .select({ retryLimit: billingJobDefinitions.retryLimit })
    .from(billingJobDefinitions)
    .where(eq(billingJobDefinitions.jobKey, existing.jobKey))
    .limit(1);

  const retryLimit = def[0]?.retryLimit ?? 3;
  if (existing.attemptNumber >= retryLimit + 1) {
    throw new Error(
      `[billing-operations] Run ${runId} has reached retry limit (${retryLimit}). attempt_number=${existing.attemptNumber}`,
    );
  }

  return runBillingJob(existing.jobKey, {
    triggerType: "retry",
    scopeType: (existing.scopeType as ScopeType | null) ?? undefined,
    scopeId: existing.scopeId ?? undefined,
    _attemptNumber: existing.attemptNumber + 1,
    metadata: { retriedFromRunId: runId, previousAttemptNumber: existing.attemptNumber },
  });
}

// ─── Lookup ───────────────────────────────────────────────────────────────────

export async function getLatestBillingJobRun(
  jobKey: string,
  scopeType?: string | null,
  scopeId?: string | null,
): Promise<BillingJobRun | null> {
  const where = [eq(billingJobRuns.jobKey, jobKey)];
  if (scopeType) where.push(eq(billingJobRuns.scopeType, scopeType));
  if (scopeId) where.push(eq(billingJobRuns.scopeId, scopeId));

  const rows = await db
    .select()
    .from(billingJobRuns)
    .where(and(...where))
    .orderBy(desc(billingJobRuns.startedAt))
    .limit(1);

  return rows[0] ?? null;
}
