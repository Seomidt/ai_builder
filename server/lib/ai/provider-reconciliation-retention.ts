/**
 * Provider Reconciliation Retention Foundation
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides preview + cleanup SQL for reconciliation runs and deltas.
 *
 * Default retention: 12 months (365 days).
 * Reconciliation data is financial audit evidence — retain conservatively.
 *
 * IMPORTANT: This is MANUAL / FOUNDATION ONLY.
 * No scheduler is wired in Phase 4C. These SQL strings are for future
 * admin tooling, cron jobs, or DB maintenance scripts.
 *
 * Cleanup order:
 *   1. Delete deltas first (FK dependency on runs)
 *   2. Then delete runs
 *   Never delete runs without also deleting their deltas.
 */

/** Minimum recommended retention for reconciliation data (12 months) */
export const RECONCILIATION_RETENTION_DAYS = 365;

/**
 * Preview SQL — returns count of rows that WOULD be deleted.
 * Run this before any cleanup to confirm scope.
 */
export const RECONCILIATION_PREVIEW_SQL = `
-- Preview: reconciliation data older than ${RECONCILIATION_RETENTION_DAYS} days
SELECT
  'ai_provider_reconciliation_runs'     AS table_name,
  COUNT(*)                              AS rows_to_delete,
  MIN(created_at)                       AS oldest_row,
  MAX(created_at)                       AS newest_qualifying_row
FROM ai_provider_reconciliation_runs
WHERE created_at < NOW() - INTERVAL '${RECONCILIATION_RETENTION_DAYS} days'
UNION ALL
SELECT
  'ai_provider_reconciliation_deltas'   AS table_name,
  COUNT(*)                              AS rows_to_delete,
  MIN(created_at)                       AS oldest_row,
  MAX(created_at)                       AS newest_qualifying_row
FROM ai_provider_reconciliation_deltas
WHERE created_at < NOW() - INTERVAL '${RECONCILIATION_RETENTION_DAYS} days';
`.trim();

/**
 * Cleanup SQL — delete deltas first, then runs.
 * Run RECONCILIATION_PREVIEW_SQL first and verify scope.
 *
 * Must be executed as two statements in order:
 *   1. Delete deltas (references runs via run_id)
 *   2. Delete runs
 */
export const RECONCILIATION_CLEANUP_DELTA_SQL = `
-- Step 1: Delete reconciliation deltas older than ${RECONCILIATION_RETENTION_DAYS} days
-- VERIFY with preview SQL before running.
DELETE FROM ai_provider_reconciliation_deltas
WHERE created_at < NOW() - INTERVAL '${RECONCILIATION_RETENTION_DAYS} days'
RETURNING id, run_id, provider, severity, created_at;
`.trim();

export const RECONCILIATION_CLEANUP_RUN_SQL = `
-- Step 2: Delete reconciliation runs older than ${RECONCILIATION_RETENTION_DAYS} days
-- Only run AFTER step 1 (delete deltas first).
DELETE FROM ai_provider_reconciliation_runs
WHERE created_at < NOW() - INTERVAL '${RECONCILIATION_RETENTION_DAYS} days'
RETURNING id, provider, status, created_at;
`.trim();

/**
 * Return all retention SQL strings for the given retention window.
 */
export function getReconciliationRetentionSql(retentionDays: number = RECONCILIATION_RETENTION_DAYS): {
  previewSql: string;
  cleanupDeltaSql: string;
  cleanupRunSql: string;
} {
  return {
    previewSql: `
-- Preview: reconciliation data older than ${retentionDays} days
SELECT
  'ai_provider_reconciliation_runs'     AS table_name,
  COUNT(*)                              AS rows_to_delete,
  MIN(created_at)                       AS oldest_row,
  MAX(created_at)                       AS newest_qualifying_row
FROM ai_provider_reconciliation_runs
WHERE created_at < NOW() - INTERVAL '${retentionDays} days'
UNION ALL
SELECT
  'ai_provider_reconciliation_deltas'   AS table_name,
  COUNT(*)                              AS rows_to_delete,
  MIN(created_at)                       AS oldest_row,
  MAX(created_at)                       AS newest_qualifying_row
FROM ai_provider_reconciliation_deltas
WHERE created_at < NOW() - INTERVAL '${retentionDays} days';
    `.trim(),
    cleanupDeltaSql: `
-- Step 1: Delete reconciliation deltas older than ${retentionDays} days
DELETE FROM ai_provider_reconciliation_deltas
WHERE created_at < NOW() - INTERVAL '${retentionDays} days'
RETURNING id, run_id, provider, severity, created_at;
    `.trim(),
    cleanupRunSql: `
-- Step 2: Delete reconciliation runs older than ${retentionDays} days
-- Only run AFTER step 1.
DELETE FROM ai_provider_reconciliation_runs
WHERE created_at < NOW() - INTERVAL '${retentionDays} days'
RETURNING id, provider, status, created_at;
    `.trim(),
  };
}
