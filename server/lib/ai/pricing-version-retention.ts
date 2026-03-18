/**
 * Pricing Version Retention — Phase 4H
 *
 * SERVER-ONLY: Retention policy helpers for provider_pricing_versions and
 * customer_pricing_versions tables.
 *
 * POLICY: Pricing versions must generally NOT be deleted.
 *
 * Rationale:
 *   Every ai_billing_usage row references a pricing version (via
 *   provider_pricing_version_id and customer_pricing_version_id).
 *   Deleting a pricing version referenced by a historical billing row would
 *   corrupt the audit trail and make billing non-reproducible.
 *
 *   Pricing versions are reference data, not event logs. They are small in size
 *   (one row per pricing regime change) and accumulate slowly. The cost of
 *   retaining them indefinitely is negligible compared to the audit value.
 *
 *   Phase 4H does NOT implement destructive cleanup. Only preview and policy
 *   documentation are provided.
 *
 * Safe deletion criteria (future phases only, with manual review):
 *   A pricing version row MAY be deleted only if:
 *     1. No ai_billing_usage row references it (provider_pricing_version_id or customer_pricing_version_id)
 *     2. It has never been in an active effective window (test data only)
 *     3. A human engineer reviews and approves the deletion
 *
 * Recommended workflow for future price changes:
 *   1. Insert a new row with updated pricing_version and new effective_from
 *   2. Set effective_to on the previous row to match the new row's effective_from
 *   3. Do NOT update existing rows' price fields
 */

import { eq, and, lt, isNull, not } from "drizzle-orm";
import { db } from "../../db";
import { providerPricingVersions, customerPricingVersions, aiBillingUsage } from "@shared/schema";

// ─── Policy Documentation ──────────────────────────────────────────────────────

export interface PricingVersionRetentionPolicy {
  defaultAction: "retain_forever";
  rationale: string;
  safeToDeleteCriteria: string[];
  recommendedVersioningWorkflow: string[];
  minimumRetentionMonths: null;
}

/**
 * Return the documented pricing version retention policy.
 * Used for admin visibility and audit documentation.
 */
export function explainPricingVersionRetentionPolicy(): PricingVersionRetentionPolicy {
  return {
    defaultAction: "retain_forever",
    rationale:
      "Pricing versions back historical billing rows in ai_billing_usage. " +
      "Deleting them would corrupt billing reproducibility and audit trails. " +
      "The table accumulates one row per pricing regime change and remains small indefinitely.",
    safeToDeleteCriteria: [
      "No ai_billing_usage.provider_pricing_version_id references the row",
      "No ai_billing_usage.customer_pricing_version_id references the row",
      "The row was never in an active effective window (i.e. test data only)",
      "A human engineer has reviewed and approved the deletion",
    ],
    recommendedVersioningWorkflow: [
      "1. Insert a new row with updated pricing_version and new effective_from",
      "2. Set effective_to on the expiring row to match the new effective_from (non-overlapping)",
      "3. Do NOT update price fields on existing rows",
      "4. Verify the EXCLUDE constraint rejects any attempt to create overlapping windows",
    ],
    minimumRetentionMonths: null,
  };
}

// ─── Preview Unused Versions ──────────────────────────────────────────────────

export interface UnusedPricingVersionPreview {
  unusedProviderVersions: Array<{
    id: string;
    provider: string;
    model: string;
    pricingVersion: string;
    effectiveFrom: Date;
    effectiveTo: Date | null;
    createdAt: Date;
  }>;
  unusedCustomerVersions: Array<{
    id: string;
    tenantId: string;
    feature: string;
    provider: string;
    pricingVersion: string;
    effectiveFrom: Date;
    createdAt: Date;
  }>;
  totalUnusedProvider: number;
  totalUnusedCustomer: number;
  note: string;
}

/**
 * Preview provider and customer pricing versions not referenced by any
 * ai_billing_usage row. Read-only — does NOT delete anything.
 *
 * These are candidates for eventual cleanup but must be reviewed manually.
 *
 * IMPORTANT: "unused" means not referenced by any billing row — it does NOT
 * mean safe to delete. Verify the safe deletion criteria before any action.
 */
export async function previewUnusedPricingVersions(): Promise<UnusedPricingVersionPreview> {
  // Provider versions not referenced by any billing row
  const allProviderVersions = await db
    .select({
      id: providerPricingVersions.id,
      provider: providerPricingVersions.provider,
      model: providerPricingVersions.model,
      pricingVersion: providerPricingVersions.pricingVersion,
      effectiveFrom: providerPricingVersions.effectiveFrom,
      effectiveTo: providerPricingVersions.effectiveTo,
      createdAt: providerPricingVersions.createdAt,
    })
    .from(providerPricingVersions)
    .orderBy(providerPricingVersions.createdAt)
    .limit(1000);

  // Customer versions not referenced by any billing row
  const allCustomerVersions = await db
    .select({
      id: customerPricingVersions.id,
      tenantId: customerPricingVersions.tenantId,
      feature: customerPricingVersions.feature,
      provider: customerPricingVersions.provider,
      pricingVersion: customerPricingVersions.pricingVersion,
      effectiveFrom: customerPricingVersions.effectiveFrom,
      createdAt: customerPricingVersions.createdAt,
    })
    .from(customerPricingVersions)
    .orderBy(customerPricingVersions.createdAt)
    .limit(1000);

  // Check which provider versions are referenced
  const unusedProvider: UnusedPricingVersionPreview["unusedProviderVersions"] = [];
  for (const pv of allProviderVersions) {
    const refs = await db
      .select({ id: aiBillingUsage.id })
      .from(aiBillingUsage)
      .where(eq(aiBillingUsage.providerPricingVersionId, pv.id))
      .limit(1);
    if (refs.length === 0) {
      unusedProvider.push({
        id: pv.id,
        provider: pv.provider,
        model: pv.model,
        pricingVersion: pv.pricingVersion,
        effectiveFrom: pv.effectiveFrom,
        effectiveTo: pv.effectiveTo ?? null,
        createdAt: pv.createdAt,
      });
    }
  }

  // Check which customer versions are referenced
  const unusedCustomer: UnusedPricingVersionPreview["unusedCustomerVersions"] = [];
  for (const cv of allCustomerVersions) {
    const refs = await db
      .select({ id: aiBillingUsage.id })
      .from(aiBillingUsage)
      .where(eq(aiBillingUsage.customerPricingVersionId, cv.id))
      .limit(1);
    if (refs.length === 0) {
      unusedCustomer.push({
        id: cv.id,
        tenantId: cv.tenantId,
        feature: cv.feature,
        provider: cv.provider,
        pricingVersion: cv.pricingVersion,
        effectiveFrom: cv.effectiveFrom,
        createdAt: cv.createdAt,
      });
    }
  }

  return {
    unusedProviderVersions: unusedProvider,
    unusedCustomerVersions: unusedCustomer,
    totalUnusedProvider: unusedProvider.length,
    totalUnusedCustomer: unusedCustomer.length,
    note:
      "These versions are not referenced by any billing row. " +
      "Review all safe deletion criteria before any action. " +
      "Phase 4H does not implement destructive cleanup.",
  };
}
