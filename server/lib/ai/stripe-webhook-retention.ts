/**
 * Stripe Webhook Retention & Gap Detection — Phase 4M
 *
 * SERVER-ONLY: Never import from client/ code.
 *
 * Read-only gap detection helpers. No destructive operations.
 * Paid/refunded records are never deleted in this phase.
 */

import { eq, and, lt, isNull, ne, desc } from "drizzle-orm";
import { db } from "../../db";
import {
  stripeWebhookEvents,
  stripeInvoiceLinks,
  invoicePayments,
} from "@shared/schema";
import type { StripeWebhookEvent, StripeInvoiceLink, InvoicePayment } from "@shared/schema";

export interface WebhookRetentionPolicy {
  retentionRules: {
    status: string;
    rule: string;
  }[];
  summary: string;
}

export interface UnprocessedWebhookPreview {
  id: string;
  stripeEventId: string;
  eventType: string;
  processingStatus: string;
  receivedAt: Date;
  lastError: string | null;
  invoiceId: string | null;
}

export interface PaymentWithoutWebhookConfirmation {
  paymentId: string;
  invoiceId: string;
  tenantId: string;
  paymentStatus: string;
  amountUsd: string;
  createdAt: Date;
}

export interface StripeLinkWithoutSuccessfulPayment {
  stripeLinkId: string;
  invoiceId: string;
  tenantId: string;
  syncStatus: string;
  createdAt: Date;
  daysSinceCreation: number;
}

/**
 * Explain the retention policy for stripe_webhook_events.
 */
export function explainStripeWebhookRetentionPolicy(): WebhookRetentionPolicy {
  return {
    retentionRules: [
      {
        status: "processed",
        rule: "Retain indefinitely. Processed webhook events are part of the payment audit trail.",
      },
      {
        status: "ignored",
        rule: "Retain for minimum 30 days. Ignored events may need review if payment state is disputed.",
      },
      {
        status: "failed",
        rule: "Retain indefinitely. Failed events must be inspectable for debugging and support.",
      },
      {
        status: "received",
        rule: "Events stuck in 'received' for > 1 hour may indicate processing failures. Review and reprocess or mark failed.",
      },
    ],
    summary:
      "Stripe webhook events are append-only audit records. No events are deleted in Phase 4M. " +
      "Paid/refunded payment records are never deleted. Gap detection identifies events that may need attention.",
  };
}

/**
 * List webhook events that are NOT in 'processed' status.
 * These may represent failures, gaps, or events awaiting processing.
 */
export async function previewWebhookEventsWithoutProcessedState(
  limit = 100,
): Promise<UnprocessedWebhookPreview[]> {
  const rows = await db
    .select()
    .from(stripeWebhookEvents)
    .where(ne(stripeWebhookEvents.processingStatus, "processed"))
    .orderBy(desc(stripeWebhookEvents.receivedAt))
    .limit(limit);

  return rows.map((r) => ({
    id: r.id,
    stripeEventId: r.stripeEventId,
    eventType: r.eventType,
    processingStatus: r.processingStatus,
    receivedAt: r.receivedAt,
    lastError: r.lastError,
    invoiceId: r.invoiceId,
  }));
}

/**
 * List invoice_payments that have no corresponding webhook event recorded.
 * These are payments created internally but not yet confirmed by Stripe.
 */
export async function previewPaymentsWithoutWebhookConfirmation(
  limit = 100,
): Promise<PaymentWithoutWebhookConfirmation[]> {
  const allPayments = await db
    .select()
    .from(invoicePayments)
    .orderBy(desc(invoicePayments.createdAt))
    .limit(500);

  const allWebhooks = await db
    .select({ invoiceId: stripeWebhookEvents.invoiceId })
    .from(stripeWebhookEvents)
    .where(eq(stripeWebhookEvents.processingStatus, "processed"));

  const confirmedInvoiceIds = new Set(
    allWebhooks.map((w) => w.invoiceId).filter(Boolean) as string[],
  );

  return allPayments
    .filter(
      (p) =>
        !confirmedInvoiceIds.has(p.invoiceId) &&
        p.paymentStatus !== "void",
    )
    .slice(0, limit)
    .map((p) => ({
      paymentId: p.id,
      invoiceId: p.invoiceId,
      tenantId: p.tenantId,
      paymentStatus: p.paymentStatus,
      amountUsd: String(p.amountUsd),
      createdAt: p.createdAt,
    }));
}

/**
 * List stripe_invoice_links that do NOT have a paid/refunded payment.
 * Useful for identifying invoices with Stripe links that never completed payment.
 */
export async function previewStripeLinksWithoutSuccessfulPayment(
  days: number,
): Promise<StripeLinkWithoutSuccessfulPayment[]> {
  if (days <= 0) {
    throw new Error(
      `[ai/stripe-webhook-retention] days must be > 0, got ${days}`,
    );
  }
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const links = await db
    .select()
    .from(stripeInvoiceLinks)
    .where(lt(stripeInvoiceLinks.createdAt, cutoff))
    .orderBy(desc(stripeInvoiceLinks.createdAt))
    .limit(500);

  const now = Date.now();
  const result: StripeLinkWithoutSuccessfulPayment[] = [];

  for (const link of links) {
    const payments = await db
      .select()
      .from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, link.invoiceId))
      .orderBy(desc(invoicePayments.createdAt))
      .limit(1);

    const p = payments[0] ?? null;
    const hasSuccessfulPayment =
      p && (p.paymentStatus === "paid" || p.paymentStatus === "refunded");

    if (!hasSuccessfulPayment) {
      result.push({
        stripeLinkId: link.id,
        invoiceId: link.invoiceId,
        tenantId: link.tenantId,
        syncStatus: link.syncStatus,
        createdAt: link.createdAt,
        daysSinceCreation: Math.floor(
          (now - link.createdAt.getTime()) / (1000 * 60 * 60 * 24),
        ),
      });
    }

    if (result.length >= 100) break;
  }

  return result;
}
