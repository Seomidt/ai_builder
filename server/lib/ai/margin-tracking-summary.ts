/**
 * Margin Tracking Summary — Phase 4I
 *
 * SERVER-ONLY: Read helpers for margin_tracking_runs and margin_tracking_snapshots.
 * Also provides direct analytical summaries from ai_billing_usage for ad-hoc queries.
 *
 * Backend-only — no UI. Designed for admin dashboards and billing analytics.
 *
 * Source of truth hierarchy:
 *   1. ai_billing_usage — canonical billing truth for individual rows
 *   2. billing_period_tenant_snapshots — canonical accounting truth for closed periods
 *   3. margin_tracking_snapshots — analytical summaries (rebuildable, not canonical)
 */

import { eq, and, gte, lt, desc, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  marginTrackingRuns,
  marginTrackingSnapshots,
  aiBillingUsage,
  billingPeriods,
  billingPeriodTenantSnapshots,
} from "@shared/schema";
import type { MarginTrackingRun, MarginTrackingSnapshot } from "@shared/schema";

// ─── Run & Snapshot Reads ─────────────────────────────────────────────────────

export async function getMarginTrackingRun(
  runId: string,
): Promise<MarginTrackingRun | null> {
  const rows = await db
    .select()
    .from(marginTrackingRuns)
    .where(eq(marginTrackingRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

export async function listMarginTrackingRuns(limit = 50): Promise<MarginTrackingRun[]> {
  return db
    .select()
    .from(marginTrackingRuns)
    .orderBy(desc(marginTrackingRuns.createdAt))
    .limit(limit);
}

export async function listMarginTrackingSnapshots(
  runId: string,
  limit = 200,
): Promise<MarginTrackingSnapshot[]> {
  return db
    .select()
    .from(marginTrackingSnapshots)
    .where(eq(marginTrackingSnapshots.runId, runId))
    .orderBy(desc(marginTrackingSnapshots.marginUsd))
    .limit(limit);
}

// ─── Ad-hoc Analytical Summaries ─────────────────────────────────────────────
// These query ai_billing_usage directly — always historically correct.

export interface MarginSummary {
  billingRowCount: number;
  totalProviderCostUsd: number;
  totalCustomerPriceUsd: number;
  totalMarginUsd: number;
  overallMarginPct: number | null;
}

function toMarginSummary(row: {
  rowCount: string;
  totalProviderCost: string;
  totalCustomerPrice: string;
  totalMargin: string;
}): MarginSummary {
  const providerCost = Number(row.totalProviderCost);
  const customerPrice = Number(row.totalCustomerPrice);
  const margin = Number(row.totalMargin);
  return {
    billingRowCount: Number(row.rowCount),
    totalProviderCostUsd: providerCost,
    totalCustomerPriceUsd: customerPrice,
    totalMarginUsd: margin,
    overallMarginPct: customerPrice > 0 ? margin / customerPrice : null,
  };
}

/**
 * Direct margin summary for a tenant over an optional time window.
 * Queries ai_billing_usage directly — always historically correct.
 */
export async function getTenantMarginSummary(
  tenantId: string,
  periodStart?: Date,
  periodEnd?: Date,
): Promise<MarginSummary> {
  const conditions: Parameters<typeof and>[0][] = [
    eq(aiBillingUsage.tenantId, tenantId),
  ];
  if (periodStart) conditions.push(gte(aiBillingUsage.createdAt, periodStart));
  if (periodEnd) conditions.push(lt(aiBillingUsage.createdAt, periodEnd));

  const [row] = await db
    .select({
      rowCount: sql<string>`COUNT(*)`,
      totalProviderCost: sql<string>`COALESCE(SUM(provider_cost_usd::numeric), 0)`,
      totalCustomerPrice: sql<string>`COALESCE(SUM(customer_price_usd::numeric), 0)`,
      totalMargin: sql<string>`COALESCE(SUM(margin_usd::numeric), 0)`,
    })
    .from(aiBillingUsage)
    .where(and(...conditions));

  return toMarginSummary(row!);
}

/**
 * Margin summary for a billing period using its exact window.
 * Also cross-references billing_period_tenant_snapshots for consistency check.
 */
export interface PeriodMarginSummary extends MarginSummary {
  periodId: string;
  periodStart: Date;
  periodEnd: Date;
  periodStatus: string;
  snapshotTotal: {
    providerCostUsd: number;
    customerPriceUsd: number;
    marginUsd: number;
  } | null;
}

export async function getPeriodMarginSummary(
  periodId: string,
): Promise<PeriodMarginSummary | null> {
  const periods = await db
    .select()
    .from(billingPeriods)
    .where(eq(billingPeriods.id, periodId))
    .limit(1);
  if (periods.length === 0) return null;
  const period = periods[0];

  const [billingAgg] = await db
    .select({
      rowCount: sql<string>`COUNT(*)`,
      totalProviderCost: sql<string>`COALESCE(SUM(provider_cost_usd::numeric), 0)`,
      totalCustomerPrice: sql<string>`COALESCE(SUM(customer_price_usd::numeric), 0)`,
      totalMargin: sql<string>`COALESCE(SUM(margin_usd::numeric), 0)`,
    })
    .from(aiBillingUsage)
    .where(
      and(
        gte(aiBillingUsage.createdAt, period.periodStart),
        lt(aiBillingUsage.createdAt, period.periodEnd),
      ),
    );

  // Cross-reference with closed-period snapshots
  const snapshots = await db
    .select({
      providerCostUsd: sql<string>`COALESCE(SUM(provider_cost_usd::numeric), 0)`,
      customerPriceUsd: sql<string>`COALESCE(SUM(customer_price_usd::numeric), 0)`,
      marginUsd: sql<string>`COALESCE(SUM(margin_usd::numeric), 0)`,
    })
    .from(billingPeriodTenantSnapshots)
    .where(eq(billingPeriodTenantSnapshots.billingPeriodId, periodId));

  const snapshotRow = snapshots[0];
  const snapshotTotal =
    snapshotRow && Number(snapshotRow.customerPriceUsd) > 0
      ? {
          providerCostUsd: Number(snapshotRow.providerCostUsd),
          customerPriceUsd: Number(snapshotRow.customerPriceUsd),
          marginUsd: Number(snapshotRow.marginUsd),
        }
      : null;

  const base = toMarginSummary(billingAgg!);
  return {
    ...base,
    periodId,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    periodStatus: period.status,
    snapshotTotal,
  };
}

/**
 * Global margin summary across all tenants over an optional time window.
 */
export async function getGlobalMarginSummary(
  periodStart?: Date,
  periodEnd?: Date,
): Promise<MarginSummary> {
  const conditions: Parameters<typeof and>[0][] = [];
  if (periodStart) conditions.push(gte(aiBillingUsage.createdAt, periodStart));
  if (periodEnd) conditions.push(lt(aiBillingUsage.createdAt, periodEnd));

  const [row] = await db
    .select({
      rowCount: sql<string>`COUNT(*)`,
      totalProviderCost: sql<string>`COALESCE(SUM(provider_cost_usd::numeric), 0)`,
      totalCustomerPrice: sql<string>`COALESCE(SUM(customer_price_usd::numeric), 0)`,
      totalMargin: sql<string>`COALESCE(SUM(margin_usd::numeric), 0)`,
    })
    .from(aiBillingUsage)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  return toMarginSummary(row!);
}

/**
 * Margin breakdown by provider + model over an optional time window.
 */
export interface ProviderModelMarginRow {
  provider: string | null;
  model: string | null;
  billingRowCount: number;
  totalProviderCostUsd: number;
  totalCustomerPriceUsd: number;
  totalMarginUsd: number;
  marginPct: number | null;
}

export async function getProviderModelMarginSummary(
  provider: string,
  model: string,
  periodStart?: Date,
  periodEnd?: Date,
): Promise<ProviderModelMarginRow | null> {
  const conditions: Parameters<typeof and>[0][] = [
    eq(aiBillingUsage.provider, provider),
    eq(aiBillingUsage.model, model),
  ];
  if (periodStart) conditions.push(gte(aiBillingUsage.createdAt, periodStart));
  if (periodEnd) conditions.push(lt(aiBillingUsage.createdAt, periodEnd));

  const [row] = await db
    .select({
      rowCount: sql<string>`COUNT(*)`,
      totalProviderCost: sql<string>`COALESCE(SUM(provider_cost_usd::numeric), 0)`,
      totalCustomerPrice: sql<string>`COALESCE(SUM(customer_price_usd::numeric), 0)`,
      totalMargin: sql<string>`COALESCE(SUM(margin_usd::numeric), 0)`,
    })
    .from(aiBillingUsage)
    .where(and(...conditions));

  if (!row || Number(row.rowCount) === 0) return null;

  const providerCost = Number(row.totalProviderCost);
  const customerPrice = Number(row.totalCustomerPrice);
  const margin = Number(row.totalMargin);
  return {
    provider,
    model,
    billingRowCount: Number(row.rowCount),
    totalProviderCostUsd: providerCost,
    totalCustomerPriceUsd: customerPrice,
    totalMarginUsd: margin,
    marginPct: customerPrice > 0 ? margin / customerPrice : null,
  };
}

/**
 * Margin breakdown by feature over an optional time window.
 */
export interface FeatureMarginRow {
  feature: string | null;
  billingRowCount: number;
  totalProviderCostUsd: number;
  totalCustomerPriceUsd: number;
  totalMarginUsd: number;
  marginPct: number | null;
}

export async function getFeatureMarginSummary(
  feature: string,
  periodStart?: Date,
  periodEnd?: Date,
): Promise<FeatureMarginRow | null> {
  const conditions: Parameters<typeof and>[0][] = [
    eq(aiBillingUsage.feature, feature),
  ];
  if (periodStart) conditions.push(gte(aiBillingUsage.createdAt, periodStart));
  if (periodEnd) conditions.push(lt(aiBillingUsage.createdAt, periodEnd));

  const [row] = await db
    .select({
      rowCount: sql<string>`COUNT(*)`,
      totalProviderCost: sql<string>`COALESCE(SUM(provider_cost_usd::numeric), 0)`,
      totalCustomerPrice: sql<string>`COALESCE(SUM(customer_price_usd::numeric), 0)`,
      totalMargin: sql<string>`COALESCE(SUM(margin_usd::numeric), 0)`,
    })
    .from(aiBillingUsage)
    .where(and(...conditions));

  if (!row || Number(row.rowCount) === 0) return null;

  const providerCost = Number(row.totalProviderCost);
  const customerPrice = Number(row.totalCustomerPrice);
  const margin = Number(row.totalMargin);
  return {
    feature,
    billingRowCount: Number(row.rowCount),
    totalProviderCostUsd: providerCost,
    totalCustomerPriceUsd: customerPrice,
    totalMarginUsd: margin,
    marginPct: customerPrice > 0 ? margin / customerPrice : null,
  };
}
