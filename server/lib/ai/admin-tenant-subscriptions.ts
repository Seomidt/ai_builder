/**
 * Admin Tenant Subscription Helpers — Phase 4P
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides safe admin operations for tenant plan migrations:
 *   - Preview plan changes before applying
 *   - Apply plan changes using existing subscription primitives
 *   - Preview/apply plan cancellations
 *   - List full subscription history for a tenant
 *
 * Design rules:
 *   A) No silent plan replacement — all changes are explicit and traceable
 *   B) Non-overlapping window guarantees preserved via assertNoOverlap + DB trigger
 *   C) Historical subscriptions remain intact — only new rows added
 *   D) All operations record admin_change_requests + admin_change_events
 */

import { eq, desc } from "drizzle-orm";
import { db } from "../../db";
import {
  subscriptionPlans,
  planEntitlements,
  tenantSubscriptions,
  adminChangeRequests,
  adminChangeEvents,
} from "@shared/schema";
import type { SubscriptionPlan, PlanEntitlement, TenantSubscription } from "@shared/schema";
import {
  getActiveTenantSubscription,
  changeTenantSubscription,
  cancelTenantSubscription,
} from "./subscriptions";

// ─── Internal Admin Change Helpers ───────────────────────────────────────────

async function createAdminChangeRequest(
  changeType: string,
  targetScope: string,
  targetId: string | null,
  requestPayload: Record<string, unknown>,
  requestedBy: string | null,
): Promise<string> {
  const rows = await db
    .insert(adminChangeRequests)
    .values({ changeType, targetScope, targetId, requestedBy, status: "pending", requestPayload })
    .returning({ id: adminChangeRequests.id });
  return rows[0].id;
}

async function recordAdminChangeEvent(
  adminChangeRequestId: string,
  eventType: string,
  metadata: Record<string, unknown> | null = null,
): Promise<void> {
  await db.insert(adminChangeEvents).values({ adminChangeRequestId, eventType, metadata });
}

async function markAdminChangeApplied(id: string, appliedResult: Record<string, unknown>): Promise<void> {
  await db.update(adminChangeRequests)
    .set({ status: "applied", appliedResult, appliedAt: new Date() })
    .where(eq(adminChangeRequests.id, id));
}

async function markAdminChangeFailed(id: string, errorMessage: string): Promise<void> {
  await db.update(adminChangeRequests)
    .set({ status: "failed", errorMessage })
    .where(eq(adminChangeRequests.id, id));
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TenantPlanChangePreview {
  tenantId: string;
  currentSubscription: TenantSubscription | null;
  currentPlan: SubscriptionPlan | null;
  currentEntitlements: PlanEntitlement[];
  proposedPlanId: string;
  proposedPlan: SubscriptionPlan | null;
  proposedEntitlements: PlanEntitlement[];
  proposedEffectiveFrom: string;
  overlapRisk: boolean;
  overlapExplanation: string | null;
  safeToApply: boolean;
  message: string;
}

export interface TenantPlanCancellationPreview {
  tenantId: string;
  currentSubscription: TenantSubscription | null;
  currentPlan: SubscriptionPlan | null;
  proposedEffectiveTo: string;
  safeToApply: boolean;
  message: string;
}

// ─── Preview Tenant Plan Change ───────────────────────────────────────────────

export async function previewTenantPlanChange(
  tenantId: string,
  newPlanId: string,
  effectiveFrom: Date,
): Promise<TenantPlanChangePreview> {
  let currentSubscription: TenantSubscription | null = null;
  let currentPlan: SubscriptionPlan | null = null;
  let currentEntitlements: PlanEntitlement[] = [];

  try {
    currentSubscription = await getActiveTenantSubscription(tenantId, new Date());
    const planRows = await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, currentSubscription.subscriptionPlanId))
      .limit(1);
    currentPlan = planRows[0] ?? null;
    currentEntitlements = await db
      .select()
      .from(planEntitlements)
      .where(eq(planEntitlements.subscriptionPlanId, currentSubscription.subscriptionPlanId));
  } catch {
    // No active subscription — valid for new tenant
  }

  const newPlanRows = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, newPlanId))
    .limit(1);
  const proposedPlan = newPlanRows[0] ?? null;

  const proposedEntitlements = proposedPlan
    ? await db.select().from(planEntitlements).where(eq(planEntitlements.subscriptionPlanId, newPlanId))
    : [];

  if (!proposedPlan) {
    return {
      tenantId,
      currentSubscription,
      currentPlan,
      currentEntitlements,
      proposedPlanId: newPlanId,
      proposedPlan: null,
      proposedEntitlements: [],
      proposedEffectiveFrom: effectiveFrom.toISOString(),
      overlapRisk: false,
      overlapExplanation: null,
      safeToApply: false,
      message: `Proposed plan '${newPlanId}' not found.`,
    };
  }

  if (proposedPlan.status === "archived") {
    return {
      tenantId,
      currentSubscription,
      currentPlan,
      currentEntitlements,
      proposedPlanId: newPlanId,
      proposedPlan,
      proposedEntitlements,
      proposedEffectiveFrom: effectiveFrom.toISOString(),
      overlapRisk: false,
      overlapExplanation: null,
      safeToApply: false,
      message: `Proposed plan '${proposedPlan.planCode}' is archived and cannot be assigned.`,
    };
  }

  // Check for overlap: existing active subscription window vs proposed effectiveFrom
  let overlapRisk = false;
  let overlapExplanation: string | null = null;
  if (currentSubscription) {
    const currentTo = currentSubscription.effectiveTo ? new Date(currentSubscription.effectiveTo) : null;
    if (!currentTo || currentTo > effectiveFrom) {
      overlapRisk = true;
      overlapExplanation = `Current subscription [${new Date(currentSubscription.effectiveFrom).toISOString()} → ${currentTo?.toISOString() ?? "open"}] overlaps with proposed effectiveFrom=${effectiveFrom.toISOString()}. changeTenantSubscription will close the current window before applying.`;
    }
  }

  return {
    tenantId,
    currentSubscription,
    currentPlan,
    currentEntitlements,
    proposedPlanId: newPlanId,
    proposedPlan,
    proposedEntitlements,
    proposedEffectiveFrom: effectiveFrom.toISOString(),
    overlapRisk,
    overlapExplanation,
    safeToApply: true,
    message: overlapRisk
      ? `Plan change safe to apply. Current subscription window will be closed at effectiveFrom=${effectiveFrom.toISOString()}.`
      : `Plan change safe to apply. No active subscription — new subscription will be created.`,
  };
}

// ─── Apply Tenant Plan Change ─────────────────────────────────────────────────

export async function applyTenantPlanChange(
  tenantId: string,
  newPlanId: string,
  effectiveFrom: Date,
  requestedBy: string | null = null,
): Promise<{ changeRequestId: string; newSubscriptionId: string }> {
  const changeRequestId = await createAdminChangeRequest(
    "tenant_subscription_change",
    "tenant",
    tenantId,
    { tenantId, newPlanId, effectiveFrom: effectiveFrom.toISOString() },
    requestedBy,
  );

  await recordAdminChangeEvent(changeRequestId, "request_created", { tenantId, newPlanId });
  await recordAdminChangeEvent(changeRequestId, "apply_started", null);

  try {
    // Derive billing period from plan's billing interval
    const planRows = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, newPlanId)).limit(1);
    if (planRows.length === 0) throw new Error(`[admin-tenant-subscriptions] Plan not found: ${newPlanId}`);
    const plan = planRows[0];

    const newCurrentPeriodStart = effectiveFrom;
    const newCurrentPeriodEnd = new Date(effectiveFrom);
    if (plan.billingInterval === "yearly") {
      newCurrentPeriodEnd.setFullYear(newCurrentPeriodEnd.getFullYear() + 1);
    } else {
      newCurrentPeriodEnd.setMonth(newCurrentPeriodEnd.getMonth() + 1);
    }

    const result = await changeTenantSubscription(tenantId, {
      newPlanId,
      newCurrentPeriodStart,
      newCurrentPeriodEnd,
      effectiveFrom,
      eventType: "subscription_upgraded",
      metadata: requestedBy ? { requestedBy } : null,
    });

    await markAdminChangeApplied(changeRequestId, {
      newSubscriptionId: result.next.id,
      previousSubscriptionId: result.previous.id,
      tenantId,
      newPlanId,
    });
    await recordAdminChangeEvent(changeRequestId, "apply_succeeded", { newSubscriptionId: result.next.id });

    return { changeRequestId, newSubscriptionId: result.next.id };
  } catch (err) {
    await markAdminChangeFailed(changeRequestId, (err as Error).message);
    await recordAdminChangeEvent(changeRequestId, "apply_failed", { error: (err as Error).message });
    throw err;
  }
}

// ─── Preview Tenant Plan Cancellation ────────────────────────────────────────

export async function previewTenantPlanCancellation(
  tenantId: string,
  effectiveTo: Date,
): Promise<TenantPlanCancellationPreview> {
  let currentSubscription: TenantSubscription | null = null;
  let currentPlan: SubscriptionPlan | null = null;

  try {
    currentSubscription = await getActiveTenantSubscription(tenantId, new Date());
    const planRows = await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, currentSubscription.subscriptionPlanId))
      .limit(1);
    currentPlan = planRows[0] ?? null;
  } catch {
    return {
      tenantId,
      currentSubscription: null,
      currentPlan: null,
      proposedEffectiveTo: effectiveTo.toISOString(),
      safeToApply: false,
      message: "No active subscription found for this tenant.",
    };
  }

  if (effectiveTo <= new Date(currentSubscription.effectiveFrom)) {
    return {
      tenantId,
      currentSubscription,
      currentPlan,
      proposedEffectiveTo: effectiveTo.toISOString(),
      safeToApply: false,
      message: `Proposed effectiveTo=${effectiveTo.toISOString()} is before or equal to current subscription effectiveFrom=${new Date(currentSubscription.effectiveFrom).toISOString()}.`,
    };
  }

  return {
    tenantId,
    currentSubscription,
    currentPlan,
    proposedEffectiveTo: effectiveTo.toISOString(),
    safeToApply: true,
    message: `Cancellation safe to apply. Subscription will end at ${effectiveTo.toISOString()}.`,
  };
}

// ─── Apply Tenant Plan Cancellation ──────────────────────────────────────────

export async function applyTenantPlanCancellation(
  tenantId: string,
  effectiveTo: Date,
  requestedBy: string | null = null,
): Promise<{ changeRequestId: string; subscriptionId: string }> {
  const changeRequestId = await createAdminChangeRequest(
    "tenant_subscription_cancel",
    "tenant",
    tenantId,
    { tenantId, effectiveTo: effectiveTo.toISOString() },
    requestedBy,
  );

  await recordAdminChangeEvent(changeRequestId, "request_created", { tenantId, effectiveTo: effectiveTo.toISOString() });
  await recordAdminChangeEvent(changeRequestId, "apply_started", null);

  try {
    const cancelled = await cancelTenantSubscription(
      tenantId,
      effectiveTo,
      requestedBy ? { requestedBy } : null,
    );

    await markAdminChangeApplied(changeRequestId, { subscriptionId: cancelled.id, tenantId });
    await recordAdminChangeEvent(changeRequestId, "apply_succeeded", { subscriptionId: cancelled.id });

    return { changeRequestId, subscriptionId: cancelled.id };
  } catch (err) {
    await markAdminChangeFailed(changeRequestId, (err as Error).message);
    await recordAdminChangeEvent(changeRequestId, "apply_failed", { error: (err as Error).message });
    throw err;
  }
}

// ─── List Subscription History ────────────────────────────────────────────────

export async function listTenantSubscriptionHistory(
  tenantId: string,
): Promise<(TenantSubscription & { plan: SubscriptionPlan | null })[]> {
  const subs = await db
    .select()
    .from(tenantSubscriptions)
    .where(eq(tenantSubscriptions.tenantId, tenantId))
    .orderBy(desc(tenantSubscriptions.effectiveFrom));

  const result: (TenantSubscription & { plan: SubscriptionPlan | null })[] = [];
  for (const sub of subs) {
    const planRows = await db
      .select()
      .from(subscriptionPlans)
      .where(eq(subscriptionPlans.id, sub.subscriptionPlanId))
      .limit(1);
    result.push({ ...sub, plan: planRows[0] ?? null });
  }

  return result;
}
