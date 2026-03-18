/**
 * Entitlement & Overage Summary — Phase 4O
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Summary helpers for entitlement enforcement state, overage usage,
 * and commercial treatment of individual billing rows.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  aiBillingUsage,
  storageBillingUsage,
  tenantAiAllowanceUsage,
  tenantStorageAllowanceUsage,
} from "@shared/schema";
import {
  getActiveTenantSubscription,
  getTenantPlanEntitlements,
} from "./subscriptions";
import {
  getTenantIncludedAiAllowance,
  getTenantIncludedStorageAllowance,
  getTenantOverageRules,
} from "./subscription-usage";
import {
  getTenantConsumedAiAllowanceUsd,
  getTenantConsumedStorageAllowance,
} from "./allowance-application";

// ─── Entitlement Usage Summary ────────────────────────────────────────────────

export interface TenantEntitlementUsageSummaryFull {
  tenantId: string;
  billingPeriodId: string;
  includedAiAllowanceUsd: number;
  consumedAiAllowanceUsd: number;
  remainingAiAllowanceUsd: number;
  includedStorageAllowanceGb: number;
  consumedStorageAllowanceGb: number;
  remainingStorageAllowanceGb: number;
  aiTreatmentCounts: Record<string, number>;
  storageTreatmentCounts: Record<string, number>;
}

/**
 * Returns entitlement usage totals for a tenant within a billing period.
 * billingPeriodId here is the tenant_subscription.id (used as period key in ledger).
 */
export async function getTenantEntitlementUsageSummary(
  tenantId: string,
  billingPeriodId: string,
): Promise<TenantEntitlementUsageSummaryFull> {
  const atTime = new Date();

  let includedAiUsd = 0;
  let includedStorageGb = 0;

  try {
    const sub = await getActiveTenantSubscription(tenantId, atTime);
    const periodStart = new Date(sub.currentPeriodStart);
    const periodEnd = new Date(sub.currentPeriodEnd);
    includedAiUsd = await getTenantIncludedAiAllowance(tenantId, periodStart, periodEnd);
    includedStorageGb = await getTenantIncludedStorageAllowance(tenantId, periodStart, periodEnd);
  } catch { }

  const consumedAiUsd = await getTenantConsumedAiAllowanceUsd(tenantId, billingPeriodId);
  const { consumedUsageAmount: consumedStorageGb } = await getTenantConsumedStorageAllowance(tenantId, billingPeriodId);

  const aiTreatmentRows = await db
    .select({
      treatment: aiBillingUsage.entitlementTreatment,
      cnt: sql<number>`COUNT(*)::integer`,
    })
    .from(aiBillingUsage)
    .where(eq(aiBillingUsage.tenantId, tenantId))
    .groupBy(aiBillingUsage.entitlementTreatment);

  const storageTreatmentRows = await db
    .select({
      treatment: storageBillingUsage.entitlementTreatment,
      cnt: sql<number>`COUNT(*)::integer`,
    })
    .from(storageBillingUsage)
    .where(eq(storageBillingUsage.tenantId, tenantId))
    .groupBy(storageBillingUsage.entitlementTreatment);

  const aiTreatmentCounts: Record<string, number> = {};
  for (const r of aiTreatmentRows) aiTreatmentCounts[r.treatment] = r.cnt;

  const storageTreatmentCounts: Record<string, number> = {};
  for (const r of storageTreatmentRows) storageTreatmentCounts[r.treatment] = r.cnt;

  return {
    tenantId,
    billingPeriodId,
    includedAiAllowanceUsd: includedAiUsd,
    consumedAiAllowanceUsd: consumedAiUsd,
    remainingAiAllowanceUsd: Math.max(0, includedAiUsd - consumedAiUsd),
    includedStorageAllowanceGb: includedStorageGb,
    consumedStorageAllowanceGb: consumedStorageGb,
    remainingStorageAllowanceGb: Math.max(0, includedStorageGb - consumedStorageGb),
    aiTreatmentCounts,
    storageTreatmentCounts,
  };
}

// ─── Overage Summary ─────────────────────────────────────────────────────────

export interface TenantOverageSummary {
  tenantId: string;
  billingPeriodId: string;
  aiOverageAmountUsd: number;
  storageOverageAmountUsd: number;
  aiOverageRowCount: number;
  storageOverageRowCount: number;
}

export async function getTenantOverageSummary(
  tenantId: string,
  billingPeriodId: string,
): Promise<TenantOverageSummary> {
  const aiOverage = await db
    .select({
      totalUsd: sql<string>`COALESCE(SUM(overage_amount_usd), 0)`,
      cnt: sql<number>`COUNT(*)::integer`,
    })
    .from(tenantAiAllowanceUsage)
    .where(
      and(
        eq(tenantAiAllowanceUsage.tenantId, tenantId),
        eq(tenantAiAllowanceUsage.billingPeriodId, billingPeriodId),
        sql`overage_amount_usd > 0`,
      ),
    );

  const storageOverage = await db
    .select({
      totalUsd: sql<string>`COALESCE(SUM(overage_amount_usd), 0)`,
      cnt: sql<number>`COUNT(*)::integer`,
    })
    .from(tenantStorageAllowanceUsage)
    .where(
      and(
        eq(tenantStorageAllowanceUsage.tenantId, tenantId),
        eq(tenantStorageAllowanceUsage.billingPeriodId, billingPeriodId),
        sql`overage_amount_usd > 0`,
      ),
    );

  return {
    tenantId,
    billingPeriodId,
    aiOverageAmountUsd: Number(aiOverage[0]?.totalUsd ?? 0),
    storageOverageAmountUsd: Number(storageOverage[0]?.totalUsd ?? 0),
    aiOverageRowCount: aiOverage[0]?.cnt ?? 0,
    storageOverageRowCount: storageOverage[0]?.cnt ?? 0,
  };
}

// ─── Individual Row Commercial Treatment ─────────────────────────────────────

export interface BillingRowCommercialTreatment {
  id: string;
  tenantId: string;
  customerPriceUsd: number;
  entitlementTreatment: string;
  includedAmountUsd: number;
  overageAmountUsd: number;
  allowanceLedgerRow: {
    id: string;
    includedAmountUsd: number;
    overageAmountUsd: number;
  } | null;
}

export async function getBillingUsageCommercialTreatment(
  billingUsageId: string,
): Promise<BillingRowCommercialTreatment> {
  const rows = await db
    .select()
    .from(aiBillingUsage)
    .where(eq(aiBillingUsage.id, billingUsageId))
    .limit(1);

  if (rows.length === 0) throw new Error(`ai_billing_usage not found: ${billingUsageId}`);
  const row = rows[0];

  const ledger = await db
    .select()
    .from(tenantAiAllowanceUsage)
    .where(eq(tenantAiAllowanceUsage.sourceBillingUsageId, billingUsageId))
    .limit(1);

  return {
    id: row.id,
    tenantId: row.tenantId,
    customerPriceUsd: Number(row.customerPriceUsd),
    entitlementTreatment: row.entitlementTreatment,
    includedAmountUsd: Number(row.includedAmountUsd),
    overageAmountUsd: Number(row.overageAmountUsd),
    allowanceLedgerRow: ledger[0]
      ? {
          id: ledger[0].id,
          includedAmountUsd: Number(ledger[0].includedAmountUsd),
          overageAmountUsd: Number(ledger[0].overageAmountUsd),
        }
      : null,
  };
}

export interface StorageBillingRowCommercialTreatment {
  id: string;
  tenantId: string;
  customerPriceUsd: number;
  entitlementTreatment: string;
  entIncludedUsageAmount: number;
  entOverageUsageAmount: number;
  includedAmountUsd: number;
  overageAmountUsd: number;
  allowanceLedgerRow: {
    id: string;
    includedUsageAmount: number;
    overageUsageAmount: number;
    includedAmountUsd: number;
    overageAmountUsd: number;
  } | null;
}

export async function getStorageBillingCommercialTreatment(
  storageBillingUsageId: string,
): Promise<StorageBillingRowCommercialTreatment> {
  const rows = await db
    .select()
    .from(storageBillingUsage)
    .where(eq(storageBillingUsage.id, storageBillingUsageId))
    .limit(1);

  if (rows.length === 0) throw new Error(`storage_billing_usage not found: ${storageBillingUsageId}`);
  const row = rows[0];

  const ledger = await db
    .select()
    .from(tenantStorageAllowanceUsage)
    .where(eq(tenantStorageAllowanceUsage.sourceStorageBillingUsageId, storageBillingUsageId))
    .limit(1);

  return {
    id: row.id,
    tenantId: row.tenantId,
    customerPriceUsd: Number(row.customerPriceUsd),
    entitlementTreatment: row.entitlementTreatment,
    entIncludedUsageAmount: Number(row.entIncludedUsageAmount),
    entOverageUsageAmount: Number(row.entOverageUsageAmount),
    includedAmountUsd: Number(row.includedAmountUsd),
    overageAmountUsd: Number(row.overageAmountUsd),
    allowanceLedgerRow: ledger[0]
      ? {
          id: ledger[0].id,
          includedUsageAmount: Number(ledger[0].includedUsageAmount),
          overageUsageAmount: Number(ledger[0].overageUsageAmount),
          includedAmountUsd: Number(ledger[0].includedAmountUsd),
          overageAmountUsd: Number(ledger[0].overageAmountUsd),
        }
      : null,
  };
}

// ─── Full Commercial State Explain ───────────────────────────────────────────

export interface TenantCommercialState {
  tenantId: string;
  atTime: string;
  hasSubscription: boolean;
  plan: { id: string; code: string; name: string; billingInterval: string } | null;
  includedAiAllowanceUsd: number;
  consumedAiAllowanceUsd: number;
  remainingAiAllowanceUsd: number;
  includedStorageAllowanceGb: number;
  consumedStorageAllowanceGb: number;
  remainingStorageAllowanceGb: number;
  overageRules: { allowOverageAi: boolean; allowOverageStorage: boolean };
  featureFlags: Record<string, boolean>;
  featureExecutionAllowed: boolean;
  planEntitlements: Array<{
    key: string;
    type: string;
    numericValue: number | null;
    booleanValue: boolean | null;
  }>;
  error: string | null;
}

/**
 * Full explain of a tenant's current commercial state — plan, entitlements,
 * allowance consumption, overage eligibility, and feature execution status.
 */
export async function explainTenantCommercialState(
  tenantId: string,
  atTime: Date = new Date(),
): Promise<TenantCommercialState> {
  const base: TenantCommercialState = {
    tenantId,
    atTime: atTime.toISOString(),
    hasSubscription: false,
    plan: null,
    includedAiAllowanceUsd: 0,
    consumedAiAllowanceUsd: 0,
    remainingAiAllowanceUsd: 0,
    includedStorageAllowanceGb: 0,
    consumedStorageAllowanceGb: 0,
    remainingStorageAllowanceGb: 0,
    overageRules: { allowOverageAi: false, allowOverageStorage: false },
    featureFlags: {},
    featureExecutionAllowed: true,
    planEntitlements: [],
    error: null,
  };

  let subscription: Awaited<ReturnType<typeof getActiveTenantSubscription>>;
  try {
    subscription = await getActiveTenantSubscription(tenantId, atTime);
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  const entitlements = await getTenantPlanEntitlements(tenantId, atTime);
  const overageRules = await getTenantOverageRules(tenantId, atTime);

  const periodStart = new Date(subscription.currentPeriodStart);
  const periodEnd = new Date(subscription.currentPeriodEnd);
  const billingPeriodId = subscription.id;

  const includedAiUsd = await getTenantIncludedAiAllowance(tenantId, periodStart, periodEnd);
  const includedStorageGb = await getTenantIncludedStorageAllowance(tenantId, periodStart, periodEnd);
  const consumedAiUsd = await getTenantConsumedAiAllowanceUsd(tenantId, billingPeriodId);
  const { consumedUsageAmount: consumedStorageGb } = await getTenantConsumedStorageAllowance(tenantId, billingPeriodId);

  const featureFlags: Record<string, boolean> = {};
  let featureExecutionAllowed = true;
  for (const e of entitlements) {
    if (e.entitlementType === "feature_flag" && e.booleanValue !== null) {
      featureFlags[e.entitlementKey] = e.booleanValue;
      if (!e.booleanValue) featureExecutionAllowed = false;
    }
  }

  return {
    ...base,
    hasSubscription: true,
    plan: {
      id: subscription.subscriptionPlanId,
      code: "",
      name: "",
      billingInterval: "",
    },
    includedAiAllowanceUsd: includedAiUsd,
    consumedAiAllowanceUsd: consumedAiUsd,
    remainingAiAllowanceUsd: Math.max(0, includedAiUsd - consumedAiUsd),
    includedStorageAllowanceGb: includedStorageGb,
    consumedStorageAllowanceGb: consumedStorageGb,
    remainingStorageAllowanceGb: Math.max(0, includedStorageGb - consumedStorageGb),
    overageRules: {
      allowOverageAi: overageRules.allowOverageAi,
      allowOverageStorage: overageRules.allowOverageStorage,
    },
    featureFlags,
    featureExecutionAllowed,
    planEntitlements: entitlements.map((e) => ({
      key: e.entitlementKey,
      type: e.entitlementType,
      numericValue: e.numericValue !== null ? Number(e.numericValue) : null,
      booleanValue: e.booleanValue ?? null,
    })),
    error: null,
  };
}
