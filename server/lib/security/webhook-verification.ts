/**
 * Phase 39 — Webhook Signature Verification
 * Generic HMAC signature verification for incoming webhooks.
 *
 * Rules:
 *  - Verify BEFORE processing payload
 *  - Use constant-time comparison
 *  - Replay protection via timestamp tolerance
 *  - Log all failures as security events
 *  - NEVER log webhook secrets or raw bodies if sensitive
 */

import crypto from "crypto";
import type { Request } from "express";

// ── Timestamp tolerance ───────────────────────────────────────────────────────

export const DEFAULT_TIMESTAMP_TOLERANCE_SECONDS = 300; // 5 minutes

// ── Provider definitions ──────────────────────────────────────────────────────

export type WebhookProvider = "stripe" | "generic" | "internal";

export interface WebhookVerificationResult {
  verified:  boolean;
  provider:  WebhookProvider;
  reason:    string;
  eventType: string | null;
  timestamp: number | null;
}

// ── Constant-time HMAC comparison ─────────────────────────────────────────────

function hmacSha256Hex(payload: string | Buffer, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // prevent timing leak
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ── Generic HMAC verification ─────────────────────────────────────────────────

/**
 * Verify a raw HMAC-SHA256 signature.
 * signature should be the hex digest (or "sha256=<hex>" format).
 */
export function verifyHmacSignature(
  rawBody:   string | Buffer,
  signature: string,
  secret:    string,
): boolean {
  if (!signature || !secret) return false;
  const sig     = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const expected = hmacSha256Hex(rawBody, secret);
  return constantTimeEqual(expected, sig.toLowerCase());
}

/**
 * Verify an HMAC signature that includes a timestamp for replay protection.
 * Format: timestamp.body signed together.
 */
export function verifyTimestampedSignature(
  rawBody:              string | Buffer,
  signature:            string,
  timestamp:            string | number,
  secret:               string,
  toleranceSeconds:     number = DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
): { valid: boolean; reason: string } {
  if (!signature || !secret || !timestamp) {
    return { valid: false, reason: "missing_fields" };
  }

  const ts  = Number(timestamp);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) {
    return { valid: false, reason: "timestamp_out_of_tolerance" };
  }

  const payload  = `${ts}.${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`;
  const sig      = signature.startsWith("sha256=") ? signature.slice(7) : signature;
  const expected = hmacSha256Hex(payload, secret);
  const valid    = constantTimeEqual(expected, sig.toLowerCase());

  return { valid, reason: valid ? "ok" : "signature_mismatch" };
}

// ── Stripe webhook verification ───────────────────────────────────────────────

export function verifyStripeWebhook(
  rawBody:           Buffer | string,
  stripeSignature:   string,
  webhookSecret:     string,
  toleranceSeconds:  number = DEFAULT_TIMESTAMP_TOLERANCE_SECONDS,
): WebhookVerificationResult {
  // Stripe signature format: t=<timestamp>,v1=<sig1>[,v1=<sig2>]
  if (!stripeSignature) {
    return { verified: false, provider: "stripe", reason: "missing_signature_header", eventType: null, timestamp: null };
  }

  const parts:  Record<string, string> = {};
  for (const chunk of stripeSignature.split(",")) {
    const [k, v] = chunk.split("=");
    if (k && v) parts[k.trim()] = v.trim();
  }

  const ts = Number(parts["t"]);
  if (!ts) {
    return { verified: false, provider: "stripe", reason: "missing_timestamp", eventType: null, timestamp: null };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > toleranceSeconds) {
    return { verified: false, provider: "stripe", reason: "timestamp_out_of_tolerance", eventType: null, timestamp: ts };
  }

  const v1Sigs = Object.entries(parts)
    .filter(([k]) => k === "v1")
    .map(([, v]) => v);

  if (!v1Sigs.length) {
    return { verified: false, provider: "stripe", reason: "no_v1_signature", eventType: null, timestamp: ts };
  }

  const payload  = `${ts}.${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`;
  const expected = hmacSha256Hex(payload, webhookSecret);

  const anyMatch = v1Sigs.some(sig => constantTimeEqual(expected, sig.toLowerCase()));

  return {
    verified:  anyMatch,
    provider:  "stripe",
    reason:    anyMatch ? "ok" : "signature_mismatch",
    eventType: null, // caller parses event type from body after verification
    timestamp: ts,
  };
}

// ── Generic webhook verification ──────────────────────────────────────────────

export function verifyGenericWebhook(
  rawBody:   Buffer | string,
  headers:   Record<string, string | string[] | undefined>,
  secret:    string,
): WebhookVerificationResult {
  const sig = (
    headers["x-hub-signature-256"] ??
    headers["x-webhook-signature"] ??
    headers["x-signature-256"] ??
    headers["x-signature"] ??
    ""
  );

  const signature = Array.isArray(sig) ? sig[0] : sig;

  if (!signature) {
    return { verified: false, provider: "generic", reason: "no_signature_header", eventType: null, timestamp: null };
  }

  const verified = verifyHmacSignature(rawBody, signature, secret);
  return {
    verified,
    provider:  "generic",
    reason:    verified ? "ok" : "signature_mismatch",
    eventType: null,
    timestamp: null,
  };
}

// ── assertVerifiedWebhook (middleware-style) ──────────────────────────────────

export class WebhookVerificationError extends Error {
  readonly provider:  WebhookProvider;
  readonly reason:    string;
  constructor(provider: WebhookProvider, reason: string) {
    super(`Webhook verification failed [${provider}]: ${reason}`);
    this.name     = "WebhookVerificationError";
    this.provider = provider;
    this.reason   = reason;
  }
}

export function assertVerifiedWebhook(
  provider: WebhookProvider,
  rawBody:  Buffer | string,
  headers:  Record<string, string | string[] | undefined>,
  secret:   string,
): WebhookVerificationResult {
  let result: WebhookVerificationResult;

  if (provider === "stripe") {
    const sig = (headers["stripe-signature"] ?? "") as string;
    result = verifyStripeWebhook(rawBody, sig, secret);
  } else {
    result = verifyGenericWebhook(rawBody, headers, secret);
  }

  if (!result.verified) {
    throw new WebhookVerificationError(provider, result.reason);
  }

  return result;
}

// ── Verification stats ────────────────────────────────────────────────────────

interface VerificationRecord {
  provider:  WebhookProvider;
  success:   boolean;
  reason:    string;
  at:        number;
}

const verificationLog: VerificationRecord[] = [];
const MAX_LOG_SIZE = 500;

export function recordWebhookVerification(result: WebhookVerificationResult): void {
  verificationLog.unshift({ provider: result.provider, success: result.verified, reason: result.reason, at: Date.now() });
  if (verificationLog.length > MAX_LOG_SIZE) verificationLog.length = MAX_LOG_SIZE;
}

export function getWebhookVerificationStats(): {
  total:    number;
  failures: number;
  recentFailures: Array<{ provider: string; reason: string; at: string }>;
} {
  const failures = verificationLog.filter(r => !r.success);
  return {
    total:    verificationLog.length,
    failures: failures.length,
    recentFailures: failures.slice(0, 20).map(r => ({
      provider: r.provider,
      reason:   r.reason,
      at:       new Date(r.at).toISOString(),
    })),
  };
}
