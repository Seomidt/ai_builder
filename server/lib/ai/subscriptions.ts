/**
 * Subscription Plans & Entitlements — Phase 4N
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Manages the SaaS subscription lifecycle for tenants:
 *   - Plan catalog resolution
 *   - Tenant subscription creation, change, and cancellation
 *   - Durable event history on all changes
 *   - Non-overlapping window enforcement (DB trigger + runtime guard)
 *
 * Design rules enforced:
 *   A) Plans are immutable commercial snapshots — never edit in place
 *   B) Exactly one active subscription per tenant at any point in time
 *   C) All state changes record a tenant_subscription_events row
 *   D) Historical invoices are never touched by subscription changes
 *   E) Entitlement resolution is deterministic by timestamp
 */

import { eq, and, isNull, lte, gte, or, desc } from "drizzle-orm";
import { db } from "../../db";
import {
  subscriptionPlans,
  planEntitlements,
  tenantSubscriptions,
  tenantSubscriptionEvents,
} from "@shared/schema";
import type {
  SubscriptionPlan,
  PlanEntitlement,
  TenantSubscription,
  TenantSubscriptionEvent,
} from "@shared/schema";

// ─── Plan Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve the active tenant subscription at a given point in time.
 * Throws if no active subscription exists, or if >1 active row found (data error).
 */
export async function getActiveTenantSubscription(
  tenantId: string,
  atTime: Date = new Date(),
): Promise<TenantSubscription> {
  const rows = await db
    .select()
    .from(tenantSubscriptions)
    .where(
      and(
        eq(tenantSubscriptions.tenantId, tenantId),
        lte(tenantSubscriptions.effectiveFrom, atTime),
        or(
          isNull(tenantSubscriptions.effectiveTo),
          gte(tenantSubscriptions.effectiveTo, atTime),
        ),
      ),
    )
    .orderBy(desc(tenantSubscriptions.effectiveFrom));

  if (rows.length === 0) {
    throw new Error(
      `[subscriptions] No active subscription for tenant '${tenantId}' at ${atTime.toISOString()}`,
    );
  }
  if (rows.length > 1) {
    throw new Error(
      `[subscriptions] Data integrity error: ${rows.length} overlapping subscriptions for tenant '${tenantId}' at ${atTime.toISOString()}`,
    );
  }
  return rows[0];
}

/**
 * Resolve all plan entitlements for the active tenant subscription at a given time.
 * Returns empty array if tenant has no active subscription.
 */
export async function getTenantPlanEntitlements(
  tenantId: string,
  atTime: Date = new Date(),
): Promise<PlanEntitlement[]> {
  let subscription: TenantSubscription;
  try {
    subscription = await getActiveTenantSubscription(tenantId, atTime);
  } catch {
    return [];
  }

  return db
    .select()
    .from(planEntitlements)
    .where(eq(planEntitlements.subscriptionPlanId, subscription.subscriptionPlanId));
}

/**
 * Resolve a plan by planCode at a given effective time.
 * Returns the most recently effective active plan version.
 */
export async function getPlanByCode(
  planCode: string,
  atTime: Date = new Date(),
): Promise<SubscriptionPlan | null> {
  const rows = await db
    .select()
    .from(subscriptionPlans)
    .where(
      and(
        eq(subscriptionPlans.planCode, planCode),
        eq(subscriptionPlans.status, "active"),
        lte(subscriptionPlans.effectiveFrom, atTime),
        or(
          isNull(subscriptionPlans.effectiveTo),
          gte(subscriptionPlans.effectiveTo, atTime),
        ),
      ),
    )
    .orderBy(desc(subscriptionPlans.effectiveFrom))
    .limit(1);

  return rows[0] ?? null;
}

// ─── Subscription Mutation ────────────────────────────────────────────────────

export interface CreateTenantSubscriptionInput {
  tenantId: string;
  subscriptionPlanId: string;
  status?: "trialing" | "active" | "past_due" | "paused" | "cancelled";
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Create a new tenant subscription.
 * Checks for overlapping windows at runtime (DB trigger is primary guard).
 * Records a subscription_created event.
 */
export async function createTenantSubscription(
  input: CreateTenantSubscriptionInput,
): Promise<TenantSubscription> {
  return db.transaction(async (tx) => {
    await assertNoOverlap(
      tx,
      input.tenantId,
      input.effectiveFrom,
      input.effectiveTo ?? null,
      null,
    );

    const [sub] = await tx
      .insert(tenantSubscriptions)
      .values({
        tenantId: input.tenantId,
        subscriptionPlanId: input.subscriptionPlanId,
        status: input.status ?? "active",
        currentPeriodStart: input.currentPeriodStart,
        currentPeriodEnd: input.currentPeriodEnd,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        metadata: input.metadata ?? null,
      })
      .returning();

    await tx.insert(tenantSubscriptionEvents).values({
      tenantSubscriptionId: sub.id,
      tenantId: input.tenantId,
      eventType: "subscription_created",
      metadata: { planId: input.subscriptionPlanId, status: sub.status },
    });

    return sub;
  });
}

export interface ChangeTenantSubscriptionInput {
  newPlanId: string;
  newStatus?: "trialing" | "active" | "past_due" | "paused" | "cancelled";
  newCurrentPeriodStart: Date;
  newCurrentPeriodEnd: Date;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  metadata?: Record<string, unknown> | null;
  eventType?:
    | "subscription_upgraded"
    | "subscription_downgraded"
    | "subscription_renewed"
    | "subscription_paused"
    | "subscription_resumed";
}

/**
 * Change a tenant's active subscription to a new plan.
 * Closes the current subscription window (sets effectiveTo = effectiveFrom of new one)
 * and inserts a new subscription row. Records event history on both.
 */
export async function changeTenantSubscription(
  tenantId: string,
  input: ChangeTenantSubscriptionInput,
): Promise<{ previous: TenantSubscription; next: TenantSubscription }> {
  return db.transaction(async (tx) => {
    const current = await getActiveTenantSubscription(tenantId);

    await tx
      .update(tenantSubscriptions)
      .set({ effectiveTo: input.effectiveFrom, status: "cancelled" })
      .where(eq(tenantSubscriptions.id, current.id));

    await tx.insert(tenantSubscriptionEvents).values({
      tenantSubscriptionId: current.id,
      tenantId,
      eventType: "subscription_cancelled",
      metadata: {
        reason: "replaced_by_plan_change",
        newPlanId: input.newPlanId,
      },
    });

    await assertNoOverlap(
      tx,
      tenantId,
      input.effectiveFrom,
      input.effectiveTo ?? null,
      current.id,
    );

    const [next] = await tx
      .insert(tenantSubscriptions)
      .values({
        tenantId,
        subscriptionPlanId: input.newPlanId,
        status: input.newStatus ?? "active",
        currentPeriodStart: input.newCurrentPeriodStart,
        currentPeriodEnd: input.newCurrentPeriodEnd,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        metadata: input.metadata ?? null,
      })
      .returning();

    await tx.insert(tenantSubscriptionEvents).values({
      tenantSubscriptionId: next.id,
      tenantId,
      eventType: input.eventType ?? "subscription_upgraded",
      metadata: {
        previousPlanId: current.subscriptionPlanId,
        newPlanId: input.newPlanId,
      },
    });

    return { previous: current, next };
  });
}

/**
 * Cancel the active tenant subscription.
 * Sets effectiveTo on the current subscription and records a cancellation event.
 */
export async function cancelTenantSubscription(
  tenantId: string,
  effectiveTo: Date = new Date(),
  metadata?: Record<string, unknown> | null,
): Promise<TenantSubscription> {
  return db.transaction(async (tx) => {
    const current = await getActiveTenantSubscription(tenantId);

    const [updated] = await tx
      .update(tenantSubscriptions)
      .set({ effectiveTo, status: "cancelled" })
      .where(eq(tenantSubscriptions.id, current.id))
      .returning();

    await tx.insert(tenantSubscriptionEvents).values({
      tenantSubscriptionId: current.id,
      tenantId,
      eventType: "subscription_cancelled",
      metadata: metadata ?? null,
    });

    return updated;
  });
}

/**
 * Explicitly record a subscription lifecycle event.
 * Use for external events not covered by create/change/cancel.
 */
export async function recordTenantSubscriptionEvent(
  tenantSubscriptionId: string,
  tenantId: string,
  eventType: string,
  metadata?: Record<string, unknown> | null,
): Promise<TenantSubscriptionEvent> {
  const [row] = await db
    .insert(tenantSubscriptionEvents)
    .values({ tenantSubscriptionId, tenantId, eventType, metadata: metadata ?? null })
    .returning();
  return row;
}

// ─── Non-Overlap Guard ────────────────────────────────────────────────────────

/**
 * Runtime check: ensure no existing active subscription window overlaps
 * with the proposed [effectiveFrom, effectiveTo) window for this tenant.
 *
 * The primary enforcement is the DB trigger (no_overlapping_tenant_subscriptions),
 * but this runtime guard provides a friendlier error message.
 *
 * excludeId — subscription row to skip (used during plan changes where the
 * old row's effectiveTo is being set within the same transaction).
 */
async function assertNoOverlap(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  tenantId: string,
  effectiveFrom: Date,
  effectiveTo: Date | null,
  excludeId: string | null,
): Promise<void> {
  const allRows = await tx
    .select()
    .from(tenantSubscriptions)
    .where(eq(tenantSubscriptions.tenantId, tenantId));

  const candidates = excludeId
    ? allRows.filter((r) => r.id !== excludeId)
    : allRows;

  for (const row of candidates) {
    const rowTo = row.effectiveTo ? new Date(row.effectiveTo) : null;
    const rowFrom = new Date(row.effectiveFrom);
    const newTo = effectiveTo;
    const newFrom = effectiveFrom;

    const overlaps =
      (rowTo === null || rowTo > newFrom) &&
      (newTo === null || newTo > rowFrom);

    if (overlaps) {
      throw new Error(
        `[subscriptions] Overlapping subscription window for tenant '${tenantId}': ` +
          `existing row ${row.id} [${rowFrom.toISOString()} → ${rowTo?.toISOString() ?? "open"}] ` +
          `conflicts with proposed [${newFrom.toISOString()} → ${newTo?.toISOString() ?? "open"}]`,
      );
    }
  }
}
