/**
 * Phase 22 — Invoice Service
 * Manages Stripe invoice tracking and payment failure observability.
 */

import { db } from "../../db";
import { stripeInvoices } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";
import { stripeIds } from "./stripe-client";

/**
 * Get a Stripe invoice by Stripe invoice ID.
 */
export async function getStripeInvoice(stripeInvoiceId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM stripe_invoices WHERE stripe_invoice_id = ${stripeInvoiceId} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

/**
 * List invoices for a tenant.
 */
export async function listStripeInvoices(tenantId: string, params?: {
  status?: string;
  limit?: number;
  offset?: number;
}): Promise<Array<Record<string, unknown>>> {
  const limit = params?.limit ?? 50;
  const offset = params?.offset ?? 0;
  const statusClause = params?.status
    ? drizzleSql`AND status = ${params.status}`
    : drizzleSql``;
  const rows = await db.execute(drizzleSql`
    SELECT * FROM stripe_invoices
    WHERE tenant_id = ${tenantId} ${statusClause}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * Create (upsert) an invoice record.
 * Idempotent on stripeInvoiceId.
 */
export async function upsertStripeInvoice(params: {
  stripeInvoiceId?: string;
  tenantId: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  amount: number;
  currency?: string;
  status?: string;
  issuedAt?: Date;
  paidAt?: Date;
  paymentError?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ id: string; stripeInvoiceId: string; isNew: boolean }> {
  if (!params.tenantId?.trim()) throw new Error("tenantId is required");

  const invoiceId = params.stripeInvoiceId ?? stripeIds.invoice();

  // Check existing (idempotency)
  const existing = await getStripeInvoice(invoiceId);
  if (existing) {
    return { id: existing.id as string, stripeInvoiceId: invoiceId, isNew: false };
  }

  const rows = await db.insert(stripeInvoices).values({
    stripeInvoiceId: invoiceId,
    tenantId: params.tenantId,
    stripeCustomerId: params.stripeCustomerId ?? null,
    stripeSubscriptionId: params.stripeSubscriptionId ?? null,
    amount: params.amount,
    currency: params.currency ?? "usd",
    status: params.status ?? "open",
    paymentAttempts: 1,
    lastPaymentError: params.paymentError ?? null,
    issuedAt: params.issuedAt ?? new Date(),
    paidAt: params.paidAt ?? null,
    metadata: params.metadata ?? null,
  }).returning({ id: stripeInvoices.id, stripeInvoiceId: stripeInvoices.stripeInvoiceId });

  return { id: rows[0].id, stripeInvoiceId: rows[0].stripeInvoiceId, isNew: true };
}

/**
 * Mark an invoice as paid.
 */
export async function markInvoicePaid(stripeInvoiceId: string): Promise<{ updated: boolean }> {
  await db.execute(drizzleSql`
    UPDATE stripe_invoices SET
      status = 'paid',
      paid_at = NOW(),
      last_payment_error = NULL,
      updated_at = NOW()
    WHERE stripe_invoice_id = ${stripeInvoiceId}
  `);
  return { updated: true };
}

/**
 * Mark an invoice payment as failed (increments attempts, stores error).
 */
export async function markInvoicePaymentFailed(stripeInvoiceId: string, error?: string): Promise<{ updated: boolean; attempts: number }> {
  await db.execute(drizzleSql`
    UPDATE stripe_invoices SET
      status = 'open',
      payment_attempts = payment_attempts + 1,
      last_payment_error = ${error ?? "Payment declined"},
      updated_at = NOW()
    WHERE stripe_invoice_id = ${stripeInvoiceId}
  `);
  const inv = await getStripeInvoice(stripeInvoiceId);
  return { updated: true, attempts: Number(inv?.payment_attempts ?? 1) };
}

/**
 * Void an invoice.
 */
export async function voidInvoice(stripeInvoiceId: string): Promise<{ voided: boolean }> {
  await db.execute(drizzleSql`
    UPDATE stripe_invoices SET status = 'void', updated_at = NOW()
    WHERE stripe_invoice_id = ${stripeInvoiceId}
  `);
  return { voided: true };
}

/**
 * Get payment failure metrics (observability).
 */
export async function getPaymentFailureMetrics(): Promise<{
  totalInvoices: number;
  totalPaid: number;
  totalFailed: number;
  totalOpen: number;
  failureRate: number;
  recentFailures: Array<Record<string, unknown>>;
}> {
  const rows = await db.execute(drizzleSql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'paid') AS total_paid,
      COUNT(*) FILTER (WHERE payment_attempts > 1 AND status != 'paid') AS total_failed,
      COUNT(*) FILTER (WHERE status = 'open') AS total_open
    FROM stripe_invoices
  `);
  const r = rows.rows[0] as Record<string, unknown>;
  const total = Number(r.total ?? 0);
  const totalFailed = Number(r.total_failed ?? 0);

  const recent = await db.execute(drizzleSql`
    SELECT stripe_invoice_id, tenant_id, amount, currency, payment_attempts, last_payment_error, updated_at
    FROM stripe_invoices
    WHERE payment_attempts > 1 AND status != 'paid'
    ORDER BY updated_at DESC LIMIT 10
  `);

  return {
    totalInvoices: total,
    totalPaid: Number(r.total_paid ?? 0),
    totalFailed,
    totalOpen: Number(r.total_open ?? 0),
    failureRate: total > 0 ? parseFloat((totalFailed / total * 100).toFixed(2)) : 0,
    recentFailures: recent.rows as Record<string, unknown>[],
  };
}

/**
 * Get revenue summary from paid invoices.
 */
export async function getRevenueFromInvoices(params?: { currency?: string }): Promise<{
  totalRevenue: number;
  currency: string;
  invoiceCount: number;
}> {
  const currency = params?.currency ?? "usd";
  const rows = await db.execute(drizzleSql`
    SELECT
      COALESCE(SUM(amount), 0) AS total_revenue,
      COUNT(*) AS invoice_count
    FROM stripe_invoices
    WHERE status = 'paid' AND currency = ${currency}
  `);
  const r = rows.rows[0] as Record<string, unknown>;
  return {
    totalRevenue: Number(r.total_revenue ?? 0),
    currency,
    invoiceCount: Number(r.invoice_count ?? 0),
  };
}
