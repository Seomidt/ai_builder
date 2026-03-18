/**
 * Storage Billing Engine — Phase 4K
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Derives canonical storage billing from canonical storage usage rows,
 * resolving deterministic pricing versions at the time of usage.
 *
 * Source of truth hierarchy:
 *   storage_usage              → raw usage measurements (canonical)
 *   storage_pricing_versions   → provider-side pricing basis
 *   customer_storage_pricing_versions → tenant-specific markup/tiers
 *   storage_billing_usage      → canonical storage billing rows (derived, immutable)
 *
 * Derivation rules (per storage_usage row):
 *   included_usage_amount = min(raw_usage_amount, resolved included threshold)
 *   billable_usage_amount = max(raw_usage_amount - included_usage_amount, 0)
 *   provider_cost_usd     = billable_usage_amount × provider unit_price_usd
 *   customer_price_usd    = billable_usage_amount × customer unit_price_usd
 *   margin_usd            = customer_price_usd - provider_cost_usd
 *
 * Historical correctness:
 *   Pricing is resolved at usage_period_start — future pricing changes
 *   never rewrite historical storage billing rows.
 *
 * Idempotency:
 *   UNIQUE(storage_usage_id) ensures one billing row per usage row.
 */

import { and, eq, gte, gt, isNull, lt, lte, or } from "drizzle-orm";
import { db } from "../../db";
import { applyStorageAllowanceToBillingUsage } from "./allowance-application";
import {
  storageUsage,
  storagePricingVersions,
  customerStoragePricingVersions,
  storageBillingUsage,
} from "@shared/schema";
import type {
  StorageBillingUsage,
  StoragePricingVersion,
  CustomerStoragePricingVersion,
  StorageUsage,
} from "@shared/schema";

// ─── Pricing Version Resolution ───────────────────────────────────────────────

/**
 * Resolve the provider-side storage pricing version active at atTime.
 * Throws if no version or >1 version found (prevents silent mis-billing).
 */
export async function resolveStoragePricingVersion(
  storageProvider: string,
  storageProduct: string,
  metricType: string,
  atTime: Date,
): Promise<StoragePricingVersion> {
  const rows = await db
    .select()
    .from(storagePricingVersions)
    .where(
      and(
        eq(storagePricingVersions.storageProvider, storageProvider),
        eq(storagePricingVersions.storageProduct, storageProduct),
        eq(storagePricingVersions.metricType, metricType),
        lte(storagePricingVersions.effectiveFrom, atTime),
        or(
          isNull(storagePricingVersions.effectiveTo),
          gt(storagePricingVersions.effectiveTo, atTime),
        ),
      ),
    );

  if (rows.length === 0) {
    throw new Error(
      `[ai/storage-billing] No provider storage pricing version found for provider=${storageProvider} product=${storageProduct} metric=${metricType} at ${atTime.toISOString()}`,
    );
  }
  if (rows.length > 1) {
    throw new Error(
      `[ai/storage-billing] Multiple provider storage pricing versions found (${rows.length}) for provider=${storageProvider} product=${storageProduct} metric=${metricType} at ${atTime.toISOString()} — overlapping windows`,
    );
  }
  return rows[0];
}

/**
 * Resolve the customer (tenant-specific) storage pricing version active at atTime.
 * Returns null if no customer pricing version found (fall back to provider pricing only, no markup).
 */
export async function resolveCustomerStoragePricingVersion(
  tenantId: string,
  storageProvider: string,
  storageProduct: string,
  metricType: string,
  atTime: Date,
): Promise<CustomerStoragePricingVersion | null> {
  const rows = await db
    .select()
    .from(customerStoragePricingVersions)
    .where(
      and(
        eq(customerStoragePricingVersions.tenantId, tenantId),
        eq(customerStoragePricingVersions.storageProvider, storageProvider),
        eq(customerStoragePricingVersions.storageProduct, storageProduct),
        eq(customerStoragePricingVersions.metricType, metricType),
        lte(customerStoragePricingVersions.effectiveFrom, atTime),
        or(
          isNull(customerStoragePricingVersions.effectiveTo),
          gt(customerStoragePricingVersions.effectiveTo, atTime),
        ),
      ),
    );

  if (rows.length > 1) {
    throw new Error(
      `[ai/storage-billing] Multiple customer storage pricing versions found (${rows.length}) for tenant=${tenantId} provider=${storageProvider} product=${storageProduct} metric=${metricType} at ${atTime.toISOString()} — overlapping windows`,
    );
  }
  return rows[0] ?? null;
}

// ─── Billing Derivation ───────────────────────────────────────────────────────

/**
 * Derive and persist a storage billing row from a storage usage row.
 *
 * Idempotent: if a billing row for this storage_usage_id already exists, returns it.
 * Pricing is resolved at usage_period_start — deterministic and historically correct.
 *
 * Fallback: if no customer pricing version exists, customer_price = provider_cost (zero margin).
 */
export async function createStorageBillingUsage(
  storageUsageId: string,
): Promise<StorageBillingUsage> {
  // Idempotency check
  const existing = await db
    .select()
    .from(storageBillingUsage)
    .where(eq(storageBillingUsage.storageUsageId, storageUsageId))
    .limit(1);
  if (existing.length > 0) {
    console.log(`[ai/storage-billing] Billing row already exists for storageUsageId=${storageUsageId}`);
    return existing[0];
  }

  // Load usage row
  const usageRows = await db
    .select()
    .from(storageUsage)
    .where(eq(storageUsage.id, storageUsageId))
    .limit(1);
  if (usageRows.length === 0) {
    throw new Error(`[ai/storage-billing] Storage usage row not found: ${storageUsageId}`);
  }
  const usage = usageRows[0];
  const atTime = usage.usagePeriodStart;

  // Resolve provider pricing
  const providerVersion = await resolveStoragePricingVersion(
    usage.storageProvider,
    usage.storageProduct,
    usage.metricType,
    atTime,
  );

  // Resolve customer pricing (optional)
  const customerVersion = await resolveCustomerStoragePricingVersion(
    usage.tenantId,
    usage.storageProvider,
    usage.storageProduct,
    usage.metricType,
    atTime,
  );

  // Derivation
  const rawUsage = Number(usage.usageAmount);
  const providerIncluded = Number(providerVersion.includedUsage ?? 0);
  const customerIncluded = customerVersion
    ? Number(customerVersion.includedUsage ?? 0)
    : providerIncluded;

  // Use customer included threshold if available, else provider threshold
  const effectiveIncluded = customerVersion ? customerIncluded : providerIncluded;
  const includedUsageAmount = Math.min(rawUsage, effectiveIncluded);
  const billableUsageAmount = Math.max(rawUsage - includedUsageAmount, 0);

  const providerUnitPrice = Number(providerVersion.unitPriceUsd);
  const customerUnitPrice = customerVersion
    ? Number(customerVersion.unitPriceUsd)
    : providerUnitPrice;

  const providerCostUsd = billableUsageAmount * providerUnitPrice;
  const customerPriceUsd = billableUsageAmount * customerUnitPrice;
  const marginUsd = customerPriceUsd - providerCostUsd;

  const pricingVersion = customerVersion
    ? customerVersion.pricingVersion
    : providerVersion.pricingVersion;

  const inserted = await db
    .insert(storageBillingUsage)
    .values({
      storageUsageId,
      tenantId: usage.tenantId,
      storageProvider: usage.storageProvider,
      storageProduct: usage.storageProduct,
      metricType: usage.metricType,
      providerPricingVersionId: providerVersion.id,
      customerPricingVersionId: customerVersion?.id ?? null,
      rawUsageAmount: String(rawUsage.toFixed(8)),
      includedUsageAmount: String(includedUsageAmount.toFixed(8)),
      billableUsageAmount: String(billableUsageAmount.toFixed(8)),
      providerCostUsd: String(providerCostUsd.toFixed(8)),
      customerPriceUsd: String(customerPriceUsd.toFixed(8)),
      marginUsd: String(marginUsd.toFixed(8)),
      pricingVersion,
    })
    .returning();

  console.log(
    `[ai/storage-billing] Created billing row for storageUsageId=${storageUsageId}: billable=${billableUsageAmount}, customer_price=${customerPriceUsd.toFixed(8)}`,
  );

  // Phase 4O: Apply plan allowance classification after confirmed storage billing insert.
  // Fire-and-forget — never breaks storage billing flow if allowance resolution fails.
  void applyStorageAllowanceToBillingUsage(inserted[0].id).catch((err) =>
    console.error("[ai/storage-billing] Allowance application failed (suppressed):", err instanceof Error ? err.message : err),
  );

  return inserted[0];
}

// ─── List Helpers ─────────────────────────────────────────────────────────────

export async function listStorageBillingUsageByTenant(
  tenantId: string,
  limit = 100,
): Promise<StorageBillingUsage[]> {
  return db
    .select()
    .from(storageBillingUsage)
    .where(eq(storageBillingUsage.tenantId, tenantId))
    .orderBy(storageBillingUsage.createdAt)
    .limit(limit);
}

export async function listStorageBillingUsageByPeriod(
  periodStart: Date,
  periodEnd: Date,
  tenantId?: string,
): Promise<StorageBillingUsage[]> {
  const conditions = [
    gte(storageBillingUsage.createdAt, periodStart),
    lt(storageBillingUsage.createdAt, periodEnd),
  ];
  if (tenantId) conditions.push(eq(storageBillingUsage.tenantId, tenantId));
  return db
    .select()
    .from(storageBillingUsage)
    .where(and(...conditions))
    .orderBy(storageBillingUsage.createdAt)
    .limit(500);
}
