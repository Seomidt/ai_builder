/**
 * Billing Monitoring Summary — Phase 4Q
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Aggregated monitoring views for admin dashboards and health checks.
 * All helpers are read-only. No mutations.
 *
 * Summaries:
 *   - Invoice monitoring: by status, revenue, finalization rate
 *   - Payment monitoring: by status, success/failure rates
 *   - Subscription monitoring: distribution by status
 *   - Reconciliation monitoring: finding counts by severity
 *   - Allowance monitoring: included vs overage breakdown
 *   - Tenant monetization health: revenue, margin, wallet status
 *   - Global monetization health: platform-wide aggregation
 *
 * Design rules:
 *   A) Optional tenantId scopes all helpers to a single tenant when provided
 *   B) Optional windowStart/windowEnd filter by createdAt when provided
 *   C) All USD values are parseFloat'd Postgres numerics
 *   D) No pagination — summaries are aggregate rows only
 */

import { eq, and, gte, lt, sql, inArray } from "drizzle-orm";
import { db } from "../../db";
import {
  invoices,
  invoicePayments,
  tenantSubscriptions,
  providerReconciliationFindings,
  tenantAiAllowanceUsage,
  tenantStorageAllowanceUsage,
  aiBillingUsage,
  storageBillingUsage,
} from "@shared/schema";

// ─── Invoice Monitoring ───────────────────────────────────────────────────────

export interface InvoiceMonitoringSummary {
  tenantId?: string;
  windowStart?: string;
  windowEnd?: string;
  draftCount: number;
  finalizedCount: number;
  voidCount: number;
  totalFinalizedUsd: number;
  totalDraftUsd: number;
  finalizationRatePct: number | null;
}

export async function getInvoiceMonitoringSummary(
  windowStart?: Date,
  windowEnd?: Date,
  tenantId?: string,
): Promise<InvoiceMonitoringSummary> {
  const where = [
    ...(tenantId ? [eq(invoices.tenantId, tenantId)] : []),
    ...(windowStart ? [gte(invoices.createdAt, windowStart)] : []),
    ...(windowEnd ? [lt(invoices.createdAt, windowEnd)] : []),
  ];

  const rows = await db
    .select({
      draftCount: sql<number>`count(*) filter (where status = 'draft')::int`,
      finalizedCount: sql<number>`count(*) filter (where status = 'finalized')::int`,
      voidCount: sql<number>`count(*) filter (where status = 'void')::int`,
      totalFinalizedUsd: sql<string>`coalesce(sum(total_usd) filter (where status = 'finalized'), 0)`,
      totalDraftUsd: sql<string>`coalesce(sum(total_usd) filter (where status = 'draft'), 0)`,
      totalCount: sql<number>`count(*)::int`,
    })
    .from(invoices)
    .where(and(...where));

  const r = rows[0];
  const draftCount = r?.draftCount ?? 0;
  const finalizedCount = r?.finalizedCount ?? 0;
  const totalCount = r?.totalCount ?? 0;
  const finalizationRatePct = totalCount > 0 ? (finalizedCount / totalCount) * 100 : null;

  return {
    tenantId,
    windowStart: windowStart?.toISOString(),
    windowEnd: windowEnd?.toISOString(),
    draftCount,
    finalizedCount,
    voidCount: r?.voidCount ?? 0,
    totalFinalizedUsd: parseFloat(r?.totalFinalizedUsd ?? "0"),
    totalDraftUsd: parseFloat(r?.totalDraftUsd ?? "0"),
    finalizationRatePct,
  };
}

// ─── Payment Monitoring ───────────────────────────────────────────────────────

export interface PaymentMonitoringSummary {
  tenantId?: string;
  windowStart?: string;
  windowEnd?: string;
  pendingCount: number;
  processingCount: number;
  paidCount: number;
  failedCount: number;
  refundedCount: number;
  voidCount: number;
  totalPaidUsd: number;
  totalFailedUsd: number;
  totalRefundedUsd: number;
  successRatePct: number | null;
  failureRatePct: number | null;
}

export async function getPaymentMonitoringSummary(
  windowStart?: Date,
  windowEnd?: Date,
  tenantId?: string,
): Promise<PaymentMonitoringSummary> {
  const where = [
    ...(tenantId ? [eq(invoicePayments.tenantId, tenantId)] : []),
    ...(windowStart ? [gte(invoicePayments.createdAt, windowStart)] : []),
    ...(windowEnd ? [lt(invoicePayments.createdAt, windowEnd)] : []),
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
      totalRefundedUsd: sql<string>`coalesce(sum(amount_usd) filter (where payment_status = 'refunded'), 0)`,
      totalCount: sql<number>`count(*)::int`,
    })
    .from(invoicePayments)
    .where(and(...where));

  const r = rows[0];
  const paidCount = r?.paidCount ?? 0;
  const failedCount = r?.failedCount ?? 0;
  const totalCount = r?.totalCount ?? 0;

  return {
    tenantId,
    windowStart: windowStart?.toISOString(),
    windowEnd: windowEnd?.toISOString(),
    pendingCount: r?.pendingCount ?? 0,
    processingCount: r?.processingCount ?? 0,
    paidCount,
    failedCount,
    refundedCount: r?.refundedCount ?? 0,
    voidCount: r?.voidCount ?? 0,
    totalPaidUsd: parseFloat(r?.totalPaidUsd ?? "0"),
    totalFailedUsd: parseFloat(r?.totalFailedUsd ?? "0"),
    totalRefundedUsd: parseFloat(r?.totalRefundedUsd ?? "0"),
    successRatePct: totalCount > 0 ? (paidCount / totalCount) * 100 : null,
    failureRatePct: totalCount > 0 ? (failedCount / totalCount) * 100 : null,
  };
}

// ─── Subscription Monitoring ──────────────────────────────────────────────────

export interface SubscriptionMonitoringSummary {
  tenantId?: string;
  activeCount: number;
  trialingCount: number;
  pastDueCount: number;
  pausedCount: number;
  cancelledCount: number;
  totalCount: number;
  churnedPct: number | null;
  atRiskPct: number | null;
}

export async function getSubscriptionMonitoringSummary(
  tenantId?: string,
): Promise<SubscriptionMonitoringSummary> {
  const where = tenantId ? [eq(tenantSubscriptions.tenantId, tenantId)] : [];

  const rows = await db
    .select({
      activeCount: sql<number>`count(*) filter (where status = 'active')::int`,
      trialingCount: sql<number>`count(*) filter (where status = 'trialing')::int`,
      pastDueCount: sql<number>`count(*) filter (where status = 'past_due')::int`,
      pausedCount: sql<number>`count(*) filter (where status = 'paused')::int`,
      cancelledCount: sql<number>`count(*) filter (where status = 'cancelled')::int`,
      totalCount: sql<number>`count(*)::int`,
    })
    .from(tenantSubscriptions)
    .where(and(...where));

  const r = rows[0];
  const cancelledCount = r?.cancelledCount ?? 0;
  const pastDueCount = r?.pastDueCount ?? 0;
  const totalCount = r?.totalCount ?? 0;

  return {
    tenantId,
    activeCount: r?.activeCount ?? 0,
    trialingCount: r?.trialingCount ?? 0,
    pastDueCount,
    pausedCount: r?.pausedCount ?? 0,
    cancelledCount,
    totalCount,
    churnedPct: totalCount > 0 ? (cancelledCount / totalCount) * 100 : null,
    atRiskPct: totalCount > 0 ? (pastDueCount / totalCount) * 100 : null,
  };
}

// ─── Reconciliation Monitoring ────────────────────────────────────────────────

export interface ReconciliationMonitoringSummary {
  windowStart?: string;
  windowEnd?: string;
  infoCount: number;
  warningCount: number;
  criticalCount: number;
  totalCount: number;
  criticalRatePct: number | null;
}

export async function getReconciliationMonitoringSummary(
  windowStart?: Date,
  windowEnd?: Date,
): Promise<ReconciliationMonitoringSummary> {
  const where = [
    ...(windowStart ? [gte(providerReconciliationFindings.createdAt, windowStart)] : []),
    ...(windowEnd ? [lt(providerReconciliationFindings.createdAt, windowEnd)] : []),
  ];

  const rows = await db
    .select({
      infoCount: sql<number>`count(*) filter (where severity = 'info')::int`,
      warningCount: sql<number>`count(*) filter (where severity = 'warning')::int`,
      criticalCount: sql<number>`count(*) filter (where severity = 'critical')::int`,
      totalCount: sql<number>`count(*)::int`,
    })
    .from(providerReconciliationFindings)
    .where(and(...where));

  const r = rows[0];
  const criticalCount = r?.criticalCount ?? 0;
  const totalCount = r?.totalCount ?? 0;

  return {
    windowStart: windowStart?.toISOString(),
    windowEnd: windowEnd?.toISOString(),
    infoCount: r?.infoCount ?? 0,
    warningCount: r?.warningCount ?? 0,
    criticalCount,
    totalCount,
    criticalRatePct: totalCount > 0 ? (criticalCount / totalCount) * 100 : null,
  };
}

// ─── Allowance Monitoring ─────────────────────────────────────────────────────

export interface AllowanceMonitoringSummary {
  tenantId?: string;
  windowStart?: string;
  windowEnd?: string;
  aiIncludedAmountUsd: number;
  aiOverageAmountUsd: number;
  storageIncludedAmountUsd: number;
  storageOverageAmountUsd: number;
  totalIncludedAmountUsd: number;
  totalOverageAmountUsd: number;
  overageRatePct: number | null;
}

export async function getAllowanceMonitoringSummary(
  windowStart?: Date,
  windowEnd?: Date,
  tenantId?: string,
): Promise<AllowanceMonitoringSummary> {
  const aiWhere = [
    ...(tenantId ? [eq(aiBillingUsage.tenantId, tenantId)] : []),
    ...(windowStart ? [gte(aiBillingUsage.createdAt, windowStart)] : []),
    ...(windowEnd ? [lt(aiBillingUsage.createdAt, windowEnd)] : []),
  ];
  const stWhere = [
    ...(tenantId ? [eq(storageBillingUsage.tenantId, tenantId)] : []),
    ...(windowStart ? [gte(storageBillingUsage.createdAt, windowStart)] : []),
    ...(windowEnd ? [lt(storageBillingUsage.createdAt, windowEnd)] : []),
  ];

  const [aiRows, stRows] = await Promise.all([
    db
      .select({
        included: sql<string>`coalesce(sum(included_amount_usd), 0)`,
        overage: sql<string>`coalesce(sum(overage_amount_usd), 0)`,
      })
      .from(aiBillingUsage)
      .where(and(...aiWhere)),
    db
      .select({
        included: sql<string>`coalesce(sum(included_amount_usd), 0)`,
        overage: sql<string>`coalesce(sum(overage_amount_usd), 0)`,
      })
      .from(storageBillingUsage)
      .where(and(...stWhere)),
  ]);

  const aiIncluded = parseFloat(aiRows[0]?.included ?? "0");
  const aiOverage = parseFloat(aiRows[0]?.overage ?? "0");
  const stIncluded = parseFloat(stRows[0]?.included ?? "0");
  const stOverage = parseFloat(stRows[0]?.overage ?? "0");
  const totalIncluded = aiIncluded + stIncluded;
  const totalOverage = aiOverage + stOverage;
  const totalBilling = totalIncluded + totalOverage;

  return {
    tenantId,
    windowStart: windowStart?.toISOString(),
    windowEnd: windowEnd?.toISOString(),
    aiIncludedAmountUsd: aiIncluded,
    aiOverageAmountUsd: aiOverage,
    storageIncludedAmountUsd: stIncluded,
    storageOverageAmountUsd: stOverage,
    totalIncludedAmountUsd: totalIncluded,
    totalOverageAmountUsd: totalOverage,
    overageRatePct: totalBilling > 0 ? (totalOverage / totalBilling) * 100 : null,
  };
}

// ─── Tenant Monetization Health ───────────────────────────────────────────────

export interface TenantMonetizationHealthSummary {
  tenantId: string;
  windowStart: string;
  windowEnd: string;
  aiRevenueUsd: number;
  storageRevenueUsd: number;
  totalRevenueUsd: number;
  totalProviderCostUsd: number;
  totalMarginUsd: number;
  effectiveMarginPct: number | null;
  walletPendingCount: number;
  walletFailedCount: number;
  invoicesSummary: { draftCount: number; finalizedCount: number; totalFinalizedUsd: number };
  paymentsSummary: { paidCount: number; failedCount: number; totalPaidUsd: number };
}

export async function getTenantMonetizationHealthSummary(
  tenantId: string,
  windowStart: Date,
  windowEnd: Date,
): Promise<TenantMonetizationHealthSummary> {
  const [aiRows, stRows, invRows, payRows] = await Promise.all([
    db
      .select({
        revenue: sql<string>`coalesce(sum(customer_price_usd), 0)`,
        providerCost: sql<string>`coalesce(sum(provider_cost_usd), 0)`,
        margin: sql<string>`coalesce(sum(margin_usd), 0)`,
        walletPending: sql<number>`count(*) filter (where wallet_status = 'pending')::int`,
        walletFailed: sql<number>`count(*) filter (where wallet_status = 'failed')::int`,
      })
      .from(aiBillingUsage)
      .where(and(eq(aiBillingUsage.tenantId, tenantId), gte(aiBillingUsage.createdAt, windowStart), lt(aiBillingUsage.createdAt, windowEnd))),
    db
      .select({ revenue: sql<string>`coalesce(sum(customer_price_usd), 0)`, providerCost: sql<string>`coalesce(sum(provider_cost_usd), 0)` })
      .from(storageBillingUsage)
      .where(and(eq(storageBillingUsage.tenantId, tenantId), gte(storageBillingUsage.createdAt, windowStart), lt(storageBillingUsage.createdAt, windowEnd))),
    db
      .select({
        draftCount: sql<number>`count(*) filter (where status = 'draft')::int`,
        finalizedCount: sql<number>`count(*) filter (where status = 'finalized')::int`,
        totalFinalizedUsd: sql<string>`coalesce(sum(total_usd) filter (where status = 'finalized'), 0)`,
      })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), gte(invoices.createdAt, windowStart), lt(invoices.createdAt, windowEnd))),
    db
      .select({
        paidCount: sql<number>`count(*) filter (where payment_status = 'paid')::int`,
        failedCount: sql<number>`count(*) filter (where payment_status = 'failed')::int`,
        totalPaidUsd: sql<string>`coalesce(sum(amount_usd) filter (where payment_status = 'paid'), 0)`,
      })
      .from(invoicePayments)
      .where(and(eq(invoicePayments.tenantId, tenantId), gte(invoicePayments.createdAt, windowStart), lt(invoicePayments.createdAt, windowEnd))),
  ]);

  const aiRevenue = parseFloat(aiRows[0]?.revenue ?? "0");
  const stRevenue = parseFloat(stRows[0]?.revenue ?? "0");
  const totalRevenue = aiRevenue + stRevenue;
  const totalProviderCost = parseFloat(aiRows[0]?.providerCost ?? "0") + parseFloat(stRows[0]?.providerCost ?? "0");
  const totalMargin = parseFloat(aiRows[0]?.margin ?? "0");
  const effectiveMarginPct = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : null;

  return {
    tenantId,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    aiRevenueUsd: aiRevenue,
    storageRevenueUsd: stRevenue,
    totalRevenueUsd: totalRevenue,
    totalProviderCostUsd: totalProviderCost,
    totalMarginUsd: totalMargin,
    effectiveMarginPct,
    walletPendingCount: aiRows[0]?.walletPending ?? 0,
    walletFailedCount: aiRows[0]?.walletFailed ?? 0,
    invoicesSummary: {
      draftCount: invRows[0]?.draftCount ?? 0,
      finalizedCount: invRows[0]?.finalizedCount ?? 0,
      totalFinalizedUsd: parseFloat(invRows[0]?.totalFinalizedUsd ?? "0"),
    },
    paymentsSummary: {
      paidCount: payRows[0]?.paidCount ?? 0,
      failedCount: payRows[0]?.failedCount ?? 0,
      totalPaidUsd: parseFloat(payRows[0]?.totalPaidUsd ?? "0"),
    },
  };
}

// ─── Global Monetization Health ───────────────────────────────────────────────

export interface GlobalMonetizationHealthSummary {
  windowStart: string;
  windowEnd: string;
  aiRevenueUsd: number;
  storageRevenueUsd: number;
  totalRevenueUsd: number;
  totalProviderCostUsd: number;
  totalMarginUsd: number;
  effectiveMarginPct: number | null;
  walletPendingCount: number;
  walletFailedCount: number;
  invoicesSummary: { draftCount: number; finalizedCount: number; voidCount: number; totalFinalizedUsd: number };
  paymentsSummary: { paidCount: number; failedCount: number; totalPaidUsd: number; totalFailedUsd: number };
  subscriptionsSummary: { activeCount: number; trialingCount: number; pastDueCount: number };
}

export async function getGlobalMonetizationHealthSummary(
  windowStart: Date,
  windowEnd: Date,
): Promise<GlobalMonetizationHealthSummary> {
  const [aiRows, stRows, invRows, payRows, subRows] = await Promise.all([
    db
      .select({
        revenue: sql<string>`coalesce(sum(customer_price_usd), 0)`,
        providerCost: sql<string>`coalesce(sum(provider_cost_usd), 0)`,
        margin: sql<string>`coalesce(sum(margin_usd), 0)`,
        walletPending: sql<number>`count(*) filter (where wallet_status = 'pending')::int`,
        walletFailed: sql<number>`count(*) filter (where wallet_status = 'failed')::int`,
      })
      .from(aiBillingUsage)
      .where(and(gte(aiBillingUsage.createdAt, windowStart), lt(aiBillingUsage.createdAt, windowEnd))),
    db
      .select({ revenue: sql<string>`coalesce(sum(customer_price_usd), 0)`, providerCost: sql<string>`coalesce(sum(provider_cost_usd), 0)` })
      .from(storageBillingUsage)
      .where(and(gte(storageBillingUsage.createdAt, windowStart), lt(storageBillingUsage.createdAt, windowEnd))),
    db
      .select({
        draftCount: sql<number>`count(*) filter (where status = 'draft')::int`,
        finalizedCount: sql<number>`count(*) filter (where status = 'finalized')::int`,
        voidCount: sql<number>`count(*) filter (where status = 'void')::int`,
        totalFinalizedUsd: sql<string>`coalesce(sum(total_usd) filter (where status = 'finalized'), 0)`,
      })
      .from(invoices)
      .where(and(gte(invoices.createdAt, windowStart), lt(invoices.createdAt, windowEnd))),
    db
      .select({
        paidCount: sql<number>`count(*) filter (where payment_status = 'paid')::int`,
        failedCount: sql<number>`count(*) filter (where payment_status = 'failed')::int`,
        totalPaidUsd: sql<string>`coalesce(sum(amount_usd) filter (where payment_status = 'paid'), 0)`,
        totalFailedUsd: sql<string>`coalesce(sum(amount_usd) filter (where payment_status = 'failed'), 0)`,
      })
      .from(invoicePayments)
      .where(and(gte(invoicePayments.createdAt, windowStart), lt(invoicePayments.createdAt, windowEnd))),
    db
      .select({
        activeCount: sql<number>`count(*) filter (where status = 'active')::int`,
        trialingCount: sql<number>`count(*) filter (where status = 'trialing')::int`,
        pastDueCount: sql<number>`count(*) filter (where status = 'past_due')::int`,
      })
      .from(tenantSubscriptions),
  ]);

  const aiRevenue = parseFloat(aiRows[0]?.revenue ?? "0");
  const stRevenue = parseFloat(stRows[0]?.revenue ?? "0");
  const totalRevenue = aiRevenue + stRevenue;
  const totalProviderCost = parseFloat(aiRows[0]?.providerCost ?? "0") + parseFloat(stRows[0]?.providerCost ?? "0");
  const totalMargin = parseFloat(aiRows[0]?.margin ?? "0");
  const effectiveMarginPct = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : null;

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    aiRevenueUsd: aiRevenue,
    storageRevenueUsd: stRevenue,
    totalRevenueUsd: totalRevenue,
    totalProviderCostUsd: totalProviderCost,
    totalMarginUsd: totalMargin,
    effectiveMarginPct,
    walletPendingCount: aiRows[0]?.walletPending ?? 0,
    walletFailedCount: aiRows[0]?.walletFailed ?? 0,
    invoicesSummary: {
      draftCount: invRows[0]?.draftCount ?? 0,
      finalizedCount: invRows[0]?.finalizedCount ?? 0,
      voidCount: invRows[0]?.voidCount ?? 0,
      totalFinalizedUsd: parseFloat(invRows[0]?.totalFinalizedUsd ?? "0"),
    },
    paymentsSummary: {
      paidCount: payRows[0]?.paidCount ?? 0,
      failedCount: payRows[0]?.failedCount ?? 0,
      totalPaidUsd: parseFloat(payRows[0]?.totalPaidUsd ?? "0"),
      totalFailedUsd: parseFloat(payRows[0]?.totalFailedUsd ?? "0"),
    },
    subscriptionsSummary: {
      activeCount: subRows[0]?.activeCount ?? 0,
      trialingCount: subRows[0]?.trialingCount ?? 0,
      pastDueCount: subRows[0]?.pastDueCount ?? 0,
    },
  };
}
