/**
 * Phase 20 — Plan Lifecycle
 * Tenant plan assignment, upgrades, downgrades, trial, cancellation, and expiry.
 */

import { db } from "../../db";
import { tenantPlans } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";

export type PlanStatus = "active" | "cancelled" | "suspended" | "trial" | "expired";

export interface AssignPlanParams {
  tenantId: string;
  planId: string;
  status?: PlanStatus;
  startedAt?: Date;
  expiresAt?: Date;
}

/**
 * Assign a plan to a tenant. Deactivates any existing active plans first.
 */
export async function assignPlan(params: AssignPlanParams): Promise<{
  id: string;
  tenantId: string;
  planId: string;
  status: string;
}> {
  if (!params.tenantId?.trim()) throw new Error("tenantId is required");
  if (!params.planId?.trim()) throw new Error("planId is required");

  // Cancel prior active/trial assignments
  await db.execute(drizzleSql`
    UPDATE tenant_plans
    SET status = 'cancelled', updated_at = NOW()
    WHERE tenant_id = ${params.tenantId} AND status IN ('active', 'trial')
  `);

  const rows = await db
    .insert(tenantPlans)
    .values({
      tenantId: params.tenantId,
      planId: params.planId,
      status: params.status ?? "active",
      startedAt: params.startedAt ?? new Date(),
      expiresAt: params.expiresAt ?? null,
    })
    .returning({ id: tenantPlans.id, tenantId: tenantPlans.tenantId, planId: tenantPlans.planId, status: tenantPlans.status });

  return rows[0];
}

/**
 * Start a trial for a tenant (time-limited plan access).
 */
export async function startTrial(
  tenantId: string,
  planId: string,
  trialDays: number = 14,
): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + trialDays * 86_400_000);
  const result = await assignPlan({ tenantId, planId, status: "trial", expiresAt });
  return { id: result.id, expiresAt };
}

/**
 * Upgrade a tenant to a new plan. Previous plan is cancelled.
 */
export async function upgradePlan(
  tenantId: string,
  newPlanId: string,
): Promise<{ id: string; previousStatus: string }> {
  const current = await getActivePlan(tenantId);
  const result = await assignPlan({ tenantId, planId: newPlanId, status: "active" });
  return { id: result.id, previousStatus: current?.status ?? "none" };
}

/**
 * Cancel a tenant's active plan.
 */
export async function cancelPlan(tenantId: string): Promise<{ cancelled: boolean; reason?: string }> {
  const current = await getActivePlan(tenantId);
  if (!current) return { cancelled: false, reason: "No active plan to cancel" };
  await db.execute(drizzleSql`
    UPDATE tenant_plans SET status = 'cancelled', updated_at = NOW()
    WHERE id = ${current.id as string}
  `);
  return { cancelled: true };
}

/**
 * Suspend a tenant plan (e.g., payment failure).
 */
export async function suspendPlan(tenantId: string): Promise<{ suspended: boolean }> {
  await db.execute(drizzleSql`
    UPDATE tenant_plans SET status = 'suspended', updated_at = NOW()
    WHERE tenant_id = ${tenantId} AND status = 'active'
  `);
  return { suspended: true };
}

/**
 * Reactivate a suspended plan.
 */
export async function reactivatePlan(tenantId: string): Promise<{ reactivated: boolean }> {
  await db.execute(drizzleSql`
    UPDATE tenant_plans SET status = 'active', updated_at = NOW()
    WHERE tenant_id = ${tenantId} AND status = 'suspended'
  `);
  return { reactivated: true };
}

/**
 * Expire trials that have passed their expiry date.
 */
export async function expireTrials(): Promise<{ expired: number }> {
  const result = await db.execute(drizzleSql`
    UPDATE tenant_plans SET status = 'expired', updated_at = NOW()
    WHERE status = 'trial' AND expires_at IS NOT NULL AND expires_at < NOW()
    RETURNING id
  `);
  return { expired: result.rows.length };
}

/**
 * Get the active plan record for a tenant.
 */
export async function getActivePlan(tenantId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT tp.id, tp.tenant_id, tp.plan_id, tp.status, tp.started_at, tp.expires_at,
           p.plan_key, p.name AS plan_name
    FROM tenant_plans tp
    JOIN plans p ON p.id = tp.plan_id
    WHERE tp.tenant_id = ${tenantId}
      AND tp.status IN ('active', 'trial')
    ORDER BY tp.started_at DESC
    LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

/**
 * Get full plan history for a tenant.
 */
export async function getPlanHistory(tenantId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.execute(drizzleSql`
    SELECT tp.id, tp.status, tp.started_at, tp.expires_at, p.plan_key, p.name AS plan_name
    FROM tenant_plans tp
    JOIN plans p ON p.id = tp.plan_id
    WHERE tp.tenant_id = ${tenantId}
    ORDER BY tp.started_at DESC
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * List all tenants with a given plan status.
 */
export async function listTenantsByStatus(
  status: PlanStatus,
  limit: number = 100,
): Promise<Array<{ tenantId: string; planKey: string; startedAt: Date; expiresAt: Date | null }>> {
  const rows = await db.execute(drizzleSql`
    SELECT tp.tenant_id, p.plan_key, tp.started_at, tp.expires_at
    FROM tenant_plans tp
    JOIN plans p ON p.id = tp.plan_id
    WHERE tp.status = ${status}
    ORDER BY tp.started_at DESC
    LIMIT ${Math.min(limit, 500)}
  `);
  return rows.rows.map((r: Record<string, unknown>) => ({
    tenantId: r.tenant_id as string,
    planKey: r.plan_key as string,
    startedAt: new Date(r.started_at as string),
    expiresAt: r.expires_at ? new Date(r.expires_at as string) : null,
  }));
}
