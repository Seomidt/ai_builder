/**
 * Entitlement Enforcement — Phase 4O
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Enforces plan entitlements before provider execution:
 *   - Blocks disallowed feature flags
 *   - Blocks overage execution when plan disallows it
 *   - Returns deterministic enforcement decisions from plan entitlements
 *
 * Design rules:
 *   - No plan codes hardcoded — only resolved entitlements used
 *   - All guards are pre-execution (before provider call, before billing row)
 *   - Enforcement decisions are stable and re-deterministic
 */

import { getTenantPlanEntitlements, getActiveTenantSubscription } from "./subscriptions";
import type { PlanEntitlement, SubscriptionPlan } from "@shared/schema";

// ─── Error Types ──────────────────────────────────────────────────────────────

export class EntitlementBlockedError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly feature: string,
    public readonly reason: string,
  ) {
    super(`[entitlement] Tenant '${tenantId}' blocked for feature '${feature}': ${reason}`);
    this.name = "EntitlementBlockedError";
  }
}

export class OverageBlockedError extends Error {
  constructor(
    public readonly tenantId: string,
    public readonly usageType: "ai" | "storage",
    public readonly reason: string,
  ) {
    super(`[entitlement] Overage blocked for tenant '${tenantId}' (${usageType}): ${reason}`);
    this.name = "OverageBlockedError";
  }
}

// ─── Feature Flag Enforcement ─────────────────────────────────────────────────

/**
 * Assert that a tenant is entitled to a given feature.
 *
 * Lookup order:
 *   1. Resolve active subscription + entitlements at atTime
 *   2. Find entitlement_type = 'feature_flag' with matching entitlement_key = feature
 *   3. If not found → feature assumed allowed (standard/unconfigured plan)
 *   4. If found and boolean_value = false → throw EntitlementBlockedError
 *
 * No subscription → feature allowed (fail-open for unsubscribed tenants unless
 * explicitly blocked — avoids breaking existing tenants during migration).
 */
export async function assertTenantFeatureEntitled(
  tenantId: string,
  feature: string,
  atTime: Date = new Date(),
): Promise<void> {
  let entitlements: PlanEntitlement[];
  try {
    entitlements = await getTenantPlanEntitlements(tenantId, atTime);
  } catch {
    return;
  }

  const entry = entitlements.find(
    (e) => e.entitlementType === "feature_flag" && e.entitlementKey === feature,
  );

  if (entry && entry.booleanValue === false) {
    throw new EntitlementBlockedError(
      tenantId,
      feature,
      `feature_flag '${feature}' is disabled on active plan`,
    );
  }
}

/**
 * Assert that a tenant is allowed to incur overage for the given usage type.
 *
 * Checks the entitlement_key:
 *   - usageType='ai'      → 'allow_overage_ai'
 *   - usageType='storage' → 'allow_overage_storage'
 *
 * If entitlement key not present → overage allowed (fail-open).
 * If entitlement present and boolean_value = false → throw OverageBlockedError.
 */
export async function assertTenantOverageAllowed(
  tenantId: string,
  usageType: "ai" | "storage",
  atTime: Date = new Date(),
): Promise<void> {
  let entitlements: PlanEntitlement[];
  try {
    entitlements = await getTenantPlanEntitlements(tenantId, atTime);
  } catch {
    return;
  }

  const key = usageType === "ai" ? "allow_overage_ai" : "allow_overage_storage";
  const entry = entitlements.find((e) => e.entitlementKey === key);

  if (entry && entry.booleanValue === false) {
    throw new OverageBlockedError(
      tenantId,
      usageType,
      `overage disabled on active plan (entitlement_key: ${key} = false)`,
    );
  }
}

// ─── Plan Feature & Limit Helpers ─────────────────────────────────────────────

export interface TenantFeatureFlags {
  flags: Record<string, boolean>;
  hasSubscription: boolean;
}

/**
 * Returns all boolean feature flags for a tenant at a given time.
 * Empty record if no active subscription.
 */
export async function getTenantFeatureFlags(
  tenantId: string,
  atTime: Date = new Date(),
): Promise<TenantFeatureFlags> {
  let entitlements: PlanEntitlement[];
  try {
    entitlements = await getTenantPlanEntitlements(tenantId, atTime);
  } catch {
    return { flags: {}, hasSubscription: false };
  }

  const flags: Record<string, boolean> = {};
  for (const e of entitlements) {
    if (e.entitlementType === "feature_flag" && e.booleanValue !== null) {
      flags[e.entitlementKey] = e.booleanValue;
    }
  }
  return { flags, hasSubscription: true };
}

export interface TenantLimits {
  limits: Record<string, number>;
  hasSubscription: boolean;
}

/**
 * Returns all numeric plan limits for a tenant at a given time.
 * Empty record if no active subscription.
 */
export async function getTenantLimits(
  tenantId: string,
  atTime: Date = new Date(),
): Promise<TenantLimits> {
  let entitlements: PlanEntitlement[];
  try {
    entitlements = await getTenantPlanEntitlements(tenantId, atTime);
  } catch {
    return { limits: {}, hasSubscription: false };
  }

  const limits: Record<string, number> = {};
  for (const e of entitlements) {
    if (e.entitlementType === "limit" && e.numericValue !== null) {
      limits[e.entitlementKey] = Number(e.numericValue);
    }
  }
  return { limits, hasSubscription: true };
}

// ─── Decision Explain ─────────────────────────────────────────────────────────

export interface EntitlementDecision {
  tenantId: string;
  feature: string;
  atTime: string;
  hasSubscription: boolean;
  featureFlagFound: boolean;
  featureFlagValue: boolean | null;
  decision: "allowed" | "blocked";
  reason: string;
}

/**
 * Explain the entitlement decision for a tenant + feature without throwing.
 * Used for admin/audit/debug — does not block execution.
 */
export async function explainTenantEntitlementDecision(
  tenantId: string,
  feature: string,
  atTime: Date = new Date(),
): Promise<EntitlementDecision> {
  const base: EntitlementDecision = {
    tenantId,
    feature,
    atTime: atTime.toISOString(),
    hasSubscription: false,
    featureFlagFound: false,
    featureFlagValue: null,
    decision: "allowed",
    reason: "no_subscription_fail_open",
  };

  let entitlements: PlanEntitlement[];
  try {
    entitlements = await getTenantPlanEntitlements(tenantId, atTime);
  } catch {
    return base;
  }

  if (entitlements.length === 0) {
    return { ...base, reason: "no_entitlements_fail_open" };
  }

  const entry = entitlements.find(
    (e) => e.entitlementType === "feature_flag" && e.entitlementKey === feature,
  );

  if (!entry) {
    return {
      ...base,
      hasSubscription: true,
      featureFlagFound: false,
      decision: "allowed",
      reason: "feature_flag_not_configured_fail_open",
    };
  }

  const allowed = entry.booleanValue !== false;
  return {
    ...base,
    hasSubscription: true,
    featureFlagFound: true,
    featureFlagValue: entry.booleanValue,
    decision: allowed ? "allowed" : "blocked",
    reason: allowed
      ? "feature_flag_explicitly_enabled"
      : "feature_flag_explicitly_disabled",
  };
}
