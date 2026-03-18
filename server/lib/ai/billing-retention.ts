/**
 * AI Billing Retention Foundation
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides preview + cleanup SQL for ai_billing_usage rows that are older
 * than the configured retention window.
 *
 * Default retention: 24 months (730 days).
 * Billing ledger rows should be kept significantly longer than operational logs
 * to support audit trails, dispute resolution, and financial reporting.
 *
 * IMPORTANT: This is MANUAL / FOUNDATION ONLY.
 * No scheduler is wired in Phase 4A. These SQL strings are provided so that
 * a future cron job, admin endpoint, or DB maintenance script can use them.
 * Never run cleanup without operator review of the preview result first.
 */

/** Minimum recommended retention for billing data (24 months) */
export const BILLING_RETENTION_DAYS = 730;

/**
 * Preview SQL — returns count and oldest/newest rows that WOULD be deleted.
 * Run this first before any cleanup to confirm scope.
 */
export const BILLING_USAGE_PREVIEW_SQL = `
-- Preview: ai_billing_usage rows older than ${BILLING_RETENTION_DAYS} days
SELECT
  COUNT(*)                    AS rows_to_delete,
  MIN(created_at)             AS oldest_row,
  MAX(created_at)             AS newest_qualifying_row,
  MIN(provider_cost_usd)      AS min_provider_cost,
  MAX(provider_cost_usd)      AS max_provider_cost,
  SUM(customer_price_usd)     AS total_customer_price_to_delete
FROM ai_billing_usage
WHERE created_at < NOW() - INTERVAL '${BILLING_RETENTION_DAYS} days';
`.trim();

/**
 * Cleanup SQL — deletes billing rows older than the retention window.
 * Returns the IDs of deleted rows for audit logging.
 *
 * Run BILLING_USAGE_PREVIEW_SQL first and verify scope before executing this.
 */
export const BILLING_USAGE_CLEANUP_SQL = `
-- Cleanup: delete ai_billing_usage rows older than ${BILLING_RETENTION_DAYS} days
-- VERIFY with preview SQL before running.
DELETE FROM ai_billing_usage
WHERE created_at < NOW() - INTERVAL '${BILLING_RETENTION_DAYS} days'
RETURNING id, tenant_id, usage_id, customer_price_usd, created_at;
`.trim();

/**
 * Return the preview and cleanup SQL strings for external use.
 * No DB interaction — callers execute these as needed.
 */
export function getBillingRetentionSql(retentionDays: number = BILLING_RETENTION_DAYS): {
  previewSql: string;
  cleanupSql: string;
} {
  return {
    previewSql: `
-- Preview: ai_billing_usage rows older than ${retentionDays} days
SELECT
  COUNT(*)                    AS rows_to_delete,
  MIN(created_at)             AS oldest_row,
  MAX(created_at)             AS newest_qualifying_row,
  SUM(customer_price_usd)     AS total_customer_price_to_delete
FROM ai_billing_usage
WHERE created_at < NOW() - INTERVAL '${retentionDays} days';
    `.trim(),
    cleanupSql: `
-- Cleanup: delete ai_billing_usage rows older than ${retentionDays} days
-- VERIFY with preview SQL before running.
DELETE FROM ai_billing_usage
WHERE created_at < NOW() - INTERVAL '${retentionDays} days'
RETURNING id, tenant_id, usage_id, customer_price_usd, created_at;
    `.trim(),
  };
}
