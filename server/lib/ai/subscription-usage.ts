/**
 * Subscription Usage & Entitlement Allowances — Phase 4N
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Resolves included usage quotas and overage rules from plan entitlements.
 * Does NOT redesign canonical billing (ai_billing_usage, invoices, snapshots).
 * Establishes the entitlement resolution layer only.
 *
 * Entitlement keys used:
 *   included_ai_usd        — included AI spend per billing period (USD)
 *   included_storage_gb    — included storage per billing period (GB)
 *   allow_overage_ai       — boolean: tenant may exceed AI allowance
 *   allow_overage_storage  — boolean: tenant may exceed storage allowance
 *   max_clients            — numeric limit: max client seats
 *   max_coaches            — numeric limit: max coach seats
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { subscriptionPlans } from "@shared/schema";
import type { PlanEntitlement } from "@shared/schema";
import { getTenantPlanEntitlements } from "./subscriptions";

// ─── Allowance Resolution ─────────────────────────────────────────────────────

/**
 * Returns the tenant's included AI spend allowance (USD) for the period.
 * Derived from the plan entitlement key 'included_ai_usd'.
 * Returns 0 if no active subscription or no matching entitlement.
 */
export async function getTenantIncludedAiAllowance(
  tenantId: string,
  periodStart: Date,
  _periodEnd: Date,
): Promise<number> {
  const entitlements = await getTenantPlanEntitlements(tenantId, periodStart);
  const entry = entitlements.find((e) => e.entitlementKey === "included_ai_usd");
  if (!entry || entry.numericValue === null || entry.numericValue === undefined) return 0;
  return Number(entry.numericValue);
}

/**
 * Returns the tenant's included storage allowance (GB) for the period.
 * Derived from the plan entitlement key 'included_storage_gb'.
 * Returns 0 if no active subscription or no matching entitlement.
 */
export async function getTenantIncludedStorageAllowance(
  tenantId: string,
  periodStart: Date,
  _periodEnd: Date,
): Promise<number> {
  const entitlements = await getTenantPlanEntitlements(tenantId, periodStart);
  const entry = entitlements.find((e) => e.entitlementKey === "included_storage_gb");
  if (!entry || entry.numericValue === null || entry.numericValue === undefined) return 0;
  return Number(entry.numericValue);
}

// ─── Overage Rules ────────────────────────────────────────────────────────────

export interface TenantOverageRules {
  allowOverageAi: boolean;
  allowOverageStorage: boolean;
  rawEntitlements: PlanEntitlement[];
}

/**
 * Returns the tenant's overage eligibility at a given time.
 * allow_overage_ai and allow_overage_storage are boolean entitlements.
 */
export async function getTenantOverageRules(
  tenantId: string,
  atTime: Date = new Date(),
): Promise<TenantOverageRules> {
  const entitlements = await getTenantPlanEntitlements(tenantId, atTime);

  const aiEntry = entitlements.find((e) => e.entitlementKey === "allow_overage_ai");
  const storageEntry = entitlements.find((e) => e.entitlementKey === "allow_overage_storage");

  return {
    allowOverageAi: aiEntry?.booleanValue ?? false,
    allowOverageStorage: storageEntry?.booleanValue ?? false,
    rawEntitlements: entitlements,
  };
}

// ─── Full Entitlement Summary ─────────────────────────────────────────────────

export interface TenantEntitlementUsageSummary {
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  plan: {
    id: string | null;
    code: string | null;
    name: string | null;
    billingInterval: string | null;
    basePriceUsd: number | null;
  };
  includedAiUsd: number;
  includedStorageGb: number;
  allowOverageAi: boolean;
  allowOverageStorage: boolean;
  limits: Record<string, number | string | boolean | null>;
  featureFlags: Record<string, boolean | null>;
  allEntitlements: Array<{
    key: string;
    type: string;
    numericValue: number | null;
    textValue: string | null;
    booleanValue: boolean | null;
  }>;
  noSubscription: boolean;
  error: string | null;
}

/**
 * Full entitlement + usage summary for a tenant over a billing period.
 * Does not compute overage charges — that remains in canonical billing.
 * Provides the entitlement resolution layer for plan-aware reporting.
 */
export async function explainTenantEntitlementUsage(
  tenantId: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<TenantEntitlementUsageSummary> {
  const base: TenantEntitlementUsageSummary = {
    tenantId,
    periodStart: periodStart.toISOString(),
    periodEnd: periodEnd.toISOString(),
    plan: { id: null, code: null, name: null, billingInterval: null, basePriceUsd: null },
    includedAiUsd: 0,
    includedStorageGb: 0,
    allowOverageAi: false,
    allowOverageStorage: false,
    limits: {},
    featureFlags: {},
    allEntitlements: [],
    noSubscription: false,
    error: null,
  };

  let entitlements: PlanEntitlement[];
  try {
    entitlements = await getTenantPlanEntitlements(tenantId, periodStart);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("No active subscription")) {
      return { ...base, noSubscription: true };
    }
    return { ...base, error: msg };
  }

  if (entitlements.length === 0) {
    return { ...base, noSubscription: true };
  }

  const planId = entitlements[0].subscriptionPlanId;

  const planRows = await db
    .select()
    .from(subscriptionPlans)
    .where(eq(subscriptionPlans.id, planId))
    .limit(1);

  const plan = planRows[0] ?? null;

  const limits: Record<string, number | string | boolean | null> = {};
  const featureFlags: Record<string, boolean | null> = {};

  for (const e of entitlements) {
    if (e.entitlementType === "limit") {
      limits[e.entitlementKey] =
        e.numericValue !== null ? Number(e.numericValue) : (e.textValue ?? null);
    }
    if (e.entitlementType === "feature_flag") {
      featureFlags[e.entitlementKey] = e.booleanValue ?? null;
    }
  }

  return {
    ...base,
    plan: {
      id: plan?.id ?? null,
      code: plan?.planCode ?? null,
      name: plan?.planName ?? null,
      billingInterval: plan?.billingInterval ?? null,
      basePriceUsd: plan ? Number(plan.basePriceUsd) : null,
    },
    includedAiUsd: await getTenantIncludedAiAllowance(tenantId, periodStart, periodEnd),
    includedStorageGb: await getTenantIncludedStorageAllowance(tenantId, periodStart, periodEnd),
    allowOverageAi:
      entitlements.find((e) => e.entitlementKey === "allow_overage_ai")?.booleanValue ?? false,
    allowOverageStorage:
      entitlements.find((e) => e.entitlementKey === "allow_overage_storage")?.booleanValue ?? false,
    limits,
    featureFlags,
    allEntitlements: entitlements.map((e) => ({
      key: e.entitlementKey,
      type: e.entitlementType,
      numericValue: e.numericValue !== null ? Number(e.numericValue) : null,
      textValue: e.textValue ?? null,
      booleanValue: e.booleanValue ?? null,
    })),
    noSubscription: false,
    error: null,
  };
}
