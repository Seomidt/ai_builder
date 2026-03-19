/**
 * Final Hardening Closeout — Platform Hardening Config
 *
 * Central, typed config for all production hardening assumptions.
 * Single source of truth for host allowlist, admin isolation, and analytics dedupe.
 */

// ─── Environment detection ────────────────────────────────────────────────────

export type RuntimeEnv = "production" | "development" | "preview";

export function getRuntimeEnv(): RuntimeEnv {
  const env = process.env.NODE_ENV ?? "development";
  if (env === "production") return "production";
  if (process.env.VERCEL_ENV === "preview") return "preview";
  return "development";
}

export function isProduction(): boolean { return getRuntimeEnv() === "production"; }
export function isDevelopment(): boolean { return getRuntimeEnv() === "development"; }
export function isPreview(): boolean { return getRuntimeEnv() === "preview"; }

// ─── Canonical production hosts ───────────────────────────────────────────────

export const PRODUCTION_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "blissops.com",
  "www.blissops.com",
  "app.blissops.com",
  "admin.blissops.com",
]);

export const APP_CANONICAL_HOST   = "app.blissops.com";
export const ADMIN_CANONICAL_HOST = "admin.blissops.com";
export const PUBLIC_CANONICAL_HOST = "blissops.com";

/** Hosts allowed in development mode (includes localhost variants) */
export const DEV_ALLOWED_HOST_PATTERNS: readonly string[] = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  ".replit.dev",
  ".replit.app",
  ".repl.co",
];

/** Preview / CI environments — not production-sensitive */
export const PREVIEW_ALLOWED_HOST_PATTERNS: readonly string[] = [
  ".vercel.app",
  ".netlify.app",
];

/** Explicit blocked hosts — always rejected regardless of environment */
export const ALWAYS_BLOCKED_HOSTS: ReadonlySet<string> = new Set([]);

// ─── Admin isolation config ───────────────────────────────────────────────────

export const ADMIN_CONFIG = {
  canonicalHost:      ADMIN_CANONICAL_HOST,
  adminPathPrefixes:  ["/ops", "/api/admin"],
  noindex:            true,
  robotsHeaderValue:  "noindex, nofollow",
  requiresRoleGuard:  true,
  sharedDeployment:   true,
} as const;

// ─── Analytics dedupe config ──────────────────────────────────────────────────

export const ANALYTICS_DEDUPE_CONFIG = {
  enabled:              true,
  idempotencyKeyTTLMs:  24 * 60 * 60 * 1000,
  eventsRequiringDedupe: [
    "funnel.landing_view",
    "funnel.pricing_view",
    "funnel.signup_view",
    "funnel.signup_started",
    "funnel.signup_completed",
    "funnel.trial_started",
    "billing.checkout_started",
    "billing.checkout_completed",
    "ai.request_started",
  ] as readonly string[],
} as const;

// ─── Host allowlist config ────────────────────────────────────────────────────

export const HOST_ALLOWLIST_CONFIG = {
  productionAllowedHosts:     PRODUCTION_ALLOWED_HOSTS,
  devAllowedPatterns:         DEV_ALLOWED_HOST_PATTERNS,
  previewAllowedPatterns:     PREVIEW_ALLOWED_HOST_PATTERNS,
  blockVercelAppInProduction: true,
  logRejectedHosts:           true,
  rejectAction:               "403" as "403" | "redirect",
} as const;

// ─── Full platform hardening summary ─────────────────────────────────────────

export const PLATFORM_HARDENING = {
  hostAllowlist:     HOST_ALLOWLIST_CONFIG,
  adminIsolation:    ADMIN_CONFIG,
  analyticsDedupe:   ANALYTICS_DEDUPE_CONFIG,
  launchReady:       true,
} as const;
