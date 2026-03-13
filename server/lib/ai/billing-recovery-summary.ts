/**
 * billing-recovery-summary.ts — Phase 4S Recovery Explain & Detail Helpers
 *
 * Read-only helpers for explaining recovery run state and providing structured
 * detail views of billing_recovery_runs and billing_recovery_actions.
 * Never writes to any table.
 */

import { db } from "../../db";
import { eq, desc, and, sql } from "drizzle-orm";
import { billingRecoveryRuns, billingRecoveryActions } from "../../../shared/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecoveryRunDetail {
  id: string;
  recoveryType: string;
  scopeType: string;
  scopeId: string | null;
  status: string;
  triggerType: string;
  reason: string;
  dryRun: boolean;
  resultSummary: Record<string, unknown> | null;
  errorMessage: string | null;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  actions: RecoveryActionDetail[];
}

export interface RecoveryActionDetail {
  id: string;
  actionType: string;
  targetTable: string;
  targetId: string | null;
  actionStatus: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface RecoveryRunSummaryRow {
  id: string;
  recoveryType: string;
  scopeType: string;
  scopeId: string | null;
  status: string;
  dryRun: boolean;
  triggerType: string;
  reason: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
  executedCount: number;
  skippedCount: number;
  failedCount: number;
}

// ─── Functions ────────────────────────────────────────────────────────────────

/**
 * Get full detail for a single recovery run including all its actions.
 */
export async function getRecoveryRunDetail(runId: string): Promise<RecoveryRunDetail | null> {
  const runs = await db
    .select()
    .from(billingRecoveryRuns)
    .where(eq(billingRecoveryRuns.id, runId));

  if (runs.length === 0) return null;
  const run = runs[0];

  const actions = await db
    .select()
    .from(billingRecoveryActions)
    .where(eq(billingRecoveryActions.billingRecoveryRunId, runId))
    .orderBy(billingRecoveryActions.createdAt);

  const durationMs =
    run.startedAt && run.completedAt
      ? run.completedAt.getTime() - run.startedAt.getTime()
      : null;

  return {
    id: run.id,
    recoveryType: run.recoveryType,
    scopeType: run.scopeType,
    scopeId: run.scopeId ?? null,
    status: run.status,
    triggerType: run.triggerType,
    reason: run.reason,
    dryRun: run.dryRun,
    resultSummary: (run.resultSummary as Record<string, unknown>) ?? null,
    errorMessage: run.errorMessage ?? null,
    startedAt: run.startedAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
    durationMs,
    actions: actions.map((a) => ({
      id: a.id,
      actionType: a.actionType,
      targetTable: a.targetTable,
      targetId: a.targetId ?? null,
      actionStatus: a.actionStatus,
      beforeState: (a.beforeState as Record<string, unknown>) ?? null,
      afterState: (a.afterState as Record<string, unknown>) ?? null,
      details: (a.details as Record<string, unknown>) ?? null,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

/**
 * List recovery runs with aggregate action counts.
 * Supports optional filter by recoveryType, scopeType, scopeId, status.
 */
export async function listRecoveryRuns(opts: {
  recoveryType?: string;
  scopeType?: string;
  scopeId?: string;
  status?: string;
  dryRun?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ runs: RecoveryRunSummaryRow[]; total: number }> {
  const { recoveryType, scopeType, scopeId, status, dryRun, limit = 50, offset = 0 } = opts;

  const conditions: string[] = [];
  if (recoveryType) conditions.push(`brr.recovery_type = '${recoveryType.replace(/'/g, "''")}'`);
  if (scopeType) conditions.push(`brr.scope_type = '${scopeType.replace(/'/g, "''")}'`);
  if (scopeId) conditions.push(`brr.scope_id = '${scopeId.replace(/'/g, "''")}'`);
  if (status) conditions.push(`brr.status = '${status.replace(/'/g, "''")}'`);
  if (dryRun !== undefined) conditions.push(`brr.dry_run = ${dryRun}`);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const rows = await db.execute(sql.raw(`
    SELECT
      brr.id,
      brr.recovery_type,
      brr.scope_type,
      brr.scope_id,
      brr.status,
      brr.dry_run,
      brr.trigger_type,
      brr.reason,
      brr.started_at,
      brr.completed_at,
      CASE WHEN brr.started_at IS NOT NULL AND brr.completed_at IS NOT NULL
           THEN EXTRACT(EPOCH FROM (brr.completed_at - brr.started_at)) * 1000
           ELSE NULL
      END AS duration_ms,
      COALESCE(agg.executed_count, 0) AS executed_count,
      COALESCE(agg.skipped_count, 0)  AS skipped_count,
      COALESCE(agg.failed_count, 0)   AS failed_count
    FROM billing_recovery_runs brr
    LEFT JOIN (
      SELECT
        billing_recovery_run_id,
        COUNT(*) FILTER (WHERE action_status = 'executed') AS executed_count,
        COUNT(*) FILTER (WHERE action_status = 'skipped')  AS skipped_count,
        COUNT(*) FILTER (WHERE action_status = 'failed')   AS failed_count
      FROM billing_recovery_actions
      GROUP BY billing_recovery_run_id
    ) agg ON agg.billing_recovery_run_id = brr.id
    ${where}
    ORDER BY brr.started_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `));

  const countRow = await db.execute(sql.raw(`
    SELECT COUNT(*) AS cnt FROM billing_recovery_runs brr ${where}
  `));

  const total = Number((countRow.rows[0] as any)?.cnt ?? 0);

  const runs: RecoveryRunSummaryRow[] = (rows.rows as any[]).map((r: any) => ({
    id: r.id,
    recoveryType: r.recovery_type,
    scopeType: r.scope_type,
    scopeId: r.scope_id ?? null,
    status: r.status,
    dryRun: r.dry_run,
    triggerType: r.trigger_type,
    reason: r.reason,
    startedAt: r.started_at?.toISOString?.() ?? String(r.started_at),
    completedAt: r.completed_at ? (r.completed_at?.toISOString?.() ?? String(r.completed_at)) : null,
    durationMs: r.duration_ms !== null && r.duration_ms !== undefined ? Number(r.duration_ms) : null,
    executedCount: Number(r.executed_count),
    skippedCount: Number(r.skipped_count),
    failedCount: Number(r.failed_count),
  }));

  return { runs, total };
}

/**
 * Explain a recovery run: structured human-readable explanation of what happened.
 */
export async function explainRecoveryRun(runId: string): Promise<{
  runId: string;
  headline: string;
  detail: string;
  actionsBreakdown: Record<string, number>;
  warnings: string[];
} | null> {
  const detail = await getRecoveryRunDetail(runId);
  if (!detail) return null;

  const actionsBreakdown: Record<string, number> = {};
  for (const a of detail.actions) {
    actionsBreakdown[a.actionStatus] = (actionsBreakdown[a.actionStatus] ?? 0) + 1;
  }

  const warnings: string[] = [];
  if (detail.dryRun) {
    warnings.push("This was a dry-run — no changes were applied to canonical billing data");
  }
  if (actionsBreakdown["failed"] > 0) {
    warnings.push(`${actionsBreakdown["failed"]} action(s) failed — check action details`);
  }
  if (detail.status === "failed" && !detail.errorMessage) {
    warnings.push("Run status is failed but no top-level error message was recorded");
  }

  const headline =
    detail.status === "completed"
      ? `Recovery run completed successfully (${actionsBreakdown["executed"] ?? 0} action(s) applied)`
      : detail.status === "failed"
        ? `Recovery run failed — ${detail.errorMessage ?? "see action details"}`
        : detail.status === "skipped"
          ? "Recovery run was skipped — nothing to do"
          : `Recovery run is in '${detail.status}' state`;

  const executedActions = detail.actions.filter((a) => a.actionStatus === "executed");
  const tableSet = [...new Set(executedActions.map((a) => a.targetTable))];

  const detailStr = [
    `Type: ${detail.recoveryType}`,
    `Scope: ${detail.scopeType}${detail.scopeId ? ` / ${detail.scopeId}` : ""}`,
    `Trigger: ${detail.triggerType}`,
    `Reason: ${detail.reason}`,
    `Duration: ${detail.durationMs !== null ? `${detail.durationMs}ms` : "unknown"}`,
    tableSet.length > 0 ? `Affected tables: ${tableSet.join(", ")}` : "No tables affected",
  ].join(" | ");

  return { runId, headline, detail: detailStr, actionsBreakdown, warnings };
}

/**
 * Get aggregate stats for recovery runs grouped by recovery_type and status.
 */
export async function getRecoveryRunStats(windowDays = 30): Promise<
  Array<{
    recoveryType: string;
    status: string;
    dryRun: boolean;
    count: number;
    lastRunAt: string;
  }>
> {
  const rows = await db.execute(sql.raw(`
    SELECT
      recovery_type,
      status,
      dry_run,
      COUNT(*) AS cnt,
      MAX(started_at) AS last_run_at
    FROM billing_recovery_runs
    WHERE started_at >= NOW() - INTERVAL '${windowDays} days'
    GROUP BY recovery_type, status, dry_run
    ORDER BY last_run_at DESC
  `));

  return (rows.rows as any[]).map((r: any) => ({
    recoveryType: r.recovery_type,
    status: r.status,
    dryRun: r.dry_run,
    count: Number(r.cnt),
    lastRunAt: r.last_run_at?.toISOString?.() ?? String(r.last_run_at),
  }));
}
