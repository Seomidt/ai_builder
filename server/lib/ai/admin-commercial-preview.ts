/**
 * Admin Commercial Preview Helpers — Phase 4P
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides dry-run and preview helpers for commercial changes:
 *   - Preview pricing impact for a tenant
 *   - Preview plan entitlement impact for a tenant
 *   - Preview global pricing window changes
 *   - Explain an admin change request preview
 *
 * Design rules:
 *   A) No writes during preview — strictly read-only
 *   B) No mutation of canonical billing tables ever
 *   C) Structured JSON-safe output for all previews
 *   D) Focus on correctness and explainability
 */

import { eq, and, lte, or, isNull, gt, desc } from "drizzle-orm";
import { db } from "../../db";
import {
  providerPricingVersions,
  customerPricingVersions,
  storagePricingVersions,
  customerStoragePricingVersions,
  subscriptionPlans,
  planEntitlements,
  tenantSubscriptions,
  adminChangeRequests,
  adminChangeEvents,
} from "@shared/schema";
import type {
  ProviderPricingVersion,
  CustomerPricingVersion,
  PlanEntitlement,
  AdminChangeRequest,
  AdminChangeEvent,
} from "@shared/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PricingVersionWindow {
  id: string;
  versionKey: string;
  pricingVersion: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}

export interface TenantPricingImpactPreview {
  tenantId: string;
  atTime: string;
  activeProviderVersions: PricingVersionWindow[];
  activeCustomerVersions: PricingVersionWindow[];
  proposedChangeSummary: string;
  overlapConflicts: PricingVersionWindow[];
  onlyAffectsFuture: boolean;
  historicalBillingUntouched: boolean;
  message: string;
}

export interface PlanImpactPreview {
  tenantId: string;
  atTime: string;
  currentPlanId: string | null;
  currentPlanCode: string | null;
  currentEntitlements: { key: string; type: string; value: string | null }[];
  proposedPlanId: string;
  proposedPlanCode: string | null;
  proposedEntitlements: { key: string; type: string; value: string | null }[];
  addedEntitlements: string[];
  removedEntitlements: string[];
  changedEntitlements: string[];
  overageImplication: string | null;
  safeToApply: boolean;
}

export interface GlobalPricingWindowPreview {
  proposedProvider: string;
  proposedModel: string;
  proposedEffectiveFrom: string;
  proposedEffectiveTo: string | null;
  existingWindows: PricingVersionWindow[];
  conflicts: PricingVersionWindow[];
  onlyAffectsFuture: boolean;
  historicalBillingUntouched: boolean;
  safeToApply: boolean;
  message: string;
}

// ─── Preview Pricing Impact for Tenant ────────────────────────────────────────

export async function previewPricingImpactForTenant(
  tenantId: string,
  atTime: Date,
  proposedChanges: {
    provider?: string;
    model?: string;
    feature?: string;
    proposedEffectiveFrom?: Date;
    proposedEffectiveTo?: Date | null;
  },
): Promise<TenantPricingImpactPreview> {
  const customerVersions = await db
    .select()
    .from(customerPricingVersions)
    .where(
      and(
        eq(customerPricingVersions.tenantId, tenantId),
        lte(customerPricingVersions.effectiveFrom, atTime),
        or(
          isNull(customerPricingVersions.effectiveTo),
          gt(customerPricingVersions.effectiveTo, atTime),
        ),
      ),
    );

  const providerVersions = proposedChanges.provider && proposedChanges.model
    ? await db
        .select()
        .from(providerPricingVersions)
        .where(
          and(
            eq(providerPricingVersions.provider, proposedChanges.provider),
            eq(providerPricingVersions.model, proposedChanges.model),
            lte(providerPricingVersions.effectiveFrom, atTime),
            or(
              isNull(providerPricingVersions.effectiveTo),
              gt(providerPricingVersions.effectiveTo, atTime),
            ),
          ),
        )
    : [];

  const proposedFrom = proposedChanges.proposedEffectiveFrom;
  const proposedTo = proposedChanges.proposedEffectiveTo ?? null;

  const overlapConflicts: PricingVersionWindow[] = [];
  if (proposedFrom) {
    for (const v of providerVersions) {
      const vFrom = new Date(v.effectiveFrom);
      const vTo = v.effectiveTo ? new Date(v.effectiveTo) : null;
      const pFrom = new Date(proposedFrom);
      const pTo = proposedTo ? new Date(proposedTo) : null;
      const aEnd = pTo ? pTo.getTime() : Infinity;
      const bEnd = vTo ? vTo.getTime() : Infinity;
      if (pFrom.getTime() < bEnd && vFrom.getTime() < aEnd) {
        overlapConflicts.push({
          id: v.id,
          versionKey: `${v.provider}/${v.model}`,
          pricingVersion: v.pricingVersion,
          effectiveFrom: vFrom.toISOString(),
          effectiveTo: vTo?.toISOString() ?? null,
        });
      }
    }
  }

  const onlyAffectsFuture = proposedFrom ? new Date(proposedFrom) > atTime : true;

  return {
    tenantId,
    atTime: atTime.toISOString(),
    activeProviderVersions: providerVersions.map((v) => ({
      id: v.id,
      versionKey: `${v.provider}/${v.model}`,
      pricingVersion: v.pricingVersion,
      effectiveFrom: new Date(v.effectiveFrom).toISOString(),
      effectiveTo: v.effectiveTo ? new Date(v.effectiveTo).toISOString() : null,
    })),
    activeCustomerVersions: customerVersions.map((v) => ({
      id: v.id,
      versionKey: `${v.tenantId}/${v.feature}/${v.provider}`,
      pricingVersion: v.pricingVersion,
      effectiveFrom: new Date(v.effectiveFrom).toISOString(),
      effectiveTo: v.effectiveTo ? new Date(v.effectiveTo).toISOString() : null,
    })),
    proposedChangeSummary: JSON.stringify(proposedChanges),
    overlapConflicts,
    onlyAffectsFuture,
    historicalBillingUntouched: true,
    message: overlapConflicts.length > 0
      ? `${overlapConflicts.length} overlap conflict(s) detected. Apply blocked.`
      : onlyAffectsFuture
        ? "Proposed change only affects future records. Historical billing untouched."
        : "Proposed change may affect current or past resolution windows.",
  };
}

// ─── Preview Plan Impact for Tenant ───────────────────────────────────────────

function entitlementValue(e: PlanEntitlement): string | null {
  if (e.booleanValue !== null && e.booleanValue !== undefined) return String(e.booleanValue);
  if (e.numericValue !== null && e.numericValue !== undefined) return String(e.numericValue);
  return e.textValue ?? null;
}

export async function previewPlanImpactForTenant(
  tenantId: string,
  atTime: Date,
  proposedPlanId: string,
): Promise<PlanImpactPreview> {
  let currentPlanId: string | null = null;
  let currentPlanCode: string | null = null;
  let currentEntitlements: PlanEntitlement[] = [];

  try {
    const subs = await db
      .select()
      .from(tenantSubscriptions)
      .where(
        and(
          eq(tenantSubscriptions.tenantId, tenantId),
          lte(tenantSubscriptions.effectiveFrom, atTime),
          or(isNull(tenantSubscriptions.effectiveTo), gt(tenantSubscriptions.effectiveTo, atTime)),
        ),
      )
      .orderBy(desc(tenantSubscriptions.effectiveFrom))
      .limit(1);

    if (subs.length > 0) {
      currentPlanId = subs[0].subscriptionPlanId;
      const planRows = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, currentPlanId)).limit(1);
      currentPlanCode = planRows[0]?.planCode ?? null;
      currentEntitlements = await db.select().from(planEntitlements).where(eq(planEntitlements.subscriptionPlanId, currentPlanId));
    }
  } catch {
    // No active subscription
  }

  const proposedPlanRows = await db.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, proposedPlanId)).limit(1);
  const proposedPlanCode = proposedPlanRows[0]?.planCode ?? null;
  const proposedEntitlements = await db.select().from(planEntitlements).where(eq(planEntitlements.subscriptionPlanId, proposedPlanId));

  const currentKeys = new Set(currentEntitlements.map((e) => e.entitlementKey));
  const proposedKeys = new Set(proposedEntitlements.map((e) => e.entitlementKey));

  const addedEntitlements = proposedEntitlements.filter((e) => !currentKeys.has(e.entitlementKey)).map((e) => e.entitlementKey);
  const removedEntitlements = currentEntitlements.filter((e) => !proposedKeys.has(e.entitlementKey)).map((e) => e.entitlementKey);
  const changedEntitlements = proposedEntitlements
    .filter((e) => {
      const cur = currentEntitlements.find((c) => c.entitlementKey === e.entitlementKey);
      return cur && entitlementValue(cur) !== entitlementValue(e);
    })
    .map((e) => e.entitlementKey);

  const overageAllowAi = proposedEntitlements.find((e) => e.entitlementKey === "allow_overage_ai");
  const overageAllowStorage = proposedEntitlements.find((e) => e.entitlementKey === "allow_overage_storage");
  const overageImplication =
    overageAllowAi?.booleanValue === false && overageAllowStorage?.booleanValue === false
      ? "Proposed plan disables both AI and storage overage."
      : overageAllowAi?.booleanValue === false
        ? "Proposed plan disables AI overage."
        : overageAllowStorage?.booleanValue === false
          ? "Proposed plan disables storage overage."
          : null;

  return {
    tenantId,
    atTime: atTime.toISOString(),
    currentPlanId,
    currentPlanCode,
    currentEntitlements: currentEntitlements.map((e) => ({ key: e.entitlementKey, type: e.entitlementType, value: entitlementValue(e) })),
    proposedPlanId,
    proposedPlanCode,
    proposedEntitlements: proposedEntitlements.map((e) => ({ key: e.entitlementKey, type: e.entitlementType, value: entitlementValue(e) })),
    addedEntitlements,
    removedEntitlements,
    changedEntitlements,
    overageImplication,
    safeToApply: proposedPlanRows[0]?.status !== "archived",
  };
}

// ─── Preview Global Pricing Window Change ─────────────────────────────────────

export async function previewGlobalPricingWindowChange(proposedChange: {
  provider: string;
  model: string;
  proposedEffectiveFrom: Date;
  proposedEffectiveTo?: Date | null;
}): Promise<GlobalPricingWindowPreview> {
  const existing = await db
    .select()
    .from(providerPricingVersions)
    .where(
      and(
        eq(providerPricingVersions.provider, proposedChange.provider),
        eq(providerPricingVersions.model, proposedChange.model),
      ),
    )
    .orderBy(desc(providerPricingVersions.effectiveFrom));

  const pFrom = proposedChange.proposedEffectiveFrom;
  const pTo = proposedChange.proposedEffectiveTo ?? null;

  const conflicts: PricingVersionWindow[] = [];
  for (const v of existing) {
    const vFrom = new Date(v.effectiveFrom);
    const vTo = v.effectiveTo ? new Date(v.effectiveTo) : null;
    const aEnd = pTo ? pTo.getTime() : Infinity;
    const bEnd = vTo ? vTo.getTime() : Infinity;
    if (pFrom.getTime() < bEnd && vFrom.getTime() < aEnd) {
      conflicts.push({
        id: v.id,
        versionKey: `${v.provider}/${v.model}`,
        pricingVersion: v.pricingVersion,
        effectiveFrom: vFrom.toISOString(),
        effectiveTo: vTo?.toISOString() ?? null,
      });
    }
  }

  const now = new Date();
  const onlyAffectsFuture = pFrom > now;

  return {
    proposedProvider: proposedChange.provider,
    proposedModel: proposedChange.model,
    proposedEffectiveFrom: pFrom.toISOString(),
    proposedEffectiveTo: pTo?.toISOString() ?? null,
    existingWindows: existing.map((v) => ({
      id: v.id,
      versionKey: `${v.provider}/${v.model}`,
      pricingVersion: v.pricingVersion,
      effectiveFrom: new Date(v.effectiveFrom).toISOString(),
      effectiveTo: v.effectiveTo ? new Date(v.effectiveTo).toISOString() : null,
    })),
    conflicts,
    onlyAffectsFuture,
    historicalBillingUntouched: true,
    safeToApply: conflicts.length === 0,
    message: conflicts.length > 0
      ? `${conflicts.length} overlap conflict(s) detected. Apply blocked.`
      : onlyAffectsFuture
        ? "Safe to apply — proposed window only affects future billing."
        : "Proposed window starts in the past/present. Existing billing rows remain untouched (immutable).",
  };
}

// ─── Explain Admin Change Preview ─────────────────────────────────────────────

export interface AdminChangePreviewExplanation {
  changeRequestId: string;
  changeRequest: AdminChangeRequest | null;
  events: AdminChangeEvent[];
  dryRunSummary: Record<string, unknown> | null;
  status: string | null;
  explanation: string;
}

export async function explainAdminChangePreview(
  changeRequestId: string,
): Promise<AdminChangePreviewExplanation> {
  const requestRows = await db
    .select()
    .from(adminChangeRequests)
    .where(eq(adminChangeRequests.id, changeRequestId))
    .limit(1);

  const changeRequest = requestRows[0] ?? null;

  const events = await db
    .select()
    .from(adminChangeEvents)
    .where(eq(adminChangeEvents.adminChangeRequestId, changeRequestId))
    .orderBy(adminChangeEvents.createdAt);

  const dryRunSummary = changeRequest?.dryRunSummary as Record<string, unknown> | null ?? null;

  return {
    changeRequestId,
    changeRequest,
    events,
    dryRunSummary,
    status: changeRequest?.status ?? null,
    explanation: changeRequest
      ? `Admin change request '${changeRequest.changeType}' (scope: ${changeRequest.targetScope}) has status '${changeRequest.status}'. ${events.length} event(s) recorded.`
      : `No admin change request found for id: ${changeRequestId}`,
  };
}
