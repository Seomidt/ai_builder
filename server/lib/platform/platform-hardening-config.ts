/**
 * Platform Hardening Config
 * Phase Next — Domain/Subdomain/Auth Architecture Hardening
 *
 * Central, typed config for all production hardening assumptions.
 * Single source of truth for:
 *   - Host allowlist (production vs dev vs preview)
 *   - Admin isolation (admin.blissops.com)
 *   - www → apex redirect
 *   - Auth/cookie strategy
 *   - Tenant subdomain readiness
 *   - Analytics dedupe
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

// ─── Root domain ──────────────────────────────────────────────────────────────

export const ROOT_DOMAIN = "blissops.com";

// ─── Canonical production hosts ───────────────────────────────────────────────
//
// DOMAIN MODEL:
//
//  blissops.com          Public marketing, SEO, landing. INDEXED.
//  www.blissops.com      Alias — 301 redirect to blissops.com (apex).
//  app.blissops.com      Authenticated SPA. Auth callbacks live here. NOINDEX.
//  admin.blissops.com    Internal ops console (/ops/*). NOINDEX.
//
// Auth decision: auth callbacks stay on app.blissops.com/auth/* (no dedicated
//   auth host). Supabase allow-list already targets app.blissops.com.
//   Cookie scope is app.blissops.com (not root domain) for security isolation.
//
// Tenant subdomains: NOT yet live. Prep documented in TENANT_SUBDOMAIN_CONFIG.

export const PRODUCTION_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "blissops.com",
  "www.blissops.com",
  "app.blissops.com",
  "admin.blissops.com",
]);

export const PUBLIC_CANONICAL_HOST = ROOT_DOMAIN;
export const APP_CANONICAL_HOST    = `app.${ROOT_DOMAIN}`;
export const ADMIN_CANONICAL_HOST  = `admin.${ROOT_DOMAIN}`;
export const WWW_HOST              = `www.${ROOT_DOMAIN}`;

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

// ─── Admin isolation config ───────────────────────────────────────────────────
//
// /ops/* and /api/admin/* are restricted to admin.blissops.com.
// GET requests from wrong host → 302 redirect to admin.blissops.com.
// API and mutating methods → 403 (never redirect).

export const ADMIN_CONFIG = {
  canonicalHost:      ADMIN_CANONICAL_HOST,
  adminPathPrefixes:  ["/ops", "/api/admin"],
  noindex:            true,
  robotsHeaderValue:  "noindex, nofollow",
  requiresRoleGuard:  true,
  sharedDeployment:   true,
} as const;

// ─── Auth strategy config ─────────────────────────────────────────────────────
//
// Auth callbacks stay on app.blissops.com/auth/*.
// No dedicated auth.blissops.com subdomain justified at this stage:
//   1. Supabase allow-list targets app.blissops.com — changing it is risky.
//   2. Cookie scope is app.blissops.com — cross-domain token handoff not needed.
//   3. Operational complexity outweighs the benefit before Phase 52 isolation.
//
// Cookie scope: app.blissops.com (NOT .blissops.com root).
// Rationale: public domain (blissops.com) must not receive privileged session
//   cookies. Root-domain scope would send tokens on every public request → CSRF risk.
// Only the locale preference cookie uses root-domain scope (benign, non-sensitive).
//
// Logout redirect: https://app.blissops.com/auth/login (hard canonical, not relative).
// Magic links / invites / password reset: all target app.blissops.com.

export const AUTH_CONFIG = {
  canonicalCallbackHost:  APP_CANONICAL_HOST,
  callbackBasePath:       "/auth",
  cookieScope:            APP_CANONICAL_HOST,       // privileged cookies
  rootDomainCookieScope:  `.${ROOT_DOMAIN}`,        // locale pref only
  logoutRedirect:         `https://${APP_CANONICAL_HOST}/auth/login`,
  supabaseAllowListNote:  "Ensure Supabase allow-list targets app.blissops.com — do not add blissops.com",
} as const;

// ─── Cookie / session policy ──────────────────────────────────────────────────
//
// DECISION: App-scoped cookies (app.blissops.com), NOT root-domain (.blissops.com).
// This is the conservative, secure choice. Migration to root-domain scope only if:
//   a) Admin gets isolated deployment (Phase 52+) AND needs SSO with app
//   b) A public-to-app handoff token is required
//   c) Team explicitly re-evaluates the CSRF surface

export const COOKIE_POLICY = {
  privilegedScope:      APP_CANONICAL_HOST,
  localeScope:          `.${ROOT_DOMAIN}`,
  sameSite:             "Lax" as const,
  secure:               true,
  migrateToRootNote:    "Re-evaluate in Phase 52 if admin isolation requires cross-subdomain SSO.",
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
//
// Future model: coachname.blissops.com → routes to tenant-specific app.
// OR: app.blissops.com/tenant/:slug (simpler, no DNS per-tenant needed).
//
// RESERVED SUBDOMAINS — must never be allocated to tenants:

export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  "www",
  "app",
  "admin",
  "api",
  "auth",
  "mail",
  "smtp",
  "imap",
  "pop",
  "ftp",
  "sftp",
  "cdn",
  "static",
  "assets",
  "media",
  "status",
  "health",
  "ping",
  "blog",
  "docs",
  "help",
  "support",
  "careers",
  "legal",
  "privacy",
  "terms",
  "security",
  "billing",
  "dashboard",
  "manage",
  "portal",
  "dev",
  "staging",
  "preview",
  "beta",
  "sandbox",
  "test",
  "internal",
  "ops",
  "infra",
  "metrics",
  "monitoring",
  "grafana",
  "prometheus",
  "sentry",
  "feedback",
  "changelog",
  "release",
  "git",
  "github",
  "ci",
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
    "if tenants share sessions with app.blissops.com.",
    "Otherwise use host-only cookies per tenant subdomain.",
    "Re-evaluate in Phase 52+.",
  ].join(" "),
  migrationNote: [
    "If migrating from app.blissops.com/... to tenant.blissops.com/:...,",
    "use 301 redirects from old paths, update Supabase OAuth allow-list,",
    "update cookie domain, and handle wildcard TLS cert via Cloudflare.",
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
  note:       "www is not canonical. All www traffic 301-redirects to apex.",
} as const;

// ─── SEO / indexing config ────────────────────────────────────────────────────

export const SEO_CONFIG = {
  indexedHosts:     new Set([PUBLIC_CANONICAL_HOST]) as ReadonlySet<string>,
  noindexHosts:     new Set([APP_CANONICAL_HOST, ADMIN_CANONICAL_HOST, WWW_HOST]) as ReadonlySet<string>,
  previewHostNote:  "All *.vercel.app and *.replit.dev hosts must carry noindex — never canonical.",
  canonicalNote:    "Canonical tags must only point to blissops.com, never to preview or app host.",
} as const;

// ─── Cloudflare / Vercel operator execution plan ──────────────────────────────
//
// Required Cloudflare DNS records:
//
//   A     @              76.76.21.21                        (Vercel anycast — proxy OFF during validation)
//   CNAME www            5882b65e4b130c85.vercel-dns.com    (Vercel — proxy OFF during validation)
//   CNAME app            cname.vercel-dns.com               (Future — when app.blissops.com is Vercel-connected)
//   CNAME admin          cname.vercel-dns.com               (Future — when admin.blissops.com is Vercel-connected)
//
// Required Vercel domains (attached to Production — main branch):
//
//   blissops.com         Primary production domain
//   www.blissops.com     Redirect to blissops.com
//   app.blissops.com     Future — when app SPA moves to subdomain
//   admin.blissops.com   Future — when admin is isolated
//
// SSL/TLS (Cloudflare):
//   - Full (Strict) after Vercel SSL cert is issued
//   - Proxy ON (orange cloud) after Vercel validation
//
// Wildcard DNS (future tenant subdomains):
//   CNAME *   cname.vercel-dns.com   (add when TENANT_SUBDOMAIN_CONFIG.enabled = true)

export const OPERATOR_PLAN_NOTE = "See comments in TENANT_SUBDOMAIN_CONFIG and above for Cloudflare/Vercel steps.";

// ─── Full platform hardening summary ─────────────────────────────────────────

export const PLATFORM_HARDENING = {
  hostAllowlist:      HOST_ALLOWLIST_CONFIG,
  adminIsolation:     ADMIN_CONFIG,
  authStrategy:       AUTH_CONFIG,
  cookiePolicy:       COOKIE_POLICY,
  wwwRedirect:        WWW_REDIRECT_CONFIG,
  seo:                SEO_CONFIG,
  tenantReadiness:    TENANT_SUBDOMAIN_CONFIG,
  analyticsDedupe:    ANALYTICS_DEDUPE_CONFIG,
  launchReady:        true,
} as const;
