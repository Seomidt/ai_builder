/**
 * Billing Periods Foundation
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides lifecycle management for billing periods.
 *
 * Period lifecycle:
 *   open    → active period; ai_billing_usage rows accrue here
 *   closing → transitional state during snapshot generation
 *   closed  → fully closed; billing_period_tenant_snapshots are canonical
 *
 * Reporting rule (enforced by application, not DB):
 *   open   period → aggregate from live ai_billing_usage
 *   closed period → aggregate from billing_period_tenant_snapshots
 *
 * DB-level invariants (Phase 4D.1 hardening):
 *   - period_start < period_end (CHECK constraint)
 *   - status ∈ {open, closing, closed} (CHECK constraint)
 *   - UNIQUE(period_start, period_end) (uniqueIndex)
 *   - Non-overlapping periods (EXCLUDE USING gist btree_gist)
 *   - billing_period_tenant_snapshots are immutable (DB trigger prevents UPDATE/DELETE)
 *   - closed_at is only set when status = 'closed'
 *   - Close flow uses SELECT FOR UPDATE row-level locking (concurrency-safe)
 *
 * Phase 4D: foundation only. No scheduler, no cron, no admin API.
 * Periods are created and closed manually via closeBillingPeriod().
 */

import { eq, desc, and } from "drizzle-orm";
import { db } from "../../db";
import { billingPeriods } from "@shared/schema";
import type { BillingPeriod } from "@shared/schema";

// Type for a Drizzle transaction client (used by concurrency-safe close flow)
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ─── Errors ────────────────────────────────────────────────────────────────────

export class BillingPeriodError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "BillingPeriodError";
  }
}

// ─── Concurrency-Safe Row Lock ────────────────────────────────────────────────

/**
 * Lock a billing period row using SELECT FOR UPDATE within a transaction.
 *
 * Must be called inside a `db.transaction()` block.
 * Blocks until the row lock is acquired — any concurrent writer holding the lock
 * must commit or rollback first.
 *
 * This is the primary concurrency guard for the period close flow.
 * Two concurrent close attempts will serialize at this point:
 *   - Worker A: acquires lock, proceeds with close
 *   - Worker B: waits... acquires lock after A commits, sees status='closing'
 *     or 'closed', throws BillingPeriodError immediately — no duplicate work
 *
 * Returns the current period row (fresh read under lock), or null if not found.
 *
 * Usage:
 *   await db.transaction(async (tx) => {
 *     const period = await lockBillingPeriodRow(tx, periodId);
 *     // ... check status, mutate ...
 *   });
 */
export async function lockBillingPeriodRow(
  tx: DbTransaction,
  periodId: string,
): Promise<BillingPeriod | null> {
  const rows = await tx
    .select()
    .from(billingPeriods)
    .where(eq(billingPeriods.id, periodId))
    .for("update")
    .limit(1);

  return rows[0] ?? null;
}

// ─── Read Operations ──────────────────────────────────────────────────────────

/**
 * Return the currently open billing period, or null if none exists.
 *
 * The operational norm is exactly one open period at a time.
 * If multiple open periods exist (should not happen), returns the most recent.
 */
export async function getOpenBillingPeriod(): Promise<BillingPeriod | null> {
  const rows = await db
    .select()
    .from(billingPeriods)
    .where(eq(billingPeriods.status, "open"))
    .orderBy(desc(billingPeriods.createdAt))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Return a billing period by id, or null if not found.
 */
export async function getBillingPeriodById(periodId: string): Promise<BillingPeriod | null> {
  const rows = await db
    .select()
    .from(billingPeriods)
    .where(eq(billingPeriods.id, periodId))
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Return billing periods ordered newest first, up to `limit` rows.
 */
export async function getBillingPeriods(limit = 50): Promise<BillingPeriod[]> {
  return db
    .select()
    .from(billingPeriods)
    .orderBy(desc(billingPeriods.createdAt))
    .limit(limit);
}

// ─── Write Operations ─────────────────────────────────────────────────────────

/**
 * Create a new billing period with status='open'.
 *
 * Validates:
 *   - period_start < period_end (additional application-level guard on top of CHECK)
 *   - UNIQUE(period_start, period_end) is enforced at DB level
 *
 * Returns the newly created period id.
 * Throws BillingPeriodError on invalid input.
 * Throws on DB constraint violation (e.g. duplicate period window).
 */
export async function createBillingPeriod(
  periodStart: Date,
  periodEnd: Date,
): Promise<string> {
  if (periodStart >= periodEnd) {
    throw new BillingPeriodError(
      `period_start must be before period_end: ${periodStart.toISOString()} >= ${periodEnd.toISOString()}`,
      "invalid_period_window",
    );
  }

  const inserted = await db
    .insert(billingPeriods)
    .values({
      periodStart,
      periodEnd,
      status: "open",
    })
    .returning({ id: billingPeriods.id });

  const id = inserted[0]?.id;
  if (!id) {
    throw new BillingPeriodError("Failed to create billing period — no id returned", "insert_failed");
  }

  console.info(
    `[billing-periods] Created period: ${id}`,
    `(${periodStart.toISOString()} → ${periodEnd.toISOString()})`,
  );

  return id;
}

/**
 * Transition a billing period to 'closing' — standalone (outside transaction).
 *
 * Non-transactional version kept for backwards compatibility.
 * For concurrency-safe close, use closeBillingPeriod() which uses the tx versions.
 */
export async function markBillingPeriodClosing(periodId: string): Promise<void> {
  const period = await getBillingPeriodById(periodId);
  if (!period) {
    throw new BillingPeriodError(`Billing period not found: ${periodId}`, "period_not_found");
  }
  if (period.status !== "open") {
    throw new BillingPeriodError(
      `Cannot transition to 'closing': period ${periodId} is in status '${period.status}' (expected 'open')`,
      "invalid_status_transition",
    );
  }
  await db
    .update(billingPeriods)
    .set({ status: "closing" })
    .where(and(eq(billingPeriods.id, periodId), eq(billingPeriods.status, "open")));
  console.info(`[billing-periods] Period ${periodId} → closing`);
}

/**
 * Transition a billing period to 'closing' within an existing transaction.
 *
 * Called inside a db.transaction() block with SELECT FOR UPDATE already held.
 * The caller has already validated status via lockBillingPeriodRow().
 */
export async function markBillingPeriodClosingTx(tx: DbTransaction, periodId: string): Promise<void> {
  await tx
    .update(billingPeriods)
    .set({ status: "closing" })
    .where(and(eq(billingPeriods.id, periodId), eq(billingPeriods.status, "open")));
  console.info(`[billing-periods] Period ${periodId} → closing (tx)`);
}

/**
 * Transition a billing period to 'closed' — standalone (outside transaction).
 */
export async function markBillingPeriodClosed(periodId: string): Promise<void> {
  const period = await getBillingPeriodById(periodId);
  if (!period) {
    throw new BillingPeriodError(`Billing period not found: ${periodId}`, "period_not_found");
  }
  if (period.status !== "closing") {
    throw new BillingPeriodError(
      `Cannot transition to 'closed': period ${periodId} is in status '${period.status}' (expected 'closing')`,
      "invalid_status_transition",
    );
  }
  await db
    .update(billingPeriods)
    .set({ status: "closed", closedAt: new Date() })
    .where(and(eq(billingPeriods.id, periodId), eq(billingPeriods.status, "closing")));
  console.info(`[billing-periods] Period ${periodId} → closed`);
}

/**
 * Transition a billing period to 'closed' within an existing transaction.
 *
 * Called inside a db.transaction() block with SELECT FOR UPDATE already held.
 * The caller has already validated status via lockBillingPeriodRow().
 */
export async function markBillingPeriodClosedTx(tx: DbTransaction, periodId: string): Promise<void> {
  await tx
    .update(billingPeriods)
    .set({ status: "closed", closedAt: new Date() })
    .where(and(eq(billingPeriods.id, periodId), eq(billingPeriods.status, "closing")));
  console.info(`[billing-periods] Period ${periodId} → closed (tx)`);
}

/**
 * Restore a 'closing' period back to 'open' within a transaction — for rollback after snapshot failure.
 *
 * Only operates on 'closing' → 'open'. Never reopens 'closed' periods.
 */
export async function restoreBillingPeriodToOpenTx(tx: DbTransaction, periodId: string): Promise<void> {
  const result = await tx
    .update(billingPeriods)
    .set({ status: "open" })
    .where(and(eq(billingPeriods.id, periodId), eq(billingPeriods.status, "closing")))
    .returning({ id: billingPeriods.id });

  if (result.length > 0) {
    console.warn(`[billing-periods] Period ${periodId} restored to 'open' after snapshot failure (tx)`);
  } else {
    console.error(`[billing-periods] Could not restore period ${periodId} to 'open' (tx) — unexpected state`);
  }
}

/**
 * Restore a 'closing' period back to 'open' — standalone version for error paths.
 *
 * Only operates on 'closing' → 'open'. Never reopens 'closed' periods.
 */
export async function restoreBillingPeriodToOpen(periodId: string): Promise<void> {
  const result = await db
    .update(billingPeriods)
    .set({ status: "open" })
    .where(and(eq(billingPeriods.id, periodId), eq(billingPeriods.status, "closing")))
    .returning({ id: billingPeriods.id });

  if (result.length > 0) {
    console.warn(`[billing-periods] Period ${periodId} restored to 'open' after snapshot failure`);
  } else {
    console.error(`[billing-periods] Could not restore period ${periodId} to 'open' — unexpected state`);
  }
}
