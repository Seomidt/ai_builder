/**
 * AI Billing Summary
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Returns a backend-only billing summary for a given tenant.
 * Used for admin dashboards, internal reporting, and future Stripe metered billing sync.
 *
 * No public route is exposed here — callers are responsible for access control.
 * Phase 4A: foundation only. No Stripe sync, no invoice generation.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { aiBillingUsage } from "@shared/schema";

export interface AiBillingSummary {
  tenantId: string;
  totalProviderCostUsd: number;
  totalCustomerPriceUsd: number;
  totalMarginUsd: number;
  billedRequestCount: number;
  lastBilledAt: string | null;
}

/**
 * Return an aggregate billing summary for the given tenant.
 *
 * Sums over all ai_billing_usage rows for the tenant (no date filter applied here —
 * callers can extend with a date range if needed in future phases).
 *
 * Returns zeroed-out summary if the tenant has no billing rows.
 * Throws on DB error — callers should wrap in try/catch if fire-and-forget is needed.
 */
export async function getAiBillingSummary(tenantId: string): Promise<AiBillingSummary> {
  const rows = await db
    .select({
      totalProviderCostUsd: sql<string>`COALESCE(SUM(provider_cost_usd), 0)`,
      totalCustomerPriceUsd: sql<string>`COALESCE(SUM(customer_price_usd), 0)`,
      totalMarginUsd: sql<string>`COALESCE(SUM(margin_usd), 0)`,
      billedRequestCount: sql<number>`COUNT(*)::int`,
      lastBilledAt: sql<string | null>`MAX(created_at)`,
    })
    .from(aiBillingUsage)
    .where(eq(aiBillingUsage.tenantId, tenantId));

  const row = rows[0];

  return {
    tenantId,
    totalProviderCostUsd: Number(row?.totalProviderCostUsd ?? 0),
    totalCustomerPriceUsd: Number(row?.totalCustomerPriceUsd ?? 0),
    totalMarginUsd: Number(row?.totalMarginUsd ?? 0),
    billedRequestCount: Number(row?.billedRequestCount ?? 0),
    lastBilledAt: row?.lastBilledAt ?? null,
  };
}
