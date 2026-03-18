/**
 * Billing Ops Retention Inspection — Phase 4R
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Inspection helpers for the billing operations job system.
 * All functions are read-only — no destructive operations.
 * Focus: identifying candidates for future retention/cleanup operations.
 *
 * Design rules:
 *   A) days > 0 enforced on all time-bounded helpers
 *   B) No destructive cleanup in Phase 4R — inspection only
 *   C) Structured return types for admin dashboard consumption
 *   D) Safe to call repeatedly — no side effects
 */

import { eq, and, desc, lt, sql, isNull, inArray, not } from "drizzle-orm";
import { db } from "../../db";
import { billingJobDefinitions, billingJobRuns } from "@shared/schema";
import type { BillingJobDefinition, BillingJobRun } from "@shared/schema";

// ─── Retention Policy ─────────────────────────────────────────────────────────

export interface BillingOpsRetentionPolicy {
  description: string;
  completedRunRetentionDays: number;
  failedRunRetentionDays: number;
  timedOutRunRetentionDays: number;
  skippedRunRetentionDays: number;
  definitionRetentionNote: string;
  cleanupAllowed: boolean;
}

export function explainBillingOpsRetentionPolicy(): BillingOpsRetentionPolicy {
  return {
    description:
      "Billing job run records are operational audit logs. Retention is conservative by default. " +
      "Completed runs older than 90 days may be candidates for archival. " +
      "Failed and timed-out runs should be retained for longer for ops investigation. " +
      "No destructive cleanup is implemented in Phase 4R.",
    completedRunRetentionDays: 90,
    failedRunRetentionDays: 365,
    timedOutRunRetentionDays: 365,
    skippedRunRetentionDays: 30,
    definitionRetentionNote:
      "Job definitions should never be deleted while their runs are retained. " +
      "Archive definitions by setting status='archived' instead.",
    cleanupAllowed: false,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function guardDays(days: number): void {
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`[billing-ops-retention] days must be > 0 (got: ${days})`);
  }
}

// ─── Completed Run Preview ────────────────────────────────────────────────────

export interface CompletedJobRunPreview {
  runId: string;
  jobKey: string;
  completedAt: string;
  durationMs: number | null;
  attemptNumber: number;
  ageApproxDays: number;
}

export async function previewCompletedJobRunsOlderThan(
  days: number,
): Promise<CompletedJobRunPreview[]> {
  guardDays(days);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: billingJobRuns.id,
      jobKey: billingJobRuns.jobKey,
      completedAt: billingJobRuns.completedAt,
      durationMs: billingJobRuns.durationMs,
      attemptNumber: billingJobRuns.attemptNumber,
      startedAt: billingJobRuns.startedAt,
    })
    .from(billingJobRuns)
    .where(
      and(
        eq(billingJobRuns.runStatus, "completed"),
        lt(billingJobRuns.completedAt, cutoff),
      ),
    )
    .orderBy(billingJobRuns.completedAt)
    .limit(500);

  const now = Date.now();
  return rows.map((r) => ({
    runId: r.id,
    jobKey: r.jobKey,
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : "",
    durationMs: r.durationMs ?? null,
    attemptNumber: r.attemptNumber,
    ageApproxDays: Math.floor(
      (now - new Date(r.completedAt ?? r.startedAt).getTime()) / (24 * 60 * 60 * 1000),
    ),
  }));
}

// ─── Failed Run Preview ───────────────────────────────────────────────────────

export interface FailedJobRunPreview {
  runId: string;
  jobKey: string;
  runStatus: string;
  startedAt: string;
  completedAt: string | null;
  errorMessage: string | null;
  attemptNumber: number;
  ageApproxDays: number;
}

export async function previewFailedJobRunsOlderThan(
  days: number,
): Promise<FailedJobRunPreview[]> {
  guardDays(days);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: billingJobRuns.id,
      jobKey: billingJobRuns.jobKey,
      runStatus: billingJobRuns.runStatus,
      startedAt: billingJobRuns.startedAt,
      completedAt: billingJobRuns.completedAt,
      errorMessage: billingJobRuns.errorMessage,
      attemptNumber: billingJobRuns.attemptNumber,
    })
    .from(billingJobRuns)
    .where(
      and(
        eq(billingJobRuns.runStatus, "failed"),
        lt(billingJobRuns.startedAt, cutoff),
      ),
    )
    .orderBy(billingJobRuns.startedAt)
    .limit(500);

  const now = Date.now();
  return rows.map((r) => ({
    runId: r.id,
    jobKey: r.jobKey,
    runStatus: r.runStatus,
    startedAt: new Date(r.startedAt).toISOString(),
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    errorMessage: r.errorMessage ?? null,
    attemptNumber: r.attemptNumber,
    ageApproxDays: Math.floor(
      (now - new Date(r.startedAt).getTime()) / (24 * 60 * 60 * 1000),
    ),
  }));
}

// ─── Timed Out Run Preview ────────────────────────────────────────────────────

export interface TimedOutJobRunPreview {
  runId: string;
  jobKey: string;
  startedAt: string;
  completedAt: string | null;
  ageApproxDays: number;
  scopeType: string | null;
  scopeId: string | null;
}

export async function previewTimedOutJobRunsOlderThan(
  days: number,
): Promise<TimedOutJobRunPreview[]> {
  guardDays(days);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const rows = await db
    .select({
      id: billingJobRuns.id,
      jobKey: billingJobRuns.jobKey,
      startedAt: billingJobRuns.startedAt,
      completedAt: billingJobRuns.completedAt,
      scopeType: billingJobRuns.scopeType,
      scopeId: billingJobRuns.scopeId,
    })
    .from(billingJobRuns)
    .where(
      and(
        eq(billingJobRuns.runStatus, "timed_out"),
        lt(billingJobRuns.startedAt, cutoff),
      ),
    )
    .orderBy(billingJobRuns.startedAt)
    .limit(500);

  const now = Date.now();
  return rows.map((r) => ({
    runId: r.id,
    jobKey: r.jobKey,
    startedAt: new Date(r.startedAt).toISOString(),
    completedAt: r.completedAt ? new Date(r.completedAt).toISOString() : null,
    ageApproxDays: Math.floor(
      (now - new Date(r.startedAt).getTime()) / (24 * 60 * 60 * 1000),
    ),
    scopeType: r.scopeType ?? null,
    scopeId: r.scopeId ?? null,
  }));
}

// ─── Definitions Without Runs ─────────────────────────────────────────────────

export interface JobDefinitionWithoutRuns {
  definitionId: string;
  jobKey: string;
  jobName: string;
  status: string;
  createdAt: string;
  scheduleType: string;
}

export async function previewJobDefinitionsWithoutRuns(): Promise<JobDefinitionWithoutRuns[]> {
  const defs = await db.select().from(billingJobDefinitions);

  const result: JobDefinitionWithoutRuns[] = [];

  for (const def of defs) {
    const runs = await db
      .select({ id: billingJobRuns.id })
      .from(billingJobRuns)
      .where(eq(billingJobRuns.jobKey, def.jobKey))
      .limit(1);

    if (runs.length === 0) {
      result.push({
        definitionId: def.id,
        jobKey: def.jobKey,
        jobName: def.jobName,
        status: def.status,
        createdAt: new Date(def.createdAt).toISOString(),
        scheduleType: def.scheduleType,
      });
    }
  }

  return result;
}

// ─── Duplicate Started Runs ───────────────────────────────────────────────────

export interface DuplicateStartedRunGroup {
  jobKey: string;
  scopeType: string | null;
  scopeId: string | null;
  startedRunCount: number;
  runIds: string[];
  oldestStartedAt: string;
  newestStartedAt: string;
}

export async function previewDuplicateStartedRuns(): Promise<DuplicateStartedRunGroup[]> {
  const startedRuns = await db
    .select({
      id: billingJobRuns.id,
      jobKey: billingJobRuns.jobKey,
      scopeType: billingJobRuns.scopeType,
      scopeId: billingJobRuns.scopeId,
      startedAt: billingJobRuns.startedAt,
    })
    .from(billingJobRuns)
    .where(eq(billingJobRuns.runStatus, "started"))
    .orderBy(billingJobRuns.jobKey, billingJobRuns.startedAt);

  // Group by (jobKey, scopeType, scopeId)
  const grouped = new Map<string, typeof startedRuns>();
  for (const run of startedRuns) {
    const key = `${run.jobKey}|${run.scopeType ?? ""}|${run.scopeId ?? ""}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(run);
  }

  const result: DuplicateStartedRunGroup[] = [];
  for (const [, runs] of grouped) {
    if (runs.length > 1) {
      const sorted = [...runs].sort(
        (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime(),
      );
      result.push({
        jobKey: runs[0].jobKey,
        scopeType: runs[0].scopeType ?? null,
        scopeId: runs[0].scopeId ?? null,
        startedRunCount: runs.length,
        runIds: runs.map((r) => r.id),
        oldestStartedAt: new Date(sorted[0].startedAt).toISOString(),
        newestStartedAt: new Date(sorted[sorted.length - 1].startedAt).toISOString(),
      });
    }
  }

  return result;
}
