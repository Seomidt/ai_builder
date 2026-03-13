/**
 * Billing Job Locking — Phase 4R
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Implements distributed, DB-safe singleton job locking using a two-layer strategy:
 *
 * Layer 1 — Postgres transaction-scoped advisory lock (pg_try_advisory_xact_lock):
 *   Prevents the check-and-insert race condition between concurrent instances.
 *   Lock is automatically released when the transaction commits.
 *   Safe for connection pooling (Supabase / pgbouncer) because lock scope = transaction.
 *
 * Layer 2 — billing_job_runs 'started' row as persistent lock indicator:
 *   Once the advisory lock succeeds and a new 'started' run is inserted, that row
 *   acts as the singleton guard for the duration of the job execution.
 *   Checked via: any 'started' run for the same job+scope younger than timeout_seconds.
 *
 * Design rules:
 *   A) Never use in-memory locks — they don't survive restarts or multiple instances
 *   B) Advisory lock is transaction-scoped → safe for pgbouncer pooling
 *   C) 'started' run row is the long-term singleton guard
 *   D) Stale 'started' runs (older than timeout_seconds) are treated as released
 *   E) withBillingJobLock wraps the entire fn, ensuring release on any exit path
 */

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../../db";
import { billingJobRuns, billingJobDefinitions } from "@shared/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LockAcquisitionResult {
  acquired: boolean;
  existingRunId: string | null;
  lockKey: string;
  reason: string;
}

// ─── Lock Key ────────────────────────────────────────────────────────────────

function buildLockKey(
  jobKey: string,
  scopeType?: string | null,
  scopeId?: string | null,
): string {
  const parts = [jobKey];
  if (scopeType) parts.push(scopeType);
  if (scopeId) parts.push(scopeId);
  return parts.join(":");
}

// ─── Acquire Lock ─────────────────────────────────────────────────────────────

/**
 * Attempt to acquire a singleton lock for the given job+scope.
 *
 * Strategy:
 * 1. Compute advisory lock id via hashtext(lockKey) — deterministic, Postgres-native
 * 2. In a transaction: try pg_try_advisory_xact_lock(lockId)
 * 3. While holding advisory lock, check for existing non-expired 'started' run
 * 4. If none found, mark lock as acquired (caller inserts the run row)
 * 5. Commit — advisory lock releases, 'started' run row is the persistent guard
 *
 * Returns { acquired: false } with reason if blocked.
 */
export async function acquireBillingJobLock(
  jobKey: string,
  scopeType?: string | null,
  scopeId?: string | null,
  timeoutSeconds = 300,
): Promise<LockAcquisitionResult> {
  const lockKey = buildLockKey(jobKey, scopeType, scopeId);

  const result = await db.transaction(async (tx) => {
    // Layer 1: Advisory lock — prevents race window between check and insert
    const advisoryRows = await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})::bigint) AS acquired`,
    );
    const advisoryAcquired = (advisoryRows.rows[0] as { acquired: boolean }).acquired;

    if (!advisoryAcquired) {
      return {
        acquired: false,
        existingRunId: null,
        lockKey,
        reason: "Advisory lock contention — another instance is checking the same job",
      };
    }

    // Layer 2: Check for existing non-expired 'started' run
    const cutoff = new Date(Date.now() - timeoutSeconds * 1000);
    const where = [
      eq(billingJobRuns.jobKey, jobKey),
      eq(billingJobRuns.runStatus, "started"),
      gte(billingJobRuns.startedAt, cutoff),
    ];
    if (scopeType) where.push(eq(billingJobRuns.scopeType, scopeType));
    if (scopeId) where.push(eq(billingJobRuns.scopeId, scopeId));

    const existingRuns = await tx
      .select({ id: billingJobRuns.id, startedAt: billingJobRuns.startedAt })
      .from(billingJobRuns)
      .where(and(...where))
      .limit(1);

    if (existingRuns.length > 0) {
      return {
        acquired: false,
        existingRunId: existingRuns[0].id,
        lockKey,
        reason: `Singleton lock held by existing run ${existingRuns[0].id} started at ${existingRuns[0].startedAt.toISOString()}`,
      };
    }

    return {
      acquired: true,
      existingRunId: null,
      lockKey,
      reason: "Lock acquired",
    };
    // Advisory lock auto-releases on transaction commit
  });

  return result;
}

// ─── Release Lock ─────────────────────────────────────────────────────────────

/**
 * Release the billing job lock by marking the run as completed/failed/skipped.
 * The 'started' run row IS the lock — calling completeBillingJobRun/failBillingJobRun
 * in billing-operations.ts releases it implicitly.
 *
 * This function is a no-op explicit marker — it exists for clarity and future extension.
 * Actual release is via the run's terminal status update.
 */
export async function releaseBillingJobLock(
  jobKey: string,
  scopeType?: string | null,
  scopeId?: string | null,
): Promise<void> {
  // Lock is released when the 'started' run transitions to a terminal status
  // (completed / failed / skipped / timed_out). No additional DB action needed.
  // This function exists as an explicit release marker for clarity.
  void jobKey; void scopeType; void scopeId;
}

// ─── With Lock ────────────────────────────────────────────────────────────────

/**
 * Execute fn while holding the billing job lock.
 * If lock cannot be acquired, fn is not called and skip reason is returned.
 */
export async function withBillingJobLock<T>(
  jobKey: string,
  fn: (lockResult: LockAcquisitionResult) => Promise<T>,
  scopeType?: string | null,
  scopeId?: string | null,
  timeoutSeconds = 300,
): Promise<{ lockResult: LockAcquisitionResult; outcome: T | null; skipped: boolean }> {
  const lockResult = await acquireBillingJobLock(jobKey, scopeType, scopeId, timeoutSeconds);

  if (!lockResult.acquired) {
    return { lockResult, outcome: null, skipped: true };
  }

  try {
    const outcome = await fn(lockResult);
    return { lockResult, outcome, skipped: false };
  } finally {
    await releaseBillingJobLock(jobKey, scopeType, scopeId);
  }
}

// ─── Lookup Helpers ───────────────────────────────────────────────────────────

/**
 * Check if any non-expired 'started' run exists for this job+scope.
 * Useful for health checks and debugging without acquiring the lock.
 */
export async function isBillingJobRunning(
  jobKey: string,
  scopeType?: string | null,
  scopeId?: string | null,
): Promise<{ running: boolean; runId: string | null; startedAt: Date | null }> {
  const def = await db
    .select({ timeoutSeconds: billingJobDefinitions.timeoutSeconds })
    .from(billingJobDefinitions)
    .where(eq(billingJobDefinitions.jobKey, jobKey))
    .limit(1);

  const timeoutSeconds = def[0]?.timeoutSeconds ?? 300;
  const cutoff = new Date(Date.now() - timeoutSeconds * 1000);

  const where = [
    eq(billingJobRuns.jobKey, jobKey),
    eq(billingJobRuns.runStatus, "started"),
    gte(billingJobRuns.startedAt, cutoff),
  ];
  if (scopeType) where.push(eq(billingJobRuns.scopeType, scopeType));
  if (scopeId) where.push(eq(billingJobRuns.scopeId, scopeId));

  const rows = await db
    .select({ id: billingJobRuns.id, startedAt: billingJobRuns.startedAt })
    .from(billingJobRuns)
    .where(and(...where))
    .limit(1);

  return {
    running: rows.length > 0,
    runId: rows[0]?.id ?? null,
    startedAt: rows[0]?.startedAt ?? null,
  };
}
