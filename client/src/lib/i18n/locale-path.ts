/**
 * i18n Locale Path Helpers
 *
 * Utilities for constructing locale-aware paths and navigation.
 *
 * Current routing strategy: locale is NOT in the URL (SPA with cookie-based locale).
 * These helpers are provided for:
 *  1. Future locale-prefixed URL strategy
 *  2. Canonical URL generation for SEO
 *  3. External link construction with locale context
 *
 * All helpers are pure functions, no side-effects.
 */

import { type Locale, SUPPORTED_LOCALES, DEFAULT_LOCALE, isSupportedLocale } from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// Core helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prepend locale segment to path: withLocale("/dashboard", "da") → "/da/dashboard"
 * Skips default locale prefix if skipDefault=true (default: false).
 */
export function withLocale(path: string, locale: Locale, skipDefault = false): string {
  if (skipDefault && locale === DEFAULT_LOCALE) return ensureLeadingSlash(path);
  const stripped = stripLocale(path);
  return `/${locale}${ensureLeadingSlash(stripped)}`;
}

/**
 * Remove locale segment from path: stripLocale("/da/dashboard") → "/dashboard"
 */
export function stripLocale(path: string): string {
  const parts = path.split("/").filter(Boolean);
  if (parts.length > 0 && isSupportedLocale(parts[0])) {
    return "/" + parts.slice(1).join("/");
  }
  return ensureLeadingSlash(path);
}

/**
 * Replace locale segment in path: replaceLocale("/en/dashboard", "da") → "/da/dashboard"
 * If path has no locale prefix, prepends new locale.
 */
export function replaceLocale(path: string, newLocale: Locale): string {
  const stripped = stripLocale(path);
  return withLocale(stripped, newLocale);
}

/**
 * Extract locale from path if present.
 */
export function getLocaleFromPath(path: string): Locale | undefined {
  const parts = path.split("/").filter(Boolean);
  const first = parts[0];
  return isSupportedLocale(first) ? first : undefined;
}

/**
 * Check if path has a locale prefix.
 */
export function hasLocalePrefixInPath(path: string): boolean {
  return getLocaleFromPath(path) !== undefined;
}

/**
 * Generate all locale variants of a path.
 */
export function getAllLocaleVariants(path: string): Record<Locale, string> {
  const stripped = stripLocale(path);
  const entries = SUPPORTED_LOCALES.map(locale => [locale, withLocale(stripped, locale)]);
  return Object.fromEntries(entries) as Record<Locale, string>;
}

/**
 * Build an hreflang map for SEO (future use).
 */
export function buildHreflangMap(
  basePath: string,
  baseUrl = ""
): Record<Locale | "x-default", string> {
  const stripped = stripLocale(basePath);
  const map: Partial<Record<Locale | "x-default", string>> = {};
  for (const locale of SUPPORTED_LOCALES) {
    map[locale] = `${baseUrl}${withLocale(stripped, locale)}`;
  }
  map["x-default"] = `${baseUrl}${withLocale(stripped, DEFAULT_LOCALE)}`;
  return map as Record<Locale | "x-default", string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal utilities
// ─────────────────────────────────────────────────────────────────────────────

function ensureLeadingSlash(path: string): string {
  return path.startsWith("/") ? path : `/${path}`;
}

export function ensureTrailingSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

export function removeTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}
