/**
 * Wallet Retention Foundation
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides preview + cleanup SQL for tenant_credit_ledger rows older than
 * the configured retention window.
 *
 * Default retention: 24 months (730 days).
 * Wallet ledger is financial/audit data — retain conservatively.
 *
 * IMPORTANT: This is MANUAL / FOUNDATION ONLY.
 * No scheduler is wired in Phase 4B. These SQL strings are provided so that
 * a future cron job, admin endpoint, or DB maintenance script can use them.
 * Never run cleanup without operator review of the preview result first.
 *
 * Note: tenant_credit_accounts are metadata rows — do NOT delete them unless
 * the tenant itself is being fully removed. Only ledger entries age out.
 */

/** Minimum recommended retention for wallet ledger data (24 months) */
export const WALLET_LEDGER_RETENTION_DAYS = 730;

/**
 * Preview SQL — returns count and oldest/newest rows that WOULD be deleted.
 * Run this first before any cleanup to confirm scope.
 */
export const WALLET_LEDGER_PREVIEW_SQL = `
-- Preview: tenant_credit_ledger rows older than ${WALLET_LEDGER_RETENTION_DAYS} days
SELECT
  COUNT(*)                    AS rows_to_delete,
  MIN(created_at)             AS oldest_row,
  MAX(created_at)             AS newest_qualifying_row,
  COUNT(DISTINCT tenant_id)   AS affected_tenants,
  SUM(CASE WHEN direction = 'credit' THEN amount_usd ELSE 0 END) AS total_credits_to_delete,
  SUM(CASE WHEN direction = 'debit'  THEN amount_usd ELSE 0 END) AS total_debits_to_delete
FROM tenant_credit_ledger
WHERE created_at < NOW() - INTERVAL '${WALLET_LEDGER_RETENTION_DAYS} days';
`.trim();

/**
 * Cleanup SQL — deletes ledger rows older than the retention window.
 * Returns the IDs of deleted rows for audit logging.
 *
 * Run WALLET_LEDGER_PREVIEW_SQL first and verify scope before executing this.
 */
export const WALLET_LEDGER_CLEANUP_SQL = `
-- Cleanup: delete tenant_credit_ledger rows older than ${WALLET_LEDGER_RETENTION_DAYS} days
-- VERIFY with preview SQL before running.
DELETE FROM tenant_credit_ledger
WHERE created_at < NOW() - INTERVAL '${WALLET_LEDGER_RETENTION_DAYS} days'
RETURNING id, tenant_id, entry_type, amount_usd, direction, created_at;
`.trim();

/**
 * Return the preview and cleanup SQL strings for external use.
 * No DB interaction — callers execute these as needed.
 */
export function getWalletRetentionSql(retentionDays: number = WALLET_LEDGER_RETENTION_DAYS): {
  previewSql: string;
  cleanupSql: string;
} {
  return {
    previewSql: `
-- Preview: tenant_credit_ledger rows older than ${retentionDays} days
SELECT
  COUNT(*)                    AS rows_to_delete,
  MIN(created_at)             AS oldest_row,
  MAX(created_at)             AS newest_qualifying_row,
  COUNT(DISTINCT tenant_id)   AS affected_tenants,
  SUM(CASE WHEN direction = 'credit' THEN amount_usd ELSE 0 END) AS total_credits_to_delete,
  SUM(CASE WHEN direction = 'debit'  THEN amount_usd ELSE 0 END) AS total_debits_to_delete
FROM tenant_credit_ledger
WHERE created_at < NOW() - INTERVAL '${retentionDays} days';
    `.trim(),
    cleanupSql: `
-- Cleanup: delete tenant_credit_ledger rows older than ${retentionDays} days
-- VERIFY with preview SQL before running.
DELETE FROM tenant_credit_ledger
WHERE created_at < NOW() - INTERVAL '${retentionDays} days'
RETURNING id, tenant_id, entry_type, amount_usd, direction, created_at;
    `.trim(),
  };
}
