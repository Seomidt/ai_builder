/**
 * Phase 7 — Security Headers Middleware
 * INV-SEC6: Security headers must be present in all responses.
 */

import type { Request, Response, NextFunction } from "express";

const isDev = process.env.NODE_ENV !== "production";

// Content-Security-Policy — strict but compatible with Vite dev server
const CSP = isDev
  ? [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self' ws: wss:",
      "font-src 'self' data:",
      "frame-ancestors 'none'",
    ].join("; ")
  : [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "font-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; ");

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

  if (!isDev) {
    res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }

  // Remove fingerprinting headers
  res.removeHeader("X-Powered-By");
  res.removeHeader("Server");

  next();
}

export function explainSecurityHeaders(): {
  headers: Array<{ name: string; value: string; purpose: string }>;
  note: string;
} {
  return {
    headers: [
      { name: "Content-Security-Policy", value: CSP, purpose: "Prevents XSS by restricting content sources" },
      { name: "X-Frame-Options", value: "DENY", purpose: "Prevents clickjacking by disabling framing" },
      { name: "X-Content-Type-Options", value: "nosniff", purpose: "Prevents MIME-type sniffing" },
      { name: "Referrer-Policy", value: "strict-origin-when-cross-origin", purpose: "Controls referrer information" },
      { name: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload", purpose: "Enforces HTTPS (production only)" },
      { name: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()", purpose: "Restricts browser feature access" },
    ],
    note: "INV-SEC6: Applied to all responses. CSP relaxed in development for Vite HMR.",
  };
}
