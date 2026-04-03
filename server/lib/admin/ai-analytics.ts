/**
 * ai-analytics.ts — Admin AI Analytics Queries
 *
 * SERVER-ONLY. Read-only analytics against ai_billing_usage and ai_usage.
 *
 * All functions:
 *  - Return typed result arrays
 *  - Never throw — errors are caught and returned as empty arrays
 *  - Support optional date range filtering (ISO strings)
 *  - Use ai_billing_usage as the authoritative billing source
 *    (providerCostUsd, customerPriceUsd, marginUsd)
 *
 * Three report dimensions:
 *   A. modelUsageSummary()   — per provider+model aggregates
 *   B. tenantUsageSummary()  — per tenant+model aggregates
 *   C. dailySpendSummary()   — per-day aggregates (newest first)
 */

import { sql } from "drizzle-orm";
import { db } from "../../db.ts";

// ── Shared date-range helper ───────────────────────────────────────────────────

/**
 * Builds a WHERE clause fragment for created_at range filtering.
 * Both from and to are optional. When both are absent, returns sql`` (no filter).
 */
function dateRangeClause(from?: string, to?: string) {
  if (from && to)   return sql`AND b.created_at >= ${from}::timestamptz AND b.created_at < ${to}::timestamptz`;
  if (from)         return sql`AND b.created_at >= ${from}::timestamptz`;
  if (to)           return sql`AND b.created_at < ${to}::timestamptz`;
  return sql``;
}

// ── A. Model Usage Summary ─────────────────────────────────────────────────────

export interface ModelUsageRow {
  provider:        string | null;
  model:           string | null;
  calls:           number;
  inputTokens:     number;
  outputTokens:    number;
  totalTokens:     number;
  providerCostUsd: string;
  customerRevUsd:  string;
  marginUsd:       string;
}

/**
 * Per-model aggregate: cost, revenue, margin, token counts.
 * Ordered by total provider cost descending.
 *
 * @param from  ISO date string (inclusive) — e.g. "2025-01-01"
 * @param to    ISO date string (exclusive) — e.g. "2025-02-01"
 */
export async function modelUsageSummary(from?: string, to?: string): Promise<ModelUsageRow[]> {
  try {
    const rows = await db.execute(sql`
      SELECT
        b.provider,
        b.model,
        COUNT(*)::integer                             AS calls,
        COALESCE(SUM(b.input_tokens_billable),  0)::integer  AS input_tokens,
        COALESCE(SUM(b.output_tokens_billable), 0)::integer  AS output_tokens,
        COALESCE(SUM(b.total_tokens_billable),  0)::integer  AS total_tokens,
        COALESCE(SUM(b.provider_cost_usd),  0)::text        AS provider_cost_usd,
        COALESCE(SUM(b.customer_price_usd), 0)::text        AS customer_rev_usd,
        COALESCE(SUM(b.margin_usd),         0)::text        AS margin_usd
      FROM ai_billing_usage b
      WHERE 1=1
      ${dateRangeClause(from, to)}
      GROUP BY b.provider, b.model
      ORDER BY SUM(b.provider_cost_usd) DESC NULLS LAST
    `);

    return (rows.rows as Record<string, unknown>[]).map((r) => ({
      provider:        String(r.provider ?? ""),
      model:           String(r.model ?? ""),
      calls:           Number(r.calls ?? 0),
      inputTokens:     Number(r.input_tokens ?? 0),
      outputTokens:    Number(r.output_tokens ?? 0),
      totalTokens:     Number(r.total_tokens ?? 0),
      providerCostUsd: String(r.provider_cost_usd ?? "0"),
      customerRevUsd:  String(r.customer_rev_usd ?? "0"),
      marginUsd:       String(r.margin_usd ?? "0"),
    }));
  } catch (err) {
    console.error("[ai-analytics] modelUsageSummary error:", (err as Error).message);
    return [];
  }
}

// ── B. Tenant Usage Summary ────────────────────────────────────────────────────

export interface TenantUsageRow {
  tenantId:        string;
  provider:        string | null;
  model:           string | null;
  calls:           number;
  inputTokens:     number;
  outputTokens:    number;
  providerCostUsd: string;
  customerRevUsd:  string;
  marginUsd:       string;
}

/**
 * Per-tenant, per-model breakdown.
 * Ordered by tenant_id, then provider cost descending.
 */
export async function tenantUsageSummary(
  tenantId?: string,
  from?: string,
  to?: string,
): Promise<TenantUsageRow[]> {
  try {
    const tenantFilter = tenantId ? sql`AND b.tenant_id = ${tenantId}` : sql``;

    const rows = await db.execute(sql`
      SELECT
        b.tenant_id,
        b.provider,
        b.model,
        COUNT(*)::integer                              AS calls,
        COALESCE(SUM(b.input_tokens_billable),  0)::integer  AS input_tokens,
        COALESCE(SUM(b.output_tokens_billable), 0)::integer  AS output_tokens,
        COALESCE(SUM(b.provider_cost_usd),  0)::text        AS provider_cost_usd,
        COALESCE(SUM(b.customer_price_usd), 0)::text        AS customer_rev_usd,
        COALESCE(SUM(b.margin_usd),         0)::text        AS margin_usd
      FROM ai_billing_usage b
      WHERE 1=1
      ${tenantFilter}
      ${dateRangeClause(from, to)}
      GROUP BY b.tenant_id, b.provider, b.model
      ORDER BY b.tenant_id, SUM(b.provider_cost_usd) DESC NULLS LAST
    `);

    return (rows.rows as Record<string, unknown>[]).map((r) => ({
      tenantId:        String(r.tenant_id ?? ""),
      provider:        String(r.provider ?? ""),
      model:           String(r.model ?? ""),
      calls:           Number(r.calls ?? 0),
      inputTokens:     Number(r.input_tokens ?? 0),
      outputTokens:    Number(r.output_tokens ?? 0),
      providerCostUsd: String(r.provider_cost_usd ?? "0"),
      customerRevUsd:  String(r.customer_rev_usd ?? "0"),
      marginUsd:       String(r.margin_usd ?? "0"),
    }));
  } catch (err) {
    console.error("[ai-analytics] tenantUsageSummary error:", (err as Error).message);
    return [];
  }
}

// ── C. Daily Spend Summary ─────────────────────────────────────────────────────

export interface DailySpendRow {
  day:             string;
  calls:           number;
  inputTokens:     number;
  outputTokens:    number;
  providerCostUsd: string;
  customerRevUsd:  string;
  marginUsd:       string;
}

/**
 * Day-by-day aggregate of cost, revenue, and margin.
 * Ordered by day descending (most recent first).
 *
 * @param days  How many calendar days to return (default: 30, max: 365)
 */
export async function dailySpendSummary(
  days   = 30,
  from?: string,
  to?:   string,
): Promise<DailySpendRow[]> {
  const safeDays = Math.min(Math.max(1, days), 365);

  try {
    // If explicit date range is provided, use it; otherwise use last N days
    const windowClause = from || to
      ? dateRangeClause(from, to)
      : sql`AND b.created_at >= (NOW() - (${String(safeDays)} || ' days')::interval)`;

    const rows = await db.execute(sql`
      SELECT
        DATE_TRUNC('day', b.created_at)::date::text  AS day,
        COUNT(*)::integer                              AS calls,
        COALESCE(SUM(b.input_tokens_billable),  0)::integer  AS input_tokens,
        COALESCE(SUM(b.output_tokens_billable), 0)::integer  AS output_tokens,
        COALESCE(SUM(b.provider_cost_usd),  0)::text        AS provider_cost_usd,
        COALESCE(SUM(b.customer_price_usd), 0)::text        AS customer_rev_usd,
        COALESCE(SUM(b.margin_usd),         0)::text        AS margin_usd
      FROM ai_billing_usage b
      WHERE 1=1
      ${windowClause}
      GROUP BY DATE_TRUNC('day', b.created_at)
      ORDER BY DATE_TRUNC('day', b.created_at) DESC
    `);

    return (rows.rows as Record<string, unknown>[]).map((r) => ({
      day:             String(r.day ?? ""),
      calls:           Number(r.calls ?? 0),
      inputTokens:     Number(r.input_tokens ?? 0),
      outputTokens:    Number(r.output_tokens ?? 0),
      providerCostUsd: String(r.provider_cost_usd ?? "0"),
      customerRevUsd:  String(r.customer_rev_usd ?? "0"),
      marginUsd:       String(r.margin_usd ?? "0"),
    }));
  } catch (err) {
    console.error("[ai-analytics] dailySpendSummary error:", (err as Error).message);
    return [];
  }
}
