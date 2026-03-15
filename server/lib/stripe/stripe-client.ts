/**
 * Phase 22 — Stripe Client
 * Provides a simulated Stripe-compatible client for the internal control plane.
 * Architecture is production-ready: swap simulatedStripe for real Stripe SDK when
 * a live Stripe integration is connected.
 *
 * In production with real Stripe: replace this module with stripe-replit-sync
 * getUncachableStripeClient() per the Stripe skill.
 */

import crypto from "crypto";

export const STRIPE_API_VERSION = "2024-06-20";

// ── Stripe-like ID generators ─────────────────────────────────────────────────

export function generateStripeId(prefix: string): string {
  const rand = crypto.randomBytes(12).toString("hex");
  return `${prefix}_${rand}`;
}

export const stripeIds = {
  customer: () => generateStripeId("cus"),
  subscription: () => generateStripeId("sub"),
  invoice: () => generateStripeId("in"),
  event: () => generateStripeId("evt"),
  paymentIntent: () => generateStripeId("pi"),
  charge: () => generateStripeId("ch"),
};

// ── Stripe plan → price mapping ────────────────────────────────────────────────

export const STRIPE_PLAN_PRICE_MAP: Record<string, { monthly: number; yearly: number; currency: string }> = {
  free:         { monthly: 0,       yearly: 0,       currency: "usd" },
  starter:      { monthly: 2900,    yearly: 29000,   currency: "usd" }, // $29/mo, $290/yr
  professional: { monthly: 9900,    yearly: 99000,   currency: "usd" }, // $99/mo, $990/yr
  enterprise:   { monthly: 49900,   yearly: 499000,  currency: "usd" }, // $499/mo, $4990/yr
};

/**
 * Get the subscription amount for a plan key (monthly, in cents).
 */
export function getPlanAmount(planKey: string): number {
  return STRIPE_PLAN_PRICE_MAP[planKey]?.monthly ?? 0;
}

// ── Stripe event type constants ────────────────────────────────────────────────

export const STRIPE_EVENT_TYPES = {
  CUSTOMER_CREATED:           "customer.created",
  CUSTOMER_UPDATED:           "customer.updated",
  CUSTOMER_DELETED:           "customer.deleted",
  SUBSCRIPTION_CREATED:       "customer.subscription.created",
  SUBSCRIPTION_UPDATED:       "customer.subscription.updated",
  SUBSCRIPTION_DELETED:       "customer.subscription.deleted",
  INVOICE_CREATED:            "invoice.created",
  INVOICE_PAYMENT_SUCCEEDED:  "invoice.payment_succeeded",
  INVOICE_PAYMENT_FAILED:     "invoice.payment_failed",
  INVOICE_FINALIZED:          "invoice.finalized",
  PAYMENT_INTENT_SUCCEEDED:   "payment_intent.succeeded",
  PAYMENT_INTENT_FAILED:      "payment_intent.payment_failed",
} as const;

export type StripeEventType = typeof STRIPE_EVENT_TYPES[keyof typeof STRIPE_EVENT_TYPES];

// ── Simulated Stripe event builder ─────────────────────────────────────────────

export interface StripeEvent {
  id: string;
  type: StripeEventType | string;
  created: number;
  data: {
    object: Record<string, unknown>;
    previous_attributes?: Record<string, unknown>;
  };
  livemode: boolean;
  api_version: string;
}

export function buildStripeEvent(
  type: StripeEventType | string,
  object: Record<string, unknown>,
  previousAttributes?: Record<string, unknown>,
): StripeEvent {
  return {
    id: stripeIds.event(),
    type,
    created: Math.floor(Date.now() / 1000),
    data: { object, previous_attributes: previousAttributes },
    livemode: false,
    api_version: STRIPE_API_VERSION,
  };
}

// ── Stripe customer object builder ─────────────────────────────────────────────

export function buildStripeCustomerObject(params: {
  customerId: string;
  email?: string;
  tenantId: string;
  metadata?: Record<string, string>;
}): Record<string, unknown> {
  return {
    id: params.customerId,
    object: "customer",
    email: params.email ?? null,
    created: Math.floor(Date.now() / 1000),
    metadata: { tenant_id: params.tenantId, ...(params.metadata ?? {}) },
    livemode: false,
  };
}

// ── Stripe subscription object builder ────────────────────────────────────────

export function buildStripeSubscriptionObject(params: {
  subscriptionId: string;
  customerId: string;
  planKey: string;
  status?: string;
  cancelAtPeriodEnd?: boolean;
}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  const periodEnd = now + 30 * 24 * 3600; // 30 days
  const amount = getPlanAmount(params.planKey);
  return {
    id: params.subscriptionId,
    object: "subscription",
    customer: params.customerId,
    status: params.status ?? "active",
    cancel_at_period_end: params.cancelAtPeriodEnd ?? false,
    current_period_start: now,
    current_period_end: periodEnd,
    metadata: { plan_key: params.planKey },
    plan: { amount, currency: "usd", interval: "month" },
    livemode: false,
  };
}

// ── Stripe invoice object builder ─────────────────────────────────────────────

export function buildStripeInvoiceObject(params: {
  invoiceId: string;
  customerId: string;
  subscriptionId?: string;
  tenantId: string;
  planKey: string;
  status?: string;
  paymentError?: string;
}): Record<string, unknown> {
  const amount = getPlanAmount(params.planKey);
  const now = Math.floor(Date.now() / 1000);
  return {
    id: params.invoiceId,
    object: "invoice",
    customer: params.customerId,
    subscription: params.subscriptionId ?? null,
    amount_due: amount,
    amount_paid: params.status === "paid" ? amount : 0,
    currency: "usd",
    status: params.status ?? "open",
    created: now,
    metadata: { tenant_id: params.tenantId, plan_key: params.planKey },
    last_payment_error: params.paymentError
      ? { message: params.paymentError, type: "card_error" }
      : null,
    livemode: false,
  };
}
