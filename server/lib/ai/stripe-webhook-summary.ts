/**
 * Stripe Webhook Summary Helpers — Phase 4M
 *
 * SERVER-ONLY: Never import from client/ code.
 *
 * Read-only helpers for inspecting Stripe webhook event history,
 * invoice lifecycle, and payment state. Useful for finance/support/debugging.
 */

import { eq, desc } from "drizzle-orm";
import { db } from "../../db";
import {
  stripeWebhookEvents,
  invoices,
  invoicePayments,
  stripeInvoiceLinks,
  paymentEvents,
} from "@shared/schema";
import type {
  StripeWebhookEvent,
  Invoice,
  InvoicePayment,
  StripeInvoiceLink,
  PaymentEvent,
} from "@shared/schema";

export interface StripeWebhookOutcomeExplanation {
  webhookEvent: StripeWebhookEvent;
  invoice: Invoice | null;
  invoicePayment: InvoicePayment | null;
  stripeLink: StripeInvoiceLink | null;
  paymentEventTimeline: PaymentEvent[];
  summary: string;
}

export interface InvoiceStripeLifecycle {
  invoiceId: string;
  invoiceNumber: string;
  invoiceStatus: string;
  invoiceTotalUsd: string;
  payment: InvoicePayment | null;
  stripeLink: StripeInvoiceLink | null;
  webhookEvents: StripeWebhookEvent[];
  paymentTimeline: PaymentEvent[];
}

/**
 * List the most recent stripe_webhook_events rows.
 */
export async function listStripeWebhookEvents(
  limit = 100,
): Promise<StripeWebhookEvent[]> {
  return db
    .select()
    .from(stripeWebhookEvents)
    .orderBy(desc(stripeWebhookEvents.receivedAt))
    .limit(limit);
}

/**
 * Fetch a single stripe_webhook_events row by Stripe event ID.
 */
export async function getStripeWebhookEventByStripeEventId(
  stripeEventId: string,
): Promise<StripeWebhookEvent | null> {
  const rows = await db
    .select()
    .from(stripeWebhookEvents)
    .where(eq(stripeWebhookEvents.stripeEventId, stripeEventId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Return the full Stripe lifecycle for an invoice:
 * invoice → payment → stripe_link → webhook events → payment timeline.
 */
export async function getInvoiceStripeLifecycle(
  invoiceId: string,
): Promise<InvoiceStripeLifecycle | null> {
  const invoiceRows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (invoiceRows.length === 0) return null;
  const invoice = invoiceRows[0];

  const [paymentRows, stripeLinkRows, webhookRows, paymentTimelineRows] =
    await Promise.all([
      db
        .select()
        .from(invoicePayments)
        .where(eq(invoicePayments.invoiceId, invoiceId))
        .orderBy(desc(invoicePayments.createdAt))
        .limit(1),
      db
        .select()
        .from(stripeInvoiceLinks)
        .where(eq(stripeInvoiceLinks.invoiceId, invoiceId))
        .limit(1),
      db
        .select()
        .from(stripeWebhookEvents)
        .where(eq(stripeWebhookEvents.invoiceId, invoiceId))
        .orderBy(desc(stripeWebhookEvents.receivedAt))
        .limit(50),
      db
        .select()
        .from(paymentEvents)
        .where(eq(paymentEvents.invoiceId, invoiceId))
        .orderBy(paymentEvents.createdAt)
        .limit(200),
    ]);

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    invoiceStatus: invoice.status,
    invoiceTotalUsd: String(invoice.totalUsd),
    payment: paymentRows[0] ?? null,
    stripeLink: stripeLinkRows[0] ?? null,
    webhookEvents: webhookRows,
    paymentTimeline: paymentTimelineRows as PaymentEvent[],
  };
}

/**
 * Return a full explanation of what happened for a given Stripe event ID.
 * Useful for support and debugging.
 */
export async function explainStripeWebhookOutcome(
  stripeEventId: string,
): Promise<StripeWebhookOutcomeExplanation | null> {
  const webhookRows = await db
    .select()
    .from(stripeWebhookEvents)
    .where(eq(stripeWebhookEvents.stripeEventId, stripeEventId))
    .limit(1);
  if (webhookRows.length === 0) return null;
  const webhookEvent = webhookRows[0];

  const [invoiceRows, paymentRows, stripeLinkRows, timelineRows] =
    await Promise.all([
      webhookEvent.invoiceId
        ? db
            .select()
            .from(invoices)
            .where(eq(invoices.id, webhookEvent.invoiceId))
            .limit(1)
        : Promise.resolve([]),
      webhookEvent.invoicePaymentId
        ? db
            .select()
            .from(invoicePayments)
            .where(eq(invoicePayments.id, webhookEvent.invoicePaymentId))
            .limit(1)
        : webhookEvent.invoiceId
          ? db
              .select()
              .from(invoicePayments)
              .where(eq(invoicePayments.invoiceId, webhookEvent.invoiceId))
              .orderBy(desc(invoicePayments.createdAt))
              .limit(1)
          : Promise.resolve([]),
      webhookEvent.invoiceId
        ? db
            .select()
            .from(stripeInvoiceLinks)
            .where(eq(stripeInvoiceLinks.invoiceId, webhookEvent.invoiceId))
            .limit(1)
        : Promise.resolve([]),
      webhookEvent.invoiceId
        ? db
            .select()
            .from(paymentEvents)
            .where(eq(paymentEvents.invoiceId, webhookEvent.invoiceId))
            .orderBy(paymentEvents.createdAt)
            .limit(200)
        : Promise.resolve([]),
    ]);

  const invoice = (invoiceRows as Invoice[])[0] ?? null;
  const payment = (paymentRows as InvoicePayment[])[0] ?? null;
  const stripeLink = (stripeLinkRows as StripeInvoiceLink[])[0] ?? null;
  const timeline = timelineRows as PaymentEvent[];

  const statusLabel =
    webhookEvent.processingStatus === "processed"
      ? "processed successfully"
      : webhookEvent.processingStatus === "ignored"
        ? "received but ignored (no effective payment change)"
        : webhookEvent.processingStatus === "failed"
          ? "processing failed"
          : "received, not yet processed";

  const summary = [
    `Webhook ${stripeEventId} (${webhookEvent.eventType}): ${statusLabel}.`,
    invoice
      ? `Invoice: ${invoice.invoiceNumber} — total=${invoice.totalUsd} USD, status=${invoice.status}.`
      : "No linked invoice.",
    payment
      ? `Payment: id=${payment.id}, status=${payment.paymentStatus}, amount=${payment.amountUsd} USD.`
      : "No linked payment.",
    stripeLink
      ? `Stripe link: sync_status=${stripeLink.syncStatus}.`
      : "No Stripe link.",
    `Payment event timeline: ${timeline.length} entries.`,
    webhookEvent.lastError ? `Last error: ${webhookEvent.lastError}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return {
    webhookEvent,
    invoice,
    invoicePayment: payment,
    stripeLink,
    paymentEventTimeline: timeline,
    summary,
  };
}
