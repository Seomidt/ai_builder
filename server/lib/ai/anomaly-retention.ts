/**
 * AI Anomaly Events Retention — Phase 3K
 *
 * SERVER-ONLY: Must never be imported from client/ code.
 *
 * Foundation-only module: contains exact SQL for preview and cleanup of
 * ai_anomaly_events rows older than 90 days.
 *
 * No scheduler. No auto-run. Manual execution only.
 *
 * Usage:
 *   import { previewAnomalyEventCleanup, runAnomalyEventCleanup } from "./anomaly-retention";
 *   const preview = await previewAnomalyEventCleanup();  // count rows to be deleted
 *   const result  = await runAnomalyEventCleanup();      // delete them
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";

export const ANOMALY_EVENT_RETENTION_DAYS = 90;

export interface AnomalyCleanupPreview {
  rowsEligibleForDeletion: number;
  retentionDays: number;
  cutoffDate: Date;
}

export interface AnomalyCleanupResult {
  rowsDeleted: number;
  retentionDays: number;
  cutoffDate: Date;
  executedAt: Date;
}

/**
 * Preview how many ai_anomaly_events rows would be deleted by a cleanup run.
 * Does NOT delete anything.
 */
export async function previewAnomalyEventCleanup(): Promise<AnomalyCleanupPreview> {
  const cutoffDate = new Date(
    Date.now() - ANOMALY_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );

  const result = await db.execute(
    sql`SELECT count(*)::int AS cnt
        FROM ai_anomaly_events
        WHERE created_at < NOW() - INTERVAL '${sql.raw(String(ANOMALY_EVENT_RETENTION_DAYS))} days'`,
  );

  const cnt = (result.rows[0] as { cnt: number }).cnt ?? 0;

  return {
    rowsEligibleForDeletion: Number(cnt),
    retentionDays: ANOMALY_EVENT_RETENTION_DAYS,
    cutoffDate,
  };
}

/**
 * Delete ai_anomaly_events rows older than ANOMALY_EVENT_RETENTION_DAYS days.
 *
 * SQL:
 *   DELETE FROM ai_anomaly_events
 *   WHERE created_at < NOW() - INTERVAL '90 days'
 *
 * Safe to run repeatedly — idempotent.
 */
export async function runAnomalyEventCleanup(): Promise<AnomalyCleanupResult> {
  const cutoffDate = new Date(
    Date.now() - ANOMALY_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const executedAt = new Date();

  const result = await db.execute(
    sql`DELETE FROM ai_anomaly_events
        WHERE created_at < NOW() - INTERVAL '${sql.raw(String(ANOMALY_EVENT_RETENTION_DAYS))} days'`,
  );

  const rowsDeleted = result.rowCount ?? 0;

  console.info(
    `[anomaly-retention] Cleanup complete: deleted ${rowsDeleted} ai_anomaly_events rows older than ${ANOMALY_EVENT_RETENTION_DAYS} days`,
  );

  return {
    rowsDeleted,
    retentionDays: ANOMALY_EVENT_RETENTION_DAYS,
    cutoffDate,
    executedAt,
  };
}
