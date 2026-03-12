/**
 * Storage Billing Summary Helpers — Phase 4K
 *
 * SERVER-ONLY: Read helpers for storage usage and storage billing.
 * Designed for admin tooling, invoice generation, and billing analytics.
 *
 * Source of truth:
 *   storage_usage         → raw usage truth
 *   storage_billing_usage → canonical billing truth (derived from usage + pricing)
 *   billing_period_tenant_snapshots → closed period accounting truth
 */

import { and, eq, gte, lt, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  storageUsage,
  storageBillingUsage,
  storagePricingVersions,
  customerStoragePricingVersions,
} from "@shared/schema";
import type { StorageBillingUsage, StorageUsage } from "@shared/schema";

// ─── Usage Summary ────────────────────────────────────────────────────────────

export interface StorageUsageSummaryRow {
  metricType: string | null;
  storageProvider: string | null;
  storageProduct: string | null;
  totalUsageAmount: number;
  usageUnit: string | null;
  rowCount: number;
}

/**
 * Aggregate raw storage usage for a tenant over an optional time window.
 * Queries storage_usage directly — always historically correct.
 */
export async function getTenantStorageUsageSummary(
  tenantId: string,
  periodStart?: Date,
  periodEnd?: Date,
): Promise<StorageUsageSummaryRow[]> {
  const conditions: Parameters<typeof and>[0][] = [
    eq(storageUsage.tenantId, tenantId),
  ];
  if (periodStart) conditions.push(gte(storageUsage.usagePeriodStart, periodStart));
  if (periodEnd) conditions.push(lt(storageUsage.usagePeriodStart, periodEnd));

  const rows = await db
    .select({
      metricType: storageUsage.metricType,
      storageProvider: storageUsage.storageProvider,
      storageProduct: storageUsage.storageProduct,
      usageUnit: storageUsage.usageUnit,
      totalUsageAmount: sql<string>`COALESCE(SUM(usage_amount::numeric), 0)`,
      rowCount: sql<string>`COUNT(*)`,
    })
    .from(storageUsage)
    .where(and(...conditions))
    .groupBy(
      storageUsage.metricType,
      storageUsage.storageProvider,
      storageUsage.storageProduct,
      storageUsage.usageUnit,
    );

  return rows.map((r) => ({
    metricType: r.metricType,
    storageProvider: r.storageProvider,
    storageProduct: r.storageProduct,
    usageUnit: r.usageUnit,
    totalUsageAmount: Number(r.totalUsageAmount),
    rowCount: Number(r.rowCount),
  }));
}

// ─── Billing Summary ──────────────────────────────────────────────────────────

export interface StorageBillingSummaryRow {
  metricType: string | null;
  storageProvider: string | null;
  storageProduct: string | null;
  billingRowCount: number;
  totalRawUsage: number;
  totalBillableUsage: number;
  totalProviderCostUsd: number;
  totalCustomerPriceUsd: number;
  totalMarginUsd: number;
  marginPct: number | null;
}

/**
 * Aggregate storage billing data for a tenant over an optional time window.
 * Queries storage_billing_usage — canonical billing truth.
 */
export async function getTenantStorageBillingSummary(
  tenantId: string,
  periodStart?: Date,
  periodEnd?: Date,
): Promise<StorageBillingSummaryRow[]> {
  const conditions: Parameters<typeof and>[0][] = [
    eq(storageBillingUsage.tenantId, tenantId),
  ];
  if (periodStart) conditions.push(gte(storageBillingUsage.createdAt, periodStart));
  if (periodEnd) conditions.push(lt(storageBillingUsage.createdAt, periodEnd));

  const rows = await db
    .select({
      metricType: storageBillingUsage.metricType,
      storageProvider: storageBillingUsage.storageProvider,
      storageProduct: storageBillingUsage.storageProduct,
      billingRowCount: sql<string>`COUNT(*)`,
      totalRawUsage: sql<string>`COALESCE(SUM(raw_usage_amount::numeric), 0)`,
      totalBillableUsage: sql<string>`COALESCE(SUM(billable_usage_amount::numeric), 0)`,
      totalProviderCost: sql<string>`COALESCE(SUM(provider_cost_usd::numeric), 0)`,
      totalCustomerPrice: sql<string>`COALESCE(SUM(customer_price_usd::numeric), 0)`,
      totalMargin: sql<string>`COALESCE(SUM(margin_usd::numeric), 0)`,
    })
    .from(storageBillingUsage)
    .where(and(...conditions))
    .groupBy(
      storageBillingUsage.metricType,
      storageBillingUsage.storageProvider,
      storageBillingUsage.storageProduct,
    );

  return rows.map((r) => {
    const customerPrice = Number(r.totalCustomerPrice);
    const margin = Number(r.totalMargin);
    return {
      metricType: r.metricType,
      storageProvider: r.storageProvider,
      storageProduct: r.storageProduct,
      billingRowCount: Number(r.billingRowCount),
      totalRawUsage: Number(r.totalRawUsage),
      totalBillableUsage: Number(r.totalBillableUsage),
      totalProviderCostUsd: Number(r.totalProviderCost),
      totalCustomerPriceUsd: customerPrice,
      totalMarginUsd: margin,
      marginPct: customerPrice > 0 ? margin / customerPrice : null,
    };
  });
}

// ─── Single Row Read ──────────────────────────────────────────────────────────

export async function getStorageBillingUsageByStorageUsageId(
  storageUsageId: string,
): Promise<StorageBillingUsage | null> {
  const rows = await db
    .select()
    .from(storageBillingUsage)
    .where(eq(storageBillingUsage.storageUsageId, storageUsageId))
    .limit(1);
  return rows[0] ?? null;
}

// ─── Explain Helper ───────────────────────────────────────────────────────────

export interface StorageBillingExplanation {
  storageBillingUsageId: string;
  tenantId: string;
  storageProvider: string;
  storageProduct: string;
  metricType: string;
  pricingVersion: string;
  sourceStorageUsage: {
    id: string;
    usageAmount: number;
    usageUnit: string;
    usagePeriodStart: Date;
    usagePeriodEnd: Date;
    sourceType: string;
    bucket: string | null;
  } | null;
  resolvedProviderPricingVersion: {
    id: string;
    pricingVersion: string;
    unitPriceUsd: number;
    includedUsage: number | null;
  } | null;
  resolvedCustomerPricingVersion: {
    id: string;
    pricingVersion: string;
    unitPriceUsd: number;
    includedUsage: number | null;
  } | null;
  derivation: {
    rawUsageAmount: number;
    includedUsageAmount: number;
    billableUsageAmount: number;
    providerCostUsd: number;
    customerPriceUsd: number;
    marginUsd: number;
    marginPct: number | null;
  };
  sourceSummary: string;
}

/**
 * Explain the full derivation chain for a storage billing row.
 * Returns source usage, resolved pricing versions, and derivation details.
 */
export async function explainStorageBillingSource(
  storageBillingUsageId: string,
): Promise<StorageBillingExplanation | null> {
  const billingRows = await db
    .select()
    .from(storageBillingUsage)
    .where(eq(storageBillingUsage.id, storageBillingUsageId))
    .limit(1);
  if (billingRows.length === 0) return null;
  const billing = billingRows[0];

  // Source usage
  const usageRows = await db
    .select()
    .from(storageUsage)
    .where(eq(storageUsage.id, billing.storageUsageId))
    .limit(1);
  const usage = usageRows[0] ?? null;

  // Provider pricing version
  let providerPricing = null;
  if (billing.providerPricingVersionId) {
    const pvRows = await db
      .select()
      .from(storagePricingVersions)
      .where(eq(storagePricingVersions.id, billing.providerPricingVersionId))
      .limit(1);
    if (pvRows[0]) {
      providerPricing = {
        id: pvRows[0].id,
        pricingVersion: pvRows[0].pricingVersion,
        unitPriceUsd: Number(pvRows[0].unitPriceUsd),
        includedUsage: pvRows[0].includedUsage != null ? Number(pvRows[0].includedUsage) : null,
      };
    }
  }

  // Customer pricing version
  let customerPricing = null;
  if (billing.customerPricingVersionId) {
    const cpvRows = await db
      .select()
      .from(customerStoragePricingVersions)
      .where(eq(customerStoragePricingVersions.id, billing.customerPricingVersionId))
      .limit(1);
    if (cpvRows[0]) {
      customerPricing = {
        id: cpvRows[0].id,
        pricingVersion: cpvRows[0].pricingVersion,
        unitPriceUsd: Number(cpvRows[0].unitPriceUsd),
        includedUsage: cpvRows[0].includedUsage != null ? Number(cpvRows[0].includedUsage) : null,
      };
    }
  }

  const customerPrice = Number(billing.customerPriceUsd);
  const marginUsd = Number(billing.marginUsd);

  return {
    storageBillingUsageId,
    tenantId: billing.tenantId,
    storageProvider: billing.storageProvider,
    storageProduct: billing.storageProduct,
    metricType: billing.metricType,
    pricingVersion: billing.pricingVersion,
    sourceStorageUsage: usage
      ? {
          id: usage.id,
          usageAmount: Number(usage.usageAmount),
          usageUnit: usage.usageUnit,
          usagePeriodStart: usage.usagePeriodStart,
          usagePeriodEnd: usage.usagePeriodEnd,
          sourceType: usage.sourceType,
          bucket: usage.bucket,
        }
      : null,
    resolvedProviderPricingVersion: providerPricing,
    resolvedCustomerPricingVersion: customerPricing,
    derivation: {
      rawUsageAmount: Number(billing.rawUsageAmount),
      includedUsageAmount: Number(billing.includedUsageAmount),
      billableUsageAmount: Number(billing.billableUsageAmount),
      providerCostUsd: Number(billing.providerCostUsd),
      customerPriceUsd: customerPrice,
      marginUsd,
      marginPct: customerPrice > 0 ? marginUsd / customerPrice : null,
    },
    sourceSummary: `Storage billing row ${storageBillingUsageId} derives from storage_usage ${billing.storageUsageId}. Raw=${billing.rawUsageAmount}, included=${billing.includedUsageAmount}, billable=${billing.billableUsageAmount}. Provider pricing version: ${billing.providerPricingVersionId ?? "none"}. Customer pricing: ${billing.customerPricingVersionId ?? "none (fallback to provider)"}. Historical amounts are immutable.`,
  };
}
