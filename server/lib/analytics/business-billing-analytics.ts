/**
 * Phase 35 — Business & Billing Analytics
 *
 * Sources: tenants, tenant_subscriptions, tenant_plans, invoices,
 *          invoice_payments, tenant_credit_accounts, tenant_credit_ledger
 *
 * All functions are read-only and fail-open.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

export interface BusinessBillingSummary {
  tenants: {
    total: number;
    active: number;
    trial: number;
    suspended: number;
    deleted: number;
  };
  subscriptions: {
    active: number;
    canceled: number;
    pastDue: number;
  };
  invoices: {
    total: number;
    finalized: number;
    draft: number;
    totalRevenue: number;
    avgInvoiceValue: number;
  };
  payments: {
    total: number;
    succeeded: number;
    failed: number;
    successRate: number;
  };
  mrrEstimateUsd: number;
  topRevenueByTenant: { tenantId: string; totalUsd: number }[];
  retrievedAt: string;
  windowHours: number;
}

export interface BusinessBillingTrend {
  points: {
    bucket: string;
    newTenants: number;
    newInvoices: number;
    revenueUsd: number;
  }[];
  windowHours: number;
}

export async function getBusinessBillingSummary(
  windowHours = 720,
): Promise<BusinessBillingSummary> {
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();

  const [tenantRow, subRow, invoiceRow, paymentRow, topRevenueRow] = await Promise.all([
    db.execute<any>(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE lifecycle_status = 'active')::int    AS active,
        COUNT(*) FILTER (WHERE lifecycle_status = 'trial')::int     AS trial,
        COUNT(*) FILTER (WHERE lifecycle_status = 'suspended')::int AS suspended,
        COUNT(*) FILTER (WHERE lifecycle_status = 'deleted')::int   AS deleted
      FROM tenants
    `),
    db.execute<any>(sql`
      SELECT
        COUNT(*) FILTER (WHERE status = 'active')::int   AS active,
        COUNT(*) FILTER (WHERE status = 'canceled')::int AS canceled,
        COUNT(*) FILTER (WHERE status = 'past_due')::int AS past_due
      FROM tenant_subscriptions
    `).catch(() => ({ rows: [{}] })),
    db.execute<any>(sql`
      SELECT
        COUNT(*)::int                                              AS total,
        COUNT(*) FILTER (WHERE status = 'finalized')::int         AS finalized,
        COUNT(*) FILTER (WHERE status = 'draft')::int             AS draft,
        COALESCE(SUM(total_usd) FILTER (WHERE status = 'finalized'),0)::float AS revenue,
        AVG(total_usd) FILTER (WHERE status = 'finalized')::float AS avg_value
      FROM invoices
      WHERE created_at >= ${since}::timestamp
    `).catch(() => ({ rows: [{}] })),
    db.execute<any>(sql`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded,
        COUNT(*) FILTER (WHERE status = 'failed')::int    AS failed
      FROM invoice_payments
      WHERE created_at >= ${since}::timestamp
    `).catch(() => ({ rows: [{}] })),
    db.execute<any>(sql`
      SELECT tenant_id,
             COALESCE(SUM(total_usd),0)::float AS total_usd
      FROM invoices
      WHERE status = 'finalized'
        AND created_at >= ${since}::timestamp
      GROUP BY tenant_id
      ORDER BY total_usd DESC
      LIMIT 10
    `).catch(() => ({ rows: [] })),
  ]);

  const t = tenantRow.rows[0]  ?? {};
  const s = subRow.rows[0]     ?? {};
  const i = invoiceRow.rows[0] ?? {};
  const p = paymentRow.rows[0] ?? {};

  const pTotal     = Number(p.total     ?? 0);
  const pSucceeded = Number(p.succeeded ?? 0);

  // MRR estimate: finalized invoices in last 30 days / (windowHours / 720)
  const monthFraction = windowHours / 720;
  const mrrEst = monthFraction > 0
    ? Math.round(Number(i.revenue ?? 0) / monthFraction * 100) / 100 : 0;

  return {
    tenants: {
      total:     Number(t.total     ?? 0),
      active:    Number(t.active    ?? 0),
      trial:     Number(t.trial     ?? 0),
      suspended: Number(t.suspended ?? 0),
      deleted:   Number(t.deleted   ?? 0),
    },
    subscriptions: {
      active:   Number(s.active   ?? 0),
      canceled: Number(s.canceled ?? 0),
      pastDue:  Number(s.past_due ?? 0),
    },
    invoices: {
      total:           Number(i.total     ?? 0),
      finalized:       Number(i.finalized ?? 0),
      draft:           Number(i.draft     ?? 0),
      totalRevenue:    Math.round(Number(i.revenue   ?? 0) * 100) / 100,
      avgInvoiceValue: Math.round(Number(i.avg_value ?? 0) * 100) / 100,
    },
    payments: {
      total:       pTotal,
      succeeded:   pSucceeded,
      failed:      Number(p.failed ?? 0),
      successRate: pTotal > 0 ? Math.round(pSucceeded / pTotal * 10000) / 100 : 100,
    },
    mrrEstimateUsd: mrrEst,
    topRevenueByTenant: (topRevenueRow.rows as any[]).map(r => ({
      tenantId: r.tenant_id,
      totalUsd: Math.round(Number(r.total_usd) * 100) / 100,
    })),
    retrievedAt: new Date().toISOString(),
    windowHours,
  };
}

export async function getBusinessBillingTrend(
  windowHours = 720,
): Promise<BusinessBillingTrend> {
  const since = new Date(Date.now() - windowHours * 3600 * 1000).toISOString();
  const granularity = windowHours > 168 ? "day" : "hour";

  const [tenantTrend, invoiceTrend] = await Promise.all([
    db.execute<any>(sql.raw(`
      SELECT
        TO_CHAR(DATE_TRUNC('${granularity}', created_at), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
        COUNT(*)::int AS new_tenants
      FROM tenants
      WHERE created_at >= '${since}'::timestamp
      GROUP BY 1 ORDER BY 1
    `)),
    db.execute<any>(sql.raw(`
      SELECT
        TO_CHAR(DATE_TRUNC('${granularity}', created_at), 'YYYY-MM-DD"T"HH24:MI') AS bucket,
        COUNT(*)::int AS new_invoices,
        COALESCE(SUM(total_usd) FILTER (WHERE status = 'finalized'),0)::float AS revenue_usd
      FROM invoices
      WHERE created_at >= '${since}'::timestamp
      GROUP BY 1 ORDER BY 1
    `)).catch(() => ({ rows: [] })),
  ]);

  const tMap = new Map((tenantTrend.rows as any[]).map(r => [r.bucket, Number(r.new_tenants)]));
  const iMap = new Map((invoiceTrend.rows as any[]).map(r => [r.bucket, { inv: Number(r.new_invoices), rev: Number(r.revenue_usd) }]));
  const buckets = Array.from(new Set([
    ...Array.from(tMap.keys()),
    ...Array.from(iMap.keys()),
  ])).sort();

  return {
    points: buckets.map(b => ({
      bucket:      b,
      newTenants:  tMap.get(b) ?? 0,
      newInvoices: iMap.get(b)?.inv ?? 0,
      revenueUsd:  Math.round((iMap.get(b)?.rev ?? 0) * 100) / 100,
    })),
    windowHours,
  };
}

export function explainBusinessBilling(summary: BusinessBillingSummary): {
  summary: string; issues: string[]; recommendations: string[];
} {
  const issues: string[] = [];
  const recs: string[]   = [];

  if (summary.subscriptions.pastDue > 0)
    issues.push(`${summary.subscriptions.pastDue} subscription(s) past due`);
  if (summary.payments.successRate < 90)
    issues.push(`Payment success rate ${summary.payments.successRate}% below 90%`);
  if (summary.tenants.suspended > 0)
    issues.push(`${summary.tenants.suspended} tenant(s) suspended`);

  if (summary.subscriptions.pastDue > 0) recs.push("Follow up on past-due subscriptions");
  if (summary.payments.failed > 0) recs.push("Retry or investigate failed payments");
  if (summary.tenants.suspended > 0) recs.push("Review suspended tenants for account status");
  if (recs.length === 0) recs.push("Billing metrics are healthy");

  return {
    summary: `${summary.tenants.active} active tenants, MRR estimate $${summary.mrrEstimateUsd.toFixed(2)}`,
    issues,
    recommendations: recs,
  };
}
