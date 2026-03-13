/**
 * Payment Retention & Gap Detection — Phase 4L
 *
 * SERVER-ONLY: Retention policy, gap detection, and preview helpers.
 *
 * RETENTION POLICY:
 *   - Paid and refunded payment records are long-lived financial artifacts
 *   - No destructive cleanup for paid/refunded rows in this phase
 *   - Gap detection only: identify orphaned or stale records
 *   - Prepare for future finance/admin tooling
 */

import { eq, and, lt, isNull, isNotNull, desc } from "drizzle-orm";
import { db } from "../../db";
import {
  invoicePayments,
  stripeInvoiceLinks,
  invoices,
} from "@shared/schema";
import type { InvoicePayment, StripeInvoiceLink } from "@shared/schema";

export interface PaymentRetentionPolicy {
  paidPayments: string;
  refundedPayments: string;
  failedPayments: string;
  pendingPayments: string;
  voidPayments: string;
  destructiveOpsAllowed: boolean;
  rationale: string;
}

export function explainPaymentRetentionPolicy(): PaymentRetentionPolicy {
  return {
    paidPayments:
      "Indefinite retention. Paid payment records are financial artifacts tied to finalized invoices and must not be deleted.",
    refundedPayments:
      "Indefinite retention. Refunded payment records document the refund lifecycle and must not be deleted.",
    failedPayments:
      "Retain for minimum 90 days. Failed payment records are useful for support/debugging. Future phases may archive after extended retention.",
    pendingPayments:
      "Pending payments older than 30 days may indicate stale payment intents. Safe to review and void, but not automated in this phase.",
    voidPayments:
      "Retain for minimum 90 days after voiding. Void payments remain as audit evidence.",
    destructiveOpsAllowed: false,
    rationale:
      "Payment records represent financial lifecycle events tied to invoices. Premature deletion creates audit gaps and makes dispute resolution impossible. Retention is conservative by design.",
  };
}

export interface PaymentWithoutStripeLinkPreview {
  paymentId: string;
  invoiceId: string;
  tenantId: string;
  paymentStatus: string;
  amountUsd: string;
  createdAt: Date;
  recommendation: string;
}

export async function previewPaymentsWithoutStripeLink(): Promise<
  PaymentWithoutStripeLinkPreview[]
> {
  const payments = await db
    .select()
    .from(invoicePayments)
    .orderBy(desc(invoicePayments.createdAt))
    .limit(500);

  const results: PaymentWithoutStripeLinkPreview[] = [];
  for (const p of payments) {
    const links = await db
      .select()
      .from(stripeInvoiceLinks)
      .where(eq(stripeInvoiceLinks.invoiceId, p.invoiceId))
      .limit(1);
    if (links.length === 0) {
      results.push({
        paymentId: p.id,
        invoiceId: p.invoiceId,
        tenantId: p.tenantId,
        paymentStatus: p.paymentStatus,
        amountUsd: String(p.amountUsd),
        createdAt: p.createdAt,
        recommendation:
          "Payment exists without Stripe linkage. Create a Stripe link if Stripe sync is intended.",
      });
    }
  }
  return results;
}

export interface StripeLinkWithoutPaymentPreview {
  stripeLinkId: string;
  invoiceId: string;
  tenantId: string;
  syncStatus: string;
  createdAt: Date;
  recommendation: string;
}

export async function previewStripeLinksWithoutPayments(): Promise<
  StripeLinkWithoutPaymentPreview[]
> {
  const links = await db
    .select()
    .from(stripeInvoiceLinks)
    .orderBy(desc(stripeInvoiceLinks.createdAt))
    .limit(500);

  const results: StripeLinkWithoutPaymentPreview[] = [];
  for (const link of links) {
    const payments = await db
      .select()
      .from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, link.invoiceId))
      .limit(1);
    if (payments.length === 0) {
      results.push({
        stripeLinkId: link.id,
        invoiceId: link.invoiceId,
        tenantId: link.tenantId,
        syncStatus: link.syncStatus,
        createdAt: link.createdAt,
        recommendation:
          "Stripe link exists without a payment record. Create a payment if invoice is finalized and ready for collection.",
      });
    }
  }
  return results;
}

export interface StalePaymentPreview {
  paymentId: string;
  invoiceId: string;
  tenantId: string;
  paymentStatus: string;
  amountUsd: string;
  createdAt: Date;
  daysSinceCreation: number;
  recommendation: string;
}

export async function previewPendingPaymentsOlderThan(
  days: number,
): Promise<StalePaymentPreview[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.paymentStatus, "pending"),
        lt(invoicePayments.createdAt, cutoff),
      ),
    )
    .orderBy(invoicePayments.createdAt)
    .limit(200);

  const now = Date.now();
  return rows.map((p) => ({
    paymentId: p.id,
    invoiceId: p.invoiceId,
    tenantId: p.tenantId,
    paymentStatus: p.paymentStatus,
    amountUsd: String(p.amountUsd),
    createdAt: p.createdAt,
    daysSinceCreation: Math.floor(
      (now - p.createdAt.getTime()) / (1000 * 60 * 60 * 24),
    ),
    recommendation: `Pending payment older than ${days} days. Review and either process or void.`,
  }));
}

export async function previewFailedPaymentsOlderThan(
  days: number,
): Promise<StalePaymentPreview[]> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const rows = await db
    .select()
    .from(invoicePayments)
    .where(
      and(
        eq(invoicePayments.paymentStatus, "failed"),
        lt(invoicePayments.createdAt, cutoff),
      ),
    )
    .orderBy(invoicePayments.createdAt)
    .limit(200);

  const now = Date.now();
  return rows.map((p) => ({
    paymentId: p.id,
    invoiceId: p.invoiceId,
    tenantId: p.tenantId,
    paymentStatus: p.paymentStatus,
    amountUsd: String(p.amountUsd),
    createdAt: p.createdAt,
    daysSinceCreation: Math.floor(
      (now - p.createdAt.getTime()) / (1000 * 60 * 60 * 24),
    ),
    recommendation: `Failed payment older than ${days} days. Review for retry or archival.`,
  }));
}
