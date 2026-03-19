/**
 * Domain Architecture Configuration
 * Phase 49 — Domain/Subdomain Architecture
 *
 * Platform: blissops.com — AI Builder Platform
 * Model: single-domain — entire app on blissops.com
 * Updated: 2026-03-19 — migrated from multi-subdomain to single-domain
 *
 * CURRENT MODE: single-domain
 *   - blissops.com → authenticated application (all routes)
 *   - www.blissops.com → 301 redirect to blissops.com
 *   - app.blissops.com → NOT LIVE (planned future subdomain)
 *   - admin.blissops.com → NOT LIVE (planned future subdomain)
 *
 * When migrating to multi-domain:
 *   - Change APP + AUTH + ADMIN back to their respective subdomains
 *   - Update Supabase allow-list
 *   - Update Vercel project domains
 *   - Update DOMAIN_CONFIG.mode in server/lib/platform/domain-config.ts
 */

// ─── Domain Role Enum ────────────────────────────────────────────────────────

export const DOMAIN_ROLE = {
  PUBLIC:  "public",
  APP:     "app",
  ADMIN:   "admin",
  AUTH:    "auth",
} as const;

export type DomainRole = (typeof DOMAIN_ROLE)[keyof typeof DOMAIN_ROLE];

// ─── Canonical Hostnames ─────────────────────────────────────────────────────

/**
 * Single-domain mode: everything lives on blissops.com.
 *
 * All roles map to the same host. Auth callbacks, app routes,
 * and admin/ops routes all live under blissops.com.
 */
export const CANONICAL_HOSTS: Record<DomainRole, string> = {
  [DOMAIN_ROLE.PUBLIC]: "blissops.com",
  [DOMAIN_ROLE.APP]:    "blissops.com",   // single-domain: was app.blissops.com
  [DOMAIN_ROLE.ADMIN]:  "blissops.com",   // single-domain: was admin.blissops.com
  [DOMAIN_ROLE.AUTH]:   "blissops.com",   // single-domain: auth callbacks on blissops.com
};

/** www always redirects to apex public domain */
export const WWW_REDIRECT_TARGET = "blissops.com";

/** Root domain — used for .blissops.com cookie scope when needed */
export const ROOT_DOMAIN = "blissops.com";

/** All canonical hostnames (unique) */
export const ALL_CANONICAL_HOSTS: ReadonlySet<string> = new Set([
  CANONICAL_HOSTS[DOMAIN_ROLE.PUBLIC],
  CANONICAL_HOSTS[DOMAIN_ROLE.APP],
  CANONICAL_HOSTS[DOMAIN_ROLE.ADMIN],
]);

// ─── Domain Metadata ─────────────────────────────────────────────────────────

export interface DomainConfig {
  role:        DomainRole;
  host:        string;
  purpose:     string;
  audience:    string;
  indexed:     boolean;
  localeStrategy: "prefix" | "cookie" | "default-only";
  authRequired: boolean;
  sharedDeployment: DomainRole | null;
  notes:       string;
}

export const DOMAIN_CONFIGS: Record<DomainRole, DomainConfig> = {
  [DOMAIN_ROLE.PUBLIC]: {
    role:             DOMAIN_ROLE.PUBLIC,
    host:             "blissops.com",
    purpose:          "Authenticated application — all routes (single-domain mode)",
    audience:         "Authenticated users only",
    indexed:          false,
    localeStrategy:   "cookie",
    authRequired:     true,
    sharedDeployment: null,
    notes:            "Single-domain mode. Not a public marketing site. All routes require auth.",
  },
  [DOMAIN_ROLE.APP]: {
    role:             DOMAIN_ROLE.APP,
    host:             "blissops.com",
    purpose:          "Authenticated app SPA — projects, runs, settings, integrations",
    audience:         "Authenticated users (coaches, clients, org members)",
    indexed:          false,
    localeStrategy:   "cookie",
    authRequired:     true,
    sharedDeployment: null,
    notes:            "Single-domain mode: app routes on blissops.com. Auth callbacks live here.",
  },
  [DOMAIN_ROLE.ADMIN]: {
    role:             DOMAIN_ROLE.ADMIN,
    host:             "blissops.com",
    purpose:          "Internal ops console — tenant management, jobs, AI governance, security",
    audience:         "Platform staff only (platform_admin role required)",
    indexed:          false,
    localeStrategy:   "default-only",
    authRequired:     true,
    sharedDeployment: DOMAIN_ROLE.APP,
    notes:            "Single-domain mode: ops routes on blissops.com/ops/*. Role-based, not host-based.",
  },
  [DOMAIN_ROLE.AUTH]: {
    role:             DOMAIN_ROLE.AUTH,
    host:             "blissops.com",
    purpose:          "Auth/callback flows — Supabase OAuth, magic link, invite, password reset",
    audience:         "All users (unauthenticated callbacks)",
    indexed:          false,
    localeStrategy:   "default-only",
    authRequired:     false,
    sharedDeployment: DOMAIN_ROLE.APP,
    notes:            "Single-domain mode: auth callbacks on blissops.com/auth/*. Registered in Supabase allow-list.",
  },
};

// ─── Locale Strategy Descriptions ────────────────────────────────────────────

export const LOCALE_STRATEGY_LABELS: Record<DomainConfig["localeStrategy"], string> = {
  "prefix":       "URL-prefixed (/en/..., /da/...) — SEO-safe, canonical-aware",
  "cookie":       "Cookie-based (blissops_locale) — no URL prefix, B2B SaaS pattern",
  "default-only": "Default locale only — no switching unless explicitly enabled",
};

// ─── Predicates ──────────────────────────────────────────────────────────────

/** Check if a hostname is one of the canonical app/admin/public hosts */
export function isKnownHost(hostname: string): boolean {
  return ALL_CANONICAL_HOSTS.has(hostname);
}

/** Resolve domain role from hostname */
export function getDomainRoleFromHost(hostname: string): DomainRole | null {
  const h = hostname.toLowerCase().replace(/:\d+$/, ""); // strip port
  // Single-domain: blissops.com is everything
  if (h === "blissops.com" || h === `www.${ROOT_DOMAIN}`) return DOMAIN_ROLE.PUBLIC;
  // localhost / dev
  if (h === "localhost" || h === "127.0.0.1") return DOMAIN_ROLE.APP;
  return null;
}

/** True if domain should be indexed by search engines */
export function isDomainIndexable(role: DomainRole): boolean {
  return DOMAIN_CONFIGS[role].indexed;
}

/** True if locale prefix strategy applies */
export function usesLocalePrefix(role: DomainRole): boolean {
  return DOMAIN_CONFIGS[role].localeStrategy === "prefix";
}

/** True if cookie-based locale applies */
export function usesCookieLocale(role: DomainRole): boolean {
  return DOMAIN_CONFIGS[role].localeStrategy === "cookie";
}

/** True if path is an auth callback path (locale-neutral) */
export function isAuthCallbackPath(path: string): boolean {
  const normalised = path.replace(/^\/+/, "").toLowerCase();
  return (
    normalised.startsWith("auth/") ||
    normalised.startsWith("api/auth/") ||
    normalised === "auth"
  );
}

/** True if path belongs to the ops/admin surface */
export function isOpsPath(path: string): boolean {
  const normalised = path.replace(/^\/+/, "").toLowerCase();
  return normalised.startsWith("ops") || normalised.startsWith("ops/");
}

/** True if path is an API route (must not be locale-prefixed) */
export function isApiPath(path: string): boolean {
  const normalised = path.replace(/^\/+/, "").toLowerCase();
  return normalised.startsWith("api/") || normalised === "api";
}
