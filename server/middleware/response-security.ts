/**
 * Phase 13.2 — Response Header Hardening
 *
 * Explicitly sets final security response headers after helmet.
 * Ensures deterministic values regardless of helmet version drift.
 *
 * These headers override or complement helmet defaults:
 * - X-Frame-Options: DENY (stricter than helmet's SAMEORIGIN)
 * - X-Content-Type-Options: nosniff
 * - Referrer-Policy: strict-origin-when-cross-origin
 * - Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
 * - X-Permitted-Cross-Domain-Policies: none
 * - Cache-Control: no-store for /api responses (prevent sensitive data caching)
 *
 * INV-SEC-H1: Security headers must be present on live responses.
 */

import type { Request, Response, NextFunction } from "express";

const RESPONSE_SECURITY_HEADERS: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Permitted-Cross-Domain-Policies": "none",
  "X-Download-Options": "noopen",
};

export function responseSecurityMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  for (const [header, value] of Object.entries(RESPONSE_SECURITY_HEADERS)) {
    res.setHeader(header, value);
  }

  // Prevent API responses from being cached by proxies / browsers
  if (req.path.startsWith("/api")) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
  }

  next();
}

// ── Introspection ─────────────────────────────────────────────────────────────

export function getResponseSecurityHeaders(): Record<string, string> {
  return { ...RESPONSE_SECURITY_HEADERS };
}
