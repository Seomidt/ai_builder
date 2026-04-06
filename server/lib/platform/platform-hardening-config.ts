/**
 * Platform Hardening Config — Single-Domain Production Mode
 *
 * Central, typed config for all production hardening assumptions.
 * Single source of truth for:
 *   - Host allowlist (production vs dev vs preview)
 *   - Admin access (path-based + role-based — NOT hostname-based)
 *   - www → apex redirect
 *   - Auth/cookie strategy
 *   - Tenant subdomain readiness
 *   - Analytics dedupe
 *
 * CURRENT LIVE PRODUCTION MODE: single
 *   blissops.com = authenticated application
 *   app.blissops.com = allowed alias for app traffic
 *   www.blissops.com = 301 redirect to blissops.com
 */

import { DOMAIN_CONFIG } from "./domain-config.ts";

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

// ─── Root domain ──────────────────────────────────────────────────────────────

export const ROOT_DOMAIN = "blissops.com";

// ─── Canonical production hosts ───────────────────────────────────────────────
//
// CURRENT LIVE DOMAIN MODEL (single-domain mode with app alias):
//
//  blissops.com        Authenticated application (tenants, admin — path-based). NOINDEX.
//  app.blissops.com    Allowed host alias for authenticated application.
//  www.blissops.com    301 redirect to blissops.com.
//
// Auth callbacks: https://blissops.com/auth/*
// Cookie scope: blissops.com (host-scoped)

export const PRODUCTION_ALLOWED_HOSTS: ReadonlySet<string> = new Set(
  DOMAIN_CONFIG.allowHosts,
);

export const PUBLIC_CANONICAL_HOST  = ROOT_DOMAIN;
export const APP_CANONICAL_HOST     = DOMAIN_CONFIG.mode === "multi" ? "app.blissops.com" : ROOT_DOMAIN;
export const ADMIN_CANONICAL_HOST   = DOMAIN_CONFIG.mode === "multi" ? "admin.blissops.com" : ROOT_DOMAIN;
export const WWW_HOST               = `www.${ROOT_DOMAIN}`;

/** Hosts allowed in development mode */
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

/** Hosts explicitly blocked regardless of environment */
export const ALWAYS_BLOCKED_HOSTS: ReadonlySet<string> = new Set([]);

// ─── Admin access config ──────────────────────────────────────────────────────
//
// Admin/ops access is PATH-BASED and ROLE-BASED — not hostname-based.
// No hostname-based gating. The planned admin subdomain is not active in this mode.
//
// Enforcement chain for /ops/* and /api/admin/*:
//   1. authMiddleware — valid session required
//   2. lockdownGuard — lockdown allowlist check (if enabled)
//   3. adminGuardMiddleware — platform_admin role required
//
// All three layers are in server/app.ts middleware stack.

export const ADMIN_CONFIG = {
  canonicalHost:      ADMIN_CANONICAL_HOST,
  adminPathPrefixes:  ["/ops", "/api/admin"],
  noindex:            true,
  robotsHeaderValue:  "noindex, nofollow",
  requiresRoleGuard:  true,
  sharedDeployment:   true,
  hostBasedAccess:    DOMAIN_CONFIG.mode === "multi",
} as const;

// ─── Auth strategy config ─────────────────────────────────────────────────────
//
// Single-domain mode: auth lives on blissops.com.
//
// Auth URLs:
//   Login:    https://blissops.com/auth/login
//   Callback: https://blissops.com/auth/callback
//   Logout:   https://blissops.com/auth/logout
//
// Cookie scope: blissops.com (host-scoped)
// SameSite: Lax  Secure: true (production)
//
// Future (multi-domain): move callbacks to app.blissops.com/auth/*,
// update Supabase OAuth allow-list, update cookie domain to .blissops.com.

export const AUTH_CONFIG = {
  canonicalCallbackHost:  APP_CANONICAL_HOST,
  callbackBasePath:       "/auth",
  cookieScope:            APP_CANONICAL_HOST,
  rootDomainCookieScope:  ROOT_DOMAIN,
  logoutRedirect:         `https://${APP_CANONICAL_HOST}/auth/login`,
  loginUrl:               `https://${APP_CANONICAL_HOST}/auth/login`,
  callbackUrl:            `https://${APP_CANONICAL_HOST}/auth/callback`,
  supabaseAllowListNote:  "Supabase allow-list should include https://blissops.com/auth/callback and optionally https://app.blissops.com/auth/callback",
} as const;

// ─── Cookie / session policy ──────────────────────────────────────────────────
//
// Single-domain: cookies scoped to blissops.com.
// Secure=true, SameSite=Lax in production.
// No subdomain cookie sharing needed until multi-domain migration.

export const COOKIE_POLICY = {
  privilegedScope:      APP_CANONICAL_HOST,
  localeScope:          ROOT_DOMAIN,
  sameSite:             "Lax" as const,
  secure:               true,
  migrateToRootNote:    "If full multi-domain mode is activated later, re-scope to .blissops.com for cross-subdomain SSO.",
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

// ─── Tenant subdomain readiness ───────────────────────────────────────────────
//
// CURRENT STATE: NOT live. Prep only.
// Tenant routing is currently path-based: blissops.com/tenant/:slug
//
// Future: tenant.blissops.com subdomains (requires wildcard DNS + Vercel config)

export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  "www", "app", "admin", "api", "auth", "mail", "smtp", "imap", "pop",
  "ftp", "sftp", "cdn", "static", "assets", "media", "status", "health",
  "ping", "blog", "docs", "help", "support", "careers", "legal", "privacy",
  "terms", "security", "billing", "dashboard", "manage", "portal", "dev",
  "staging", "preview", "beta", "sandbox", "test", "internal", "ops",
  "infra", "metrics", "monitoring", "grafana", "prometheus", "sentry",
  "feedback", "changelog", "release", "git", "github", "ci",
]);

export const TENANT_SUBDOMAIN_CONFIG = {
  enabled:              false,
  wildcardDnsRequired:  true,
  wildcardPattern:      "*.blissops.com",
  cloudflareProxyable:  true,
  hostParsingNote: [
    "To resolve tenant from hostname: extract subdomain from host, strip port,",
    "reject if in RESERVED_SUBDOMAINS, look up tenant in DB by slug.",
    "Implement in server/middleware/tenant-resolver.ts when enabling.",
  ].join(" "),
  cookieNote: [
    "Tenant subdomains will need root-domain cookie scope (.blissops.com)",
    "Re-evaluate when enabling multi-domain mode.",
  ].join(" "),
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

// ─── www redirect config ──────────────────────────────────────────────────────

export const WWW_REDIRECT_CONFIG = {
  from:       WWW_HOST,
  to:         PUBLIC_CANONICAL_HOST,
  statusCode: 301 as const,
  note:       "www.blissops.com 301-redirects to blissops.com (apex).",
} as const;

// ─── SEO / indexing config ────────────────────────────────────────────────────
//
// blissops.com is currently the authenticated app — NOT a public marketing site.
// All hosts must be noindex until a separate public landing site exists.

export const SEO_CONFIG = {
  indexedHosts:     new Set<string>() as ReadonlySet<string>,  // NONE — app is not public
  noindexHosts:     PRODUCTION_ALLOWED_HOSTS,
  previewHostNote:  "All *.vercel.app and *.replit.dev hosts must carry noindex — never canonical.",
  appOnRootNote:    "blissops.com is the authenticated app. Disallow: / until a public marketing site exists.",
} as const;

// ─── Full platform hardening summary ─────────────────────────────────────────

export const PLATFORM_HARDENING = {
  hostAllowlist:      HOST_ALLOWLIST_CONFIG,
  adminAccess:        ADMIN_CONFIG,
  authStrategy:       AUTH_CONFIG,
  cookiePolicy:       COOKIE_POLICY,
  wwwRedirect:        WWW_REDIRECT_CONFIG,
  seo:                SEO_CONFIG,
  tenantReadiness:    TENANT_SUBDOMAIN_CONFIG,
  analyticsDedupe:    ANALYTICS_DEDUPE_CONFIG,
  domainMode:         DOMAIN_CONFIG.mode,
  launchReady:        true,
} as const;
