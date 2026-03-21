/**
 * Domain Architecture Configuration
 * Phase 49 → updated 2026-03-21 — Canonical 3-Surface Architecture
 *
 * Platform: blissops.com — AI Builder Platform
 * Model: canonical multi-domain (marketing + tenant + admin)
 *
 * CANONICAL DOMAIN MODEL:
 *   blissops.com          → MarketingApp  (public site — indexed)
 *   www.blissops.com      → MarketingApp  (alias → redirect to blissops.com)
 *   app.blissops.com      → TenantApp     (authenticated product surface)
 *   admin.blissops.com    → AdminApp      (platform operations)
 *
 * Auth:
 *   - Supabase auth callbacks: app.blissops.com/auth/callback
 *   - Session cookie domain: ".blissops.com" — shared app + admin
 *   - Marketing host: no auth shell, /auth/* redirects to app.blissops.com
 *
 * Security:
 *   - Domain = UI routing ONLY, never trusted for authorization
 *   - AdminRoute + backend /api/auth/session enforce platform_admin role
 *   - Tenant membership enforced server-side on all data routes
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
 * Canonical hosts per domain role.
 * Session shared via cookie domain=".blissops.com" (app + admin).
 */
export const CANONICAL_HOSTS: Record<DomainRole, string> = {
  [DOMAIN_ROLE.PUBLIC]: "blissops.com",         // marketing site
  [DOMAIN_ROLE.APP]:    "app.blissops.com",      // tenant product surface
  [DOMAIN_ROLE.ADMIN]:  "admin.blissops.com",    // platform ops surface
  [DOMAIN_ROLE.AUTH]:   "app.blissops.com",      // auth callbacks on tenant app domain
};

/** www always redirects to apex public domain */
export const WWW_REDIRECT_TARGET = "blissops.com";

/** Root domain — used for .blissops.com cookie scope when needed */
export const ROOT_DOMAIN = "blissops.com";

/** All canonical hostnames (unique) */
export const ALL_CANONICAL_HOSTS: ReadonlySet<string> = new Set([
  CANONICAL_HOSTS[DOMAIN_ROLE.PUBLIC],   // blissops.com
  CANONICAL_HOSTS[DOMAIN_ROLE.APP],      // app.blissops.com
  CANONICAL_HOSTS[DOMAIN_ROLE.ADMIN],    // admin.blissops.com
  `www.${ROOT_DOMAIN}`,                  // www.blissops.com
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
    purpose:          "Marketing/public site — landing, pricing, about, public content",
    audience:         "All visitors (unauthenticated + authenticated)",
    indexed:          true,
    localeStrategy:   "prefix",
    authRequired:     false,
    sharedDeployment: null,
    notes:            "Root domain is the public marketing site. No auth shell. CTAs link to app.blissops.com.",
  },
  [DOMAIN_ROLE.APP]: {
    role:             DOMAIN_ROLE.APP,
    host:             "app.blissops.com",
    purpose:          "Authenticated tenant product — projects, runs, architectures, workspace",
    audience:         "Authenticated users (org members, tenant users)",
    indexed:          false,
    localeStrategy:   "cookie",
    authRequired:     true,
    sharedDeployment: null,
    notes:            "Tenant product surface. Auth callbacks registered here. Session cookie shared with admin via .blissops.com.",
  },
  [DOMAIN_ROLE.ADMIN]: {
    role:             DOMAIN_ROLE.ADMIN,
    host:             "admin.blissops.com",
    purpose:          "Internal ops console — tenant management, jobs, AI governance, security",
    audience:         "Platform staff only (platform_admin role required)",
    indexed:          false,
    localeStrategy:   "default-only",
    authRequired:     true,
    sharedDeployment: DOMAIN_ROLE.APP,
    notes:            "Multi-domain: admin.blissops.com. Session shared via .blissops.com cookie. Role still backend-enforced.",
  },
  [DOMAIN_ROLE.AUTH]: {
    role:             DOMAIN_ROLE.AUTH,
    host:             "app.blissops.com",
    purpose:          "Auth/callback flows — Supabase OAuth, magic link, invite, password reset",
    audience:         "All users (unauthenticated callbacks)",
    indexed:          false,
    localeStrategy:   "default-only",
    authRequired:     false,
    sharedDeployment: DOMAIN_ROLE.APP,
    notes:            "Auth callbacks on app.blissops.com/auth/*. Must be registered in Supabase allow-list. Marketing domain redirects here.",
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
  // Admin surface
  if (h === "admin.blissops.com" || h === "admin.localhost") return DOMAIN_ROLE.ADMIN;
  // Tenant product surface
  if (h === "app.blissops.com" || h === "app.localhost") return DOMAIN_ROLE.APP;
  // Marketing / public surface
  if (h === "blissops.com" || h === `www.${ROOT_DOMAIN}`) return DOMAIN_ROLE.PUBLIC;
  // localhost → tenant by default (documented in runtime/domain.ts)
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
