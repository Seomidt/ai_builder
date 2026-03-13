/**
 * Invoice Payment State Machine — Phase 4L
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Manages the payment lifecycle for finalized invoices.
 *
 * Source of truth rules:
 *   - invoices.total_usd = invoice amount source of truth
 *   - invoice_payments.amount_usd = payment amount source of truth
 *   - Stripe object IDs are linkage only — they do not override totals
 *   - payment_events = timeline only — not financial truth
 *
 * State machine:
 *   pending → processing → paid      (happy path)
 *   pending → processing → failed    (payment failure)
 *   pending → void                   (cancelled before processing)
 *   processing → failed              (provider declined)
 *   paid → refunded                  (post-payment refund)
 *
 * Guards:
 *   - Only finalized invoices may enter payment flow
 *   - Draft and void invoices are rejected
 *   - Invalid transitions throw
 *   - updated_at maintained on every transition
 *   - payment_events row recorded for each state change
 *
 * Atomicity:
 *   - Every state mutation + event insert is wrapped in a single
 *     db.transaction() — if event insert fails, the state change
 *     is rolled back, ensuring no audit gaps.
 */

import { eq, and, desc } from "drizzle-orm";
import { db } from "../../db";
import {
  invoicePayments,
  invoices,
  paymentEvents,
} from "@shared/schema";
import type { InvoicePayment, Invoice } from "@shared/schema";

const VALID_TRANSITIONS: Record<string, string[]> = {
  pending: ["processing", "void"],
  processing: ["paid", "failed"],
  paid: ["refunded"],
  failed: [],
  refunded: [],
  void: [],
};

async function loadInvoice(invoiceId: string): Promise<Invoice> {
  const rows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(`[ai/invoice-payments] Invoice not found: ${invoiceId}`);
  }
  return rows[0];
}

async function loadPayment(paymentId: string): Promise<InvoicePayment> {
  const rows = await db
    .select()
    .from(invoicePayments)
    .where(eq(invoicePayments.id, paymentId))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(`[ai/invoice-payments] Payment not found: ${paymentId}`);
  }
  return rows[0];
}

function assertValidTransition(
  current: string,
  target: string,
  paymentId: string,
): void {
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed || !allowed.includes(target)) {
    throw new Error(
      `[ai/invoice-payments] Invalid transition: ${current} → ${target} for payment ${paymentId}. Allowed from '${current}': [${(allowed ?? []).join(", ")}]`,
    );
  }
}

export async function createInvoicePayment(
  invoiceId: string,
  metadata?: Record<string, unknown> | null,
): Promise<InvoicePayment> {
  const invoice = await loadInvoice(invoiceId);

  if (invoice.status !== "finalized") {
    throw new Error(
      `[ai/invoice-payments] Cannot create payment for invoice ${invoiceId} — status='${invoice.status}'. Only finalized invoices may enter payment flow.`,
    );
  }

  const payment = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(invoicePayments)
      .values({
        invoiceId,
        tenantId: invoice.tenantId,
        paymentProvider: "stripe",
        paymentStatus: "pending",
        amountUsd: String(invoice.totalUsd),
        currency: invoice.currency,
        metadata: metadata ?? null,
      })
      .returning();
    const p = inserted[0];

    await tx.insert(paymentEvents).values({
      invoicePaymentId: p.id,
      invoiceId,
      tenantId: invoice.tenantId,
      eventType: "payment_created",
      eventSource: "internal",
      eventStatus: "recorded",
      metadata: {
        amountUsd: String(invoice.totalUsd),
        invoiceNumber: invoice.invoiceNumber,
      },
    });

    return p;
  });

  console.log(
    `[ai/invoice-payments] Payment created: ${payment.id} for invoice ${invoice.invoiceNumber}`,
  );
  return payment;
}

export async function markInvoicePaymentProcessing(
  paymentId: string,
  metadata?: Record<string, unknown> | null,
): Promise<InvoicePayment> {
  const payment = await loadPayment(paymentId);
  assertValidTransition(payment.paymentStatus, "processing", paymentId);

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(invoicePayments)
      .set({
        paymentStatus: "processing",
        updatedAt: new Date(),
        metadata: metadata ?? payment.metadata,
      })
      .where(eq(invoicePayments.id, paymentId))
      .returning();

    await tx.insert(paymentEvents).values({
      invoicePaymentId: paymentId,
      invoiceId: payment.invoiceId,
      tenantId: payment.tenantId,
      eventType: "payment_processing",
      eventSource: "internal",
      eventStatus: "recorded",
      metadata: metadata ?? null,
    });

    return updated[0];
  });
}

export async function markInvoicePaymentPaid(
  paymentId: string,
  providerReference?: string | null,
  paidAt?: Date | null,
): Promise<InvoicePayment> {
  const payment = await loadPayment(paymentId);
  assertValidTransition(payment.paymentStatus, "paid", paymentId);

  const now = paidAt ?? new Date();

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(invoicePayments)
      .set({
        paymentStatus: "paid",
        paidAt: now,
        providerPaymentReference: providerReference ?? payment.providerPaymentReference,
        updatedAt: new Date(),
      })
      .where(eq(invoicePayments.id, paymentId))
      .returning();

    await tx.insert(paymentEvents).values({
      invoicePaymentId: paymentId,
      invoiceId: payment.invoiceId,
      tenantId: payment.tenantId,
      eventType: "payment_paid",
      eventSource: "internal",
      eventStatus: "recorded",
      metadata: {
        providerReference: providerReference ?? null,
        paidAt: now.toISOString(),
      },
    });

    return updated[0];
  });
}

export async function markInvoicePaymentFailed(
  paymentId: string,
  error?: string | null,
  failedAt?: Date | null,
): Promise<InvoicePayment> {
  const payment = await loadPayment(paymentId);
  assertValidTransition(payment.paymentStatus, "failed", paymentId);

  const now = failedAt ?? new Date();

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(invoicePayments)
      .set({
        paymentStatus: "failed",
        failedAt: now,
        updatedAt: new Date(),
      })
      .where(eq(invoicePayments.id, paymentId))
      .returning();

    await tx.insert(paymentEvents).values({
      invoicePaymentId: paymentId,
      invoiceId: payment.invoiceId,
      tenantId: payment.tenantId,
      eventType: "payment_failed",
      eventSource: "internal",
      eventStatus: "recorded",
      metadata: {
        error: error ?? null,
        failedAt: now.toISOString(),
      },
    });

    return updated[0];
  });
}

export async function markInvoicePaymentRefunded(
  paymentId: string,
  providerReference?: string | null,
  refundedAt?: Date | null,
): Promise<InvoicePayment> {
  const payment = await loadPayment(paymentId);
  assertValidTransition(payment.paymentStatus, "refunded", paymentId);

  const now = refundedAt ?? new Date();

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(invoicePayments)
      .set({
        paymentStatus: "refunded",
        refundedAt: now,
        providerPaymentReference: providerReference ?? payment.providerPaymentReference,
        updatedAt: new Date(),
      })
      .where(eq(invoicePayments.id, paymentId))
      .returning();

    await tx.insert(paymentEvents).values({
      invoicePaymentId: paymentId,
      invoiceId: payment.invoiceId,
      tenantId: payment.tenantId,
      eventType: "payment_refunded",
      eventSource: "internal",
      eventStatus: "recorded",
      metadata: {
        providerReference: providerReference ?? null,
        refundedAt: now.toISOString(),
      },
    });

    return updated[0];
  });
}

export async function markInvoicePaymentVoid(
  paymentId: string,
): Promise<InvoicePayment> {
  const payment = await loadPayment(paymentId);
  assertValidTransition(payment.paymentStatus, "void", paymentId);

  return db.transaction(async (tx) => {
    const updated = await tx
      .update(invoicePayments)
      .set({
        paymentStatus: "void",
        updatedAt: new Date(),
      })
      .where(eq(invoicePayments.id, paymentId))
      .returning();

    await tx.insert(paymentEvents).values({
      invoicePaymentId: paymentId,
      invoiceId: payment.invoiceId,
      tenantId: payment.tenantId,
      eventType: "payment_voided",
      eventSource: "internal",
      eventStatus: "recorded",
      metadata: null,
    });

    return updated[0];
  });
}

export async function getInvoicePaymentByInvoiceId(
  invoiceId: string,
): Promise<InvoicePayment | null> {
  const rows = await db
    .select()
    .from(invoicePayments)
    .where(eq(invoicePayments.invoiceId, invoiceId))
    .orderBy(desc(invoicePayments.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function listInvoicePaymentsByTenant(
  tenantId: string,
  limit = 100,
): Promise<InvoicePayment[]> {
  return db
    .select()
    .from(invoicePayments)
    .where(eq(invoicePayments.tenantId, tenantId))
    .orderBy(desc(invoicePayments.createdAt))
    .limit(limit);
}

export async function listPaymentEventsByInvoice(
  invoiceId: string,
  limit = 200,
): Promise<{ id: string; invoicePaymentId: string | null; eventType: string; eventSource: string; metadata: unknown; createdAt: Date }[]> {
  return db
    .select()
    .from(paymentEvents)
    .where(eq(paymentEvents.invoiceId, invoiceId))
    .orderBy(paymentEvents.createdAt)
    .limit(limit);
}
