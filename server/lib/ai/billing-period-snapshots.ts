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
  storageBillingUsage,
} from "@shared/schema";
import type { BillingPeriod, BillingPeriodTenantSnapshot } from "@shared/schema";
import {
  getBillingPeriodById,
  lockBillingPeriodRow,
  markBillingPeriodClosingTx,
  markBillingPeriodClosedTx,
  restoreBillingPeriodToOpenTx,
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
  // Phase 4O: allowance classification totals
  aiIncludedAmountUsd: string;
  aiOverageAmountUsd: string;
}

export interface TenantStorageAllowanceRow {
  tenantId: string;
  storageIncludedAmountUsd: string;
  storageOverageAmountUsd: string;
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
      // Phase 4O: allowance classification totals from inline columns
      aiIncludedAmountUsd: sql<string>`COALESCE(SUM(included_amount_usd), 0)`,
      aiOverageAmountUsd: sql<string>`COALESCE(SUM(overage_amount_usd), 0)`,
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

/**
 * Aggregate storage_billing_usage included/overage amounts for a period window, grouped by tenant_id.
 * Phase 4O: used alongside aggregateBillingUsageForPeriod to populate snapshot storage allowance fields.
 */
export async function aggregateStorageAllowanceForPeriod(
  periodStart: Date,
  periodEnd: Date,
): Promise<TenantStorageAllowanceRow[]> {
  const rows = await db
    .select({
      tenantId: storageBillingUsage.tenantId,
      storageIncludedAmountUsd: sql<string>`COALESCE(SUM(included_amount_usd), 0)`,
      storageOverageAmountUsd: sql<string>`COALESCE(SUM(overage_amount_usd), 0)`,
    })
    .from(storageBillingUsage)
    .where(
      and(
        gte(storageBillingUsage.createdAt, periodStart),
        lt(storageBillingUsage.createdAt, periodEnd),
      ),
    )
    .groupBy(storageBillingUsage.tenantId);

  return rows as TenantStorageAllowanceRow[];
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

  const [aggregates, storageAllowances] = await Promise.all([
    aggregateBillingUsageForPeriod(period.periodStart, period.periodEnd),
    aggregateStorageAllowanceForPeriod(period.periodStart, period.periodEnd),
  ]);

  if (aggregates.length === 0) {
    console.info(`[billing-period-snapshots] No usage found for period ${periodId} — no snapshots created`);
    return 0;
  }

  // Build a lookup map for storage allowance rows — O(1) per tenant during values construction.
  const storageAllowanceByTenant = new Map(
    storageAllowances.map((r) => [r.tenantId, r]),
  );

  const values = aggregates.map((row) => {
    const storageRow = storageAllowanceByTenant.get(row.tenantId);
    return {
      billingPeriodId: periodId,
      tenantId: row.tenantId,
      providerCostUsd: row.providerCostUsd,
      customerPriceUsd: row.customerPriceUsd,
      marginUsd: row.marginUsd,
      requestCount: row.requestCount,
      debitedAmountUsd: row.debitedAmountUsd,
      // Phase 4O: allowance classification totals
      aiIncludedAmountUsd: row.aiIncludedAmountUsd,
      aiOverageAmountUsd: row.aiOverageAmountUsd,
      storageIncludedAmountUsd: storageRow?.storageIncludedAmountUsd ?? "0",
      storageOverageAmountUsd: storageRow?.storageOverageAmountUsd ?? "0",
    };
  });

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
 * Close a billing period safely with concurrency protection.
 *
 * This is the main entry point for the period close flow.
 *
 * Full lifecycle (Phase 4D.1 — concurrency-safe):
 *
 *   Phase 1 (within a transaction with SELECT FOR UPDATE row lock):
 *     1. Lock the billing period row — serializes concurrent close attempts
 *     2. Validate status is 'open' — rejects already-closed/closing periods
 *     3. Transition to 'closing' within the transaction
 *     4. Commit — releases row lock
 *
 *   Phase 2 (outside transaction — idempotent):
 *     5. Generate tenant snapshots (ON CONFLICT DO NOTHING)
 *
 *   Phase 3 (within a second transaction with SELECT FOR UPDATE):
 *     6. Lock the row again — verify still 'closing'
 *     7. Transition to 'closed' + set closed_at
 *     8. Commit
 *
 * Concurrency guarantee:
 *   Two parallel calls with the same periodId will serialize at the Phase 1 lock.
 *   The second caller will find status='closing' (or 'closed') and throw immediately.
 *   Snapshot inserts are idempotent via UNIQUE constraint — no duplicate rows possible.
 *
 * Failure safety:
 *   If snapshot generation fails (between Phase 1 and Phase 3), Phase 3 recovery
 *   transaction restores the period to 'open' so it can be retried cleanly.
 *
 * Throws BillingPeriodError on:
 *   - period not found
 *   - period is not 'open' (already_closed, already_closing)
 * Throws on unexpected DB errors (snapshot generation, lock acquisition).
 */
export async function closeBillingPeriod(periodId: string): Promise<{ snapshotsCreated: number }> {
  // ── Phase 1: Lock row, validate, claim 'closing' ─────────────────────────
  //
  // SELECT FOR UPDATE serializes concurrent close attempts.
  // Only one caller can hold the row lock at a time.
  // The second caller blocks here, then sees the updated status after Phase 1 commits.
  await db.transaction(async (tx) => {
    const period = await lockBillingPeriodRow(tx, periodId);

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
        `Billing period ${periodId} is already in 'closing' state — another worker may be closing it`,
        "already_closing",
      );
    }
    if (period.status !== "open") {
      throw new BillingPeriodError(
        `Billing period ${periodId} has unexpected status: ${period.status}`,
        "invalid_status",
      );
    }

    // Transition to 'closing' within the same transaction (atomic with the lock check)
    await markBillingPeriodClosingTx(tx, periodId);
  });
  // Phase 1 transaction committed — row lock released.
  // Any concurrent caller now sees status='closing' and will throw 'already_closing'.

  // ── Phase 2: Generate snapshots (idempotent, outside transaction) ─────────
  //
  // Snapshot inserts use ON CONFLICT DO NOTHING — safe under retries.
  // If this fails, Phase 3 recovery restores the period to 'open'.
  let snapshotsCreated = 0;
  try {
    snapshotsCreated = await createTenantBillingSnapshots(periodId);
  } catch (snapshotErr) {
    // Snapshot generation failed — restore period to 'open' in a recovery transaction
    console.error(
      `[billing-period-snapshots] Snapshot generation failed for period ${periodId} — attempting recovery:`,
      snapshotErr instanceof Error ? snapshotErr.message : snapshotErr,
    );
    await db.transaction(async (tx) => {
      // Lock the row to safely check state before restoring
      const period = await lockBillingPeriodRow(tx, periodId);
      if (period && period.status === "closing") {
        await restoreBillingPeriodToOpenTx(tx, periodId);
      } else {
        console.error(
          `[billing-period-snapshots] Cannot restore period ${periodId} — unexpected status: ${period?.status}`,
        );
      }
    });
    throw snapshotErr;
  }

  // ── Phase 3: Lock row again, verify still 'closing', mark 'closed' ────────
  await db.transaction(async (tx) => {
    const period = await lockBillingPeriodRow(tx, periodId);

    if (!period) {
      throw new BillingPeriodError(`Period ${periodId} disappeared after snapshot generation`, "period_not_found");
    }
    if (period.status !== "closing") {
      // This should never happen in normal operation — only if a concurrent process
      // has interfered beyond the Phase 1 lock. Log and throw.
      throw new BillingPeriodError(
        `Period ${periodId} is no longer 'closing' before final close — status is '${period.status}'`,
        "unexpected_status_before_close",
      );
    }

    await markBillingPeriodClosedTx(tx, periodId);
  });

  console.info(
    `[billing-period-snapshots] Period ${periodId} closed successfully. Snapshots created: ${snapshotsCreated}`,
  );

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
