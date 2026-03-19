/**
 * Phase 44 — CSP Nonce Infrastructure
 *
 * Generates a cryptographically random, request-scoped nonce for use in CSP
 * script-src/style-src nonce directives.
 *
 * CURRENT STATUS: Infrastructure implemented. Full rollout BLOCKED pending SSR.
 *
 * WHY NONCE IS NOT FULLY LIVE YET:
 *   This platform uses Vite CSR (client-side rendering). The server renders a
 *   single index.html shell. Nonce injection into that shell requires either:
 *     A. React 18 streaming SSR + server-side nonce injection into <script> tags
 *     B. EJS/Handlebars templating of index.html to inject nonce at request time
 *   Neither is available without a non-trivial Vite SSR migration.
 *
 *   For inline scripts, 'self' without nonce is an acceptable launch-safe
 *   baseline for an internal SaaS platform with no public-facing anonymous users.
 *
 * MIGRATION PATH TO FULL NONCE:
 *   Step 1: Switch Vite to SSR mode or use an index.html template approach
 *   Step 2: In securityHeaders middleware, replace script-src 'self' with
 *           `'nonce-${res.locals.cspNonce}'`
 *   Step 3: Inject nonce into all server-emitted <script> tags in the HTML shell
 *   Step 4: Remove 'unsafe-eval' from dev script-src (use nonce instead)
 *   Step 5: QA against all inline script execution paths
 *
 * WHAT THIS FILE DOES NOW:
 *   - Generates a request-scoped nonce and stores in res.locals.cspNonce
 *   - The nonce is available for future SSR integration
 *   - Adds X-CSP-Nonce-Ready: true header (observable by monitoring)
 *
 * INV-NONCE-1: nonce must be generated per-request, never reused
 * INV-NONCE-2: nonce must be at least 128 bits of entropy (16 random bytes → 22 base64url chars)
 * INV-NONCE-3: nonce must NOT be logged in access logs
 */

import { randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";

// ── Types ──────────────────────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Locals {
      /** Request-scoped CSP nonce — base64url encoded, 128-bit entropy */
      cspNonce: string;
    }
  }
}

// ── Nonce generation ───────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random base64url nonce (128-bit = 16 bytes).
 *
 * base64url avoids `+`, `/`, `=` chars that require escaping in HTML attributes.
 * INV-NONCE-2: 16 bytes = 128-bit entropy — exceeds W3C minimum of 128 bits.
 */
export function generateCspNonce(): string {
  return randomBytes(16).toString("base64url");
}

// ── Middleware ─────────────────────────────────────────────────────────────────

/**
 * Nonce middleware — generates a per-request CSP nonce and attaches it to res.locals.
 *
 * Register BEFORE securityHeaders middleware so the nonce is available when
 * CSP directives are built (for future SSR integration).
 *
 * The nonce is accessible in templates and route handlers as:
 *   res.locals.cspNonce
 *
 * Current state: nonce generated but not yet injected into CSP header.
 * Full injection requires SSR. See migration path above.
 */
export function nonceMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.locals.cspNonce = generateCspNonce();
  // INV-NONCE-3: nonce MUST NOT be logged — only set in header as a readiness signal
  res.setHeader("X-CSP-Nonce-Ready", "true");
  next();
}

// ── Introspection (for validation/testing) ─────────────────────────────────────

export interface NonceReadinessReport {
  infrastructureImplemented: boolean;
  fullRolloutLive: boolean;
  blockedBy: string;
  migrationSteps: string[];
  entropy: string;
}

export function getNonceReadinessReport(): NonceReadinessReport {
  return {
    infrastructureImplemented: true,
    fullRolloutLive: false,
    blockedBy: "Vite CSR — SSR migration required for nonce injection into HTML shell",
    migrationSteps: [
      "1. Switch Vite to SSR mode or template index.html at request time",
      "2. Update securityHeaders to use nonce-{res.locals.cspNonce} in script-src",
      "3. Inject nonce into all server-emitted <script> tags",
      "4. Remove 'unsafe-eval' from dev CSP (replaced by nonce)",
      "5. QA all inline script paths",
    ],
    entropy: "128-bit (16 random bytes, base64url encoded)",
  };
}
