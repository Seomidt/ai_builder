/**
 * Phase 23 — Webhook Signature
 * HMAC-SHA256 signing and verification for outbound webhook payloads.
 *
 * Header name: X-Webhook-Signature
 * Format:      sha256=<hex-digest>
 */

import crypto from "crypto";

export const SIGNATURE_HEADER = "X-Webhook-Signature";
export const SIGNATURE_VERSION = "sha256";
export const TIMESTAMP_HEADER  = "X-Webhook-Timestamp";
export const DELIVERY_HEADER   = "X-Webhook-Delivery";
export const EVENT_TYPE_HEADER = "X-Webhook-Event";

/**
 * Sign a webhook payload using HMAC-SHA256.
 * Returns the full signature string: "sha256=<hex>"
 */
export function signPayload(secret: string, payload: string, timestamp?: string): string {
  if (!secret?.trim()) throw new Error("secret is required for signing");
  const ts = timestamp ?? String(Date.now());
  const message = `${ts}.${payload}`;
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(message, "utf8");
  const digest = hmac.digest("hex");
  return `${SIGNATURE_VERSION}=${digest}`;
}

/**
 * Verify a webhook signature.
 * Constant-time comparison to prevent timing attacks.
 */
export function verifySignature(params: {
  secret: string;
  signature: string;
  payload: string;
  timestamp?: string;
}): boolean {
  if (!params.secret?.trim()) return false;
  if (!params.signature?.trim()) return false;
  try {
    const expected = signPayload(params.secret, params.payload, params.timestamp);
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(params.signature, "utf8");
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/**
 * Build the complete set of headers for a webhook delivery.
 */
export function buildWebhookHeaders(params: {
  secret: string;
  payload: string;
  eventType: string;
  deliveryId: string;
}): Record<string, string> {
  const timestamp = String(Date.now());
  const signature = signPayload(params.secret, params.payload, timestamp);
  return {
    "Content-Type":      "application/json",
    [SIGNATURE_HEADER]:  signature,
    [TIMESTAMP_HEADER]:  timestamp,
    [DELIVERY_HEADER]:   params.deliveryId,
    [EVENT_TYPE_HEADER]: params.eventType,
    "User-Agent":        "AI-Builder-Webhooks/1.0",
  };
}

/**
 * Generate a cryptographically secure webhook secret.
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("hex"); // 64-char hex string
}

/**
 * Mask a secret for display (shows only last 4 chars).
 */
export function maskSecret(secret: string): string {
  if (!secret || secret.length < 8) return "****";
  return `****${secret.slice(-4)}`;
}

/**
 * Extract the hex digest from a "sha256=<hex>" signature string.
 */
export function extractDigest(signature: string): string | null {
  const match = signature.match(/^sha256=([a-f0-9]+)$/);
  return match ? match[1] : null;
}
