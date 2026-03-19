/**
 * Phase 20 — Plans Service
 * CRUD for SaaS plan definitions and feature entitlements.
 */

import { db } from "../../db";
import { plans, planFeatures } from "@shared/schema";
import { eq, sql as drizzleSql } from "drizzle-orm";

export const BUILT_IN_PLANS = ["free", "starter", "professional", "enterprise"] as const;
export type BuiltInPlan = (typeof BUILT_IN_PLANS)[number];

export interface CreatePlanParams {
  planKey: string;
  name: string;
  description?: string;
  priceMonthly?: number;
  priceYearly?: number;
  active?: boolean;
}

export interface SetPlanFeatureParams {
  planId: string;
  featureKey: string;
  enabled: boolean;
  metadata?: Record<string, unknown>;
}

export async function createPlan(params: CreatePlanParams): Promise<{ id: string; planKey: string }> {
  if (!params.planKey?.trim()) throw new Error("planKey is required");
  if (!params.name?.trim()) throw new Error("name is required");

  const rows = await db
    .insert(plans)
    .values({
      planKey: params.planKey.trim().toLowerCase(),
      name: params.name.trim(),
      description: params.description ?? null,
      priceMonthly: Math.max(0, params.priceMonthly ?? 0),
      priceYearly: Math.max(0, params.priceYearly ?? 0),
      active: params.active ?? true,
    })
    .returning({ id: plans.id, planKey: plans.planKey });
  return rows[0];
}

export async function getPlan(planId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM plans WHERE id = ${planId} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

export async function getPlanByKey(planKey: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM plans WHERE plan_key = ${planKey.toLowerCase()} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

export async function listPlans(filter?: { active?: boolean }): Promise<Array<Record<string, unknown>>> {
  const activeClause = filter?.active !== undefined ? drizzleSql`WHERE active = ${filter.active}` : drizzleSql``;
  const rows = await db.execute(drizzleSql`
    SELECT id, plan_key, name, description, price_monthly, price_yearly, active, created_at
    FROM plans ${activeClause} ORDER BY price_monthly ASC
  `);
  return rows.rows as Record<string, unknown>[];
}

export async function deactivatePlan(planId: string): Promise<{ deactivated: boolean }> {
  await db.execute(drizzleSql`
    UPDATE plans SET active = false, updated_at = NOW() WHERE id = ${planId}
  `);
  return { deactivated: true };
}

export async function setPlanFeature(params: SetPlanFeatureParams): Promise<{ id: string }> {
  // Upsert: delete existing then insert
  await db.execute(drizzleSql`
    DELETE FROM plan_features WHERE plan_id = ${params.planId} AND feature_key = ${params.featureKey}
  `);
  const rows = await db
    .insert(planFeatures)
    .values({
      planId: params.planId,
      featureKey: params.featureKey,
      enabled: params.enabled,
      metadata: (params.metadata ?? null) as Record<string, unknown> | null,
    })
    .returning({ id: planFeatures.id });
  return rows[0];
}

export async function listPlanFeatures(planId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM plan_features WHERE plan_id = ${planId} ORDER BY feature_key ASC
  `);
  return rows.rows as Record<string, unknown>[];
}

export async function comparePlans(planIdA: string, planIdB: string): Promise<{
  planA: Record<string, unknown> | null;
  planB: Record<string, unknown> | null;
  onlyInA: string[];
  onlyInB: string[];
  inBoth: string[];
}> {
  const [planA, planB, featA, featB] = await Promise.all([
    getPlan(planIdA),
    getPlan(planIdB),
    listPlanFeatures(planIdA),
    listPlanFeatures(planIdB),
  ]);

  const keysA = new Set(featA.filter((f) => f.enabled).map((f) => f.feature_key as string));
  const keysB = new Set(featB.filter((f) => f.enabled).map((f) => f.feature_key as string));

  return {
    planA,
    planB,
    onlyInA: [...keysA].filter((k) => !keysB.has(k)),
    onlyInB: [...keysB].filter((k) => !keysA.has(k)),
    inBoth: [...keysA].filter((k) => keysB.has(k)),
  };
}
