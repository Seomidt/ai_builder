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
 * Invariants:
 *   - period_start < period_end (enforced by CHECK constraint)
 *   - status must be one of open/closing/closed (CHECK constraint)
 *   - UNIQUE(period_start, period_end) prevents duplicate period definitions
 *   - closed_at is only set when status = 'closed'
 *   - Closing a non-open period is an error — never silent
 *   - Re-closing a closed period is safely rejected
 *
 * Phase 5: foundation only. No scheduler, no cron, no admin API.
 * Periods are created and closed manually via these functions.
 */

import { eq, desc, and } from "drizzle-orm";
import { db } from "../../db";
import { billingPeriods } from "@shared/schema";
import type { BillingPeriod } from "@shared/schema";

// ─── Errors ────────────────────────────────────────────────────────────────────

export class BillingPeriodError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "BillingPeriodError";
  }
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
 * Transition a billing period to 'closing'.
 *
 * This is step 3 of the close flow.
 * Must only be called on open periods — enforced by this function.
 *
 * Throws BillingPeriodError if:
 *   - Period not found
 *   - Period is not in 'open' status
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
 * Transition a billing period to 'closed' and set closed_at.
 *
 * This is step 6 of the close flow — called only after successful snapshot generation.
 * Must only be called on 'closing' periods.
 *
 * Throws BillingPeriodError if period is not in 'closing' status.
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
 * Restore a 'closing' period back to 'open' — for rollback after snapshot failure.
 *
 * Called in the error path of closeBillingPeriod() to avoid leaving a period
 * stuck in 'closing' after a snapshot generation failure.
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
    console.error(
      `[billing-periods] Could not restore period ${periodId} to 'open' — may already be in unexpected state`,
    );
  }
}
