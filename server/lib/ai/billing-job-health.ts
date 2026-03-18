/**
 * Billing Job Health — Phase 4R
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides read-only operational health views for the automated billing job system.
 * All helpers are deterministic and non-destructive.
 *
 * Design rules:
 *   A) Read-only — no mutations
 *   B) olderThanMinutes > 0 guard on time-bounded queries
 *   C) Health summary aggregates from live billing_job_runs data
 *   D) Stale = 'started' status older than timeout_seconds (per definition)
 */

import { eq, and, desc, lt, inArray, sql, gte, not } from "drizzle-orm";
import { db } from "../../db";
import { billingJobDefinitions, billingJobRuns } from "@shared/schema";
import type { BillingJobDefinition, BillingJobRun } from "@shared/schema";

// ─── Definitions ──────────────────────────────────────────────────────────────

export async function listBillingJobDefinitions(): Promise<BillingJobDefinition[]> {
  return db
    .select()
    .from(billingJobDefinitions)
    .orderBy(billingJobDefinitions.jobCategory, billingJobDefinitions.jobKey);
}

// ─── Runs ─────────────────────────────────────────────────────────────────────

export async function listRecentBillingJobRuns(limit = 50): Promise<BillingJobRun[]> {
  return db
    .select()
    .from(billingJobRuns)
    .orderBy(desc(billingJobRuns.startedAt))
    .limit(limit);
}

export async function getBillingJobRunById(runId: string): Promise<BillingJobRun | null> {
  const rows = await db
    .select()
    .from(billingJobRuns)
    .where(eq(billingJobRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

// ─── Health Summary ───────────────────────────────────────────────────────────

export interface BillingJobHealthSummary {
  activeJobCount: number;
  pausedJobCount: number;
  archivedJobCount: number;
  totalJobCount: number;
  recentCompletedCount: number;
  recentFailedCount: number;
  recentTimedOutCount: number;
  recentSkippedCount: number;
  staleStartedCount: number;
  jobsMissingRecentSuccess: number;
  windowHours: number;
  computedAt: string;
}

export async function getBillingJobHealthSummary(windowHours = 24): Promise<BillingJobHealthSummary> {
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const [defRow] = await db
    .select({
      activeCount: sql<number>`count(*) filter (where status = 'active')::int`,
      pausedCount: sql<number>`count(*) filter (where status = 'paused')::int`,
      archivedCount: sql<number>`count(*) filter (where status = 'archived')::int`,
      totalCount: sql<number>`count(*)::int`,
    })
    .from(billingJobDefinitions);

  const [runRow] = await db
    .select({
      completedCount: sql<number>`count(*) filter (where run_status = 'completed')::int`,
      failedCount: sql<number>`count(*) filter (where run_status = 'failed')::int`,
      timedOutCount: sql<number>`count(*) filter (where run_status = 'timed_out')::int`,
      skippedCount: sql<number>`count(*) filter (where run_status = 'skipped')::int`,
    })
    .from(billingJobRuns)
    .where(gte(billingJobRuns.startedAt, windowStart));

  const staleRows = await previewStaleBillingJobRuns(0);
  const missingSuccessJobs = await previewJobsWithoutRecentSuccessfulRun(windowHours * 60);

  return {
    activeJobCount: defRow?.activeCount ?? 0,
    pausedJobCount: defRow?.pausedCount ?? 0,
    archivedJobCount: defRow?.archivedCount ?? 0,
    totalJobCount: defRow?.totalCount ?? 0,
    recentCompletedCount: runRow?.completedCount ?? 0,
    recentFailedCount: runRow?.failedCount ?? 0,
    recentTimedOutCount: runRow?.timedOutCount ?? 0,
    recentSkippedCount: runRow?.skippedCount ?? 0,
    staleStartedCount: staleRows.length,
    jobsMissingRecentSuccess: missingSuccessJobs.length,
    windowHours,
    computedAt: new Date().toISOString(),
  };
}

// ─── Stale Runs ───────────────────────────────────────────────────────────────

export interface StaleBillingJobRun {
  runId: string;
  jobKey: string;
  startedAt: string;
  ageMinutes: number;
  timeoutSeconds: number;
  scopeType: string | null;
  scopeId: string | null;
}

export async function previewStaleBillingJobRuns(
  olderThanMinutes: number,
): Promise<StaleBillingJobRun[]> {
  const cutoffMinutes = Math.max(0, olderThanMinutes);
  const cutoff = new Date(Date.now() - cutoffMinutes * 60 * 1000);

  const runRows = await db
    .select({
      runId: billingJobRuns.id,
      jobKey: billingJobRuns.jobKey,
      startedAt: billingJobRuns.startedAt,
      scopeType: billingJobRuns.scopeType,
      scopeId: billingJobRuns.scopeId,
      defTimeoutSeconds: billingJobDefinitions.timeoutSeconds,
    })
    .from(billingJobRuns)
    .innerJoin(
      billingJobDefinitions,
      eq(billingJobRuns.jobKey, billingJobDefinitions.jobKey),
    )
    .where(
      and(
        eq(billingJobRuns.runStatus, "started"),
        lt(billingJobRuns.startedAt, cutoff),
      ),
    )
    .orderBy(billingJobRuns.startedAt);

  const now = Date.now();
  return runRows
    .filter((r) => {
      const ageMs = now - new Date(r.startedAt).getTime();
      return ageMs > r.defTimeoutSeconds * 1000;
    })
    .map((r) => ({
      runId: r.runId,
      jobKey: r.jobKey,
      startedAt: new Date(r.startedAt).toISOString(),
      ageMinutes: Math.floor((now - new Date(r.startedAt).getTime()) / 60000),
      timeoutSeconds: r.defTimeoutSeconds,
      scopeType: r.scopeType ?? null,
      scopeId: r.scopeId ?? null,
    }));
}

// ─── Failed Jobs ──────────────────────────────────────────────────────────────

export async function previewFailedBillingJobs(limit = 50): Promise<BillingJobRun[]> {
  return db
    .select()
    .from(billingJobRuns)
    .where(inArray(billingJobRuns.runStatus, ["failed", "timed_out"]))
    .orderBy(desc(billingJobRuns.startedAt))
    .limit(limit);
}

// ─── Jobs Without Recent Success ─────────────────────────────────────────────

export interface JobWithoutRecentSuccess {
  jobKey: string;
  jobName: string;
  status: string;
  lastSuccessAt: string | null;
  lastRunAt: string | null;
  minutesSinceLastSuccess: number | null;
}

export async function previewJobsWithoutRecentSuccessfulRun(
  olderThanMinutes: number,
): Promise<JobWithoutRecentSuccess[]> {
  if (olderThanMinutes <= 0) {
    throw new Error("[billing-job-health] olderThanMinutes must be > 0");
  }

  const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);
  const defs = await db
    .select()
    .from(billingJobDefinitions)
    .where(inArray(billingJobDefinitions.status, ["active", "paused"]));

  const result: JobWithoutRecentSuccess[] = [];

  for (const def of defs) {
    const lastSuccess = await db
      .select({ completedAt: billingJobRuns.completedAt })
      .from(billingJobRuns)
      .where(
        and(
          eq(billingJobRuns.jobKey, def.jobKey),
          eq(billingJobRuns.runStatus, "completed"),
        ),
      )
      .orderBy(desc(billingJobRuns.completedAt))
      .limit(1);

    const lastRun = await db
      .select({ startedAt: billingJobRuns.startedAt })
      .from(billingJobRuns)
      .where(eq(billingJobRuns.jobKey, def.jobKey))
      .orderBy(desc(billingJobRuns.startedAt))
      .limit(1);

    const lastSuccessAt = lastSuccess[0]?.completedAt ?? null;
    const lastRunAt = lastRun[0]?.startedAt ?? null;

    const hasRecentSuccess = lastSuccessAt
      ? new Date(lastSuccessAt) >= cutoff
      : false;

    if (!hasRecentSuccess) {
      const minutesSinceLastSuccess = lastSuccessAt
        ? Math.floor((Date.now() - new Date(lastSuccessAt).getTime()) / 60000)
        : null;

      result.push({
        jobKey: def.jobKey,
        jobName: def.jobName,
        status: def.status,
        lastSuccessAt: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null,
        lastRunAt: lastRunAt ? new Date(lastRunAt).toISOString() : null,
        minutesSinceLastSuccess,
      });
    }
  }

  return result;
}

// ─── Explain Job State ────────────────────────────────────────────────────────

export interface BillingJobStateExplanation {
  jobKey: string;
  definition: BillingJobDefinition | null;
  latestRun: BillingJobRun | null;
  isRunning: boolean;
  latestRunStatus: string | null;
  latestRunAgeMinutes: number | null;
  isStale: boolean;
  explanation: string;
}

export async function explainBillingJobState(
  jobKey: string,
  scopeType?: string | null,
  scopeId?: string | null,
): Promise<BillingJobStateExplanation> {
  const defRows = await db
    .select()
    .from(billingJobDefinitions)
    .where(eq(billingJobDefinitions.jobKey, jobKey))
    .limit(1);

  const definition = defRows[0] ?? null;

  const where = [eq(billingJobRuns.jobKey, jobKey)];
  if (scopeType) where.push(eq(billingJobRuns.scopeType, scopeType));
  if (scopeId) where.push(eq(billingJobRuns.scopeId, scopeId));

  const latestRunRows = await db
    .select()
    .from(billingJobRuns)
    .where(and(...where))
    .orderBy(desc(billingJobRuns.startedAt))
    .limit(1);

  const latestRun = latestRunRows[0] ?? null;
  const isRunning = latestRun?.runStatus === "started";
  const timeoutSeconds = definition?.timeoutSeconds ?? 300;

  const ageMinutes = latestRun
    ? Math.floor((Date.now() - new Date(latestRun.startedAt).getTime()) / 60000)
    : null;

  const isStale = isRunning && ageMinutes !== null && ageMinutes > timeoutSeconds / 60;

  let explanation: string;
  if (!definition) {
    explanation = `No job definition found for key '${jobKey}'`;
  } else if (!latestRun) {
    explanation = `Job '${jobKey}' is defined (${definition.status}) but has never run`;
  } else if (isStale) {
    explanation = `Job '${jobKey}' has a stale 'started' run ${ageMinutes}m old (timeout: ${timeoutSeconds}s). May need manual resolution.`;
  } else if (isRunning) {
    explanation = `Job '${jobKey}' is currently running (started ${ageMinutes}m ago)`;
  } else {
    explanation = `Job '${jobKey}' last ran ${ageMinutes}m ago — status: ${latestRun.runStatus}`;
  }

  return {
    jobKey,
    definition,
    latestRun,
    isRunning,
    latestRunStatus: latestRun?.runStatus ?? null,
    latestRunAgeMinutes: ageMinutes,
    isStale,
    explanation,
  };
}
