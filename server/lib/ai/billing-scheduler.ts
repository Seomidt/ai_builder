/**
 * Billing Scheduler — Phase 4R
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Scheduler-safe entrypoint for triggering billing jobs by schedule.
 * This is the only way external triggers (cron, platform scheduler) should
 * invoke billing jobs. All execution still goes through runBillingJob.
 *
 * Design rules:
 *   A) No direct execution — all runs go through runBillingJob
 *   B) Conservative due-job logic — only runs active jobs with explicit schedules
 *   C) 'manual' schedule_type jobs are never auto-triggered by scheduler
 *   D) Interval jobs: due if last completed run is older than interval_seconds
 *   E) No full cron parser — interval-only auto-scheduling in Phase 4R
 *   F) Paused/archived jobs are never triggered by scheduler
 */

import { eq, and, desc, inArray } from "drizzle-orm";
import { db } from "../../db";
import { billingJobDefinitions, billingJobRuns } from "@shared/schema";
import type { BillingJobDefinition } from "@shared/schema";
import { runBillingJob } from "./billing-operations";
import type { BillingJobRunResult } from "./billing-operations";

// ─── Due Job Detection ────────────────────────────────────────────────────────

export interface DueJob {
  definition: BillingJobDefinition;
  reason: string;
  lastCompletedAt: Date | null;
  secondsSinceLastSuccess: number | null;
}

/**
 * Determine which active interval-scheduled jobs are due to run.
 * Conservative logic: only triggers interval jobs past their interval.
 * 'manual' and 'cron' schedule_type jobs are never auto-triggered here.
 */
export async function getDueBillingJobs(): Promise<DueJob[]> {
  const activeDefs = await db
    .select()
    .from(billingJobDefinitions)
    .where(
      and(
        eq(billingJobDefinitions.status, "active"),
        eq(billingJobDefinitions.scheduleType, "interval"),
      ),
    );

  const dueJobs: DueJob[] = [];
  const now = Date.now();

  for (const def of activeDefs) {
    const intervalSeconds = parseIntervalExpression(def.scheduleExpression);
    if (intervalSeconds === null || intervalSeconds <= 0) {
      continue;
    }

    const lastCompleted = await db
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

    const lastCompletedAt = lastCompleted[0]?.completedAt ?? null;
    const secondsSinceLastSuccess = lastCompletedAt
      ? Math.floor((now - new Date(lastCompletedAt).getTime()) / 1000)
      : null;

    const isDue =
      lastCompletedAt === null ||
      secondsSinceLastSuccess === null ||
      secondsSinceLastSuccess >= intervalSeconds;

    if (isDue) {
      dueJobs.push({
        definition: def,
        reason: lastCompletedAt
          ? `Last completed ${secondsSinceLastSuccess}s ago, interval is ${intervalSeconds}s`
          : "Never completed — first run due",
        lastCompletedAt,
        secondsSinceLastSuccess,
      });
    }
  }

  return dueJobs;
}

/**
 * Conservative interval expression parser.
 * Accepts numeric strings only (seconds). Returns null if unparseable.
 */
function parseIntervalExpression(expression: string | null | undefined): number | null {
  if (!expression) return null;
  const seconds = parseInt(expression, 10);
  if (isNaN(seconds) || seconds <= 0) return null;
  return seconds;
}

// ─── Scheduler Entrypoint ─────────────────────────────────────────────────────

export interface SchedulerTriggerResult {
  triggered: number;
  skipped: number;
  failed: number;
  results: Array<{
    jobKey: string;
    status: "triggered" | "skipped" | "failed";
    runResult: BillingJobRunResult | null;
    skipReason: string | null;
    error: string | null;
  }>;
  computedAt: string;
}

/**
 * Main scheduler entrypoint. Finds all due jobs and triggers them via runBillingJob.
 * Safe to call from cron or periodic platform timer.
 * All execution goes through the central job engine — no bypass.
 */
export async function triggerDueBillingJobs(): Promise<SchedulerTriggerResult> {
  const dueJobs = await getDueBillingJobs();

  let triggered = 0;
  let skipped = 0;
  let failed = 0;
  const results: SchedulerTriggerResult["results"] = [];

  for (const { definition } of dueJobs) {
    try {
      const runResult = await runBillingJob(definition.jobKey, {
        triggerType: "scheduled",
      });

      if (runResult.skipped) {
        skipped++;
        results.push({
          jobKey: definition.jobKey,
          status: "skipped",
          runResult,
          skipReason: runResult.skipReason ?? null,
          error: null,
        });
      } else if (runResult.runStatus === "failed") {
        failed++;
        results.push({
          jobKey: definition.jobKey,
          status: "failed",
          runResult,
          skipReason: null,
          error: runResult.errorMessage ?? null,
        });
      } else {
        triggered++;
        results.push({
          jobKey: definition.jobKey,
          status: "triggered",
          runResult,
          skipReason: null,
          error: null,
        });
      }
    } catch (err) {
      failed++;
      results.push({
        jobKey: definition.jobKey,
        status: "failed",
        runResult: null,
        skipReason: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return {
    triggered,
    skipped,
    failed,
    results,
    computedAt: new Date().toISOString(),
  };
}

// ─── Scheduler Status ─────────────────────────────────────────────────────────

export interface SchedulerStatus {
  activeIntervalJobs: number;
  dueNow: number;
  dueJobs: Array<{
    jobKey: string;
    intervalSeconds: number | null;
    lastCompletedAt: string | null;
    secondsSinceLastSuccess: number | null;
    reason: string;
  }>;
  computedAt: string;
}

export async function getSchedulerStatus(): Promise<SchedulerStatus> {
  const activeDefs = await db
    .select()
    .from(billingJobDefinitions)
    .where(
      and(
        eq(billingJobDefinitions.status, "active"),
        eq(billingJobDefinitions.scheduleType, "interval"),
      ),
    );

  const dueJobs = await getDueBillingJobs();

  return {
    activeIntervalJobs: activeDefs.length,
    dueNow: dueJobs.length,
    dueJobs: dueJobs.map((j) => ({
      jobKey: j.definition.jobKey,
      intervalSeconds: parseIntervalExpression(j.definition.scheduleExpression),
      lastCompletedAt: j.lastCompletedAt ? new Date(j.lastCompletedAt).toISOString() : null,
      secondsSinceLastSuccess: j.secondsSinceLastSuccess,
      reason: j.reason,
    })),
    computedAt: new Date().toISOString(),
  };
}
