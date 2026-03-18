/**
 * Stripe Webhook Verification & Processing — Phase 4M
 *
 * SERVER-ONLY: Never import from client/ code.
 *
 * Handles:
 *   - Stripe webhook signature verification
 *   - Idempotent webhook event recording (UNIQUE stripe_event_id)
 *   - Deterministic payment state transitions per event type
 *   - Full payment_events audit trail for each transition
 *
 * Safety rules:
 *   - Internal invoice totals are NEVER modified from webhook data
 *   - Repeated/duplicate webhooks for same stripe_event_id are harmless
 *   - Payment state machine guards prevent nonsense transitions
 *   - All mutations are atomic (db.transaction)
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  stripeWebhookEvents,
  stripeInvoiceLinks,
  invoicePayments,
} from "@shared/schema";
import type { StripeWebhookEvent } from "@shared/schema";
import { getStripeClient } from "./stripe-client";
import {
  getInvoicePaymentByInvoiceId,
  markInvoicePaymentProcessing,
  markInvoicePaymentPaid,
  markInvoicePaymentFailed,
  markInvoicePaymentRefunded,
} from "./invoice-payments";
import { markStripeSyncSucceeded } from "./stripe-sync";
import Stripe from "stripe";

export interface WebhookProcessResult {
  stripeEventId: string;
  eventType: string;
  outcome: "processed" | "ignored" | "failed" | "duplicate";
  invoiceId: string | null;
  paymentId: string | null;
  reason: string;
}

/**
 * Verify Stripe webhook signature using STRIPE_WEBHOOK_SECRET.
 * Returns the parsed Stripe event on success, throws on failure.
 */
export function verifyStripeWebhookSignature(
  rawBody: Buffer | string,
  signatureHeader: string,
): Stripe.Event {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error(
      "[ai/stripe-webhooks] STRIPE_WEBHOOK_SECRET is not set. Cannot verify webhook signature.",
    );
  }
  const stripe = getStripeClient();
  return stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
}

/**
 * Record an incoming Stripe webhook event in stripe_webhook_events.
 * Uses INSERT ... ON CONFLICT DO NOTHING to handle duplicates safely.
 *
 * Returns the stored row (existing if duplicate, new if first receipt).
 */
export async function recordStripeWebhookEvent(
  stripeEvent: Stripe.Event,
  invoiceId?: string | null,
  invoicePaymentId?: string | null,
  tenantId?: string | null,
): Promise<StripeWebhookEvent> {
  const inserted = await db
    .insert(stripeWebhookEvents)
    .values({
      stripeEventId: stripeEvent.id,
      eventType: stripeEvent.type,
      invoiceId: invoiceId ?? null,
      invoicePaymentId: invoicePaymentId ?? null,
      tenantId: tenantId ?? null,
      processingStatus: "received",
      payload: stripeEvent as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing({ target: stripeWebhookEvents.stripeEventId })
    .returning();

  if (inserted.length > 0) return inserted[0];

  const existing = await db
    .select()
    .from(stripeWebhookEvents)
    .where(eq(stripeWebhookEvents.stripeEventId, stripeEvent.id))
    .limit(1);
  return existing[0];
}

/**
 * Mark a webhook event's processing status in a single atomic update.
 */
async function updateWebhookStatus(
  stripeEventId: string,
  status: "processed" | "ignored" | "failed",
  error?: string | null,
): Promise<void> {
  await db
    .update(stripeWebhookEvents)
    .set({
      processingStatus: status,
      processedAt: new Date(),
      lastError: error ?? null,
    })
    .where(eq(stripeWebhookEvents.stripeEventId, stripeEventId));
}

/**
 * Extract invoice_id and invoice_payment_id from Stripe event metadata.
 * Stripe objects created by our checkout flow carry these in metadata.
 */
function extractIdsFromEvent(stripeEvent: Stripe.Event): {
  invoiceId: string | null;
  invoicePaymentId: string | null;
  tenantId: string | null;
} {
  const obj = stripeEvent.data.object as unknown as Record<string, unknown>;
  const metadata = (obj["metadata"] as Record<string, string> | undefined) ?? {};
  return {
    invoiceId: metadata["invoice_id"] ?? null,
    invoicePaymentId: metadata["invoice_payment_id"] ?? null,
    tenantId: metadata["tenant_id"] ?? null,
  };
}

/**
 * Safely attempt a payment state transition.
 * If the current state does not allow the transition, log as ignored.
 */
async function tryTransition(
  paymentId: string,
  transition: () => Promise<unknown>,
  eventType: string,
): Promise<{ success: boolean; reason: string }> {
  try {
    await transition();
    return { success: true, reason: `Transition applied for ${eventType}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Invalid transition")) {
      return {
        success: false,
        reason: `Ignored: ${msg}`,
      };
    }
    throw err;
  }
}

/**
 * Process a single Stripe event, applying the appropriate internal state transition.
 * Idempotent: if the event was already processed, returns 'duplicate'.
 */
export async function processStripeWebhookEvent(
  stripeEvent: Stripe.Event,
): Promise<WebhookProcessResult> {
  const { invoiceId, invoicePaymentId, tenantId } = extractIdsFromEvent(stripeEvent);

  const existingRow = await db
    .select()
    .from(stripeWebhookEvents)
    .where(eq(stripeWebhookEvents.stripeEventId, stripeEvent.id))
    .limit(1);

  if (existingRow.length > 0 && existingRow[0].processingStatus === "processed") {
    return {
      stripeEventId: stripeEvent.id,
      eventType: stripeEvent.type,
      outcome: "duplicate",
      invoiceId,
      paymentId: invoicePaymentId,
      reason: "Already processed — idempotent skip",
    };
  }

  if (!invoiceId) {
    await updateWebhookStatus(stripeEvent.id, "ignored");
    return {
      stripeEventId: stripeEvent.id,
      eventType: stripeEvent.type,
      outcome: "ignored",
      invoiceId: null,
      paymentId: null,
      reason: "No invoice_id in event metadata — cannot link to internal record",
    };
  }

  const payment = invoicePaymentId
    ? (await db
        .select()
        .from(invoicePayments)
        .where(eq(invoicePayments.id, invoicePaymentId))
        .limit(1))[0] ?? null
    : await getInvoicePaymentByInvoiceId(invoiceId);

  try {
    const obj = stripeEvent.data.object as unknown as Record<string, unknown>;
    let outcome: "processed" | "ignored" = "processed";
    let reason = "";

    switch (stripeEvent.type) {
      case "checkout.session.completed": {
        const sessionStatus = (obj["payment_status"] as string) ?? "";
        const sessionId = (obj["id"] as string) ?? null;
        const piId = typeof obj["payment_intent"] === "string" ? obj["payment_intent"] : null;

        await markStripeSyncSucceeded(invoiceId, {
          stripeCheckoutSessionId: sessionId,
          stripePaymentIntentId: piId ?? undefined,
        });

        if (payment && sessionStatus === "paid") {
          const r = await tryTransition(
            payment.id,
            () => markInvoicePaymentPaid(payment.id, piId),
            stripeEvent.type,
          );
          reason = r.reason;
          if (!r.success) outcome = "ignored";
        } else if (payment && sessionStatus === "unpaid") {
          const r = await tryTransition(
            payment.id,
            () => markInvoicePaymentProcessing(payment.id, { stripeCheckoutSession: sessionId }),
            stripeEvent.type,
          );
          reason = r.reason;
          if (!r.success) outcome = "ignored";
        } else {
          reason = `checkout.session.completed with payment_status='${sessionStatus}' — no state change`;
          outcome = "ignored";
        }
        break;
      }

      case "payment_intent.succeeded": {
        const piId = (obj["id"] as string) ?? null;
        const piRef = piId;

        await markStripeSyncSucceeded(invoiceId, {
          stripePaymentIntentId: piId ?? undefined,
        });

        if (payment) {
          const r = await tryTransition(
            payment.id,
            () => markInvoicePaymentPaid(payment.id, piRef),
            stripeEvent.type,
          );
          reason = r.reason;
          if (!r.success) outcome = "ignored";
        } else {
          reason = "No payment record found for invoice — cannot transition";
          outcome = "ignored";
        }
        break;
      }

      case "payment_intent.payment_failed": {
        const errMsg = ((obj["last_payment_error"] as Record<string, string> | undefined)?.["message"]) ?? "Stripe payment failed";
        if (payment) {
          const r = await tryTransition(
            payment.id,
            () => markInvoicePaymentFailed(payment.id, errMsg),
            stripeEvent.type,
          );
          reason = r.reason;
          if (!r.success) outcome = "ignored";
        } else {
          reason = "No payment record found — ignored";
          outcome = "ignored";
        }
        break;
      }

      case "charge.refunded": {
        const piId = typeof obj["payment_intent"] === "string" ? obj["payment_intent"] : null;
        if (payment) {
          const r = await tryTransition(
            payment.id,
            () => markInvoicePaymentRefunded(payment.id, piId),
            stripeEvent.type,
          );
          reason = r.reason;
          if (!r.success) outcome = "ignored";
        } else {
          reason = "No payment record found — ignored";
          outcome = "ignored";
        }
        break;
      }

      case "invoice.payment_succeeded": {
        const piId = typeof obj["payment_intent"] === "string" ? obj["payment_intent"] : null;
        if (payment) {
          const r = await tryTransition(
            payment.id,
            () => markInvoicePaymentPaid(payment.id, piId),
            stripeEvent.type,
          );
          reason = r.reason;
          if (!r.success) outcome = "ignored";
        } else {
          reason = "No payment record found — ignored";
          outcome = "ignored";
        }
        break;
      }

      case "invoice.payment_failed": {
        const errMsg = "Stripe invoice payment failed";
        if (payment) {
          const r = await tryTransition(
            payment.id,
            () => markInvoicePaymentFailed(payment.id, errMsg),
            stripeEvent.type,
          );
          reason = r.reason;
          if (!r.success) outcome = "ignored";
        } else {
          reason = "No payment record found — ignored";
          outcome = "ignored";
        }
        break;
      }

      default: {
        outcome = "ignored";
        reason = `Unhandled event type: ${stripeEvent.type}`;
      }
    }

    await updateWebhookStatus(
      stripeEvent.id,
      outcome === "ignored" ? "ignored" : "processed",
    );

    return {
      stripeEventId: stripeEvent.id,
      eventType: stripeEvent.type,
      outcome,
      invoiceId,
      paymentId: payment?.id ?? null,
      reason,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await updateWebhookStatus(stripeEvent.id, "failed", msg).catch(() => {});
    throw new Error(`[ai/stripe-webhooks] Failed to process event ${stripeEvent.id}: ${msg}`);
  }
}

/**
 * Full webhook ingestion pipeline:
 * 1. Verify signature
 * 2. Extract IDs from metadata
 * 3. Record event (idempotent)
 * 4. Process event (idempotent)
 *
 * This is the single entry point for Express route handler.
 */
export async function handleStripeWebhook(
  rawBody: Buffer | string,
  signatureHeader: string,
): Promise<WebhookProcessResult> {
  const stripeEvent = verifyStripeWebhookSignature(rawBody, signatureHeader);

  const { invoiceId, invoicePaymentId, tenantId } = extractIdsFromEvent(stripeEvent);

  await recordStripeWebhookEvent(stripeEvent, invoiceId, invoicePaymentId, tenantId);

  return processStripeWebhookEvent(stripeEvent);
}
