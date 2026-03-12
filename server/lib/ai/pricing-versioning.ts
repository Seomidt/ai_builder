/**
 * Pricing Version Resolution — Phase 4H
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides deterministic timestamp-based resolution of pricing versions.
 *
 * Resolution contract:
 *   Given (provider, model, atTime) or (tenantId, feature, provider, model, atTime),
 *   returns exactly ONE pricing version row whose effective window contains atTime:
 *     effective_from <= atTime AND (effective_to IS NULL OR atTime < effective_to)
 *
 * Strict helpers throw explicitly on zero or multiple matches.
 * Best-effort helpers return null on any failure — safe for billing integration.
 *
 * Immutability rules:
 *   - pricing version rows must never be mutated after billing references them
 *   - future price changes must insert a new row with a new pricing_version
 *   - this module is read-only — no inserts or updates
 */

import { eq, and, lte, or, isNull, gt } from "drizzle-orm";
import { db } from "../../db";
import { providerPricingVersions, customerPricingVersions } from "@shared/schema";
import type { ProviderPricingVersion, CustomerPricingVersion } from "@shared/schema";

// ─── Provider Pricing Resolution ──────────────────────────────────────────────

/**
 * Resolve exactly one provider pricing version for a provider/model at a given time.
 *
 * Window: effective_from <= atTime AND (effective_to IS NULL OR atTime < effective_to)
 *
 * Throws if:
 *   - zero versions match (gap in pricing history)
 *   - more than one version matches (overlapping windows — should never happen due to EXCLUDE constraint)
 */
export async function resolveProviderPricingVersion(
  provider: string,
  model: string,
  atTime: Date,
): Promise<ProviderPricingVersion> {
  const rows = await db
    .select()
    .from(providerPricingVersions)
    .where(
      and(
        eq(providerPricingVersions.provider, provider),
        eq(providerPricingVersions.model, model),
        lte(providerPricingVersions.effectiveFrom, atTime),
        or(
          isNull(providerPricingVersions.effectiveTo),
          gt(providerPricingVersions.effectiveTo, atTime),
        ),
      ),
    );

  if (rows.length === 0) {
    throw new Error(
      `[ai/pricing-versioning] No provider pricing version found for provider="${provider}" model="${model}" at ${atTime.toISOString()}`,
    );
  }
  if (rows.length > 1) {
    throw new Error(
      `[ai/pricing-versioning] Multiple provider pricing versions found for provider="${provider}" model="${model}" at ${atTime.toISOString()} — overlapping windows detected`,
    );
  }
  return rows[0];
}

/**
 * Best-effort wrapper around resolveProviderPricingVersion.
 * Returns null instead of throwing — safe for billing integration where
 * pricing version tables may be empty or partially populated.
 */
export async function resolveProviderPricingVersionBestEffort(
  provider: string,
  model: string,
  atTime: Date,
): Promise<ProviderPricingVersion | null> {
  try {
    return await resolveProviderPricingVersion(provider, model, atTime);
  } catch {
    return null;
  }
}

// ─── Customer Pricing Resolution ──────────────────────────────────────────────

/**
 * Resolve exactly one customer pricing version for a tenant/feature/provider
 * at a given time. Model is optional — null means "any model for this provider".
 *
 * Resolution order:
 *   1. Exact match: tenant + feature + provider + model (specific model)
 *   2. Wildcard match: tenant + feature + provider + model IS NULL (any model)
 *
 * Returns the first match found — specific model takes precedence over wildcard.
 *
 * Throws if:
 *   - zero versions match at either specificity level
 *   - more than one version matches at the same specificity level
 */
export async function resolveCustomerPricingVersion(
  tenantId: string,
  feature: string,
  provider: string,
  model: string | null,
  atTime: Date,
): Promise<CustomerPricingVersion> {
  // Try specific model match first (if model provided)
  if (model !== null) {
    const specific = await db
      .select()
      .from(customerPricingVersions)
      .where(
        and(
          eq(customerPricingVersions.tenantId, tenantId),
          eq(customerPricingVersions.feature, feature),
          eq(customerPricingVersions.provider, provider),
          eq(customerPricingVersions.model, model),
          lte(customerPricingVersions.effectiveFrom, atTime),
          or(
            isNull(customerPricingVersions.effectiveTo),
            gt(customerPricingVersions.effectiveTo, atTime),
          ),
        ),
      );

    if (specific.length > 1) {
      throw new Error(
        `[ai/pricing-versioning] Multiple customer pricing versions (specific) for tenant="${tenantId}" feature="${feature}" provider="${provider}" model="${model}" at ${atTime.toISOString()}`,
      );
    }
    if (specific.length === 1) return specific[0];
  }

  // Wildcard: model IS NULL
  const wildcard = await db
    .select()
    .from(customerPricingVersions)
    .where(
      and(
        eq(customerPricingVersions.tenantId, tenantId),
        eq(customerPricingVersions.feature, feature),
        eq(customerPricingVersions.provider, provider),
        isNull(customerPricingVersions.model),
        lte(customerPricingVersions.effectiveFrom, atTime),
        or(
          isNull(customerPricingVersions.effectiveTo),
          gt(customerPricingVersions.effectiveTo, atTime),
        ),
      ),
    );

  if (wildcard.length === 0) {
    throw new Error(
      `[ai/pricing-versioning] No customer pricing version found for tenant="${tenantId}" feature="${feature}" provider="${provider}" model="${model ?? "null"}" at ${atTime.toISOString()}`,
    );
  }
  if (wildcard.length > 1) {
    throw new Error(
      `[ai/pricing-versioning] Multiple customer pricing versions (wildcard) for tenant="${tenantId}" feature="${feature}" provider="${provider}" at ${atTime.toISOString()} — overlapping windows detected`,
    );
  }
  return wildcard[0];
}

/**
 * Best-effort wrapper around resolveCustomerPricingVersion.
 * Returns null instead of throwing — safe for billing integration.
 */
export async function resolveCustomerPricingVersionBestEffort(
  tenantId: string,
  feature: string,
  provider: string,
  model: string | null,
  atTime: Date,
): Promise<CustomerPricingVersion | null> {
  try {
    return await resolveCustomerPricingVersion(tenantId, feature, provider, model, atTime);
  } catch {
    return null;
  }
}

// ─── Lookup by ID ──────────────────────────────────────────────────────────────

/**
 * Fetch a provider pricing version by its primary key.
 * Returns null if not found.
 */
export async function getProviderPricingVersionById(
  id: string,
): Promise<ProviderPricingVersion | null> {
  const rows = await db
    .select()
    .from(providerPricingVersions)
    .where(eq(providerPricingVersions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Fetch a customer pricing version by its primary key.
 * Returns null if not found.
 */
export async function getCustomerPricingVersionById(
  id: string,
): Promise<CustomerPricingVersion | null> {
  const rows = await db
    .select()
    .from(customerPricingVersions)
    .where(eq(customerPricingVersions.id, id))
    .limit(1);
  return rows[0] ?? null;
}
