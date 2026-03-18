/**
 * Billing Event Retention — Phase 4F
 *
 * SERVER-ONLY: Manual/admin retention helpers for billing_events.
 *
 * Retention policy:
 *   Minimum 12 months. Longer retention may be required for compliance.
 *   No automated scheduler — cleanup is manual/admin-triggered for Phase 4F.
 *
 * Failure policy:
 *   These are admin-only operations. Errors are surfaced to the caller.
 *   Do not call these from the AI runtime path.
 */

import { lt } from "drizzle-orm";
import { db } from "../../db";
import { billingEvents } from "@shared/schema";

// ─── Retention Cutoff ─────────────────────────────────────────────────────────

/**
 * Calculate the retention cutoff date.
 * Events created before this date are eligible for cleanup.
 *
 * @param months — number of months to retain. Minimum enforced: 12.
 */
export function previewBillingEventRetentionCutoff(months: number): Date {
  const retentionMonths = Math.max(12, months);
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - retentionMonths);
  return cutoff;
}

// ─── Preview ──────────────────────────────────────────────────────────────────

/**
 * Preview which billing events would be deleted by a cleanup run.
 * Returns row count and earliest/latest createdAt in the eligible window.
 * Does NOT delete — read-only.
 */
export async function previewBillingEventDeletion(cutoffDate: Date): Promise<{
  eligibleCount: number;
  cutoffDate: Date;
  previewSql: string;
}> {
  const rows = await db
    .select({ id: billingEvents.id, createdAt: billingEvents.createdAt })
    .from(billingEvents)
    .where(lt(billingEvents.createdAt, cutoffDate))
    .limit(1000);

  const previewSql = `
-- Preview: billing_events eligible for deletion (created before ${cutoffDate.toISOString()})
SELECT COUNT(*) AS eligible_count,
       MIN(created_at) AS oldest_row,
       MAX(created_at) AS newest_eligible_row
FROM billing_events
WHERE created_at < '${cutoffDate.toISOString()}';
`.trim();

  return {
    eligibleCount: rows.length,
    cutoffDate,
    previewSql,
  };
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * Delete billing_events rows older than the cutoff date.
 *
 * Safety:
 *   - Minimum cutoff is enforced at 12 months by previewBillingEventRetentionCutoff().
 *   - Run previewBillingEventDeletion first to verify scope before executing.
 *   - This is a destructive operation — rows are permanently deleted.
 *
 * Returns the count of deleted rows.
 */
export async function cleanupOldBillingEvents(cutoffDate: Date): Promise<{
  deletedCount: number;
  cutoffDate: Date;
}> {
  const before = new Date(cutoffDate);

  const deleted = await db
    .delete(billingEvents)
    .where(lt(billingEvents.createdAt, before))
    .returning({ id: billingEvents.id });

  console.info(
    `[ai/billing-event-retention] Deleted ${deleted.length} billing_events rows older than ${before.toISOString()}`,
  );

  return {
    deletedCount: deleted.length,
    cutoffDate: before,
  };
}

// ─── Cleanup SQL Reference ─────────────────────────────────────────────────────

/**
 * Returns the raw SQL for manual cleanup operations.
 * Use when running directly in a DB console or admin script.
 */
export function getBillingEventCleanupSql(cutoffDate: Date): string {
  return `
-- Billing Event Cleanup — Phase 4F retention
-- Minimum retention: 12 months
-- Run previewBillingEventDeletion() first to verify scope.

-- 1. Preview
SELECT COUNT(*) AS eligible_count,
       MIN(created_at) AS oldest_row,
       MAX(created_at) AS newest_eligible_row
FROM billing_events
WHERE created_at < '${cutoffDate.toISOString()}';

-- 2. Delete (run only after preview confirms expected scope)
DELETE FROM billing_events
WHERE created_at < '${cutoffDate.toISOString()}';
`.trim();
}
