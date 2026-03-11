/**
 * AI Usage Retention
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Retention strategy:
 *   raw ai_usage rows older than 90 days can be safely deleted.
 *   tenant_ai_usage_periods must NEVER be deleted — it is the permanent aggregate
 *   summary used by guardrails and future billing/admin analytics.
 *
 * This module does NOT run automatically. Cleanup must be triggered externally
 * (e.g. a scheduled admin script, a future cron job, or a manual Admin UI action).
 *
 * Why 90 days:
 *   - Covers 3 billing periods of raw detail for dispute resolution
 *   - Matches a common regulatory audit window
 *   - Long enough to debug anomalies; aggregate table holds the permanent record
 *
 * Phase 3G.1 hardening
 */

export const AI_USAGE_RETENTION_DAYS = 90;

/**
 * Exact SQL to delete raw ai_usage rows older than the retention window.
 *
 * Safe to run at any time — does not touch tenant_ai_usage_periods.
 * Returns the number of deleted rows.
 *
 * Usage example (run via psql or a scheduled admin script):
 *
 *   DELETE FROM ai_usage
 *   WHERE created_at < NOW() - INTERVAL '90 days';
 *
 * To preview without deleting:
 *
 *   SELECT COUNT(*) FROM ai_usage
 *   WHERE created_at < NOW() - INTERVAL '90 days';
 */
export const RETENTION_CLEANUP_SQL = `
DELETE FROM ai_usage
WHERE created_at < NOW() - INTERVAL '${AI_USAGE_RETENTION_DAYS} days';
`.trim();

/**
 * Preview SQL — returns the count of rows that would be deleted.
 * Run this before the cleanup to estimate impact.
 */
export const RETENTION_PREVIEW_SQL = `
SELECT COUNT(*) AS rows_to_delete
FROM ai_usage
WHERE created_at < NOW() - INTERVAL '${AI_USAGE_RETENTION_DAYS} days';
`.trim();
