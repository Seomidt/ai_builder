/**
 * Provider Reconciliation Retention — Phase 4G
 *
 * SERVER-ONLY: Manual/admin retention helpers for provider reconciliation tables.
 *
 * Retention policy:
 *   Minimum 12 months. Reconciliation data is financial audit evidence —
 *   retain conservatively.
 *
 * IMPORTANT: Findings must be deleted before parent runs due to FK dependency.
 *   Cleanup order: provider_reconciliation_findings → provider_reconciliation_runs
 *
 * No automated scheduler in Phase 4G. Manual/admin-triggered only.
 */

import { lt } from "drizzle-orm";
import { db } from "../../db";
import { providerReconciliationRuns, providerReconciliationFindings } from "@shared/schema";

/** Minimum recommended retention for reconciliation data (12 months) */
export const PROVIDER_RECONCILIATION_RETENTION_MONTHS = 12;

// ─── Cutoff Calculation ───────────────────────────────────────────────────────

/**
 * Calculate the retention cutoff date.
 * Minimum enforced: 12 months.
 */
export function previewProviderReconciliationRetentionCutoff(months: number): Date {
  const retentionMonths = Math.max(PROVIDER_RECONCILIATION_RETENTION_MONTHS, months);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - retentionMonths);
  return cutoff;
}

// ─── Preview ──────────────────────────────────────────────────────────────────

export interface ProviderReconciliationRetentionPreview {
  eligibleRunCount: number;
  eligibleFindingCount: number;
  cutoffDate: Date;
  previewSql: string;
}

/**
 * Preview how many rows would be deleted. Read-only — does NOT delete.
 * Run this before cleanupOldProviderReconciliationData to confirm scope.
 */
export async function previewProviderReconciliationDeletion(
  cutoffDate: Date,
): Promise<ProviderReconciliationRetentionPreview> {
  const runs = await db
    .select({ id: providerReconciliationRuns.id })
    .from(providerReconciliationRuns)
    .where(lt(providerReconciliationRuns.createdAt, cutoffDate))
    .limit(10000);

  const findings = await db
    .select({ id: providerReconciliationFindings.id })
    .from(providerReconciliationFindings)
    .where(lt(providerReconciliationFindings.createdAt, cutoffDate))
    .limit(10000);

  const previewSql = `
-- Preview: provider reconciliation data eligible for deletion
-- Cutoff: ${cutoffDate.toISOString()}

SELECT 'provider_reconciliation_findings' AS table_name,
       COUNT(*) AS eligible_count,
       MIN(created_at) AS oldest_row,
       MAX(created_at) AS newest_eligible_row
FROM provider_reconciliation_findings
WHERE created_at < '${cutoffDate.toISOString()}'
UNION ALL
SELECT 'provider_reconciliation_runs' AS table_name,
       COUNT(*) AS eligible_count,
       MIN(created_at) AS oldest_row,
       MAX(created_at) AS newest_eligible_row
FROM provider_reconciliation_runs
WHERE created_at < '${cutoffDate.toISOString()}';
`.trim();

  return {
    eligibleRunCount: runs.length,
    eligibleFindingCount: findings.length,
    cutoffDate,
    previewSql,
  };
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

export interface ProviderReconciliationCleanupResult {
  deletedFindingCount: number;
  deletedRunCount: number;
  cutoffDate: Date;
}

/**
 * Delete provider reconciliation data older than the cutoff date.
 *
 * Safety:
 *   - Minimum cutoff enforced at 12 months
 *   - Findings deleted before runs (FK dependency)
 *   - Run previewProviderReconciliationDeletion first
 *
 * This is a destructive operation — rows are permanently deleted.
 */
export async function cleanupOldProviderReconciliationData(
  cutoffDate: Date,
): Promise<ProviderReconciliationCleanupResult> {
  // Step 1: Delete findings first (FK dependency on runs)
  const deletedFindings = await db
    .delete(providerReconciliationFindings)
    .where(lt(providerReconciliationFindings.createdAt, cutoffDate))
    .returning({ id: providerReconciliationFindings.id });

  // Step 2: Delete runs
  const deletedRuns = await db
    .delete(providerReconciliationRuns)
    .where(lt(providerReconciliationRuns.createdAt, cutoffDate))
    .returning({ id: providerReconciliationRuns.id });

  console.info(
    `[ai/provider-reconciliation-retention] Cleanup complete.`,
    `Deleted ${deletedFindings.length} findings and ${deletedRuns.length} runs`,
    `older than ${cutoffDate.toISOString()}`,
  );

  return {
    deletedFindingCount: deletedFindings.length,
    deletedRunCount: deletedRuns.length,
    cutoffDate,
  };
}

// ─── Raw SQL Reference ────────────────────────────────────────────────────────

/**
 * Returns raw SQL for manual cleanup operations.
 * Execute findings deletion BEFORE runs deletion.
 */
export function getProviderReconciliationCleanupSql(cutoffDate: Date): string {
  return `
-- Provider Reconciliation Cleanup — Phase 4G retention
-- Minimum retention: 12 months
-- Run preview first to confirm scope.

-- Step 1: Delete findings (FK dependency on runs — must be first)
DELETE FROM provider_reconciliation_findings
WHERE created_at < '${cutoffDate.toISOString()}';

-- Step 2: Delete runs (only after findings are deleted)
DELETE FROM provider_reconciliation_runs
WHERE created_at < '${cutoffDate.toISOString()}';
`.trim();
}
