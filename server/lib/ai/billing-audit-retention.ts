/**
 * Billing Audit Data Retention
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Preview and cleanup helpers for billing audit data retention.
 *
 * Retention policy:
 *   - Minimum 12 months retention for billing_audit_runs + billing_audit_findings
 *   - Findings linked to unresolved critical issues may need longer retention later
 *     (not enforced in this phase — planned for Phase 4F or admin tooling)
 *
 * No scheduler in this phase — manual/admin invocation only.
 *
 * IMPORTANT: Cleanup must delete findings BEFORE runs (FK constraint).
 * billing_audit_findings.run_id references billing_audit_runs.id.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";

// ─── Preview Helpers ───────────────────────────────────────────────────────────

/**
 * Preview the cutoff date for retaining N months of audit data.
 * Returns the cutoff — runs older than this would be eligible for cleanup.
 */
export function previewBillingAuditRetentionCutoff(months: number): Date {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  return cutoff;
}

export interface BillingAuditDeletionPreview {
  cutoffDate: Date;
  eligibleRunCount: number;
  eligibleFindingCount: number;
  oldestEligibleRun: Date | null;
  newestEligibleRun: Date | null;
}

/**
 * Preview what would be deleted if cleanup ran with this cutoff date.
 * Does not delete anything — dry-run only.
 */
export async function previewBillingAuditDeletion(
  cutoffDate: Date,
): Promise<BillingAuditDeletionPreview> {
  const [runPreview, findingPreview] = await Promise.all([
    db.execute<{
      eligible_count: string;
      oldest_run: Date | null;
      newest_run: Date | null;
    }>(sql`
      SELECT COUNT(*) AS eligible_count,
             MIN(started_at) AS oldest_run,
             MAX(started_at) AS newest_run
      FROM billing_audit_runs
      WHERE started_at < ${cutoffDate}
    `),
    db.execute<{ eligible_count: string }>(sql`
      SELECT COUNT(*) AS eligible_count
      FROM billing_audit_findings f
      JOIN billing_audit_runs r ON r.id = f.run_id
      WHERE r.started_at < ${cutoffDate}
    `),
  ]);

  const runRow = runPreview.rows[0];
  const findingRow = findingPreview.rows[0];

  return {
    cutoffDate,
    eligibleRunCount: Number(runRow?.eligible_count ?? 0),
    eligibleFindingCount: Number(findingRow?.eligible_count ?? 0),
    oldestEligibleRun: runRow?.oldest_run ?? null,
    newestEligibleRun: runRow?.newest_run ?? null,
  };
}

// ─── Cleanup ───────────────────────────────────────────────────────────────────

export interface BillingAuditCleanupResult {
  cutoffDate: Date;
  findingsDeleted: number;
  runsDeleted: number;
}

/**
 * Delete billing audit runs older than cutoffDate and their associated findings.
 *
 * IMPORTANT ORDERING:
 *   1. Delete findings first (FK child)
 *   2. Delete runs second (FK parent)
 *
 * This must be called only by admin/scheduled processes.
 * Returns counts of deleted rows.
 *
 * Recommended usage:
 *   const cutoff = previewBillingAuditRetentionCutoff(12); // 12 months
 *   const preview = await previewBillingAuditDeletion(cutoff);
 *   // Log preview for audit trail
 *   const result = await cleanupOldBillingAuditData(cutoff);
 */
export async function cleanupOldBillingAuditData(
  cutoffDate: Date,
): Promise<BillingAuditCleanupResult> {
  // Step 1: Collect run IDs to delete
  const eligibleRuns = await db.execute<{ id: string }>(sql`
    SELECT id FROM billing_audit_runs WHERE started_at < ${cutoffDate}
  `);

  if (eligibleRuns.rows.length === 0) {
    console.info(`[billing-audit-retention] No audit runs older than ${cutoffDate.toISOString()} — nothing to delete`);
    return { cutoffDate, findingsDeleted: 0, runsDeleted: 0 };
  }

  const runIds = eligibleRuns.rows.map((r) => r.id);

  // Step 2: Delete findings first (FK child)
  const findingsDeleteResult = await db.execute<{ count: string }>(sql`
    DELETE FROM billing_audit_findings
    WHERE run_id = ANY(${sql.raw(`ARRAY[${runIds.map((id) => `'${id}'`).join(",")}]::text[]`)})
    RETURNING id
  `);
  const findingsDeleted = findingsDeleteResult.rows.length;

  // Step 3: Delete runs (FK parent)
  const runsDeleteResult = await db.execute<{ count: string }>(sql`
    DELETE FROM billing_audit_runs
    WHERE id = ANY(${sql.raw(`ARRAY[${runIds.map((id) => `'${id}'`).join(",")}]::text[]`)})
    RETURNING id
  `);
  const runsDeleted = runsDeleteResult.rows.length;

  console.info(
    `[billing-audit-retention] Cleanup complete — cutoff=${cutoffDate.toISOString()}`,
    `runs_deleted=${runsDeleted} findings_deleted=${findingsDeleted}`,
  );

  return { cutoffDate, findingsDeleted, runsDeleted };
}

// ─── Retention SQL Reference ───────────────────────────────────────────────────
//
// Manual SQL equivalent (for DBA use or emergency admin):
//
// -- Preview what would be deleted (12-month retention):
// SELECT COUNT(*) FROM billing_audit_runs WHERE started_at < NOW() - INTERVAL '12 months';
// SELECT COUNT(*) FROM billing_audit_findings f
//   JOIN billing_audit_runs r ON r.id = f.run_id
//   WHERE r.started_at < NOW() - INTERVAL '12 months';
//
// -- Execute cleanup (findings first!):
// DELETE FROM billing_audit_findings
//   WHERE run_id IN (
//     SELECT id FROM billing_audit_runs WHERE started_at < NOW() - INTERVAL '12 months'
//   );
// DELETE FROM billing_audit_runs WHERE started_at < NOW() - INTERVAL '12 months';
