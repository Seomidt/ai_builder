/**
 * Billing Period Tenant Snapshots
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides snapshot generation, reading, and the full period close flow.
 *
 * Snapshot design:
 *   - Immutable per-tenant summary records derived from ai_billing_usage
 *   - One row per (billing_period_id, tenant_id) — UNIQUE constraint enforced at DB level
 *   - Generated only during period close flow
 *   - Never mutated or deleted after creation (immutability is by convention + UNIQUE guard)
 *   - Only tenants with actual usage in the period receive a snapshot row
 *
 * Snapshot source of truth (all amounts come from ai_billing_usage — the canonical ledger):
 *   provider_cost_usd   ← SUM(provider_cost_usd)  WHERE created_at IN [period_start, period_end)
 *   customer_price_usd  ← SUM(customer_price_usd) WHERE created_at IN [period_start, period_end)
 *   margin_usd          ← SUM(margin_usd)          WHERE created_at IN [period_start, period_end)
 *   request_count       ← COUNT(*)                 WHERE created_at IN [period_start, period_end)
 *   debited_amount_usd  ← SUM(customer_price_usd) WHERE wallet_status = 'debited'
 *                         (wallet debit metadata only — billing amounts still from ai_billing_usage)
 *
 * Period inclusion rule:
 *   ai_billing_usage.created_at >= period_start
 *   AND ai_billing_usage.created_at < period_end
 *   [inclusive start, exclusive end — consistent throughout]
 *
 * Immutability policy:
 *   No UPDATE or DELETE functions are provided.
 *   The UNIQUE(billing_period_id, tenant_id) constraint prevents duplicate creation.
 *   Application code must never modify existing snapshot rows.
 *   Closed periods must never be reopened.
 *
 * Reporting rule:
 *   open period  → read from live ai_billing_usage (via getBillingDataSourceForPeriod)
 *   closed period → read from billing_period_tenant_snapshots (via getBillingDataSourceForPeriod)
 *
 * Phase 5: foundation only. No invoice generation. No Stripe integration.
 */

import { eq, and, sql, gte, lt, desc } from "drizzle-orm";
import { db } from "../../db";
import {
  billingPeriods,
  billingPeriodTenantSnapshots,
  aiBillingUsage,
} from "@shared/schema";
import type { BillingPeriod, BillingPeriodTenantSnapshot } from "@shared/schema";
import {
  getBillingPeriodById,
  markBillingPeriodClosing,
  markBillingPeriodClosed,
  restoreBillingPeriodToOpen,
  BillingPeriodError,
} from "./billing-periods";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TenantAggregateRow {
  tenantId: string;
  providerCostUsd: string;
  customerPriceUsd: string;
  marginUsd: string;
  requestCount: number;
  debitedAmountUsd: string;
}

export interface PeriodSummary {
  periodId: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  tenantCount: number;
  totalProviderCostUsd: number;
  totalCustomerPriceUsd: number;
  totalMarginUsd: number;
  totalRequestCount: number;
  totalDebitedAmountUsd: number;
  closedAt: string | null;
}

export type BillingDataSource = "live_billing_usage" | "closed_snapshots";

// ─── Snapshot Source Aggregation ──────────────────────────────────────────────

/**
 * Aggregate ai_billing_usage rows for a period window, grouped by tenant_id.
 *
 * Period inclusion rule (consistent throughout the system):
 *   created_at >= period_start AND created_at < period_end
 *
 * Returns only tenants with at least one billing row in the period.
 * Zero-usage tenants are excluded.
 *
 * This is the canonical aggregation used both for snapshot creation and
 * for live open-period reporting.
 */
export async function aggregateBillingUsageForPeriod(
  periodStart: Date,
  periodEnd: Date,
): Promise<TenantAggregateRow[]> {
  const rows = await db
    .select({
      tenantId: aiBillingUsage.tenantId,
      providerCostUsd: sql<string>`COALESCE(SUM(provider_cost_usd), 0)`,
      customerPriceUsd: sql<string>`COALESCE(SUM(customer_price_usd), 0)`,
      marginUsd: sql<string>`COALESCE(SUM(margin_usd), 0)`,
      requestCount: sql<number>`COUNT(*)::integer`,
      debitedAmountUsd: sql<string>`COALESCE(SUM(CASE WHEN wallet_status = 'debited' THEN customer_price_usd ELSE 0 END), 0)`,
    })
    .from(aiBillingUsage)
    .where(
      and(
        gte(aiBillingUsage.createdAt, periodStart),
        lt(aiBillingUsage.createdAt, periodEnd),
      ),
    )
    .groupBy(aiBillingUsage.tenantId);

  return rows as TenantAggregateRow[];
}

// ─── Snapshot Creation ────────────────────────────────────────────────────────

/**
 * Generate and insert tenant snapshots for a billing period.
 *
 * Called by closeBillingPeriod() — do not call directly in normal operations.
 *
 * Idempotency:
 *   Uses ON CONFLICT DO NOTHING on the UNIQUE(billing_period_id, tenant_id) constraint.
 *   Safe to call multiple times — will not create duplicate rows.
 *   Returns the number of newly inserted rows.
 *
 * Only inserts rows for tenants with actual usage — no zero-padding.
 *
 * @returns number of snapshot rows inserted
 */
export async function createTenantBillingSnapshots(periodId: string): Promise<number> {
  const period = await getBillingPeriodById(periodId);
  if (!period) {
    throw new BillingPeriodError(
      `Cannot create snapshots: billing period not found: ${periodId}`,
      "period_not_found",
    );
  }

  const aggregates = await aggregateBillingUsageForPeriod(period.periodStart, period.periodEnd);

  if (aggregates.length === 0) {
    console.info(`[billing-period-snapshots] No usage found for period ${periodId} — no snapshots created`);
    return 0;
  }

  const values = aggregates.map((row) => ({
    billingPeriodId: periodId,
    tenantId: row.tenantId,
    providerCostUsd: row.providerCostUsd,
    customerPriceUsd: row.customerPriceUsd,
    marginUsd: row.marginUsd,
    requestCount: row.requestCount,
    debitedAmountUsd: row.debitedAmountUsd,
  }));

  const inserted = await db
    .insert(billingPeriodTenantSnapshots)
    .values(values)
    .onConflictDoNothing()
    .returning({ id: billingPeriodTenantSnapshots.id });

  const insertedCount = inserted.length;
  const skippedCount = aggregates.length - insertedCount;

  console.info(
    `[billing-period-snapshots] Period ${periodId}: inserted ${insertedCount} snapshots`,
    skippedCount > 0 ? `(${skippedCount} already existed, skipped)` : "",
  );

  return insertedCount;
}

// ─── Period Close Flow ────────────────────────────────────────────────────────

/**
 * Close a billing period safely.
 *
 * This is the main entry point for the period close flow.
 *
 * Full lifecycle:
 *   1. Validate period exists
 *   2. Validate period status is 'open' — rejects already-closed or closing periods
 *   3. Transition to 'closing'
 *   4. Generate tenant snapshots (idempotent via ON CONFLICT DO NOTHING)
 *   5. Transition to 'closed' + set closed_at
 *
 * Failure safety:
 *   If snapshot generation fails, restores period to 'open' before throwing.
 *   Period will never be left in 'closing' after a call to closeBillingPeriod().
 *
 * Idempotency:
 *   - Calling on an already-closed period throws BillingPeriodError (does not duplicate data).
 *   - Snapshot creation is idempotent via UNIQUE constraint — retry after partial failure is safe.
 *
 * Returns the count of newly inserted snapshot rows.
 * Throws BillingPeriodError on validation failures.
 * Throws on unexpected DB errors.
 */
export async function closeBillingPeriod(periodId: string): Promise<{ snapshotsCreated: number }> {
  // Step 1+2: Validate period exists and is open
  const period = await getBillingPeriodById(periodId);
  if (!period) {
    throw new BillingPeriodError(
      `Cannot close billing period: not found: ${periodId}`,
      "period_not_found",
    );
  }
  if (period.status === "closed") {
    throw new BillingPeriodError(
      `Billing period ${periodId} is already closed`,
      "already_closed",
    );
  }
  if (period.status === "closing") {
    throw new BillingPeriodError(
      `Billing period ${periodId} is already in 'closing' state — resume or check for stuck close`,
      "already_closing",
    );
  }
  if (period.status !== "open") {
    throw new BillingPeriodError(
      `Billing period ${periodId} has unexpected status: ${period.status}`,
      "invalid_status",
    );
  }

  // Step 3: Transition to 'closing'
  await markBillingPeriodClosing(periodId);

  // Steps 4+5+6: Generate snapshots, then close
  let snapshotsCreated = 0;
  try {
    snapshotsCreated = await createTenantBillingSnapshots(periodId);
    await markBillingPeriodClosed(periodId);

    console.info(
      `[billing-period-snapshots] Period ${periodId} closed successfully.`,
      `Snapshots created: ${snapshotsCreated}`,
    );
  } catch (err) {
    // Restore to 'open' — period must not be left stuck in 'closing'
    await restoreBillingPeriodToOpen(periodId);
    console.error(
      `[billing-period-snapshots] Close failed for period ${periodId} — restored to 'open':`,
      err instanceof Error ? err.message : err,
    );
    throw err;
  }

  return { snapshotsCreated };
}

// ─── Read Helpers ─────────────────────────────────────────────────────────────

/**
 * Return the tenant snapshot for a specific (period, tenant) pair.
 *
 * Returns null if no snapshot exists for this combination.
 * Use for closed periods only — open periods should aggregate from live billing usage.
 */
export async function getTenantBillingSnapshot(
  periodId: string,
  tenantId: string,
): Promise<BillingPeriodTenantSnapshot | null> {
  const rows = await db
    .select()
    .from(billingPeriodTenantSnapshots)
    .where(
      and(
        eq(billingPeriodTenantSnapshots.billingPeriodId, periodId),
        eq(billingPeriodTenantSnapshots.tenantId, tenantId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

/**
 * Return all tenant snapshots for a billing period, ordered by customer_price_usd descending.
 *
 * Use for closed periods only.
 */
export async function listBillingPeriodTenantSnapshots(
  periodId: string,
  limit = 200,
): Promise<BillingPeriodTenantSnapshot[]> {
  return db
    .select()
    .from(billingPeriodTenantSnapshots)
    .where(eq(billingPeriodTenantSnapshots.billingPeriodId, periodId))
    .orderBy(desc(billingPeriodTenantSnapshots.customerPriceUsd))
    .limit(limit);
}

/**
 * Return a summary for a billing period.
 *
 * For open periods: aggregates from live ai_billing_usage.
 * For closed periods: aggregates from billing_period_tenant_snapshots.
 *
 * This is the central reporting entry point that enforces the open/closed
 * reporting rule.
 */
export async function getBillingPeriodSummary(periodId: string): Promise<PeriodSummary | null> {
  const period = await getBillingPeriodById(periodId);
  if (!period) return null;

  let tenantCount = 0;
  let totalProviderCostUsd = 0;
  let totalCustomerPriceUsd = 0;
  let totalMarginUsd = 0;
  let totalRequestCount = 0;
  let totalDebitedAmountUsd = 0;

  if (period.status === "closed") {
    // Closed period: read from immutable snapshots
    const [agg] = await db
      .select({
        tenantCount: sql<string>`COUNT(*)`,
        totalProviderCostUsd: sql<string>`COALESCE(SUM(provider_cost_usd), 0)`,
        totalCustomerPriceUsd: sql<string>`COALESCE(SUM(customer_price_usd), 0)`,
        totalMarginUsd: sql<string>`COALESCE(SUM(margin_usd), 0)`,
        totalRequestCount: sql<string>`COALESCE(SUM(request_count), 0)`,
        totalDebitedAmountUsd: sql<string>`COALESCE(SUM(debited_amount_usd), 0)`,
      })
      .from(billingPeriodTenantSnapshots)
      .where(eq(billingPeriodTenantSnapshots.billingPeriodId, periodId));

    tenantCount = Number(agg?.tenantCount ?? 0);
    totalProviderCostUsd = Number(agg?.totalProviderCostUsd ?? 0);
    totalCustomerPriceUsd = Number(agg?.totalCustomerPriceUsd ?? 0);
    totalMarginUsd = Number(agg?.totalMarginUsd ?? 0);
    totalRequestCount = Number(agg?.totalRequestCount ?? 0);
    totalDebitedAmountUsd = Number(agg?.totalDebitedAmountUsd ?? 0);
  } else {
    // Open (or closing) period: aggregate from live billing usage
    const aggregates = await aggregateBillingUsageForPeriod(period.periodStart, period.periodEnd);

    tenantCount = aggregates.length;
    for (const row of aggregates) {
      totalProviderCostUsd += Number(row.providerCostUsd);
      totalCustomerPriceUsd += Number(row.customerPriceUsd);
      totalMarginUsd += Number(row.marginUsd);
      totalRequestCount += row.requestCount;
      totalDebitedAmountUsd += Number(row.debitedAmountUsd);
    }
  }

  return {
    periodId: period.id,
    periodStart: period.periodStart.toISOString(),
    periodEnd: period.periodEnd.toISOString(),
    status: period.status,
    tenantCount,
    totalProviderCostUsd,
    totalCustomerPriceUsd,
    totalMarginUsd,
    totalRequestCount,
    totalDebitedAmountUsd,
    closedAt: period.closedAt?.toISOString() ?? null,
  };
}

// ─── Reporting Rule Helper ────────────────────────────────────────────────────

/**
 * Return the correct billing data source for a period — open vs closed.
 *
 * This function makes the reporting rule explicit and unambiguous for all
 * future invoice/reporting work:
 *
 *   "live_billing_usage"  → aggregate from ai_billing_usage (open periods)
 *   "closed_snapshots"    → read from billing_period_tenant_snapshots (closed periods)
 *
 * Callers must respect this rule. Reading live usage for closed periods would
 * produce historically unstable results as new billing rows arrive.
 *
 * Returns null if the period is not found.
 */
export async function getBillingDataSourceForPeriod(
  periodId: string,
): Promise<{ source: BillingDataSource; period: BillingPeriod } | null> {
  const period = await getBillingPeriodById(periodId);
  if (!period) return null;

  const source: BillingDataSource =
    period.status === "closed" ? "closed_snapshots" : "live_billing_usage";

  return { source, period };
}
