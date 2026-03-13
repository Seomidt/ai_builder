/**
 * Payment Summary Helpers — Phase 4L
 *
 * SERVER-ONLY: Read helpers for payment data.
 * Designed for admin tooling, finance workflows, and dispute resolution.
 *
 * Source of truth rules:
 *   - invoices.total_usd = invoice amount source of truth
 *   - invoice_payments.amount_usd = payment amount source of truth
 *   - payment_events = timeline only — not financial truth
 *   - stripe_invoice_links = linkage only — does not override totals
 */

import { eq, desc, and } from "drizzle-orm";
import { db } from "../../db";
import {
  invoices,
  invoicePayments,
  stripeInvoiceLinks,
  paymentEvents,
  billingPeriods,
} from "@shared/schema";
import type {
  Invoice,
  InvoicePayment,
  StripeInvoiceLink,
  PaymentEvent,
} from "@shared/schema";

export interface InvoicePaymentSummary {
  invoice: Invoice;
  latestPayment: InvoicePayment | null;
  allPayments: InvoicePayment[];
  stripeLink: StripeInvoiceLink | null;
  paymentCount: number;
}

export async function getInvoicePaymentSummary(
  invoiceId: string,
): Promise<InvoicePaymentSummary | null> {
  const invoiceRows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (invoiceRows.length === 0) return null;
  const invoice = invoiceRows[0];

  const payments = await db
    .select()
    .from(invoicePayments)
    .where(eq(invoicePayments.invoiceId, invoiceId))
    .orderBy(desc(invoicePayments.createdAt));

  const stripeLinkRows = await db
    .select()
    .from(stripeInvoiceLinks)
    .where(eq(stripeInvoiceLinks.invoiceId, invoiceId))
    .limit(1);

  return {
    invoice,
    latestPayment: payments[0] ?? null,
    allPayments: payments,
    stripeLink: stripeLinkRows[0] ?? null,
    paymentCount: payments.length,
  };
}

export async function listPaymentsByBillingPeriod(
  billingPeriodId: string,
  limit = 200,
): Promise<{ invoice: Invoice; payment: InvoicePayment }[]> {
  const periodInvoices = await db
    .select()
    .from(invoices)
    .where(eq(invoices.billingPeriodId, billingPeriodId))
    .orderBy(desc(invoices.createdAt))
    .limit(limit);

  const results: { invoice: Invoice; payment: InvoicePayment }[] = [];
  for (const inv of periodInvoices) {
    const payments = await db
      .select()
      .from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, inv.id))
      .orderBy(desc(invoicePayments.createdAt))
      .limit(1);
    if (payments.length > 0) {
      results.push({ invoice: inv, payment: payments[0] });
    }
  }
  return results;
}

export async function getTenantLatestPaymentSummary(
  tenantId: string,
): Promise<InvoicePaymentSummary | null> {
  const payments = await db
    .select()
    .from(invoicePayments)
    .where(eq(invoicePayments.tenantId, tenantId))
    .orderBy(desc(invoicePayments.createdAt))
    .limit(1);
  if (payments.length === 0) return null;
  return getInvoicePaymentSummary(payments[0].invoiceId);
}

export interface PaymentSourceExplanation {
  invoiceId: string;
  invoiceNumber: string;
  invoiceStatus: string;
  invoiceTotalUsd: number;
  currency: string;
  payment: {
    id: string;
    paymentStatus: string;
    amountUsd: number;
    paymentProvider: string;
    providerPaymentReference: string | null;
    paidAt: Date | null;
    failedAt: Date | null;
    refundedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  } | null;
  stripeLink: {
    id: string;
    syncStatus: string;
    stripeCustomerId: string | null;
    stripeInvoiceId: string | null;
    stripePaymentIntentId: string | null;
    lastSyncedAt: Date | null;
    lastSyncError: string | null;
  } | null;
  eventTimeline: {
    id: string;
    eventType: string;
    eventSource: string;
    createdAt: Date;
    metadata: unknown;
  }[];
  sourceSummary: string;
}

export async function explainPaymentSource(
  invoiceId: string,
): Promise<PaymentSourceExplanation | null> {
  const invoiceRows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (invoiceRows.length === 0) return null;
  const invoice = invoiceRows[0];

  const payments = await db
    .select()
    .from(invoicePayments)
    .where(eq(invoicePayments.invoiceId, invoiceId))
    .orderBy(desc(invoicePayments.createdAt))
    .limit(1);
  const payment = payments[0] ?? null;

  const stripeLinkRows = await db
    .select()
    .from(stripeInvoiceLinks)
    .where(eq(stripeInvoiceLinks.invoiceId, invoiceId))
    .limit(1);
  const stripeLink = stripeLinkRows[0] ?? null;

  const events = await db
    .select()
    .from(paymentEvents)
    .where(eq(paymentEvents.invoiceId, invoiceId))
    .orderBy(paymentEvents.createdAt)
    .limit(200);

  const eventTimeline = events.map((e) => ({
    id: e.id,
    eventType: e.eventType,
    eventSource: e.eventSource,
    createdAt: e.createdAt,
    metadata: e.metadata,
  }));

  const paymentInfo = payment
    ? `Payment ${payment.id} (status=${payment.paymentStatus}, amount=${payment.amountUsd} USD)`
    : "No payment record";
  const stripeInfo = stripeLink
    ? `Stripe link (sync_status=${stripeLink.syncStatus})`
    : "No Stripe link";

  return {
    invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    invoiceStatus: invoice.status,
    invoiceTotalUsd: Number(invoice.totalUsd),
    currency: invoice.currency,
    payment: payment
      ? {
          id: payment.id,
          paymentStatus: payment.paymentStatus,
          amountUsd: Number(payment.amountUsd),
          paymentProvider: payment.paymentProvider,
          providerPaymentReference: payment.providerPaymentReference,
          paidAt: payment.paidAt,
          failedAt: payment.failedAt,
          refundedAt: payment.refundedAt,
          createdAt: payment.createdAt,
          updatedAt: payment.updatedAt,
        }
      : null,
    stripeLink: stripeLink
      ? {
          id: stripeLink.id,
          syncStatus: stripeLink.syncStatus,
          stripeCustomerId: stripeLink.stripeCustomerId,
          stripeInvoiceId: stripeLink.stripeInvoiceId,
          stripePaymentIntentId: stripeLink.stripePaymentIntentId,
          lastSyncedAt: stripeLink.lastSyncedAt,
          lastSyncError: stripeLink.lastSyncError,
        }
      : null,
    eventTimeline,
    sourceSummary: `Invoice ${invoice.invoiceNumber} (total=${invoice.totalUsd} USD, status=${invoice.status}). ${paymentInfo}. ${stripeInfo}. ${eventTimeline.length} event(s) recorded. Invoice total is the canonical source of truth — payment and Stripe data are downstream.`,
  };
}
