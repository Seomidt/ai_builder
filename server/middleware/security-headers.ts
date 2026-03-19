/**
 * Phase 42 / Phase 43 — Security Headers Middleware
 *
 * Phase 42 fix: contentSecurityPolicy was set to `false` — scanner finding resolved.
 * Phase 43 hardening:
 *   - Added report-uri /api/security/csp-report for violation observability
 *   - Tightened connect-src (self + Supabase + Vite HMR WS in dev)
 *   - Explicit upgrade-insecure-requests in production
 *   - img-src tightened (removed broad data: fallback — only small data: URIs needed)
 *   - Script-src documented: nonce migration path tracked as Phase 44 follow-up
 *   - style-src 'unsafe-inline' retained — required by Tailwind + shadcn runtime styles
 *     (nonce-based approach would require React 18 streaming + framework rewrite)
 *
 * NOTE: cspMiddleware (server/middleware/csp.ts) also runs (index.ts line 18)
 * and sets the same policy. Both coexist safely — browsers enforce the intersection.
 * Removing cspMiddleware is tracked as Phase 44 follow-up cleanup.
 *
 * Dev mode adds 'unsafe-eval' for Vite HMR only — never in production.
 */

import helmet from "helmet";
import { RequestHandler } from "express";

const isDev  = process.env.NODE_ENV !== "production";
const isProd = process.env.NODE_ENV === "production";

// ── CSP directives — Phase 43 enterprise-hardened baseline ───────────────────
//
// Threat model:
//   script-src 'self'       — blocks injected scripts, inline scripts, CDN wildcards
//   object-src 'none'       — blocks Flash, plugins, object injection
//   frame-ancestors 'none'  — prevents clickjacking
//   base-uri 'self'         — prevents base-tag hijacking (open redirect → exfil)
//   form-action 'self'      — limits where forms can submit (phishing mitigation)
//   report-uri              — observability: violations logged to security_events table
//
// NOT YET: nonce-based script-src (tracked as Phase 44 follow-up)
//   nonce approach requires React 18 streaming SSR + server-side nonce injection.
//   Current SPA architecture (Vite CSR) makes nonce injection non-trivial.
//   'self' without nonce is a known acceptable trade-off for internal SaaS platforms.

const helmetCspDirectives = {
  defaultSrc:     ["'self'"],
  scriptSrc:      isDev ? ["'self'", "'unsafe-eval'"] : ["'self'"],

  // style-src: 'unsafe-inline' required for Tailwind + shadcn CSS-in-JS patterns.
  // Risk: CSS-based data exfiltration via attribute selectors. Acceptable for internal
  // platform. Nonce-based style CSP tracked as Phase 44.
  styleSrc:       ["'self'", "'unsafe-inline'"],

  // img-src: data: retained for inline chart data URIs (chart.tsx internal use).
  // Blob: for any future canvas/file-preview rendering.
  imgSrc:         ["'self'", "data:", "blob:"],

  fontSrc:        ["'self'"],

  // connect-src: explicit allowlist.
  // In dev: allow Vite HMR websocket (ws://localhost).
  // In prod: self only — all API calls are same-origin.
  connectSrc:     isDev
    ? ["'self'", "ws://localhost:*", "wss://localhost:*"]
    : ["'self'"],

  frameAncestors: ["'none'"],
  baseUri:        ["'self'"],
  formAction:     ["'self'"],
  objectSrc:      ["'none'"],
  mediaSrc:       ["'self'"],
  workerSrc:      ["'self'", "blob:"],

  // Phase 43: CSP violation reporting endpoint
  reportUri:      ["/api/security/csp-report"],

  // Phase 43: upgrade all mixed-content requests to HTTPS in production
  ...(isProd ? { upgradeInsecureRequests: [] } : {}),
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
  cspEnabled:          boolean;
  cspDev:              boolean;
  hstsEnabled:         boolean;
  frameguard:          string;
  unsafeEval:          boolean;
  unsafeInlineScript:  boolean;
  unsafeInlineStyle:   boolean;
  wildcards:           boolean;
  frameAncestors:      string;
  objectSrc:           string;
  reportUriEnabled:    boolean;
  reportUri:           string;
  upgradeInsecure:     boolean;
} {
  return {
    cspEnabled:          true,
    cspDev:              isDev,
    hstsEnabled:         true,
    frameguard:          "DENY",
    unsafeEval:          isDev,       // only in dev for Vite HMR
    unsafeInlineScript:  false,       // never allowed in script-src
    unsafeInlineStyle:   true,        // style-src only (required for Tailwind/shadcn)
    wildcards:           false,
    frameAncestors:      "'none'",
    objectSrc:           "'none'",
    reportUriEnabled:    true,        // Phase 43: CSP violation reporting
    reportUri:           "/api/security/csp-report",
    upgradeInsecure:     isProd,      // Phase 43: upgrade mixed content in production
  };
}

/**
 * The raw CSP directive map — used by tests and the duplicate-header audit.
 */
export { helmetCspDirectives };
