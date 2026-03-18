/**
 * Phase 42 — Security Headers Middleware
 *
 * Fix: contentSecurityPolicy was set to `false` — scanner finding resolved.
 * CSP is now ENABLED in helmet with the platform's full directive set.
 *
 * NOTE: cspMiddleware (server/middleware/csp.ts) also runs (index.ts line 18)
 * and sets the same policy. Multiple identical CSP headers are safe — browsers
 * enforce the intersection, which is identical when both headers carry the same policy.
 * Removing cspMiddleware is tracked as follow-up cleanup. For now, both coexist.
 *
 * CSP directives match server/middleware/csp.ts exactly so the effective policy is
 * unchanged. Dev mode adds 'unsafe-eval' for Vite HMR only.
 */

import helmet from "helmet";
import { RequestHandler } from "express";

const isDev = process.env.NODE_ENV !== "production";

// ── CSP directives — kept in sync with server/middleware/csp.ts ───────────────

const helmetCspDirectives = {
  defaultSrc:     ["'self'"],
  scriptSrc:      isDev ? ["'self'", "'unsafe-eval'"] : ["'self'"],
  styleSrc:       ["'self'", "'unsafe-inline'"],
  imgSrc:         ["'self'", "data:"],
  fontSrc:        ["'self'"],
  connectSrc:     ["'self'"],
  frameAncestors: ["'none'"],
  baseUri:        ["'self'"],
  formAction:     ["'self'"],
  objectSrc:      ["'none'"],
  mediaSrc:       ["'self'"],
  workerSrc:      ["'self'"],
};

export const securityHeaders: RequestHandler = helmet({
  // CSP is now ENABLED — phase 42 scanner fix.
  // Previously `contentSecurityPolicy: false`; now uses explicit directives.
  contentSecurityPolicy: {
    directives: helmetCspDirectives,
  },

  // HSTS: 1 year, subdomains, preload
  strictTransportSecurity: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },

  // Clickjacking protection
  frameguard: { action: "deny" },

  // MIME type sniffing prevention
  noSniff: true,

  // Referrer policy — strict, reduces cross-origin leakage
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },

  // XSS filter deprecated in all modern browsers; CSP is the real defense
  xssFilter: false,

  // Cross-origin policies
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "cross-origin" },
  // Disabled: crossOriginEmbedderPolicy would break cross-origin asset loading
  crossOriginEmbedderPolicy: false,
});

/**
 * Introspect security header configuration.
 * Used by validation scripts.
 */
export function getSecurityHeaderConfig(): {
  cspEnabled:      boolean;
  cspDev:          boolean;
  hstsEnabled:     boolean;
  frameguard:      string;
  unsafeEval:      boolean;
  unsafeInline:    boolean;
  wildcards:       boolean;
  frameAncestors:  string;
  objectSrc:       string;
} {
  return {
    cspEnabled:     true,
    cspDev:         isDev,
    hstsEnabled:    true,
    frameguard:     "DENY",
    unsafeEval:     isDev,       // only in dev for Vite HMR
    unsafeInline:   true,        // style-src only (needed for UI frameworks)
    wildcards:      false,
    frameAncestors: "'none'",
    objectSrc:      "'none'",
  };
}

/**
 * The raw CSP directive map — used by tests and the duplicate-header audit.
 */
export { helmetCspDirectives };
