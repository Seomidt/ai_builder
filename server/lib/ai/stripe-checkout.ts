/**
 * Stripe Checkout & Payment Creation — Phase 4M
 *
 * SERVER-ONLY: Never import from client/ code.
 *
 * Creates Stripe Checkout Sessions and Payment Intents for finalized invoices.
 * Internal invoice totals remain canonical — Stripe amounts are derived from them.
 *
 * Design rules:
 *   - Only finalized invoices enter Stripe payment flow
 *   - Invoice total is fetched fresh from DB before each Stripe call
 *   - stripe_invoice_links are created idempotently (UNIQUE invoice_id)
 *   - invoice_payments rows are created if not already present
 *   - payment_events are recorded for every Stripe creation event
 *   - Invoice totals are NEVER mutated
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { invoices, invoicePayments } from "@shared/schema";
import type { Invoice, InvoicePayment, StripeInvoiceLink } from "@shared/schema";
import {
  createInvoicePayment,
  getInvoicePaymentByInvoiceId,
} from "./invoice-payments";
import {
  createStripeInvoiceLink,
  getStripeInvoiceLink,
  markStripeSyncStarted,
  markStripeSyncSucceeded,
  markStripeSyncFailed,
} from "./stripe-sync";
import { getStripeClient, toStripeAmount } from "./stripe-client";

export interface StripeCheckoutResult {
  invoiceId: string;
  invoiceNumber: string;
  invoiceTotalUsd: string;
  invoicePaymentId: string;
  stripeSessionId: string | null;
  stripePaymentIntentId: string | null;
  stripeUrl: string | null;
  mode: "checkout" | "payment_intent";
}

export interface StripeCheckoutState {
  invoiceId: string;
  invoiceNumber: string;
  invoiceStatus: string;
  invoiceTotalUsd: string;
  payment: InvoicePayment | null;
  stripeLink: StripeInvoiceLink | null;
}

async function loadFinalizedInvoice(invoiceId: string): Promise<Invoice> {
  const rows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(`[ai/stripe-checkout] Invoice not found: ${invoiceId}`);
  }
  const invoice = rows[0];
  if (invoice.status !== "finalized") {
    throw new Error(
      `[ai/stripe-checkout] Invoice ${invoiceId} has status='${invoice.status}'. Only finalized invoices may enter Stripe payment flow.`,
    );
  }
  return invoice;
}

async function ensureInvoicePayment(
  invoice: Invoice,
): Promise<InvoicePayment> {
  const existing = await getInvoicePaymentByInvoiceId(invoice.id);
  if (existing) return existing;
  return createInvoicePayment(invoice.id);
}

/**
 * Create a Stripe Checkout Session for a finalized invoice.
 * The amount is taken from the internal invoice — not specified by caller.
 */
export async function createStripeCheckoutForInvoice(
  invoiceId: string,
  successUrl: string,
  cancelUrl: string,
): Promise<StripeCheckoutResult> {
  const invoice = await loadFinalizedInvoice(invoiceId);
  const payment = await ensureInvoicePayment(invoice);

  await createStripeInvoiceLink(invoice.id);
  await markStripeSyncStarted(invoice.id);

  const stripe = getStripeClient();

  let stripeSessionId: string | null = null;
  let stripePaymentIntentId: string | null = null;
  let stripeUrl: string | null = null;

  try {
    const amountCents = toStripeAmount(invoice.totalUsd);

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: invoice.currency.toLowerCase(),
            unit_amount: amountCents,
            product_data: {
              name: `Invoice ${invoice.invoiceNumber}`,
              description: `Internal invoice for tenant ${invoice.tenantId}`,
            },
          },
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        invoice_id: invoice.id,
        invoice_number: invoice.invoiceNumber,
        invoice_payment_id: payment.id,
        tenant_id: invoice.tenantId,
      },
    });

    stripeSessionId = session.id;
    stripeUrl = session.url ?? null;
    if (typeof session.payment_intent === "string") {
      stripePaymentIntentId = session.payment_intent;
    }

    await markStripeSyncSucceeded(invoice.id, {
      stripeCheckoutSessionId: stripeSessionId,
      stripePaymentIntentId: stripePaymentIntentId ?? undefined,
    });

    console.log(
      `[ai/stripe-checkout] Checkout created for invoice ${invoice.invoiceNumber}: session=${stripeSessionId}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markStripeSyncFailed(invoice.id, msg);
    throw new Error(`[ai/stripe-checkout] Stripe checkout creation failed: ${msg}`);
  }

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    invoiceTotalUsd: String(invoice.totalUsd),
    invoicePaymentId: payment.id,
    stripeSessionId,
    stripePaymentIntentId,
    stripeUrl,
    mode: "checkout",
  };
}

/**
 * Create a Stripe Payment Intent for a finalized invoice.
 * Amount is derived from internal invoice — never from caller input.
 */
export async function createStripePaymentIntentForInvoice(
  invoiceId: string,
): Promise<StripeCheckoutResult> {
  const invoice = await loadFinalizedInvoice(invoiceId);
  const payment = await ensureInvoicePayment(invoice);

  await createStripeInvoiceLink(invoice.id);
  await markStripeSyncStarted(invoice.id);

  const stripe = getStripeClient();

  let stripePaymentIntentId: string | null = null;

  try {
    const amountCents = toStripeAmount(invoice.totalUsd);

    const intent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: invoice.currency.toLowerCase(),
      metadata: {
        invoice_id: invoice.id,
        invoice_number: invoice.invoiceNumber,
        invoice_payment_id: payment.id,
        tenant_id: invoice.tenantId,
      },
    });

    stripePaymentIntentId = intent.id;

    await markStripeSyncSucceeded(invoice.id, {
      stripePaymentIntentId,
    });

    console.log(
      `[ai/stripe-checkout] Payment intent created for invoice ${invoice.invoiceNumber}: pi=${stripePaymentIntentId}`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await markStripeSyncFailed(invoice.id, msg);
    throw new Error(`[ai/stripe-checkout] Stripe payment intent creation failed: ${msg}`);
  }

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    invoiceTotalUsd: String(invoice.totalUsd),
    invoicePaymentId: payment.id,
    stripeSessionId: null,
    stripePaymentIntentId,
    stripeUrl: null,
    mode: "payment_intent",
  };
}

/**
 * Get current Stripe state for a finalized invoice without creating anything.
 */
export async function getStripeCheckoutState(
  invoiceId: string,
): Promise<StripeCheckoutState | null> {
  const rows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (rows.length === 0) return null;
  const invoice = rows[0];

  const [payment, stripeLink] = await Promise.all([
    getInvoicePaymentByInvoiceId(invoiceId),
    getStripeInvoiceLink(invoiceId),
  ]);

  return {
    invoiceId: invoice.id,
    invoiceNumber: invoice.invoiceNumber,
    invoiceStatus: invoice.status,
    invoiceTotalUsd: String(invoice.totalUsd),
    payment,
    stripeLink,
  };
}
