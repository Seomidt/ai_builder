/**
 * Admin Plan Helpers — Phase 4P
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides safe admin operations for subscription plan management:
 *   - Create new plan versions (append-safe)
 *   - Replace plan entitlements as a controlled admin operation
 *   - Archive plans without destroying historical tenant subscription references
 *   - Inspect plan definitions
 *
 * Design rules:
 *   A) Plans are append-safe — creating a new version is preferred over in-place edit
 *   B) Historical tenant subscriptions remain traceable to plan rows used at the time
 *   C) Archived plans do not become active for new assignments
 *   D) All operations record admin_change_requests + admin_change_events
 */

import { eq, desc, asc } from "drizzle-orm";
import { db } from "../../db";
import {
  subscriptionPlans,
  planEntitlements,
  tenantSubscriptions,
  adminChangeRequests,
  adminChangeEvents,
} from "@shared/schema";
import type { SubscriptionPlan, PlanEntitlement } from "@shared/schema";

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

// ─── Plan Creation ────────────────────────────────────────────────────────────

export interface CreateSubscriptionPlanInput {
  planCode: string;
  planName: string;
  billingInterval: "monthly" | "yearly";
  basePriceUsd: string;
  currency?: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  metadata?: Record<string, unknown> | null;
  requestedBy?: string | null;
}

export interface CreateSubscriptionPlanPreview {
  valid: boolean;
  duplicateCodeAtSameEffectiveFrom: boolean;
  proposedPlanCode: string;
  proposedEffectiveFrom: string;
  message: string;
}

export async function previewCreateSubscriptionPlan(
  input: CreateSubscriptionPlanInput,
): Promise<CreateSubscriptionPlanPreview> {
  const existing = await db
    .select({ id: subscriptionPlans.id })
    .from(subscriptionPlans)
    .where(
      eq(subscriptionPlans.planCode, input.planCode),
    );

  const sameEffectiveFrom = existing.length > 0;

  return {
    valid: true,
    duplicateCodeAtSameEffectiveFrom: sameEffectiveFrom,
    proposedPlanCode: input.planCode,
    proposedEffectiveFrom: new Date(input.effectiveFrom).toISOString(),
    message: sameEffectiveFrom
      ? `Warning: planCode '${input.planCode}' already exists. A new version will be created with effectiveFrom=${new Date(input.effectiveFrom).toISOString()}.`
      : `New plan '${input.planCode}' can be created safely.`,
  };
}

export async function applyCreateSubscriptionPlan(
  input: CreateSubscriptionPlanInput,
): Promise<{ changeRequestId: string; planId: string }> {
  const payload = { ...input, effectiveFrom: input.effectiveFrom.toISOString() };
  const changeRequestId = await createAdminChangeRequest(
    "subscription_plan_create",
    "plan",
    null,
    payload,
    input.requestedBy ?? null,
  );

  await recordAdminChangeEvent(changeRequestId, "request_created", { planCode: input.planCode });
  await recordAdminChangeEvent(changeRequestId, "apply_started", null);

  try {
    const rows = await db
      .insert(subscriptionPlans)
      .values({
        planCode: input.planCode,
        planName: input.planName,
        status: "active",
        billingInterval: input.billingInterval,
        basePriceUsd: input.basePriceUsd,
        currency: input.currency ?? "USD",
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        metadata: input.metadata ?? null,
      })
      .returning({ id: subscriptionPlans.id });

    const planId = rows[0].id;
    await markAdminChangeApplied(changeRequestId, { planId, planCode: input.planCode });
    await recordAdminChangeEvent(changeRequestId, "apply_succeeded", { planId });

    return { changeRequestId, planId };
  } catch (err) {
    await markAdminChangeFailed(changeRequestId, (err as Error).message);
    await recordAdminChangeEvent(changeRequestId, "apply_failed", { error: (err as Error).message });
    throw err;
  }
}

// ─── Plan Entitlement Replacement ─────────────────────────────────────────────

export interface EntitlementInput {
  entitlementKey: string;
  entitlementType: "limit" | "included_usage" | "feature_flag" | "overage_rule";
  numericValue?: string | null;
  textValue?: string | null;
  booleanValue?: boolean | null;
  metadata?: Record<string, unknown> | null;
}

export interface ReplacePlanEntitlementsPreview {
  planId: string;
  planCode: string;
  existingCount: number;
  proposedCount: number;
  wouldDelete: number;
  wouldInsert: number;
  proposedKeys: string[];
  message: string;
}

export async function previewReplacePlanEntitlements(
  planId: string,
  entitlementSet: EntitlementInput[],
): Promise<ReplacePlanEntitlementsPreview> {
  const plan = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, planId)).limit(1);
  if (plan.length === 0) throw new Error(`[admin-plans] Plan not found: ${planId}`);

  const existing = await db.select().from(planEntitlements).where(eq(planEntitlements.subscriptionPlanId, planId));

  return {
    planId,
    planCode: plan[0].planCode,
    existingCount: existing.length,
    proposedCount: entitlementSet.length,
    wouldDelete: existing.length,
    wouldInsert: entitlementSet.length,
    proposedKeys: entitlementSet.map((e) => e.entitlementKey),
    message: `Replace ${existing.length} existing entitlements with ${entitlementSet.length} new entitlements for plan '${plan[0].planCode}'.`,
  };
}

export async function applyReplacePlanEntitlements(
  planId: string,
  entitlementSet: EntitlementInput[],
  requestedBy: string | null = null,
): Promise<{ changeRequestId: string; deletedCount: number; insertedCount: number }> {
  const plan = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, planId)).limit(1);
  if (plan.length === 0) throw new Error(`[admin-plans] Plan not found: ${planId}`);

  const changeRequestId = await createAdminChangeRequest(
    "plan_entitlement_replace",
    "plan",
    planId,
    { planId, planCode: plan[0].planCode, entitlementCount: entitlementSet.length },
    requestedBy,
  );

  await recordAdminChangeEvent(changeRequestId, "request_created", { planId, planCode: plan[0].planCode });
  await recordAdminChangeEvent(changeRequestId, "apply_started", null);

  try {
    const existing = await db.select({ id: planEntitlements.id }).from(planEntitlements).where(eq(planEntitlements.subscriptionPlanId, planId));
    const deletedCount = existing.length;

    await db.transaction(async (tx) => {
      if (existing.length > 0) {
        await tx.delete(planEntitlements).where(eq(planEntitlements.subscriptionPlanId, planId));
      }
      if (entitlementSet.length > 0) {
        await tx.insert(planEntitlements).values(
          entitlementSet.map((e) => ({
            subscriptionPlanId: planId,
            entitlementKey: e.entitlementKey,
            entitlementType: e.entitlementType,
            numericValue: e.numericValue ?? null,
            textValue: e.textValue ?? null,
            booleanValue: e.booleanValue ?? null,
            metadata: e.metadata ?? null,
          })),
        );
      }
    });

    await markAdminChangeApplied(changeRequestId, { planId, deletedCount, insertedCount: entitlementSet.length });
    await recordAdminChangeEvent(changeRequestId, "apply_succeeded", { deletedCount, insertedCount: entitlementSet.length });

    return { changeRequestId, deletedCount, insertedCount: entitlementSet.length };
  } catch (err) {
    await markAdminChangeFailed(changeRequestId, (err as Error).message);
    await recordAdminChangeEvent(changeRequestId, "apply_failed", { error: (err as Error).message });
    throw err;
  }
}

// ─── Archive Plan ─────────────────────────────────────────────────────────────

export async function archiveSubscriptionPlan(
  planId: string,
  requestedBy: string | null = null,
): Promise<{ changeRequestId: string; planId: string; previousStatus: string }> {
  const plan = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, planId)).limit(1);
  if (plan.length === 0) throw new Error(`[admin-plans] Plan not found: ${planId}`);

  const previousStatus = plan[0].status;

  const changeRequestId = await createAdminChangeRequest(
    "subscription_plan_create",
    "plan",
    planId,
    { planId, planCode: plan[0].planCode, action: "archive", previousStatus },
    requestedBy,
  );

  await recordAdminChangeEvent(changeRequestId, "request_created", { planId, planCode: plan[0].planCode, action: "archive" });
  await recordAdminChangeEvent(changeRequestId, "apply_started", null);

  try {
    await db.update(subscriptionPlans)
      .set({ status: "archived" })
      .where(eq(subscriptionPlans.id, planId));

    await markAdminChangeApplied(changeRequestId, { planId, previousStatus, newStatus: "archived" });
    await recordAdminChangeEvent(changeRequestId, "apply_succeeded", { planId, previousStatus, newStatus: "archived" });

    return { changeRequestId, planId, previousStatus };
  } catch (err) {
    await markAdminChangeFailed(changeRequestId, (err as Error).message);
    await recordAdminChangeEvent(changeRequestId, "apply_failed", { error: (err as Error).message });
    throw err;
  }
}

// ─── List & Explain ───────────────────────────────────────────────────────────

export async function listAdminSubscriptionPlans(limit = 50): Promise<SubscriptionPlan[]> {
  return db
    .select()
    .from(subscriptionPlans)
    .orderBy(desc(subscriptionPlans.createdAt))
    .limit(limit);
}

export interface PlanDefinitionExplanation {
  plan: SubscriptionPlan;
  entitlements: PlanEntitlement[];
  activeSubscriptionCount: number;
  isArchived: boolean;
}

export async function explainPlanDefinition(planId: string): Promise<PlanDefinitionExplanation> {
  const plan = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, planId)).limit(1);
  if (plan.length === 0) throw new Error(`[admin-plans] Plan not found: ${planId}`);

  const entitlements = await db
    .select()
    .from(planEntitlements)
    .where(eq(planEntitlements.subscriptionPlanId, planId))
    .orderBy(asc(planEntitlements.entitlementKey));

  const activeSubs = await db
    .select({ id: tenantSubscriptions.id })
    .from(tenantSubscriptions)
    .where(eq(tenantSubscriptions.subscriptionPlanId, planId));

  return {
    plan: plan[0],
    entitlements,
    activeSubscriptionCount: activeSubs.length,
    isArchived: plan[0].status === "archived",
  };
}
