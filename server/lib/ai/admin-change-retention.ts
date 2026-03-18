/**
 * Admin Change Retention Helpers — Phase 4P
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides operational safety and inspection helpers:
 *   - Explain the retention policy for admin change records
 *   - Preview stale pending or failed changes for ops review
 *   - Identify applied changes with no event trail (data quality check)
 *   - Identify plan rows still referenced by historical tenant subscriptions
 *
 * Design rules:
 *   A) No historical applied changes are deleted in this phase
 *   B) Read-only operational inspection only
 *   C) days must be > 0 where applicable
 */

import { eq, and, lt, isNull, ne, desc } from "drizzle-orm";
import { db } from "../../db";
import {
  adminChangeRequests,
  adminChangeEvents,
  subscriptionPlans,
  tenantSubscriptions,
} from "@shared/schema";
import type { AdminChangeRequest, SubscriptionPlan } from "@shared/schema";

// ─── Retention Policy ─────────────────────────────────────────────────────────

export interface AdminChangeRetentionPolicy {
  appliedChanges: string;
  rejectedChanges: string;
  failedChanges: string;
  pendingChanges: string;
  eventHistory: string;
  historicalPricingRows: string;
  historicalPlanRows: string;
  note: string;
}

export function explainAdminChangeRetentionPolicy(): AdminChangeRetentionPolicy {
  return {
    appliedChanges: "Retained indefinitely. Applied admin change requests are the permanent audit record of commercial decisions.",
    rejectedChanges: "Retained indefinitely. Rejected requests document explicitly blocked operations.",
    failedChanges: "Retained indefinitely. Failed requests provide error forensics for ops.",
    pendingChanges: "Stale pending requests (no apply/reject within 30 days) should be reviewed and resolved or rejected manually.",
    eventHistory: "Admin change events are append-only and never deleted. They form the immutable timeline for each change.",
    historicalPricingRows: "Provider/customer/storage pricing version rows referenced by billing rows are never deleted. Archived = logically retired but physically preserved.",
    historicalPlanRows: "Subscription plan rows referenced by tenant_subscriptions are never deleted. Archived plans are not offered for new assignments.",
    note: "Phase 4P does not implement any automated deletion. All helpers in this module are inspection-only.",
  };
}

// ─── Stale Pending Changes ────────────────────────────────────────────────────

export async function previewPendingAdminChangesOlderThan(
  days: number,
): Promise<AdminChangeRequest[]> {
  if (days <= 0) throw new Error("[admin-change-retention] days must be > 0");

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  return db
    .select()
    .from(adminChangeRequests)
    .where(
      and(
        eq(adminChangeRequests.status, "pending"),
        lt(adminChangeRequests.createdAt, cutoff),
      ),
    )
    .orderBy(desc(adminChangeRequests.createdAt));
}

// ─── Stale Failed Changes ─────────────────────────────────────────────────────

export async function previewFailedAdminChangesOlderThan(
  days: number,
): Promise<AdminChangeRequest[]> {
  if (days <= 0) throw new Error("[admin-change-retention] days must be > 0");

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  return db
    .select()
    .from(adminChangeRequests)
    .where(
      and(
        eq(adminChangeRequests.status, "failed"),
        lt(adminChangeRequests.createdAt, cutoff),
      ),
    )
    .orderBy(desc(adminChangeRequests.createdAt));
}

// ─── Applied Changes Without Events ──────────────────────────────────────────

export interface AppliedChangeWithoutEvents {
  changeRequestId: string;
  changeType: string;
  appliedAt: Date | null;
  createdAt: Date;
}

export async function previewAppliedAdminChangesWithoutEvents(): Promise<AppliedChangeWithoutEvents[]> {
  const appliedRequests = await db
    .select()
    .from(adminChangeRequests)
    .where(eq(adminChangeRequests.status, "applied"));

  const result: AppliedChangeWithoutEvents[] = [];

  for (const req of appliedRequests) {
    const events = await db
      .select({ id: adminChangeEvents.id })
      .from(adminChangeEvents)
      .where(eq(adminChangeEvents.adminChangeRequestId, req.id))
      .limit(1);

    if (events.length === 0) {
      result.push({
        changeRequestId: req.id,
        changeType: req.changeType,
        appliedAt: req.appliedAt,
        createdAt: req.createdAt,
      });
    }
  }

  return result;
}

// ─── Plan Rows Still Referenced ───────────────────────────────────────────────

export interface HistoricallyReferencedPlan {
  plan: SubscriptionPlan;
  referencedBySubscriptionCount: number;
  isArchived: boolean;
}

export async function previewPlanRowsStillReferencedHistorically(): Promise<HistoricallyReferencedPlan[]> {
  const allPlans = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.status, "archived"))
    .orderBy(desc(subscriptionPlans.createdAt));

  const result: HistoricallyReferencedPlan[] = [];

  for (const plan of allPlans) {
    const subs = await db
      .select({ id: tenantSubscriptions.id })
      .from(tenantSubscriptions)
      .where(eq(tenantSubscriptions.subscriptionPlanId, plan.id));

    if (subs.length > 0) {
      result.push({
        plan,
        referencedBySubscriptionCount: subs.length,
        isArchived: true,
      });
    }
  }

  return result;
}
