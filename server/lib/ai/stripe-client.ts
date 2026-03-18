/**
 * Stripe Client — Phase 4M
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Single source for the Stripe SDK client.
 * Configured from STRIPE_SECRET_KEY environment variable.
 *
 * Helpers:
 *   - getStripeClient()  — returns a configured Stripe instance (throws if unconfigured)
 *   - toStripeAmount()   — converts a USD amount (numeric/string) to integer cents
 */

import Stripe from "stripe";

let _client: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (_client) return _client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error(
      "[ai/stripe-client] STRIPE_SECRET_KEY is not set. Configure it as an environment variable.",
    );
  }
  _client = new Stripe(key, { apiVersion: "2026-02-25.clover" });
  return _client;
}

/**
 * Convert a USD amount (numeric string or number) to integer cents for Stripe.
 * Stripe requires integer amounts in smallest currency unit (cents for USD).
 *
 * Example: "12.50" → 1250, 12.5 → 1250, "0.01" → 1
 */
export function toStripeAmount(usdAmount: string | number): number {
  const cents = Math.round(Number(usdAmount) * 100);
  if (cents <= 0) {
    throw new Error(
      `[ai/stripe-client] Invalid Stripe amount: ${usdAmount} (must be > 0)`,
    );
  }
  return cents;
}

/**
 * Check whether Stripe is configured in this environment.
 * Use this before making Stripe API calls when graceful degradation is acceptable.
 */
export function isStripeConfigured(): boolean {
  return !!process.env.STRIPE_SECRET_KEY;
}

/**
 * Check whether webhook signature verification is configured.
 */
export function isWebhookSecretConfigured(): boolean {
  return !!process.env.STRIPE_WEBHOOK_SECRET;
}
