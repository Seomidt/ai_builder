/**
 * Phase 22 — Webhook Handler
 * Processes Stripe webhook events idempotently.
 *
 * Supported events:
 *   customer.created
 *   invoice.payment_succeeded
 *   invoice.payment_failed
 *   customer.subscription.updated
 *   customer.subscription.deleted
 *
 * Idempotency: every event is logged to stripe_webhook_events.
 * Duplicate events (same stripe event ID) are skipped.
 */

import { db } from "../../db";
import { stripeWebhookEvents } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";
import { STRIPE_EVENT_TYPES, type StripeEvent } from "./stripe-client";
import { upsertStripeCustomer, getTenantFromStripeCustomer } from "./customer-service";
import { createStripeSubscription, updateStripeSubscription, cancelStripeSubscription } from "./subscription-service";
import { upsertStripeInvoice, markInvoicePaid, markInvoicePaymentFailed } from "./invoice-service";

export interface WebhookResult {
  eventId: string;
  eventType: string;
  tenantId: string | null;
  action: string;
  skipped: boolean;
  error?: string;
}

/**
 * Check if a Stripe event has already been processed (idempotency check).
 */
export async function isEventAlreadyProcessed(stripeEventId: string): Promise<boolean> {
  const rows = await db.execute(drizzleSql`
    SELECT 1 FROM stripe_webhook_events WHERE stripe_event_id = ${stripeEventId} LIMIT 1
  `);
  return rows.rows.length > 0;
}

/**
 * Log a processed webhook event.
 * Uses raw SQL to accommodate the existing stripe_webhook_events table structure
 * (columns: processing_status, last_error, payload — set from prior phases).
 */
async function logWebhookEvent(params: {
  stripeEventId: string;
  eventType: string;
  tenantId?: string | null;
  status: "processed" | "failed" | "skipped";
  error?: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  // Map Phase 22 status to the existing column name
  await db.execute(drizzleSql`
    INSERT INTO stripe_webhook_events
      (stripe_event_id, event_type, tenant_id, processing_status, processed_at, last_error, payload)
    VALUES (
      ${params.stripeEventId},
      ${params.eventType},
      ${params.tenantId ?? null},
      ${params.status},
      NOW(),
      ${params.error ?? null},
      ${JSON.stringify(params.payload ?? {})}::jsonb
    )
    ON CONFLICT (stripe_event_id) DO NOTHING
  `);
}

/**
 * Main webhook dispatcher.
 * Routes events to the appropriate handler and ensures idempotency.
 */
export async function handleStripeWebhook(event: StripeEvent): Promise<WebhookResult> {
  // Idempotency: skip already-processed events
  if (await isEventAlreadyProcessed(event.id)) {
    return {
      eventId: event.id,
      eventType: event.type,
      tenantId: null,
      action: "skipped (already processed)",
      skipped: true,
    };
  }

  let tenantId: string | null = null;
  let action = "unhandled";
  let error: string | undefined;

  try {
    switch (event.type) {
      case STRIPE_EVENT_TYPES.CUSTOMER_CREATED:
        ({ tenantId, action } = await handleCustomerCreated(event));
        break;
      case STRIPE_EVENT_TYPES.INVOICE_PAYMENT_SUCCEEDED:
        ({ tenantId, action } = await handleInvoicePaymentSucceeded(event));
        break;
      case STRIPE_EVENT_TYPES.INVOICE_PAYMENT_FAILED:
        ({ tenantId, action } = await handleInvoicePaymentFailed(event));
        break;
      case STRIPE_EVENT_TYPES.SUBSCRIPTION_UPDATED:
        ({ tenantId, action } = await handleSubscriptionUpdated(event));
        break;
      case STRIPE_EVENT_TYPES.SUBSCRIPTION_DELETED:
        ({ tenantId, action } = await handleSubscriptionDeleted(event));
        break;
      default:
        action = `unhandled event type: ${event.type}`;
    }

    await logWebhookEvent({
      stripeEventId: event.id,
      eventType: event.type,
      tenantId,
      status: "processed",
    });
  } catch (err) {
    error = (err as Error).message;
    await logWebhookEvent({
      stripeEventId: event.id,
      eventType: event.type,
      tenantId,
      status: "failed",
      error,
    });
    return { eventId: event.id, eventType: event.type, tenantId, action, skipped: false, error };
  }

  return { eventId: event.id, eventType: event.type, tenantId, action, skipped: false };
}

// ── Event handlers ─────────────────────────────────────────────────────────────

async function handleCustomerCreated(event: StripeEvent): Promise<{ tenantId: string | null; action: string }> {
  const obj = event.data.object;
  const stripeCustomerId = obj.id as string;
  const metadata = (obj.metadata as Record<string, string>) ?? {};
  const tenantId = metadata.tenant_id ?? null;

  if (!tenantId) return { tenantId: null, action: "customer.created: no tenant_id in metadata, skipped" };

  await upsertStripeCustomer({
    tenantId,
    email: obj.email as string | undefined,
    stripeCustomerId,
    metadata,
  });

  return { tenantId, action: "customer.created: upserted stripe customer" };
}

async function handleInvoicePaymentSucceeded(event: StripeEvent): Promise<{ tenantId: string | null; action: string }> {
  const obj = event.data.object;
  const stripeInvoiceId = obj.id as string;
  const stripeCustomerId = obj.customer as string;
  const stripeSubId = obj.subscription as string | undefined;
  const amount = obj.amount_paid as number ?? 0;
  const currency = (obj.currency as string) ?? "usd";

  const tenantId = await getTenantFromStripeCustomer(stripeCustomerId);

  // Upsert invoice with paid status (idempotent)
  const existing = await import("./invoice-service").then((m) => m.getStripeInvoice(stripeInvoiceId));
  if (existing) {
    await markInvoicePaid(stripeInvoiceId);
  } else {
    await upsertStripeInvoice({
      stripeInvoiceId,
      tenantId: tenantId ?? "unknown",
      stripeCustomerId,
      stripeSubscriptionId: stripeSubId,
      amount,
      currency,
      status: "paid",
      paidAt: new Date(),
    });
  }

  return { tenantId, action: "invoice.payment_succeeded: marked paid" };
}

async function handleInvoicePaymentFailed(event: StripeEvent): Promise<{ tenantId: string | null; action: string }> {
  const obj = event.data.object;
  const stripeInvoiceId = obj.id as string;
  const stripeCustomerId = obj.customer as string;
  const stripeSubId = obj.subscription as string | undefined;
  const amount = obj.amount_due as number ?? 0;
  const currency = (obj.currency as string) ?? "usd";
  const errorMsg = (obj.last_payment_error as Record<string, string> | null)?.message ?? "Payment declined";

  const tenantId = await getTenantFromStripeCustomer(stripeCustomerId);

  const existing = await import("./invoice-service").then((m) => m.getStripeInvoice(stripeInvoiceId));
  if (existing) {
    await markInvoicePaymentFailed(stripeInvoiceId, errorMsg);
  } else {
    await upsertStripeInvoice({
      stripeInvoiceId,
      tenantId: tenantId ?? "unknown",
      stripeCustomerId,
      stripeSubscriptionId: stripeSubId,
      amount,
      currency,
      status: "open",
      paymentError: errorMsg,
    });
  }

  // Optionally: suspend tenant if repeated failures
  // (handled by runaway-protection or plan-lifecycle in Phase 20)

  return { tenantId, action: `invoice.payment_failed: recorded failure — ${errorMsg}` };
}

async function handleSubscriptionUpdated(event: StripeEvent): Promise<{ tenantId: string | null; action: string }> {
  const obj = event.data.object;
  const stripeSubId = obj.id as string;
  const status = obj.status as string;
  const cancelAtPeriodEnd = obj.cancel_at_period_end as boolean;
  const planKey = (obj.metadata as Record<string, string>)?.plan_key ?? "free";
  const periodEnd = obj.current_period_end
    ? new Date((obj.current_period_end as number) * 1000)
    : undefined;

  const { updated, tenantId } = await updateStripeSubscription(stripeSubId, {
    status,
    planKey,
    currentPeriodEnd: periodEnd,
    cancelAtPeriodEnd,
  });

  if (!updated) {
    // Subscription not in our DB yet — create it
    const stripeCustomerId = obj.customer as string;
    const tId = await getTenantFromStripeCustomer(stripeCustomerId);
    if (tId) {
      await createStripeSubscription({
        tenantId: tId,
        planKey,
        stripeSubscriptionId: stripeSubId,
        stripeCustomerId,
        status,
        currentPeriodEnd: periodEnd,
      });
      return { tenantId: tId, action: "subscription.updated: created missing subscription" };
    }
  }

  return { tenantId, action: `subscription.updated: status=${status}, plan=${planKey}` };
}

async function handleSubscriptionDeleted(event: StripeEvent): Promise<{ tenantId: string | null; action: string }> {
  const obj = event.data.object;
  const stripeSubId = obj.id as string;
  const { canceled, tenantId } = await cancelStripeSubscription(stripeSubId);
  return {
    tenantId,
    action: canceled ? "subscription.deleted: canceled subscription" : "subscription.deleted: not found, skipped",
  };
}

/**
 * Get webhook event log for a tenant (observability).
 * Uses processing_status column (actual DB column name).
 */
export async function getWebhookEventLog(params?: {
  tenantId?: string;
  eventType?: string;
  limit?: number;
}): Promise<Array<Record<string, unknown>>> {
  const limit = params?.limit ?? 50;
  const tenantClause = params?.tenantId
    ? drizzleSql`AND tenant_id = ${params.tenantId}`
    : drizzleSql``;
  const typeClause = params?.eventType
    ? drizzleSql`AND event_type = ${params.eventType}`
    : drizzleSql``;

  const rows = await db.execute(drizzleSql`
    SELECT stripe_event_id, event_type, tenant_id, processing_status AS status, processed_at, last_error AS error, received_at
    FROM stripe_webhook_events
    WHERE 1=1 ${tenantClause} ${typeClause}
    ORDER BY received_at DESC LIMIT ${limit}
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * Get webhook processing stats (observability).
 * Uses processing_status column (actual DB column name).
 */
export async function getWebhookStats(): Promise<{
  totalProcessed: number;
  totalFailed: number;
  totalSkipped: number;
  byEventType: Array<{ eventType: string; count: number }>;
}> {
  const stats = await db.execute(drizzleSql`
    SELECT
      COUNT(*) FILTER (WHERE processing_status = 'processed') AS total_processed,
      COUNT(*) FILTER (WHERE processing_status = 'failed') AS total_failed,
      COUNT(*) FILTER (WHERE processing_status = 'skipped') AS total_skipped
    FROM stripe_webhook_events
  `);
  const byType = await db.execute(drizzleSql`
    SELECT event_type, COUNT(*) AS cnt FROM stripe_webhook_events GROUP BY event_type ORDER BY cnt DESC
  `);
  const r = stats.rows[0] as Record<string, unknown>;
  return {
    totalProcessed: Number(r.total_processed ?? 0),
    totalFailed: Number(r.total_failed ?? 0),
    totalSkipped: Number(r.total_skipped ?? 0),
    byEventType: byType.rows.map((row: Record<string, unknown>) => ({
      eventType: row.event_type as string,
      count: Number(row.cnt ?? 0),
    })),
  };
}
