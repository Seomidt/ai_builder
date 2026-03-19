/**
 * Canonical URL Helpers
 * Phase 49 — Domain/Subdomain Architecture
 */

import {
  DomainRole,
  DOMAIN_ROLE,
  CANONICAL_HOSTS,
  ROOT_DOMAIN,
  getDomainRoleFromHost,
  isDomainIndexable,
} from "./config";

// ─── Canonical Host Resolution ────────────────────────────────────────────────

/** Return the canonical hostname for a given domain role */
export function getCanonicalHostForRole(role: DomainRole): string {
  return CANONICAL_HOSTS[role];
}

/** Return the canonical https:// origin for a given domain role */
export function getCanonicalOriginForRole(role: DomainRole): string {
  return `https://${getCanonicalHostForRole(role)}`;
}

// ─── Canonical URL Builder ────────────────────────────────────────────────────

export interface CanonicalUrlOptions {
  role:   DomainRole;
  path:   string;
  locale?: string;
}

/**
 * Build a canonical URL for a given domain role + path.
 * - Public domain: prepends locale prefix if provided
 * - App / admin: locale is ignored (cookie-based)
 */
export function buildCanonicalUrl({ role, path, locale }: CanonicalUrlOptions): string {
  const origin = getCanonicalOriginForRole(role);
  const cleanPath = ensureLeadingSlash(removeTrailingSlash(path));

  if (role === DOMAIN_ROLE.PUBLIC && locale) {
    const localePath = cleanPath === "/" ? `/${locale}` : `/${locale}${cleanPath}`;
    return `${origin}${localePath}`;
  }

  return `${origin}${cleanPath}`;
}

// ─── www Redirect ─────────────────────────────────────────────────────────────

/**
 * Returns the canonical redirect target for www or non-canonical hostnames.
 * Returns null if host is already canonical.
 */
export function getWwwRedirectTarget(hostname: string, path = "/"): string | null {
  const h = hostname.toLowerCase().replace(/:\d+$/, "");
  if (h === `www.${ROOT_DOMAIN}`) {
    return `https://${ROOT_DOMAIN}${ensureLeadingSlash(path)}`;
  }
  return null;
}

// ─── Noindex / Robots ────────────────────────────────────────────────────────

/**
 * Returns true if the domain should carry a noindex directive.
 * app, admin, and auth surfaces must never be indexed.
 */
export function shouldNoindexHost(hostname: string): boolean {
  const role = getDomainRoleFromHost(hostname);
  if (role === null) return true; // unknown host — safer to noindex
  return !isDomainIndexable(role);
}

/**
 * Returns the X-Robots-Tag header value for a hostname.
 */
export function getRobotsHeaderForHost(hostname: string): string {
  return shouldNoindexHost(hostname) ? "noindex, nofollow" : "index, follow";
}

// ─── Hreflang Canonical Map ───────────────────────────────────────────────────

export interface HreflangEntry {
  hreflang: string;
  href:     string;
}

/**
 * Build hreflang link entries for a public page (blissops.com only).
 * x-default points to the default locale.
 */
export function buildPublicHreflangMap(
  path: string,
  supportedLocales: readonly string[],
  defaultLocale: string,
): HreflangEntry[] {
  const origin = getCanonicalOriginForRole(DOMAIN_ROLE.PUBLIC);
  const cleanPath = path === "/" ? "" : removeTrailingSlash(path);

  const entries: HreflangEntry[] = supportedLocales.map((locale) => ({
    hreflang: locale,
    href: `${origin}/${locale}${cleanPath || "/"}`,
  }));

  entries.push({
    hreflang: "x-default",
    href: `${origin}/${defaultLocale}${cleanPath || "/"}`,
  });

  return entries;
}

// ─── Path Utilities ───────────────────────────────────────────────────────────

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

function removeTrailingSlash(path: string): string {
  return path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
}
