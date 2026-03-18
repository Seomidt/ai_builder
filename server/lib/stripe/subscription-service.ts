/**
 * Phase 22 — Subscription Service
 * Manages Stripe subscription lifecycle + internal plan sync.
 */

import { db } from "../../db";
import { stripeSubscriptions } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";
import { stripeIds, getPlanAmount } from "./stripe-client";
import { upsertStripeCustomer } from "./customer-service";

/**
 * Get the active Stripe subscription for a tenant.
 */
export async function getStripeSubscription(tenantId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM stripe_subscriptions
    WHERE tenant_id = ${tenantId}
    ORDER BY created_at DESC LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

/**
 * Get a Stripe subscription by Stripe subscription ID.
 */
export async function getStripeSubscriptionByStripeId(stripeSubId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM stripe_subscriptions WHERE stripe_subscription_id = ${stripeSubId} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

/**
 * Create a new Stripe subscription record.
 * Also ensures the Stripe customer exists (upsert).
 */
export async function createStripeSubscription(params: {
  tenantId: string;
  planKey: string;
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
  email?: string;
  status?: string;
  currentPeriodEnd?: Date;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string; stripeSubscriptionId: string; tenantId: string }> {
  if (!params.tenantId?.trim()) throw new Error("tenantId is required");
  if (!params.planKey?.trim()) throw new Error("planKey is required");

  // Ensure Stripe customer exists
  const customer = await upsertStripeCustomer({
    tenantId: params.tenantId,
    email: params.email,
    stripeCustomerId: params.stripeCustomerId,
  });

  const subId = params.stripeSubscriptionId ?? stripeIds.subscription();
  const periodEnd = params.currentPeriodEnd ?? new Date(Date.now() + 30 * 24 * 3600 * 1000);

  const rows = await db.insert(stripeSubscriptions).values({
    tenantId: params.tenantId,
    stripeSubscriptionId: subId,
    stripeCustomerId: customer.stripeCustomerId,
    planKey: params.planKey,
    status: params.status ?? "active",
    currentPeriodStart: new Date(),
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd: false,
    metadata: params.metadata ?? null,
  }).returning({ id: stripeSubscriptions.id, stripeSubscriptionId: stripeSubscriptions.stripeSubscriptionId });

  // Sync to internal plan registry
  await syncPlanFromSubscription({ tenantId: params.tenantId, planKey: params.planKey, status: params.status ?? "active" });

  return { id: rows[0].id, stripeSubscriptionId: rows[0].stripeSubscriptionId, tenantId: params.tenantId };
}

/**
 * Update an existing subscription (status, plan, period).
 */
export async function updateStripeSubscription(stripeSubId: string, params: {
  planKey?: string;
  status?: string;
  currentPeriodEnd?: Date;
  cancelAtPeriodEnd?: boolean;
  canceledAt?: Date;
  metadata?: Record<string, unknown>;
}): Promise<{ updated: boolean; tenantId: string | null }> {
  const existing = await getStripeSubscriptionByStripeId(stripeSubId);
  if (!existing) return { updated: false, tenantId: null };

  await db.execute(drizzleSql`
    UPDATE stripe_subscriptions SET
      plan_key = ${params.planKey ?? (existing.plan_key as string)},
      status = ${params.status ?? (existing.status as string)},
      current_period_end = ${params.currentPeriodEnd ?? (existing.current_period_end as Date | null)},
      cancel_at_period_end = ${params.cancelAtPeriodEnd ?? (existing.cancel_at_period_end as boolean)},
      canceled_at = ${params.canceledAt ?? null},
      updated_at = NOW()
    WHERE stripe_subscription_id = ${stripeSubId}
  `);

  const tenantId = existing.tenant_id as string;

  // Sync plan change to internal registry
  if (params.planKey || params.status) {
    await syncPlanFromSubscription({
      tenantId,
      planKey: params.planKey ?? (existing.plan_key as string),
      status: params.status ?? (existing.status as string),
    });
  }

  return { updated: true, tenantId };
}

/**
 * Cancel a subscription (marks cancelAtPeriodEnd = true).
 */
export async function cancelStripeSubscription(stripeSubId: string): Promise<{ canceled: boolean; tenantId: string | null }> {
  const result = await updateStripeSubscription(stripeSubId, {
    cancelAtPeriodEnd: true,
    status: "canceled",
    canceledAt: new Date(),
  });
  return { canceled: result.updated, tenantId: result.tenantId };
}

/**
 * List all subscriptions for a tenant.
 */
export async function listStripeSubscriptions(tenantId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM stripe_subscriptions WHERE tenant_id = ${tenantId} ORDER BY created_at DESC
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * Sync internal tenant_plans when Stripe subscription changes.
 * Keeps internal plan registry in sync with Stripe state.
 */
export async function syncPlanFromSubscription(params: {
  tenantId: string;
  planKey: string;
  status: string;
}): Promise<{ synced: boolean }> {
  try {
    // Map Stripe status to internal status
    const internalStatus = mapStripeStatusToInternal(params.status);

    // Upsert into tenant_plans (Phase 20 table)
    const existing = await db.execute(drizzleSql`
      SELECT id FROM tenant_plans WHERE tenant_id = ${params.tenantId} ORDER BY created_at DESC LIMIT 1
    `);

    const planRow = await db.execute(drizzleSql`
      SELECT id FROM plans WHERE plan_key = ${params.planKey} LIMIT 1
    `);
    const planId = (planRow.rows[0] as Record<string, unknown>)?.id as string ?? null;

    if (!planId) return { synced: false };

    if (existing.rows.length > 0) {
      await db.execute(drizzleSql`
        UPDATE tenant_plans SET status = ${internalStatus}, plan_id = ${planId}, updated_at = NOW()
        WHERE tenant_id = ${params.tenantId}
      `);
    } else {
      await db.execute(drizzleSql`
        INSERT INTO tenant_plans (tenant_id, plan_id, status, created_at, updated_at)
        VALUES (${params.tenantId}, ${planId}, ${internalStatus}, NOW(), NOW())
        ON CONFLICT (tenant_id) DO UPDATE SET status = ${internalStatus}, plan_id = ${planId}, updated_at = NOW()
      `);
    }
    return { synced: true };
  } catch {
    return { synced: false };
  }
}

function mapStripeStatusToInternal(stripeStatus: string): string {
  const map: Record<string, string> = {
    "active":     "active",
    "trialing":   "trial",
    "canceled":   "cancelled",
    "past_due":   "suspended",
    "unpaid":     "suspended",
    "incomplete": "trial",
    "incomplete_expired": "expired",
  };
  return map[stripeStatus] ?? "active";
}

/**
 * Get subscription churn metrics (observability).
 */
export async function getSubscriptionChurnMetrics(): Promise<{
  totalActive: number;
  totalCanceled: number;
  totalPastDue: number;
  churnRate: number;
}> {
  const rows = await db.execute(drizzleSql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'active' OR status = 'trialing') AS total_active,
      COUNT(*) FILTER (WHERE status = 'canceled') AS total_canceled,
      COUNT(*) FILTER (WHERE status = 'past_due' OR status = 'unpaid') AS total_past_due,
      COUNT(*) AS total
    FROM stripe_subscriptions
  `);
  const r = rows.rows[0] as Record<string, unknown>;
  const total = Number(r.total ?? 0);
  const totalCanceled = Number(r.total_canceled ?? 0);
  return {
    totalActive: Number(r.total_active ?? 0),
    totalCanceled,
    totalPastDue: Number(r.total_past_due ?? 0),
    churnRate: total > 0 ? parseFloat((totalCanceled / total * 100).toFixed(2)) : 0,
  };
}

/**
 * Get revenue metrics across subscriptions (observability).
 */
export async function getRevenueMetrics(): Promise<{
  totalMrr: number;
  planBreakdown: Array<{ planKey: string; count: number; mrr: number }>;
}> {
  const rows = await db.execute(drizzleSql`
    SELECT plan_key, COUNT(*) AS sub_count
    FROM stripe_subscriptions
    WHERE status IN ('active', 'trialing')
    GROUP BY plan_key
  `);

  const planAmounts: Record<string, number> = {
    free: 0, starter: 2900, professional: 9900, enterprise: 49900,
  };

  let totalMrr = 0;
  const planBreakdown = rows.rows.map((r: Record<string, unknown>) => {
    const count = Number(r.sub_count ?? 0);
    const mrr = count * (planAmounts[r.plan_key as string] ?? 0);
    totalMrr += mrr;
    return { planKey: r.plan_key as string, count, mrr };
  });

  return { totalMrr, planBreakdown };
}
