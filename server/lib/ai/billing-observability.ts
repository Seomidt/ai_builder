/**
 * Billing Observability — Phase 4Q (extends Phase 4C foundation)
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Computes and persists billing metrics snapshots from canonical billing tables.
 * Snapshots are observability artifacts — NOT accounting truth.
 *
 * Design rules:
 *   A) All computations are read-only over canonical tables
 *   B) Snapshot creation is idempotent per (scopeType, scopeId, window)
 *   C) Failures persist a snapshot_status='failed' row (never silently drop)
 *   D) All USD values are numeric strings from Postgres — cast via parseFloat
 *   E) metrics JSONB is structured and typed — see BillingMetrics interface
 *   F) Phase 4C helpers (getBillingHealthSummary, getTenantBillingHealthSummary) preserved
 */

import { eq, sql, and, desc, gte, lt } from "drizzle-orm";
import { db } from "../../db";
import {
  aiBillingUsage,
  storageBillingUsage,
  invoices,
  invoicePayments,
  tenantSubscriptions,
  billingMetricsSnapshots,
} from "@shared/schema";
import type { BillingMetricsSnapshot } from "@shared/schema";

// ─── Phase 4C Legacy Types (preserved) ───────────────────────────────────────

export interface BillingHealthSummary {
  totalBillingRows: number;
  walletPendingCount: number;
  walletFailedCount: number;
  walletDebitedCount: number;
  latestFailedWalletDebitAt: string | null;
  latestFailedWalletDebitMessage: string | null;
  totalProviderCostUsd: number;
  totalCustomerPriceUsd: number;
  totalMarginUsd: number;
}

export interface TenantBillingHealthSummary extends BillingHealthSummary {
  tenantId: string;
}

// ─── Phase 4C: Global Summary ─────────────────────────────────────────────────

export async function getBillingHealthSummary(): Promise<BillingHealthSummary> {
  const [aggRow] = await db
    .select({
      totalBillingRows: sql<string>`COUNT(*)`,
      walletPendingCount: sql<string>`COUNT(*) FILTER (WHERE wallet_status = 'pending')`,
      walletFailedCount: sql<string>`COUNT(*) FILTER (WHERE wallet_status = 'failed')`,
      walletDebitedCount: sql<string>`COUNT(*) FILTER (WHERE wallet_status = 'debited')`,
      totalProviderCostUsd: sql<string>`COALESCE(SUM(provider_cost_usd), 0)`,
      totalCustomerPriceUsd: sql<string>`COALESCE(SUM(customer_price_usd), 0)`,
      totalMarginUsd: sql<string>`COALESCE(SUM(margin_usd), 0)`,
    })
    .from(aiBillingUsage);

  const latestFailed = await db
    .select({ createdAt: aiBillingUsage.createdAt, walletErrorMessage: aiBillingUsage.walletErrorMessage })
    .from(aiBillingUsage)
    .where(eq(aiBillingUsage.walletStatus, "failed"))
    .orderBy(desc(aiBillingUsage.createdAt))
    .limit(1);

  return {
    totalBillingRows: Number(aggRow?.totalBillingRows ?? 0),
    walletPendingCount: Number(aggRow?.walletPendingCount ?? 0),
    walletFailedCount: Number(aggRow?.walletFailedCount ?? 0),
    walletDebitedCount: Number(aggRow?.walletDebitedCount ?? 0),
    latestFailedWalletDebitAt: latestFailed[0]?.createdAt?.toISOString() ?? null,
    latestFailedWalletDebitMessage: latestFailed[0]?.walletErrorMessage ?? null,
    totalProviderCostUsd: Number(aggRow?.totalProviderCostUsd ?? 0),
    totalCustomerPriceUsd: Number(aggRow?.totalCustomerPriceUsd ?? 0),
    totalMarginUsd: Number(aggRow?.totalMarginUsd ?? 0),
  };
}

// ─── Phase 4C: Per-Tenant Summary ────────────────────────────────────────────

export async function getTenantBillingHealthSummary(
  tenantId: string,
): Promise<TenantBillingHealthSummary> {
  const [aggRow] = await db
    .select({
      totalBillingRows: sql<string>`COUNT(*)`,
      walletPendingCount: sql<string>`COUNT(*) FILTER (WHERE wallet_status = 'pending')`,
      walletFailedCount: sql<string>`COUNT(*) FILTER (WHERE wallet_status = 'failed')`,
      walletDebitedCount: sql<string>`COUNT(*) FILTER (WHERE wallet_status = 'debited')`,
      totalProviderCostUsd: sql<string>`COALESCE(SUM(provider_cost_usd), 0)`,
      totalCustomerPriceUsd: sql<string>`COALESCE(SUM(customer_price_usd), 0)`,
      totalMarginUsd: sql<string>`COALESCE(SUM(margin_usd), 0)`,
    })
    .from(aiBillingUsage)
    .where(eq(aiBillingUsage.tenantId, tenantId));

  const latestFailed = await db
    .select({ createdAt: aiBillingUsage.createdAt, walletErrorMessage: aiBillingUsage.walletErrorMessage })
    .from(aiBillingUsage)
    .where(and(eq(aiBillingUsage.tenantId, tenantId), eq(aiBillingUsage.walletStatus, "failed")))
    .orderBy(desc(aiBillingUsage.createdAt))
    .limit(1);

  return {
    tenantId,
    totalBillingRows: Number(aggRow?.totalBillingRows ?? 0),
    walletPendingCount: Number(aggRow?.walletPendingCount ?? 0),
    walletFailedCount: Number(aggRow?.walletFailedCount ?? 0),
    walletDebitedCount: Number(aggRow?.walletDebitedCount ?? 0),
    latestFailedWalletDebitAt: latestFailed[0]?.createdAt?.toISOString() ?? null,
    latestFailedWalletDebitMessage: latestFailed[0]?.walletErrorMessage ?? null,
    totalProviderCostUsd: Number(aggRow?.totalProviderCostUsd ?? 0),
    totalCustomerPriceUsd: Number(aggRow?.totalCustomerPriceUsd ?? 0),
    totalMarginUsd: Number(aggRow?.totalMarginUsd ?? 0),
  };
}

// ─── Phase 4Q: Structured Metrics Types ──────────────────────────────────────

export interface BillingMetrics {
  windowStart: string;
  windowEnd: string;
  ai: {
    rowCount: number;
    totalProviderCostUsd: number;
    totalCustomerPriceUsd: number;
    totalMarginUsd: number;
    totalIncludedAmountUsd: number;
    totalOverageAmountUsd: number;
    walletPendingCount: number;
    walletDebitedCount: number;
    walletFailedCount: number;
  };
  storage: {
    rowCount: number;
    totalProviderCostUsd: number;
    totalCustomerPriceUsd: number;
    totalMarginUsd: number;
    totalIncludedAmountUsd: number;
    totalOverageAmountUsd: number;
  };
  invoices: {
    draftCount: number;
    finalizedCount: number;
    voidCount: number;
    totalFinalizedUsd: number;
  };
  payments: {
    pendingCount: number;
    processingCount: number;
    paidCount: number;
    failedCount: number;
    refundedCount: number;
    voidCount: number;
    totalPaidUsd: number;
    totalFailedUsd: number;
  };
  subscriptions: {
    activeCount: number;
    trialingCount: number;
    pastDueCount: number;
    pausedCount: number;
    cancelledCount: number;
  };
}

// ─── Phase 4Q: Aggregation Helpers ───────────────────────────────────────────

async function aggregateAiBillingUsage(
  windowStart: Date,
  windowEnd: Date,
  tenantId?: string,
): Promise<BillingMetrics["ai"]> {
  const where = [
    gte(aiBillingUsage.createdAt, windowStart),
    lt(aiBillingUsage.createdAt, windowEnd),
    ...(tenantId ? [eq(aiBillingUsage.tenantId, tenantId)] : []),
  ];

  const rows = await db
    .select({
      rowCount: sql<number>`count(*)::int`,
      totalProviderCostUsd: sql<string>`coalesce(sum(provider_cost_usd), 0)`,
      totalCustomerPriceUsd: sql<string>`coalesce(sum(customer_price_usd), 0)`,
      totalMarginUsd: sql<string>`coalesce(sum(margin_usd), 0)`,
      totalIncludedAmountUsd: sql<string>`coalesce(sum(included_amount_usd), 0)`,
      totalOverageAmountUsd: sql<string>`coalesce(sum(overage_amount_usd), 0)`,
      walletPendingCount: sql<number>`count(*) filter (where wallet_status = 'pending')::int`,
      walletDebitedCount: sql<number>`count(*) filter (where wallet_status = 'debited')::int`,
      walletFailedCount: sql<number>`count(*) filter (where wallet_status = 'failed')::int`,
    })
    .from(aiBillingUsage)
    .where(and(...where));

  const r = rows[0];
  return {
    rowCount: r?.rowCount ?? 0,
    totalProviderCostUsd: parseFloat(r?.totalProviderCostUsd ?? "0"),
    totalCustomerPriceUsd: parseFloat(r?.totalCustomerPriceUsd ?? "0"),
    totalMarginUsd: parseFloat(r?.totalMarginUsd ?? "0"),
    totalIncludedAmountUsd: parseFloat(r?.totalIncludedAmountUsd ?? "0"),
    totalOverageAmountUsd: parseFloat(r?.totalOverageAmountUsd ?? "0"),
    walletPendingCount: r?.walletPendingCount ?? 0,
    walletDebitedCount: r?.walletDebitedCount ?? 0,
    walletFailedCount: r?.walletFailedCount ?? 0,
  };
}

async function aggregateStorageBillingUsage(
  windowStart: Date,
  windowEnd: Date,
  tenantId?: string,
): Promise<BillingMetrics["storage"]> {
  const where = [
    gte(storageBillingUsage.createdAt, windowStart),
    lt(storageBillingUsage.createdAt, windowEnd),
    ...(tenantId ? [eq(storageBillingUsage.tenantId, tenantId)] : []),
  ];

  const rows = await db
    .select({
      rowCount: sql<number>`count(*)::int`,
      totalProviderCostUsd: sql<string>`coalesce(sum(provider_cost_usd), 0)`,
      totalCustomerPriceUsd: sql<string>`coalesce(sum(customer_price_usd), 0)`,
      totalMarginUsd: sql<string>`coalesce(sum(margin_usd), 0)`,
      totalIncludedAmountUsd: sql<string>`coalesce(sum(included_amount_usd), 0)`,
      totalOverageAmountUsd: sql<string>`coalesce(sum(overage_amount_usd), 0)`,
    })
    .from(storageBillingUsage)
    .where(and(...where));

  const r = rows[0];
  return {
    rowCount: r?.rowCount ?? 0,
    totalProviderCostUsd: parseFloat(r?.totalProviderCostUsd ?? "0"),
    totalCustomerPriceUsd: parseFloat(r?.totalCustomerPriceUsd ?? "0"),
    totalMarginUsd: parseFloat(r?.totalMarginUsd ?? "0"),
    totalIncludedAmountUsd: parseFloat(r?.totalIncludedAmountUsd ?? "0"),
    totalOverageAmountUsd: parseFloat(r?.totalOverageAmountUsd ?? "0"),
  };
}

async function aggregateInvoiceMetrics(
  windowStart: Date,
  windowEnd: Date,
  tenantId?: string,
): Promise<BillingMetrics["invoices"]> {
  const where = [
    gte(invoices.createdAt, windowStart),
    lt(invoices.createdAt, windowEnd),
    ...(tenantId ? [eq(invoices.tenantId, tenantId)] : []),
  ];

  const rows = await db
    .select({
      draftCount: sql<number>`count(*) filter (where status = 'draft')::int`,
      finalizedCount: sql<number>`count(*) filter (where status = 'finalized')::int`,
      voidCount: sql<number>`count(*) filter (where status = 'void')::int`,
      totalFinalizedUsd: sql<string>`coalesce(sum(total_usd) filter (where status = 'finalized'), 0)`,
    })
    .from(invoices)
    .where(and(...where));

  const r = rows[0];
  return {
    draftCount: r?.draftCount ?? 0,
    finalizedCount: r?.finalizedCount ?? 0,
    voidCount: r?.voidCount ?? 0,
    totalFinalizedUsd: parseFloat(r?.totalFinalizedUsd ?? "0"),
  };
}

async function aggregatePaymentMetrics(
  windowStart: Date,
  windowEnd: Date,
  tenantId?: string,
): Promise<BillingMetrics["payments"]> {
  const where = [
    gte(invoicePayments.createdAt, windowStart),
    lt(invoicePayments.createdAt, windowEnd),
    ...(tenantId ? [eq(invoicePayments.tenantId, tenantId)] : []),
  ];

  const rows = await db
    .select({
      pendingCount: sql<number>`count(*) filter (where payment_status = 'pending')::int`,
      processingCount: sql<number>`count(*) filter (where payment_status = 'processing')::int`,
      paidCount: sql<number>`count(*) filter (where payment_status = 'paid')::int`,
      failedCount: sql<number>`count(*) filter (where payment_status = 'failed')::int`,
      refundedCount: sql<number>`count(*) filter (where payment_status = 'refunded')::int`,
      voidCount: sql<number>`count(*) filter (where payment_status = 'void')::int`,
      totalPaidUsd: sql<string>`coalesce(sum(amount_usd) filter (where payment_status = 'paid'), 0)`,
      totalFailedUsd: sql<string>`coalesce(sum(amount_usd) filter (where payment_status = 'failed'), 0)`,
    })
    .from(invoicePayments)
    .where(and(...where));

  const r = rows[0];
  return {
    pendingCount: r?.pendingCount ?? 0,
    processingCount: r?.processingCount ?? 0,
    paidCount: r?.paidCount ?? 0,
    failedCount: r?.failedCount ?? 0,
    refundedCount: r?.refundedCount ?? 0,
    voidCount: r?.voidCount ?? 0,
    totalPaidUsd: parseFloat(r?.totalPaidUsd ?? "0"),
    totalFailedUsd: parseFloat(r?.totalFailedUsd ?? "0"),
  };
}

async function aggregateSubscriptionMetrics(tenantId?: string): Promise<BillingMetrics["subscriptions"]> {
  const where = tenantId ? [eq(tenantSubscriptions.tenantId, tenantId)] : [];

  const rows = await db
    .select({
      activeCount: sql<number>`count(*) filter (where status = 'active')::int`,
      trialingCount: sql<number>`count(*) filter (where status = 'trialing')::int`,
      pastDueCount: sql<number>`count(*) filter (where status = 'past_due')::int`,
      pausedCount: sql<number>`count(*) filter (where status = 'paused')::int`,
      cancelledCount: sql<number>`count(*) filter (where status = 'cancelled')::int`,
    })
    .from(tenantSubscriptions)
    .where(and(...where));

  const r = rows[0];
  return {
    activeCount: r?.activeCount ?? 0,
    trialingCount: r?.trialingCount ?? 0,
    pastDueCount: r?.pastDueCount ?? 0,
    pausedCount: r?.pausedCount ?? 0,
    cancelledCount: r?.cancelledCount ?? 0,
  };
}

// ─── Phase 4Q: Snapshot Engine ────────────────────────────────────────────────

async function computeAndPersistSnapshot(
  scopeType: "global" | "tenant" | "billing_period",
  scopeId: string | null,
  windowStart: Date,
  windowEnd: Date,
  tenantId?: string,
): Promise<BillingMetricsSnapshot> {
  const pendingId = crypto.randomUUID();

  await db.insert(billingMetricsSnapshots).values({
    id: pendingId,
    scopeType,
    scopeId,
    metricWindowStart: windowStart,
    metricWindowEnd: windowEnd,
    metrics: {},
    snapshotStatus: "started",
  });

  try {
    const [aiMetrics, storageMetrics, invoiceMetrics, paymentMetrics, subscriptionMetrics] =
      await Promise.all([
        aggregateAiBillingUsage(windowStart, windowEnd, tenantId),
        aggregateStorageBillingUsage(windowStart, windowEnd, tenantId),
        aggregateInvoiceMetrics(windowStart, windowEnd, tenantId),
        aggregatePaymentMetrics(windowStart, windowEnd, tenantId),
        aggregateSubscriptionMetrics(tenantId),
      ]);

    const metrics: BillingMetrics = {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      ai: aiMetrics,
      storage: storageMetrics,
      invoices: invoiceMetrics,
      payments: paymentMetrics,
      subscriptions: subscriptionMetrics,
    };

    const [updated] = await db
      .update(billingMetricsSnapshots)
      .set({ metrics, snapshotStatus: "completed" })
      .where(eq(billingMetricsSnapshots.id, pendingId))
      .returning();

    return updated;
  } catch (err) {
    const [failed] = await db
      .update(billingMetricsSnapshots)
      .set({
        snapshotStatus: "failed",
        errorMessage: err instanceof Error ? err.message : String(err),
      })
      .where(eq(billingMetricsSnapshots.id, pendingId))
      .returning();
    return failed;
  }
}

export async function createGlobalBillingMetricsSnapshot(
  windowStart: Date,
  windowEnd: Date,
): Promise<BillingMetricsSnapshot> {
  return computeAndPersistSnapshot("global", null, windowStart, windowEnd);
}

export async function createTenantBillingMetricsSnapshot(
  tenantId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<BillingMetricsSnapshot> {
  return computeAndPersistSnapshot("tenant", tenantId, windowStart, windowEnd, tenantId);
}

export async function createBillingPeriodMetricsSnapshot(
  billingPeriodId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<BillingMetricsSnapshot> {
  return computeAndPersistSnapshot("billing_period", billingPeriodId, windowStart, windowEnd);
}

export async function getLatestGlobalBillingMetrics(): Promise<BillingMetricsSnapshot | null> {
  const rows = await db
    .select()
    .from(billingMetricsSnapshots)
    .where(
      and(
        eq(billingMetricsSnapshots.scopeType, "global"),
        eq(billingMetricsSnapshots.snapshotStatus, "completed"),
      ),
    )
    .orderBy(desc(billingMetricsSnapshots.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getLatestTenantBillingMetrics(
  tenantId: string,
): Promise<BillingMetricsSnapshot | null> {
  const rows = await db
    .select()
    .from(billingMetricsSnapshots)
    .where(
      and(
        eq(billingMetricsSnapshots.scopeType, "tenant"),
        eq(billingMetricsSnapshots.scopeId, tenantId),
        eq(billingMetricsSnapshots.snapshotStatus, "completed"),
      ),
    )
    .orderBy(desc(billingMetricsSnapshots.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function getLatestBillingPeriodMetrics(
  billingPeriodId: string,
): Promise<BillingMetricsSnapshot | null> {
  const rows = await db
    .select()
    .from(billingMetricsSnapshots)
    .where(
      and(
        eq(billingMetricsSnapshots.scopeType, "billing_period"),
        eq(billingMetricsSnapshots.scopeId, billingPeriodId),
        eq(billingMetricsSnapshots.snapshotStatus, "completed"),
      ),
    )
    .orderBy(desc(billingMetricsSnapshots.createdAt))
    .limit(1);
  return rows[0] ?? null;
}
