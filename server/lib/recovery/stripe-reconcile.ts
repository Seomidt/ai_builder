/**
 * Phase 29 — Stripe Reconciliation
 * Detects missing payments, subscription desync, and invoice mismatches.
 */

import { Client } from "pg";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MissingPaymentRecord {
  tenantId:           string;
  stripeSubscriptionId: string;
  currentPeriodEnd:   string | null;
  status:             string;
  issue:              string;
}

export interface SubscriptionDesyncRecord {
  tenantId:             string;
  stripeSubscriptionId: string;
  stripeStatus:         string;
  internalStatus:       string;
  planKey:              string;
  issue:                string;
}

export interface InvoiceMismatch {
  tenantId:          string;
  stripeInvoiceId:   string;
  amount:            number;
  currency:          string;
  stripeStatus:      string;
  paymentAttempts:   number;
  issue:             string;
}

export interface ReconciliationReport {
  missingPayments:      MissingPaymentRecord[];
  subscriptionDesyncs:  SubscriptionDesyncRecord[];
  invoiceMismatches:    InvoiceMismatch[];
  totalIssues:          number;
  criticalIssues:       number;
  checkedAt:            string;
}

// ── DB helper ─────────────────────────────────────────────────────────────────

function getClient(): Client {
  return new Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ── Missing payments ──────────────────────────────────────────────────────────
// Subscriptions that are active/trialing but period has expired

export async function detectMissingPayments(): Promise<MissingPaymentRecord[]> {
  const client = getClient();
  await client.connect();
  const now    = new Date().toISOString();

  try {
    const res = await client.query<any>(`
      SELECT
        ss.tenant_id,
        ss.stripe_subscription_id,
        ss.current_period_end::text AS current_period_end,
        ss.status
      FROM stripe_subscriptions ss
      WHERE ss.status IN ('active', 'trialing')
        AND ss.current_period_end IS NOT NULL
        AND ss.current_period_end < '${now}'
      ORDER BY ss.current_period_end ASC
      LIMIT 100
    `);

    return res.rows.map((r: any) => ({
      tenantId:             r.tenant_id,
      stripeSubscriptionId: r.stripe_subscription_id,
      currentPeriodEnd:     r.current_period_end ?? null,
      status:               r.status,
      issue:                `Subscription period expired at ${r.current_period_end} but status is still '${r.status}'`,
    }));
  } finally {
    await client.end();
  }
}

// ── Subscription desync ───────────────────────────────────────────────────────
// Mismatches between stripe_subscriptions and tenant_subscriptions status

export async function detectSubscriptionDesync(): Promise<SubscriptionDesyncRecord[]> {
  const client = getClient();
  await client.connect();

  try {
    const res = await client.query<any>(`
      SELECT
        ss.tenant_id,
        ss.stripe_subscription_id,
        ss.status          AS stripe_status,
        ts.status          AS internal_status,
        ss.plan_key
      FROM stripe_subscriptions ss
      JOIN tenant_subscriptions  ts ON ts.tenant_id = ss.tenant_id
      WHERE ss.status <> ts.status
        AND ss.status IN ('canceled','past_due','unpaid','incomplete')
      LIMIT 100
    `);

    return res.rows.map((r: any) => ({
      tenantId:             r.tenant_id,
      stripeSubscriptionId: r.stripe_subscription_id,
      stripeStatus:         r.stripe_status,
      internalStatus:       r.internal_status,
      planKey:              r.plan_key,
      issue:                `Stripe status '${r.stripe_status}' does not match internal status '${r.internal_status}'`,
    }));
  } finally {
    await client.end();
  }
}

// ── Invoice mismatches ────────────────────────────────────────────────────────
// Invoices that are open/unpaid with multiple failed payment attempts

export async function detectInvoiceMismatches(
  maxPaymentAttempts = 2,
): Promise<InvoiceMismatch[]> {
  const client = getClient();
  await client.connect();

  try {
    const res = await client.query<any>(`
      SELECT
        si.tenant_id,
        si.stripe_invoice_id,
        si.amount,
        si.currency,
        si.status          AS stripe_status,
        si.payment_attempts
      FROM stripe_invoices si
      WHERE si.status IN ('open','uncollectible')
        AND si.payment_attempts >= ${maxPaymentAttempts}
      ORDER BY si.payment_attempts DESC
      LIMIT 100
    `);

    return res.rows.map((r: any) => ({
      tenantId:        r.tenant_id,
      stripeInvoiceId: r.stripe_invoice_id,
      amount:          parseInt(r.amount ?? "0", 10),
      currency:        r.currency,
      stripeStatus:    r.stripe_status,
      paymentAttempts: parseInt(r.payment_attempts ?? "0", 10),
      issue:           `Invoice '${r.stripe_invoice_id}' has ${r.payment_attempts} failed payment attempts (status: ${r.stripe_status})`,
    }));
  } finally {
    await client.end();
  }
}

// ── Full reconciliation report ────────────────────────────────────────────────

export async function runStripeReconciliation(): Promise<ReconciliationReport> {
  const [missingPayments, subscriptionDesyncs, invoiceMismatches] = await Promise.all([
    detectMissingPayments(),
    detectSubscriptionDesync(),
    detectInvoiceMismatches(),
  ]);

  const totalIssues    = missingPayments.length + subscriptionDesyncs.length + invoiceMismatches.length;
  const criticalIssues = missingPayments.length + subscriptionDesyncs.length;

  return {
    missingPayments,
    subscriptionDesyncs,
    invoiceMismatches,
    totalIssues,
    criticalIssues,
    checkedAt: new Date().toISOString(),
  };
}

// ── Subscription health quick-check ──────────────────────────────────────────

export async function getSubscriptionHealthSummary(): Promise<{
  totalSubscriptions:  number;
  activeCount:         number;
  pastDueCount:        number;
  canceledCount:       number;
  desynced:            number;
  missingPayments:     number;
  checkedAt:           string;
}> {
  const client = getClient();
  await client.connect();

  try {
    const r = await client.query<any>(`
      SELECT
        COUNT(*)                                                  AS total,
        COUNT(*) FILTER (WHERE status='active')                   AS active,
        COUNT(*) FILTER (WHERE status='past_due')                 AS past_due,
        COUNT(*) FILTER (WHERE status IN ('canceled','cancelled')) AS canceled
      FROM stripe_subscriptions
    `);

    const [desyncs, missing] = await Promise.all([
      detectSubscriptionDesync(),
      detectMissingPayments(),
    ]);

    const row = r.rows[0] as any ?? {};
    return {
      totalSubscriptions: parseInt(row.total    ?? "0", 10),
      activeCount:        parseInt(row.active   ?? "0", 10),
      pastDueCount:       parseInt(row.past_due ?? "0", 10),
      canceledCount:      parseInt(row.canceled ?? "0", 10),
      desynced:           desyncs.length,
      missingPayments:    missing.length,
      checkedAt:          new Date().toISOString(),
    };
  } finally {
    await client.end();
  }
}
