/**
 * Phase 25 — Security Headers Library
 * Standalone policy builder for HTTP security headers.
 * Augments Phase 13.2 middleware with programmatic inspection and strict CSP.
 */

// ── CSP Directives ─────────────────────────────────────────────────────────────

export interface CspPolicy {
  defaultSrc: string[];
  scriptSrc: string[];
  styleSrc: string[];
  imgSrc: string[];
  connectSrc: string[];
  fontSrc: string[];
  objectSrc: string[];
  mediaSrc: string[];
  frameSrc: string[];
  workerSrc: string[];
  formAction: string[];
  frameAncestors: string[];
  upgradeInsecureRequests: boolean;
}

export const PLATFORM_CSP_POLICY: CspPolicy = {
  defaultSrc: ["'self'"],
  scriptSrc: [
    "'self'",
    "https://js.stripe.com",
    "https://cdn.jsdelivr.net",
    "https://assets.vercel.com",
  ],
  styleSrc: [
    "'self'",
    "'unsafe-inline'", // Required for CSS-in-JS
    "https://fonts.googleapis.com",
  ],
  imgSrc: [
    "'self'",
    "data:",
    "blob:",
    "https:",
    "https://*.stripe.com",
    "https://*.githubusercontent.com",
  ],
  connectSrc: [
    "'self'",
    "https://api.stripe.com",
    "https://*.supabase.co",
    "wss://*.supabase.co",
    "https://api.openai.com",
    "https://api.anthropic.com",
  ],
  fontSrc: [
    "'self'",
    "https://fonts.gstatic.com",
    "data:",
  ],
  objectSrc: ["'none'"],
  mediaSrc: ["'self'"],
  frameSrc: [
    "'self'",
    "https://js.stripe.com",
    "https://hooks.stripe.com",
  ],
  workerSrc: ["'self'", "blob:"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
  upgradeInsecureRequests: true,
};

/**
 * Serialize a CSP policy object to a header string.
 */
export function buildCspHeader(policy: CspPolicy = PLATFORM_CSP_POLICY): string {
  const directives: string[] = [];

  const addDirective = (name: string, sources: string[]) => {
    if (sources.length > 0) directives.push(`${name} ${sources.join(" ")}`);
  };

  addDirective("default-src", policy.defaultSrc);
  addDirective("script-src", policy.scriptSrc);
  addDirective("style-src", policy.styleSrc);
  addDirective("img-src", policy.imgSrc);
  addDirective("connect-src", policy.connectSrc);
  addDirective("font-src", policy.fontSrc);
  addDirective("object-src", policy.objectSrc);
  addDirective("media-src", policy.mediaSrc);
  addDirective("frame-src", policy.frameSrc);
  addDirective("worker-src", policy.workerSrc);
  addDirective("form-action", policy.formAction);
  addDirective("frame-ancestors", policy.frameAncestors);
  if (policy.upgradeInsecureRequests) directives.push("upgrade-insecure-requests");

  return directives.join("; ");
}

// ── Security header policies ──────────────────────────────────────────────────

export interface SecurityHeaderSet {
  name: string;
  value: string;
  description: string;
}

export const PLATFORM_SECURITY_HEADERS: SecurityHeaderSet[] = [
  {
    name: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains; preload",
    description: "Force HTTPS for 1 year, include subdomains, preload",
  },
  {
    name: "X-Frame-Options",
    value: "DENY",
    description: "Prevent clickjacking via iframe embedding",
  },
  {
    name: "X-Content-Type-Options",
    value: "nosniff",
    description: "Prevent MIME-type sniffing",
  },
  {
    name: "Referrer-Policy",
    value: "strict-origin-when-cross-origin",
    description: "Only send origin in Referer header for cross-origin requests",
  },
  {
    name: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(self https://js.stripe.com), usb=()",
    description: "Restrict browser feature access",
  },
  {
    name: "X-XSS-Protection",
    value: "0",
    description: "Disable broken XSS auditor (use CSP instead)",
  },
  {
    name: "Cross-Origin-Opener-Policy",
    value: "same-origin",
    description: "Prevent cross-origin window opener attacks",
  },
  {
    name: "Cross-Origin-Resource-Policy",
    value: "cross-origin",
    description: "Allow cross-origin resource loading (needed for CDN assets)",
  },
];

/**
 * Get the expected value for a specific security header.
 */
export function getExpectedHeaderValue(headerName: string): string | null {
  const h = PLATFORM_SECURITY_HEADERS.find(
    (s) => s.name.toLowerCase() === headerName.toLowerCase(),
  );
  return h?.value ?? null;
}

/**
 * Validate that a set of response headers contains all required security headers.
 */
export function validateSecurityHeaders(headers: Record<string, string>): {
  valid: boolean;
  missing: string[];
  present: string[];
} {
  const required = ["X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy"];
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  const missing = required.filter(h => !(h.toLowerCase() in lower));
  const present = required.filter(h => h.toLowerCase() in lower);
  return { valid: missing.length === 0, missing, present };
}

// ── HSTS policy parser ─────────────────────────────────────────────────────────

export function parseHstsMaxAge(hstsValue: string): number {
  const match = hstsValue.match(/max-age=(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

export function isHstsCompliant(hstsValue: string): boolean {
  const maxAge = parseHstsMaxAge(hstsValue);
  return maxAge >= 31536000; // 1 year minimum
}

// ── CSP violation report builder ──────────────────────────────────────────────

export interface CspViolationReport {
  documentUri: string;
  violatedDirective: string;
  blockedUri: string;
  timestamp: string;
}

export function buildCspViolationReport(params: Partial<CspViolationReport>): CspViolationReport {
  return {
    documentUri: params.documentUri ?? "unknown",
    violatedDirective: params.violatedDirective ?? "unknown",
    blockedUri: params.blockedUri ?? "unknown",
    timestamp: params.timestamp ?? new Date().toISOString(),
  };
}

// ── Nonce generation ──────────────────────────────────────────────────────────

import crypto from "crypto";

export function generateCspNonce(): string {
  return crypto.randomBytes(16).toString("base64");
}

/**
 * Add a nonce to the script-src directive of a CSP policy.
 */
export function addNonceToCsp(policy: CspPolicy, nonce: string): CspPolicy {
  return {
    ...policy,
    scriptSrc: [...policy.scriptSrc, `'nonce-${nonce}'`],
  };
}
