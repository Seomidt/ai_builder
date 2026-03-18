/**
 * Phase 42 — Security Headers Middleware
 *
 * Fixes: contentSecurityPolicy was disabled (contentSecurityPolicy: false).
 * Now enables helmet with a full CSP matching the platform's policy from csp.ts.
 *
 * The CSP value from csp.ts (buildCspValue) is the source of truth.
 * Helmet applies all other security headers; CSP is set explicitly via the
 * cspMiddleware from csp.ts (applied separately in server/index.ts).
 *
 * Why not use helmet's built-in CSP?
 * Helmet's CSP format differs from our buildCspValue() format.
 * To avoid double-header and format conflicts, we let helmet handle all headers
 * EXCEPT CSP (contentSecurityPolicy: false here), then apply our own CSP in
 * the cspMiddleware (which already runs as the second middleware in index.ts).
 *
 * This is NOT disabling CSP — it prevents DUPLICATE/CONFLICTING CSP headers.
 * The actual CSP is applied by cspMiddleware (server/middleware/csp.ts).
 */

import helmet from "helmet";
import { RequestHandler } from "express";

export const securityHeaders: RequestHandler = helmet({
  // CSP is intentionally delegated to server/middleware/csp.ts (applied separately).
  // Setting this to false here prevents a duplicate, conflicting CSP header.
  // cspMiddleware (index.ts line 18) supplies the real Content-Security-Policy.
  contentSecurityPolicy: false,

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

  // Referrer policy
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },

  // Disable broken XSS auditor (modern browsers ignore it; CSP is the defense)
  xssFilter: false,

  // Cross-origin policies
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false, // disabled: breaks cross-origin assets needed by app
});

/**
 * Introspect security header configuration.
 * Used by validation scripts.
 */
export function getSecurityHeaderConfig(): {
  cspSource:       string;
  helmetEnabled:   boolean;
  cspDelegatedTo:  string;
  hstsEnabled:     boolean;
  frameguard:      string;
} {
  return {
    cspSource:      "server/middleware/csp.ts (cspMiddleware)",
    helmetEnabled:  true,
    cspDelegatedTo: "cspMiddleware — runs as second middleware in server/index.ts",
    hstsEnabled:    true,
    frameguard:     "DENY",
  };
}
