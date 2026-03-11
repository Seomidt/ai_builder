/**
 * AI Step Budget Retention — Phase 3L
 *
 * SERVER-ONLY: Must never be imported from client/ code.
 *
 * Foundation-only module: contains exact SQL for preview and cleanup of
 * ai_request_step_states and ai_request_step_events rows past their retention window.
 *
 * Retention windows:
 *   - ai_request_step_states: uses expires_at column (24h TTL per row)
 *   - ai_request_step_events: 30 days (aligned with request_state_events retention)
 *
 * No scheduler. No auto-run. Manual execution only.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";

export const STEP_EVENT_RETENTION_DAYS = 30;

// ─── Step States (expires_at based) ──────────────────────────────────────────

export interface StepStateCleanupResult {
  rowsDeleted: number;
  executedAt: Date;
}

/**
 * Preview how many ai_request_step_states rows have passed their expires_at.
 */
export async function previewStepStateCleanup(): Promise<{
  rowsEligibleForDeletion: number;
}> {
  const result = await db.execute(
    sql`SELECT count(*)::int AS cnt FROM ai_request_step_states WHERE expires_at < NOW()`,
  );
  return {
    rowsEligibleForDeletion: Number((result.rows[0] as { cnt: number }).cnt ?? 0),
  };
}

/**
 * Delete ai_request_step_states rows where expires_at < NOW().
 *
 * SQL:
 *   DELETE FROM ai_request_step_states WHERE expires_at < NOW()
 */
export async function runStepStateCleanup(): Promise<StepStateCleanupResult> {
  const executedAt = new Date();
  const result = await db.execute(
    sql`DELETE FROM ai_request_step_states WHERE expires_at < NOW()`,
  );
  const rowsDeleted = result.rowCount ?? 0;
  console.info(
    `[step-budget-retention] Deleted ${rowsDeleted} expired ai_request_step_states rows`,
  );
  return { rowsDeleted, executedAt };
}

// ─── Step Events (created_at based) ──────────────────────────────────────────

export interface StepEventCleanupResult {
  rowsDeleted: number;
  retentionDays: number;
  cutoffDate: Date;
  executedAt: Date;
}

/**
 * Preview how many ai_request_step_events rows are older than STEP_EVENT_RETENTION_DAYS.
 */
export async function previewStepEventCleanup(): Promise<{
  rowsEligibleForDeletion: number;
  retentionDays: number;
}> {
  const result = await db.execute(
    sql`SELECT count(*)::int AS cnt
        FROM ai_request_step_events
        WHERE created_at < NOW() - INTERVAL '${sql.raw(String(STEP_EVENT_RETENTION_DAYS))} days'`,
  );
  return {
    rowsEligibleForDeletion: Number((result.rows[0] as { cnt: number }).cnt ?? 0),
    retentionDays: STEP_EVENT_RETENTION_DAYS,
  };
}

/**
 * Delete ai_request_step_events rows older than STEP_EVENT_RETENTION_DAYS days.
 *
 * SQL:
 *   DELETE FROM ai_request_step_events
 *   WHERE created_at < NOW() - INTERVAL '30 days'
 */
export async function runStepEventCleanup(): Promise<StepEventCleanupResult> {
  const cutoffDate = new Date(
    Date.now() - STEP_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const executedAt = new Date();

  const result = await db.execute(
    sql`DELETE FROM ai_request_step_events
        WHERE created_at < NOW() - INTERVAL '${sql.raw(String(STEP_EVENT_RETENTION_DAYS))} days'`,
  );
  const rowsDeleted = result.rowCount ?? 0;

  console.info(
    `[step-budget-retention] Deleted ${rowsDeleted} ai_request_step_events rows older than ${STEP_EVENT_RETENTION_DAYS} days`,
  );

  return { rowsDeleted, retentionDays: STEP_EVENT_RETENTION_DAYS, cutoffDate, executedAt };
}
