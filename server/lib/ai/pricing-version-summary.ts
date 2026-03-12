/**
 * Pricing Version Summary — Phase 4H
 *
 * SERVER-ONLY: Read helpers for provider_pricing_versions and
 * customer_pricing_versions tables. Backend-only — no UI.
 *
 * Used for admin visibility, billing audit, and forensic debugging.
 */

import { eq, and, desc } from "drizzle-orm";
import { db } from "../../db";
import { providerPricingVersions, customerPricingVersions } from "@shared/schema";
import type { ProviderPricingVersion, CustomerPricingVersion } from "@shared/schema";
import {
  resolveProviderPricingVersion,
  resolveCustomerPricingVersion,
} from "./pricing-versioning";

// ─── List Helpers ─────────────────────────────────────────────────────────────

/**
 * List provider pricing versions for a provider+model, newest effective_from first.
 */
export async function listProviderPricingVersions(
  provider: string,
  model: string,
  limit = 50,
): Promise<ProviderPricingVersion[]> {
  return db
    .select()
    .from(providerPricingVersions)
    .where(
      and(
        eq(providerPricingVersions.provider, provider),
        eq(providerPricingVersions.model, model),
      ),
    )
    .orderBy(desc(providerPricingVersions.effectiveFrom))
    .limit(limit);
}

/**
 * List customer pricing versions for a tenant/feature/provider, newest first.
 */
export async function listCustomerPricingVersions(
  tenantId: string,
  feature: string,
  provider: string,
  limit = 50,
): Promise<CustomerPricingVersion[]> {
  return db
    .select()
    .from(customerPricingVersions)
    .where(
      and(
        eq(customerPricingVersions.tenantId, tenantId),
        eq(customerPricingVersions.feature, feature),
        eq(customerPricingVersions.provider, provider),
      ),
    )
    .orderBy(desc(customerPricingVersions.effectiveFrom))
    .limit(limit);
}

// ─── Active Version Getters ───────────────────────────────────────────────────

/**
 * Get the active provider pricing version at a given time (defaults to now).
 * Returns null if no version is active.
 */
export async function getActiveProviderPricingVersion(
  provider: string,
  model: string,
  atTime: Date = new Date(),
): Promise<ProviderPricingVersion | null> {
  try {
    return await resolveProviderPricingVersion(provider, model, atTime);
  } catch {
    return null;
  }
}

/**
 * Get the active customer pricing version at a given time (defaults to now).
 * Returns null if no version is active.
 */
export async function getActiveCustomerPricingVersion(
  tenantId: string,
  feature: string,
  provider: string,
  model: string | null,
  atTime: Date = new Date(),
): Promise<CustomerPricingVersion | null> {
  try {
    return await resolveCustomerPricingVersion(tenantId, feature, provider, model, atTime);
  } catch {
    return null;
  }
}

// ─── Explain Helper ───────────────────────────────────────────────────────────

export interface PricingVersionExplainInput {
  provider: string;
  model: string;
  tenantId?: string | null;
  feature?: string | null;
  atTime?: Date;
}

export interface PricingVersionExplainResult {
  atTime: Date;
  providerVersion: {
    id: string | null;
    pricingVersion: string | null;
    effectiveFrom: Date | null;
    effectiveTo: Date | null;
    inputTokenPriceUsd: string | null;
    outputTokenPriceUsd: string | null;
    cachedInputTokenPriceUsd: string | null;
    reasoningTokenPriceUsd: string | null;
  } | null;
  customerVersion: {
    id: string | null;
    pricingVersion: string | null;
    pricingMode: string | null;
    effectiveFrom: Date | null;
    effectiveTo: Date | null;
    multiplier: string | null;
    flatMarkupUsd: string | null;
    perRequestMarkupUsd: string | null;
  } | null;
  providerResolutionStatus: "resolved" | "not_found";
  customerResolutionStatus: "resolved" | "not_found" | "skipped";
}

/**
 * Explain the fully resolved pricing version for a given request context.
 *
 * Returns:
 *   - resolved provider pricing version (or null)
 *   - resolved customer pricing version (or null, if tenant/feature provided)
 *   - effective windows
 *   - relevant pricing parameters
 *
 * Does not throw — always returns a structured result.
 */
export async function explainResolvedPricingVersion(
  input: PricingVersionExplainInput,
): Promise<PricingVersionExplainResult> {
  const atTime = input.atTime ?? new Date();

  // Resolve provider version
  let providerVersion: PricingVersionExplainResult["providerVersion"] = null;
  let providerResolutionStatus: "resolved" | "not_found" = "not_found";

  try {
    const ppv = await resolveProviderPricingVersion(input.provider, input.model, atTime);
    providerVersion = {
      id: ppv.id,
      pricingVersion: ppv.pricingVersion,
      effectiveFrom: ppv.effectiveFrom,
      effectiveTo: ppv.effectiveTo ?? null,
      inputTokenPriceUsd: ppv.inputTokenPriceUsd,
      outputTokenPriceUsd: ppv.outputTokenPriceUsd,
      cachedInputTokenPriceUsd: ppv.cachedInputTokenPriceUsd,
      reasoningTokenPriceUsd: ppv.reasoningTokenPriceUsd,
    };
    providerResolutionStatus = "resolved";
  } catch {
    // Not found or multiple — remains null
  }

  // Resolve customer version (only if tenant and feature provided)
  let customerVersion: PricingVersionExplainResult["customerVersion"] = null;
  let customerResolutionStatus: "resolved" | "not_found" | "skipped" = "skipped";

  if (input.tenantId && input.feature) {
    try {
      const cpv = await resolveCustomerPricingVersion(
        input.tenantId,
        input.feature,
        input.provider,
        input.model,
        atTime,
      );
      customerVersion = {
        id: cpv.id,
        pricingVersion: cpv.pricingVersion,
        pricingMode: cpv.pricingMode,
        effectiveFrom: cpv.effectiveFrom,
        effectiveTo: cpv.effectiveTo ?? null,
        multiplier: cpv.multiplier ?? null,
        flatMarkupUsd: cpv.flatMarkupUsd ?? null,
        perRequestMarkupUsd: cpv.perRequestMarkupUsd ?? null,
      };
      customerResolutionStatus = "resolved";
    } catch {
      customerResolutionStatus = "not_found";
    }
  }

  return {
    atTime,
    providerVersion,
    customerVersion,
    providerResolutionStatus,
    customerResolutionStatus,
  };
}
