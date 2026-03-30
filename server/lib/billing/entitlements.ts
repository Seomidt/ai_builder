/**
 * Phase 20 — Entitlements Service
 * Feature access checks for tenants based on their active plan.
 * Integrates with Phase 18 feature flags for runtime gate resolution.
 */

import { db } from "../../db.ts";
import { sql as drizzleSql } from "drizzle-orm";

export interface EntitlementResult {
  allowed: boolean;
  reason: string;
  planKey: string | null;
  featureKey: string;
}

/**
 * Check whether a tenant has access to a specific feature.
 * Looks up the tenant's active plan and checks the plan_features table.
 */
export async function checkFeatureAccess(
  tenantId: string,
  featureKey: string,
): Promise<EntitlementResult> {
  if (!tenantId?.trim()) return { allowed: false, reason: "tenantId required", planKey: null, featureKey };
  if (!featureKey?.trim()) return { allowed: false, reason: "featureKey required", planKey: null, featureKey };

  // Get tenant's active plan
  const planRows = await db.execute(drizzleSql`
    SELECT p.id AS plan_id, p.plan_key, p.active AS plan_active
    FROM tenant_plans tp
    JOIN plans p ON p.id = tp.plan_id
    WHERE tp.tenant_id = ${tenantId}
      AND tp.status = 'active'
      AND p.active = true
    ORDER BY tp.started_at DESC
    LIMIT 1
  `);

  const plan = planRows.rows[0] as Record<string, unknown> | undefined;
  if (!plan) {
    return { allowed: false, reason: "No active plan for tenant", planKey: null, featureKey };
  }

  // Check feature entitlement
  const featureRows = await db.execute(drizzleSql`
    SELECT enabled FROM plan_features
    WHERE plan_id = ${plan.plan_id as string} AND feature_key = ${featureKey}
    LIMIT 1
  `);

  const feature = featureRows.rows[0] as Record<string, unknown> | undefined;
  if (!feature) {
    return {
      allowed: false,
      reason: `Feature '${featureKey}' not defined for plan '${plan.plan_key as string}'`,
      planKey: plan.plan_key as string,
      featureKey,
    };
  }

  const enabled = feature.enabled as boolean;
  return {
    allowed: enabled,
    reason: enabled
      ? `Feature '${featureKey}' is enabled on plan '${plan.plan_key as string}'`
      : `Feature '${featureKey}' is disabled on plan '${plan.plan_key as string}'`,
    planKey: plan.plan_key as string,
    featureKey,
  };
}

/**
 * Check multiple features at once. Returns a map of featureKey → allowed.
 */
export async function checkMultipleFeatures(
  tenantId: string,
  featureKeys: string[],
): Promise<Record<string, boolean>> {
  const results: Record<string, boolean> = {};
  for (const key of featureKeys) {
    const r = await checkFeatureAccess(tenantId, key);
    results[key] = r.allowed;
  }
  return results;
}

/**
 * Get the full entitlement matrix for a tenant — all features and their access status.
 */
export async function getTenantEntitlements(tenantId: string): Promise<{
  planKey: string | null;
  features: Array<{ featureKey: string; enabled: boolean }>;
}> {
  const planRows = await db.execute(drizzleSql`
    SELECT p.id AS plan_id, p.plan_key
    FROM tenant_plans tp
    JOIN plans p ON p.id = tp.plan_id
    WHERE tp.tenant_id = ${tenantId}
      AND tp.status = 'active'
      AND p.active = true
    ORDER BY tp.started_at DESC LIMIT 1
  `);

  const plan = planRows.rows[0] as Record<string, unknown> | undefined;
  if (!plan) return { planKey: null, features: [] };

  const featureRows = await db.execute(drizzleSql`
    SELECT feature_key, enabled FROM plan_features
    WHERE plan_id = ${plan.plan_id as string}
    ORDER BY feature_key ASC
  `);

  return {
    planKey: plan.plan_key as string,
    features: featureRows.rows.map((r: Record<string, unknown>) => ({
      featureKey: r.feature_key as string,
      enabled: r.enabled as boolean,
    })),
  };
}

/**
 * Assert feature access — throws if not allowed.
 * Use this at integration points (AI orchestrator, agent execution, etc).
 */
export async function assertFeatureAccess(tenantId: string, featureKey: string): Promise<void> {
  const result = await checkFeatureAccess(tenantId, featureKey);
  if (!result.allowed) {
    throw new Error(`ENTITLEMENT_DENIED: ${result.reason}`);
  }
}

/**
 * List all tenants on a given plan.
 */
export async function listTenantsOnPlan(planKey: string): Promise<Array<{
  tenantId: string;
  status: string;
  startedAt: Date;
}>> {
  const rows = await db.execute(drizzleSql`
    SELECT tp.tenant_id, tp.status, tp.started_at
    FROM tenant_plans tp
    JOIN plans p ON p.id = tp.plan_id
    WHERE p.plan_key = ${planKey.toLowerCase()} AND tp.status = 'active'
    ORDER BY tp.started_at DESC
  `);
  return rows.rows.map((r: Record<string, unknown>) => ({
    tenantId: r.tenant_id as string,
    status: r.status as string,
    startedAt: new Date(r.started_at as string),
  }));
}
