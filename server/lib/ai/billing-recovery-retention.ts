/**
 * billing-recovery-retention.ts — Phase 4S Recovery Inspection & Retention Helpers
 *
 * Read-only helpers for inspecting the billing_recovery_runs and billing_recovery_actions
 * tables for auditing, dashboards, and retention-policy queries.
 * Never writes to any table.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecoveryRunAgeReport {
  totalRuns: number;
  oldestRunAt: string | null;
  newestRunAt: string | null;
  runsByAge: Array<{
    ageBucket: string;
    count: number;
  }>;
  runsByType: Array<{
    recoveryType: string;
    count: number;
    lastRunAt: string;
  }>;
}

export interface RecoveryActionStats {
  totalActions: number;
  executedCount: number;
  skippedCount: number;
  failedCount: number;
  plannedCount: number;
  uniqueRunsWithActions: number;
  topTargetTables: Array<{
    targetTable: string;
    count: number;
  }>;
}

export interface RecoveryRetentionCandidate {
  runId: string;
  recoveryType: string;
  status: string;
  startedAt: string;
  ageDays: number;
  actionCount: number;
}

// ─── Inspection helpers ───────────────────────────────────────────────────────

/**
 * Get age distribution report for billing_recovery_runs.
 * Useful for retention-policy review and capacity planning.
 */
export async function getRecoveryRunAgeReport(): Promise<RecoveryRunAgeReport> {
  const totalRow = await db.execute(sql.raw(`
    SELECT
      COUNT(*) AS total_runs,
      MIN(started_at) AS oldest_run_at,
      MAX(started_at) AS newest_run_at
    FROM billing_recovery_runs
  `));

  const ageBucketRows = await db.execute(sql.raw(`
    SELECT
      CASE
        WHEN started_at >= NOW() - INTERVAL '1 day'  THEN '< 1 day'
        WHEN started_at >= NOW() - INTERVAL '7 days' THEN '1–7 days'
        WHEN started_at >= NOW() - INTERVAL '30 days' THEN '7–30 days'
        WHEN started_at >= NOW() - INTERVAL '90 days' THEN '30–90 days'
        ELSE '> 90 days'
      END AS age_bucket,
      COUNT(*) AS cnt
    FROM billing_recovery_runs
    GROUP BY age_bucket
    ORDER BY MIN(started_at) DESC
  `));

  const typeRows = await db.execute(sql.raw(`
    SELECT
      recovery_type,
      COUNT(*) AS cnt,
      MAX(started_at) AS last_run_at
    FROM billing_recovery_runs
    GROUP BY recovery_type
    ORDER BY last_run_at DESC
  `));

  const t = totalRow.rows[0] as any;
  return {
    totalRuns: Number(t?.total_runs ?? 0),
    oldestRunAt: t?.oldest_run_at ? t.oldest_run_at?.toISOString?.() ?? String(t.oldest_run_at) : null,
    newestRunAt: t?.newest_run_at ? t.newest_run_at?.toISOString?.() ?? String(t.newest_run_at) : null,
    runsByAge: (ageBucketRows.rows as any[]).map((r: any) => ({
      ageBucket: r.age_bucket,
      count: Number(r.cnt),
    })),
    runsByType: (typeRows.rows as any[]).map((r: any) => ({
      recoveryType: r.recovery_type,
      count: Number(r.cnt),
      lastRunAt: r.last_run_at?.toISOString?.() ?? String(r.last_run_at),
    })),
  };
}

/**
 * Get aggregate statistics for billing_recovery_actions across all runs.
 */
export async function getRecoveryActionStats(windowDays = 90): Promise<RecoveryActionStats> {
  const totalsRow = await db.execute(sql.raw(`
    SELECT
      COUNT(*) AS total_actions,
      COUNT(*) FILTER (WHERE action_status = 'executed') AS executed_count,
      COUNT(*) FILTER (WHERE action_status = 'skipped')  AS skipped_count,
      COUNT(*) FILTER (WHERE action_status = 'failed')   AS failed_count,
      COUNT(*) FILTER (WHERE action_status = 'planned')  AS planned_count,
      COUNT(DISTINCT billing_recovery_run_id)             AS unique_runs
    FROM billing_recovery_actions
    WHERE created_at >= NOW() - INTERVAL '${windowDays} days'
  `));

  const tableRows = await db.execute(sql.raw(`
    SELECT target_table, COUNT(*) AS cnt
    FROM billing_recovery_actions
    WHERE created_at >= NOW() - INTERVAL '${windowDays} days'
    GROUP BY target_table
    ORDER BY cnt DESC
    LIMIT 10
  `));

  const t = totalsRow.rows[0] as any;
  return {
    totalActions: Number(t?.total_actions ?? 0),
    executedCount: Number(t?.executed_count ?? 0),
    skippedCount: Number(t?.skipped_count ?? 0),
    failedCount: Number(t?.failed_count ?? 0),
    plannedCount: Number(t?.planned_count ?? 0),
    uniqueRunsWithActions: Number(t?.unique_runs ?? 0),
    topTargetTables: (tableRows.rows as any[]).map((r: any) => ({
      targetTable: r.target_table,
      count: Number(r.cnt),
    })),
  };
}

/**
 * Find runs that are candidates for retention/archival based on age threshold.
 * Returns runs older than ageDays that are in a terminal state (completed/failed/skipped).
 * Never deletes — read-only inspection only.
 */
export async function findRetentionCandidates(
  ageDays = 90,
  limit = 200,
): Promise<RecoveryRetentionCandidate[]> {
  const rows = await db.execute(sql.raw(`
    SELECT
      brr.id,
      brr.recovery_type,
      brr.status,
      brr.started_at,
      EXTRACT(EPOCH FROM (NOW() - brr.started_at)) / 86400 AS age_days,
      COALESCE(agg.action_count, 0) AS action_count
    FROM billing_recovery_runs brr
    LEFT JOIN (
      SELECT billing_recovery_run_id, COUNT(*) AS action_count
      FROM billing_recovery_actions
      GROUP BY billing_recovery_run_id
    ) agg ON agg.billing_recovery_run_id = brr.id
    WHERE brr.status IN ('completed','failed','skipped')
      AND brr.started_at < NOW() - INTERVAL '${ageDays} days'
    ORDER BY brr.started_at ASC
    LIMIT ${limit}
  `));

  return (rows.rows as any[]).map((r: any) => ({
    runId: r.id,
    recoveryType: r.recovery_type,
    status: r.status,
    startedAt: r.started_at?.toISOString?.() ?? String(r.started_at),
    ageDays: Math.floor(Number(r.age_days)),
    actionCount: Number(r.action_count),
  }));
}

/**
 * Find stuck recovery runs that are in 'started' status beyond a timeout threshold.
 * These are likely crashed or abandoned runs that need manual attention.
 */
export async function findStuckRecoveryRuns(
  stuckAfterMinutes = 60,
  limit = 50,
): Promise<
  Array<{
    runId: string;
    recoveryType: string;
    scopeType: string;
    scopeId: string | null;
    startedAt: string;
    stuckMinutes: number;
    triggerType: string;
    reason: string;
  }>
> {
  const rows = await db.execute(sql.raw(`
    SELECT
      id,
      recovery_type,
      scope_type,
      scope_id,
      started_at,
      trigger_type,
      reason,
      EXTRACT(EPOCH FROM (NOW() - started_at)) / 60 AS stuck_minutes
    FROM billing_recovery_runs
    WHERE status = 'started'
      AND started_at < NOW() - INTERVAL '${stuckAfterMinutes} minutes'
    ORDER BY started_at ASC
    LIMIT ${limit}
  `));

  return (rows.rows as any[]).map((r: any) => ({
    runId: r.id,
    recoveryType: r.recovery_type,
    scopeType: r.scope_type,
    scopeId: r.scope_id ?? null,
    startedAt: r.started_at?.toISOString?.() ?? String(r.started_at),
    stuckMinutes: Math.floor(Number(r.stuck_minutes)),
    triggerType: r.trigger_type,
    reason: r.reason,
  }));
}

/**
 * Get per-day recovery run counts for the last N days (for sparkline charts).
 */
export async function getRecoveryRunDailyTrend(
  windowDays = 14,
): Promise<Array<{ date: string; totalRuns: number; failedRuns: number; dryRunRuns: number }>> {
  const rows = await db.execute(sql.raw(`
    SELECT
      DATE_TRUNC('day', started_at) AS day,
      COUNT(*) AS total_runs,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed_runs,
      COUNT(*) FILTER (WHERE dry_run = true)    AS dry_run_runs
    FROM billing_recovery_runs
    WHERE started_at >= NOW() - INTERVAL '${windowDays} days'
    GROUP BY day
    ORDER BY day DESC
  `));

  return (rows.rows as any[]).map((r: any) => ({
    date: r.day?.toISOString?.()?.split("T")[0] ?? String(r.day),
    totalRuns: Number(r.total_runs),
    failedRuns: Number(r.failed_runs),
    dryRunRuns: Number(r.dry_run_runs),
  }));
}
