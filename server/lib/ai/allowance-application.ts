/**
 * Allowance Application — Phase 4O
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Applies included plan allowances to canonical billing rows (ai_billing_usage
 * and storage_billing_usage). Records consumption in the canonical ledger tables
 * (tenant_ai_allowance_usage, tenant_storage_allowance_usage) and updates the
 * classification fields on the source billing rows.
 *
 * Design rules:
 *   A) Idempotent per billing row — UNIQUE on source id prevents double-application
 *   B) Deterministic — consumption computed from canonical ledger, not live counters
 *   C) Historical correctness — once written, rows are never rewritten
 *   D) Plan-driven — allowances from entitlements, never hardcoded
 *   E) Canonical totals unchanged — only classification fields are updated
 *
 * Classification logic:
 *   If remaining_allowance >= customer_price_usd:
 *     → 'included': full amount covered by plan
 *   If 0 < remaining_allowance < customer_price_usd:
 *     → 'partial_included': split between included and overage
 *   If remaining_allowance = 0:
 *     → 'overage': fully overage
 *
 * For standard treatment (no subscription or standard plan):
 *   → entitlement_treatment = 'standard', no ledger row written
 */

import { eq, and, sum, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  aiBillingUsage,
  storageBillingUsage,
  tenantAiAllowanceUsage,
  tenantStorageAllowanceUsage,
} from "@shared/schema";
import type { AiBillingUsage, StorageBillingUsage } from "@shared/schema";
import { getTenantIncludedAiAllowance, getTenantIncludedStorageAllowance } from "./subscription-usage";
import { getActiveTenantSubscription } from "./subscriptions";

// ─── AI Allowance Application ─────────────────────────────────────────────────

/**
 * Get total AI allowance already consumed by a tenant in a billing period.
 * Uses canonical ledger rows — no live counter inference.
 */
export async function getTenantConsumedAiAllowanceUsd(
  tenantId: string,
  billingPeriodId: string | null,
): Promise<number> {
  if (!billingPeriodId) return 0;

  const rows = await db
    .select({ total: sql<string>`COALESCE(SUM(included_amount_usd), 0)` })
    .from(tenantAiAllowanceUsage)
    .where(
      and(
        eq(tenantAiAllowanceUsage.tenantId, tenantId),
        eq(tenantAiAllowanceUsage.billingPeriodId, billingPeriodId),
      ),
    );

  return Number(rows[0]?.total ?? 0);
}

/**
 * Apply AI plan allowance to a single ai_billing_usage row.
 *
 * - Determines remaining allowance from canonical ledger
 * - Classifies the row as included / partial_included / overage / standard
 * - Writes a tenant_ai_allowance_usage ledger row (idempotent via UNIQUE)
 * - Updates ai_billing_usage classification fields
 *
 * Fail-safe: if no active subscription, treatment = 'standard', no ledger row.
 * Idempotent: if ledger row already exists, returns existing classification without mutation.
 */
export async function applyAiAllowanceToBillingUsage(
  billingUsageId: string,
): Promise<"standard" | "included" | "partial_included" | "overage"> {
  const rows = await db
    .select()
    .from(aiBillingUsage)
    .where(eq(aiBillingUsage.id, billingUsageId))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(`[allowance-application] ai_billing_usage not found: ${billingUsageId}`);
  }

  const billingRow = rows[0];

  const existing = await db
    .select()
    .from(tenantAiAllowanceUsage)
    .where(eq(tenantAiAllowanceUsage.sourceBillingUsageId, billingUsageId))
    .limit(1);

  if (existing.length > 0) {
    return billingRow.entitlementTreatment as "standard" | "included" | "partial_included" | "overage";
  }

  const billingTime = new Date(billingRow.createdAt);
  let subscription: Awaited<ReturnType<typeof getActiveTenantSubscription>> | null = null;
  try {
    subscription = await getActiveTenantSubscription(billingRow.tenantId, billingTime);
  } catch {
    return "standard";
  }

  const periodStart = new Date(subscription.currentPeriodStart);
  const periodEnd = new Date(subscription.currentPeriodEnd);

  const includedAllowanceUsd = await getTenantIncludedAiAllowance(
    billingRow.tenantId,
    periodStart,
    periodEnd,
  );

  if (includedAllowanceUsd <= 0) {
    return "standard";
  }

  const billingPeriodId = subscription.id;
  const consumedUsd = await getTenantConsumedAiAllowanceUsd(billingRow.tenantId, billingPeriodId);
  const remainingUsd = Math.max(0, includedAllowanceUsd - consumedUsd);
  const customerPriceUsd = Number(billingRow.customerPriceUsd);

  let treatment: "included" | "partial_included" | "overage";
  let includedAmountUsd: number;
  let overageAmountUsd: number;

  if (remainingUsd >= customerPriceUsd) {
    treatment = "included";
    includedAmountUsd = customerPriceUsd;
    overageAmountUsd = 0;
  } else if (remainingUsd > 0) {
    treatment = "partial_included";
    includedAmountUsd = remainingUsd;
    overageAmountUsd = customerPriceUsd - remainingUsd;
  } else {
    treatment = "overage";
    includedAmountUsd = 0;
    overageAmountUsd = customerPriceUsd;
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(tenantAiAllowanceUsage)
      .values({
        tenantId: billingRow.tenantId,
        billingPeriodId,
        sourceBillingUsageId: billingUsageId,
        includedAmountUsd: String(includedAmountUsd),
        overageAmountUsd: String(overageAmountUsd),
      })
      .onConflictDoNothing();

    await tx
      .update(aiBillingUsage)
      .set({
        entitlementTreatment: treatment,
        includedAmountUsd: String(includedAmountUsd),
        overageAmountUsd: String(overageAmountUsd),
      })
      .where(eq(aiBillingUsage.id, billingUsageId));
  });

  return treatment;
}

/**
 * Explain the allowance application for a specific ai_billing_usage row.
 */
export async function explainAiAllowanceApplication(billingUsageId: string): Promise<{
  billingUsageId: string;
  treatment: string;
  customerPriceUsd: number;
  includedAmountUsd: number;
  overageAmountUsd: number;
  allowanceLedgerRow: { id: string; includedAmountUsd: number; overageAmountUsd: number } | null;
  alreadyApplied: boolean;
}> {
  const rows = await db
    .select()
    .from(aiBillingUsage)
    .where(eq(aiBillingUsage.id, billingUsageId))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(`[allowance-application] ai_billing_usage not found: ${billingUsageId}`);
  }

  const row = rows[0];

  const ledger = await db
    .select()
    .from(tenantAiAllowanceUsage)
    .where(eq(tenantAiAllowanceUsage.sourceBillingUsageId, billingUsageId))
    .limit(1);

  return {
    billingUsageId,
    treatment: row.entitlementTreatment,
    customerPriceUsd: Number(row.customerPriceUsd),
    includedAmountUsd: Number(row.includedAmountUsd),
    overageAmountUsd: Number(row.overageAmountUsd),
    allowanceLedgerRow: ledger[0]
      ? {
          id: ledger[0].id,
          includedAmountUsd: Number(ledger[0].includedAmountUsd),
          overageAmountUsd: Number(ledger[0].overageAmountUsd),
        }
      : null,
    alreadyApplied: ledger.length > 0,
  };
}

// ─── Storage Allowance Application ───────────────────────────────────────────

/**
 * Get total storage allowance (GB-hours or equivalent) already consumed by
 * a tenant in a billing period from the canonical ledger.
 */
export async function getTenantConsumedStorageAllowance(
  tenantId: string,
  billingPeriodId: string | null,
): Promise<{ consumedUsageAmount: number; consumedAmountUsd: number }> {
  if (!billingPeriodId) return { consumedUsageAmount: 0, consumedAmountUsd: 0 };

  const rows = await db
    .select({
      totalUsage: sql<string>`COALESCE(SUM(included_usage_amount), 0)`,
      totalUsd: sql<string>`COALESCE(SUM(included_amount_usd), 0)`,
    })
    .from(tenantStorageAllowanceUsage)
    .where(
      and(
        eq(tenantStorageAllowanceUsage.tenantId, tenantId),
        eq(tenantStorageAllowanceUsage.billingPeriodId, billingPeriodId),
      ),
    );

  return {
    consumedUsageAmount: Number(rows[0]?.totalUsage ?? 0),
    consumedAmountUsd: Number(rows[0]?.totalUsd ?? 0),
  };
}

/**
 * Apply storage plan allowance to a single storage_billing_usage row.
 *
 * Same logic as AI allowance but based on included_storage_gb entitlement.
 * Usage amounts are in raw storage units; USD amounts come from customer_price_usd.
 * Idempotent via UNIQUE on source_storage_billing_usage_id.
 */
export async function applyStorageAllowanceToBillingUsage(
  storageBillingUsageId: string,
): Promise<"standard" | "included" | "partial_included" | "overage"> {
  const rows = await db
    .select()
    .from(storageBillingUsage)
    .where(eq(storageBillingUsage.id, storageBillingUsageId))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(`[allowance-application] storage_billing_usage not found: ${storageBillingUsageId}`);
  }

  const billingRow = rows[0];

  const existing = await db
    .select()
    .from(tenantStorageAllowanceUsage)
    .where(eq(tenantStorageAllowanceUsage.sourceStorageBillingUsageId, storageBillingUsageId))
    .limit(1);

  if (existing.length > 0) {
    return billingRow.entitlementTreatment as "standard" | "included" | "partial_included" | "overage";
  }

  const billingTime = new Date(billingRow.createdAt);
  let subscription: Awaited<ReturnType<typeof getActiveTenantSubscription>> | null = null;
  try {
    subscription = await getActiveTenantSubscription(billingRow.tenantId, billingTime);
  } catch {
    return "standard";
  }

  const periodStart = new Date(subscription.currentPeriodStart);
  const periodEnd = new Date(subscription.currentPeriodEnd);

  const includedStorageGb = await getTenantIncludedStorageAllowance(
    billingRow.tenantId,
    periodStart,
    periodEnd,
  );

  if (includedStorageGb <= 0) {
    return "standard";
  }

  const billingPeriodId = subscription.id;
  const { consumedUsageAmount, consumedAmountUsd } = await getTenantConsumedStorageAllowance(
    billingRow.tenantId,
    billingPeriodId,
  );

  const remainingGb = Math.max(0, includedStorageGb - consumedUsageAmount);
  const rawUsage = Number(billingRow.rawUsageAmount);
  const customerPriceUsd = Number(billingRow.customerPriceUsd);

  let treatment: "included" | "partial_included" | "overage";
  let includedUsageAmount: number;
  let overageUsageAmount: number;
  let includedAmountUsd: number;
  let overageAmountUsd: number;

  if (remainingGb >= rawUsage) {
    treatment = "included";
    includedUsageAmount = rawUsage;
    overageUsageAmount = 0;
    includedAmountUsd = customerPriceUsd;
    overageAmountUsd = 0;
  } else if (remainingGb > 0) {
    treatment = "partial_included";
    includedUsageAmount = remainingGb;
    overageUsageAmount = rawUsage - remainingGb;
    const frac = rawUsage > 0 ? remainingGb / rawUsage : 0;
    includedAmountUsd = customerPriceUsd * frac;
    overageAmountUsd = customerPriceUsd - includedAmountUsd;
  } else {
    treatment = "overage";
    includedUsageAmount = 0;
    overageUsageAmount = rawUsage;
    includedAmountUsd = 0;
    overageAmountUsd = customerPriceUsd;
  }

  await db.transaction(async (tx) => {
    await tx
      .insert(tenantStorageAllowanceUsage)
      .values({
        tenantId: billingRow.tenantId,
        billingPeriodId,
        sourceStorageBillingUsageId: storageBillingUsageId,
        includedUsageAmount: String(includedUsageAmount),
        overageUsageAmount: String(overageUsageAmount),
        includedAmountUsd: String(includedAmountUsd),
        overageAmountUsd: String(overageAmountUsd),
      })
      .onConflictDoNothing();

    await tx
      .update(storageBillingUsage)
      .set({
        entitlementTreatment: treatment,
        entIncludedUsageAmount: String(includedUsageAmount),
        entOverageUsageAmount: String(overageUsageAmount),
        includedAmountUsd: String(includedAmountUsd),
        overageAmountUsd: String(overageAmountUsd),
      })
      .where(eq(storageBillingUsage.id, storageBillingUsageId));
  });

  return treatment;
}

/**
 * Explain the allowance application for a specific storage_billing_usage row.
 */
export async function explainStorageAllowanceApplication(storageBillingUsageId: string): Promise<{
  storageBillingUsageId: string;
  treatment: string;
  rawUsageAmount: number;
  customerPriceUsd: number;
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
  alreadyApplied: boolean;
}> {
  const rows = await db
    .select()
    .from(storageBillingUsage)
    .where(eq(storageBillingUsage.id, storageBillingUsageId))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(`[allowance-application] storage_billing_usage not found: ${storageBillingUsageId}`);
  }

  const row = rows[0];

  const ledger = await db
    .select()
    .from(tenantStorageAllowanceUsage)
    .where(eq(tenantStorageAllowanceUsage.sourceStorageBillingUsageId, storageBillingUsageId))
    .limit(1);

  return {
    storageBillingUsageId,
    treatment: row.entitlementTreatment,
    rawUsageAmount: Number(row.rawUsageAmount),
    customerPriceUsd: Number(row.customerPriceUsd),
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
    alreadyApplied: ledger.length > 0,
  };
}
