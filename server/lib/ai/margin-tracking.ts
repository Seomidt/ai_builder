/**
 * Margin Tracking Engine — Phase 4I
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Derives cost, revenue, and margin from ai_billing_usage canonical billing rows.
 * All values are derived from stored billing data — never recomputed from
 * current pricing configs.
 *
 * Derivation rules (per billing row):
 *   provider_cost_usd = ai_billing_usage.provider_cost_usd
 *   customer_price_usd = ai_billing_usage.customer_price_usd
 *   margin_usd = customer_price_usd - provider_cost_usd
 *   margin_pct = margin_usd / customer_price_usd  when customer_price_usd > 0, else null
 *
 * ANALYTICAL ONLY — not canonical financial truth.
 * ai_billing_usage remains the single source of truth for billing values.
 *
 * Period window: created_at >= periodStart AND created_at < periodEnd (exclusive end)
 */

import { eq, and, gte, lt, sql } from "drizzle-orm";
import { db } from "../../db";
import {
  aiBillingUsage,
  billingPeriods,
  marginTrackingRuns,
  marginTrackingSnapshots,
} from "@shared/schema";

// ─── Run Lifecycle ────────────────────────────────────────────────────────────

export async function createMarginTrackingRun(
  scopeType: "tenant" | "period" | "global",
  opts: { tenantId?: string | null; periodId?: string | null } = {},
): Promise<string> {
  const inserted = await db
    .insert(marginTrackingRuns)
    .values({
      scopeType,
      tenantId: opts.tenantId ?? null,
      periodId: opts.periodId ?? null,
      status: "running",
      totalBillingRows: 0,
      totalProviderCostUsd: "0",
      totalCustomerPriceUsd: "0",
      totalMarginUsd: "0",
    })
    .returning({ id: marginTrackingRuns.id });
  return inserted[0].id;
}

export async function markMarginTrackingRunCompleted(
  runId: string,
  totals: {
    totalBillingRows: number;
    totalProviderCostUsd: number;
    totalCustomerPriceUsd: number;
    totalMarginUsd: number;
  },
): Promise<void> {
  await db
    .update(marginTrackingRuns)
    .set({
      status: "completed",
      totalBillingRows: totals.totalBillingRows,
      totalProviderCostUsd: String(totals.totalProviderCostUsd),
      totalCustomerPriceUsd: String(totals.totalCustomerPriceUsd),
      totalMarginUsd: String(totals.totalMarginUsd),
      completedAt: new Date(),
    })
    .where(eq(marginTrackingRuns.id, runId));
}

export async function markMarginTrackingRunFailed(runId: string): Promise<void> {
  await db
    .update(marginTrackingRuns)
    .set({ status: "failed", completedAt: new Date() })
    .where(eq(marginTrackingRuns.id, runId));
}

// ─── Snapshot Write ───────────────────────────────────────────────────────────

export interface MarginSnapshotInput {
  runId: string;
  tenantId?: string | null;
  periodId?: string | null;
  feature?: string | null;
  provider?: string | null;
  model?: string | null;
  billingRowCount: number;
  providerCostUsd: number;
  customerPriceUsd: number;
  marginUsd: number;
  marginPct: number | null;
}

export async function recordMarginTrackingSnapshot(
  input: MarginSnapshotInput,
): Promise<string> {
  const inserted = await db
    .insert(marginTrackingSnapshots)
    .values({
      runId: input.runId,
      tenantId: input.tenantId ?? null,
      periodId: input.periodId ?? null,
      feature: input.feature ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      billingRowCount: input.billingRowCount,
      providerCostUsd: String(input.providerCostUsd),
      customerPriceUsd: String(input.customerPriceUsd),
      marginUsd: String(input.marginUsd),
      marginPct: input.marginPct != null ? String(input.marginPct) : null,
    })
    .returning({ id: marginTrackingSnapshots.id });
  return inserted[0].id;
}

// ─── Derivation Helper ────────────────────────────────────────────────────────

/**
 * Derive margin fields from stored billing values.
 * Uses canonical stored amounts — never recomputes from current pricing.
 */
export function deriveMarginFields(providerCostUsd: number, customerPriceUsd: number): {
  marginUsd: number;
  marginPct: number | null;
} {
  const marginUsd = customerPriceUsd - providerCostUsd;
  const marginPct = customerPriceUsd > 0 ? marginUsd / customerPriceUsd : null;
  return { marginUsd, marginPct };
}

// ─── Aggregation Helpers ──────────────────────────────────────────────────────

interface AggRow {
  tenantId: string | null;
  feature: string | null;
  provider: string | null;
  model: string | null;
  rowCount: string;
  totalProviderCost: string;
  totalCustomerPrice: string;
  totalMargin: string;
}

/**
 * Aggregate ai_billing_usage rows by (tenant, feature, provider, model)
 * for the given period window.
 *
 * Period window: created_at >= periodStart AND created_at < periodEnd
 */
async function aggregateBillingUsage(
  conditions: Parameters<typeof and>[0][],
): Promise<AggRow[]> {
  const rows = await db
    .select({
      tenantId: aiBillingUsage.tenantId,
      feature: aiBillingUsage.feature,
      provider: aiBillingUsage.provider,
      model: aiBillingUsage.model,
      rowCount: sql<string>`COUNT(*)`,
      totalProviderCost: sql<string>`COALESCE(SUM(provider_cost_usd::numeric), 0)`,
      totalCustomerPrice: sql<string>`COALESCE(SUM(customer_price_usd::numeric), 0)`,
      totalMargin: sql<string>`COALESCE(SUM(margin_usd::numeric), 0)`,
    })
    .from(aiBillingUsage)
    .where(and(...conditions))
    .groupBy(
      aiBillingUsage.tenantId,
      aiBillingUsage.feature,
      aiBillingUsage.provider,
      aiBillingUsage.model,
    );
  return rows as AggRow[];
}

// ─── Tenant Margin Tracking ───────────────────────────────────────────────────

/**
 * Aggregate and persist margin tracking data for one tenant over a time window.
 * Defaults to all time if no window provided.
 */
export async function runTenantMarginTracking(
  tenantId: string,
  periodStart?: Date,
  periodEnd?: Date,
): Promise<string> {
  const runId = await createMarginTrackingRun("tenant", { tenantId });
  try {
    const conditions: Parameters<typeof and>[0][] = [
      eq(aiBillingUsage.tenantId, tenantId),
    ];
    if (periodStart) conditions.push(gte(aiBillingUsage.createdAt, periodStart));
    if (periodEnd) conditions.push(lt(aiBillingUsage.createdAt, periodEnd));

    const rows = await aggregateBillingUsage(conditions);

    let totalBillingRows = 0;
    let totalProviderCost = 0;
    let totalCustomerPrice = 0;
    let totalMargin = 0;

    for (const row of rows) {
      const providerCost = Number(row.totalProviderCost);
      const customerPrice = Number(row.totalCustomerPrice);
      const margin = Number(row.totalMargin);
      const count = Number(row.rowCount);
      const { marginPct } = deriveMarginFields(providerCost, customerPrice);

      await recordMarginTrackingSnapshot({
        runId,
        tenantId,
        feature: row.feature,
        provider: row.provider,
        model: row.model,
        billingRowCount: count,
        providerCostUsd: providerCost,
        customerPriceUsd: customerPrice,
        marginUsd: margin,
        marginPct,
      });

      totalBillingRows += count;
      totalProviderCost += providerCost;
      totalCustomerPrice += customerPrice;
      totalMargin += margin;
    }

    await markMarginTrackingRunCompleted(runId, {
      totalBillingRows,
      totalProviderCostUsd: totalProviderCost,
      totalCustomerPriceUsd: totalCustomerPrice,
      totalMarginUsd: totalMargin,
    });

    return runId;
  } catch (err) {
    await markMarginTrackingRunFailed(runId);
    console.error("[ai/margin-tracking] runTenantMarginTracking failed:", err instanceof Error ? err.message : err);
    throw err;
  }
}

// ─── Period Margin Tracking ───────────────────────────────────────────────────

/**
 * Aggregate and persist margin tracking data for a specific billing period.
 * Uses the billing period's exact window (period_start, period_end).
 * Consistent with billing_period_tenant_snapshots period inclusion rule.
 */
export async function runPeriodMarginTracking(periodId: string): Promise<string> {
  // Load the billing period for its exact window
  const periods = await db
    .select()
    .from(billingPeriods)
    .where(eq(billingPeriods.id, periodId))
    .limit(1);

  if (periods.length === 0) {
    throw new Error(`[ai/margin-tracking] Billing period not found: ${periodId}`);
  }
  const period = periods[0];

  const runId = await createMarginTrackingRun("period", { periodId });
  try {
    const conditions: Parameters<typeof and>[0][] = [
      gte(aiBillingUsage.createdAt, period.periodStart),
      lt(aiBillingUsage.createdAt, period.periodEnd),
    ];

    const rows = await aggregateBillingUsage(conditions);

    let totalBillingRows = 0;
    let totalProviderCost = 0;
    let totalCustomerPrice = 0;
    let totalMargin = 0;

    for (const row of rows) {
      const providerCost = Number(row.totalProviderCost);
      const customerPrice = Number(row.totalCustomerPrice);
      const margin = Number(row.totalMargin);
      const count = Number(row.rowCount);
      const { marginPct } = deriveMarginFields(providerCost, customerPrice);

      await recordMarginTrackingSnapshot({
        runId,
        tenantId: row.tenantId,
        periodId,
        feature: row.feature,
        provider: row.provider,
        model: row.model,
        billingRowCount: count,
        providerCostUsd: providerCost,
        customerPriceUsd: customerPrice,
        marginUsd: margin,
        marginPct,
      });

      totalBillingRows += count;
      totalProviderCost += providerCost;
      totalCustomerPrice += customerPrice;
      totalMargin += margin;
    }

    await markMarginTrackingRunCompleted(runId, {
      totalBillingRows,
      totalProviderCostUsd: totalProviderCost,
      totalCustomerPriceUsd: totalCustomerPrice,
      totalMarginUsd: totalMargin,
    });

    return runId;
  } catch (err) {
    await markMarginTrackingRunFailed(runId);
    console.error("[ai/margin-tracking] runPeriodMarginTracking failed:", err instanceof Error ? err.message : err);
    throw err;
  }
}

// ─── Global Margin Tracking ───────────────────────────────────────────────────

/**
 * Aggregate and persist margin tracking data across all tenants over a window.
 * Defaults to all time if no window provided.
 */
export async function runGlobalMarginTracking(
  periodStart?: Date,
  periodEnd?: Date,
): Promise<string> {
  const runId = await createMarginTrackingRun("global");
  try {
    const conditions: Parameters<typeof and>[0][] = [];
    if (periodStart) conditions.push(gte(aiBillingUsage.createdAt, periodStart));
    if (periodEnd) conditions.push(lt(aiBillingUsage.createdAt, periodEnd));

    const rows = await aggregateBillingUsage(conditions);

    let totalBillingRows = 0;
    let totalProviderCost = 0;
    let totalCustomerPrice = 0;
    let totalMargin = 0;

    for (const row of rows) {
      const providerCost = Number(row.totalProviderCost);
      const customerPrice = Number(row.totalCustomerPrice);
      const margin = Number(row.totalMargin);
      const count = Number(row.rowCount);
      const { marginPct } = deriveMarginFields(providerCost, customerPrice);

      await recordMarginTrackingSnapshot({
        runId,
        tenantId: row.tenantId,
        feature: row.feature,
        provider: row.provider,
        model: row.model,
        billingRowCount: count,
        providerCostUsd: providerCost,
        customerPriceUsd: customerPrice,
        marginUsd: margin,
        marginPct,
      });

      totalBillingRows += count;
      totalProviderCost += providerCost;
      totalCustomerPrice += customerPrice;
      totalMargin += margin;
    }

    await markMarginTrackingRunCompleted(runId, {
      totalBillingRows,
      totalProviderCostUsd: totalProviderCost,
      totalCustomerPriceUsd: totalCustomerPrice,
      totalMarginUsd: totalMargin,
    });

    return runId;
  } catch (err) {
    await markMarginTrackingRunFailed(runId);
    console.error("[ai/margin-tracking] runGlobalMarginTracking failed:", err instanceof Error ? err.message : err);
    throw err;
  }
}
