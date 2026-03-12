/**
 * Billing Observability Foundation
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Backend-only summary helpers for monetization health monitoring.
 * Intended for admin dashboards, cron diagnostics, and internal health checks.
 *
 * Phase 4C: foundation only. No external metrics system, no public API.
 * No UI. Wire to admin endpoints or cron diagnostics when needed.
 */

import { eq, sql, and, desc, isNotNull } from "drizzle-orm";
import { db } from "../../db";
import { aiBillingUsage } from "@shared/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface BillingHealthSummary {
  /** Total number of billing rows */
  totalBillingRows: number;
  /** Rows with wallet_status = 'pending' — not yet processed */
  walletPendingCount: number;
  /** Rows with wallet_status = 'failed' — need replay */
  walletFailedCount: number;
  /** Rows with wallet_status = 'debited' — successfully processed */
  walletDebitedCount: number;
  /** ISO timestamp of the most recent failed wallet debit, or null */
  latestFailedWalletDebitAt: string | null;
  /** Error message from the most recent failed wallet debit row, or null */
  latestFailedWalletDebitMessage: string | null;
  /** Sum of all provider_cost_usd across billing rows */
  totalProviderCostUsd: number;
  /** Sum of all customer_price_usd across billing rows */
  totalCustomerPriceUsd: number;
  /** Sum of all margin_usd across billing rows */
  totalMarginUsd: number;
}

export interface TenantBillingHealthSummary extends BillingHealthSummary {
  tenantId: string;
}

// ─── Global Summary ───────────────────────────────────────────────────────────

/**
 * Return a global billing health summary across all tenants.
 *
 * Runs a single aggregation query. For large tables, add a time window filter
 * at the call site or extend this function with optional date range parameters.
 *
 * Throws on DB error.
 */
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

  // Fetch latest failed wallet debit separately to get message
  const latestFailed = await db
    .select({
      createdAt: aiBillingUsage.createdAt,
      walletErrorMessage: aiBillingUsage.walletErrorMessage,
    })
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

// ─── Per-Tenant Summary ───────────────────────────────────────────────────────

/**
 * Return a billing health summary for a single tenant.
 *
 * Uses the (tenant_id, wallet_status, created_at) index for efficient filtering.
 * Throws on DB error.
 */
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
    .select({
      createdAt: aiBillingUsage.createdAt,
      walletErrorMessage: aiBillingUsage.walletErrorMessage,
    })
    .from(aiBillingUsage)
    .where(
      and(
        eq(aiBillingUsage.tenantId, tenantId),
        eq(aiBillingUsage.walletStatus, "failed"),
      ),
    )
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
