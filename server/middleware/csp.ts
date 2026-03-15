/**
 * Phase 13.2 — Strict Content Security Policy
 *
 * Applies an explicit CSP header to all responses.
 * Dev mode adds 'unsafe-eval' to script-src only to support Vite HMR.
 * No wildcards in production.
 *
 * INV-SEC-H2: CSP must be explicit and deterministic.
 */

import type { Request, Response, NextFunction } from "express";

const isDev = process.env.NODE_ENV !== "production";

// ── CSP directive builder ─────────────────────────────────────────────────────

function buildCspValue(): string {
  const directives: string[] = [
    "default-src 'self'",
    // Dev adds 'unsafe-eval' for Vite HMR — explicitly gated on NODE_ENV
    isDev
      ? "script-src 'self' 'unsafe-eval'"
      : "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "media-src 'self'",
    "worker-src 'self'",
  ];

  return directives.join("; ");
}

// Pre-built value — deterministic per process lifetime
const CSP_VALUE = buildCspValue();

// ── Middleware ────────────────────────────────────────────────────────────────

export function cspMiddleware(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("Content-Security-Policy", CSP_VALUE);
  next();
}

// ── Introspection ─────────────────────────────────────────────────────────────

export interface CspConfig {
  value: string;
  isDev: boolean;
  unsafeEvalEnabled: boolean;
  wildcardEnabled: boolean;
}

export function getCspConfig(): CspConfig {
  return {
    value: CSP_VALUE,
    isDev,
    unsafeEvalEnabled: isDev,
    wildcardEnabled: false,
  };
}
