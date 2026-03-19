/**
 * i18n Locale Resolution — Deterministic Priority Chain
 *
 * Resolution order (highest priority first):
 *  1. Explicit locale argument (e.g. from URL or programmatic call)
 *  2. User preference (from cookie — stored after auth or explicit switch)
 *  3. Tenant default locale (future-ready hook — currently returns undefined)
 *  4. Browser Accept-Language header (client-side: navigator.language)
 *  5. Platform default locale (en)
 *
 * Design: server-safe (no window/document access in core logic), deterministic,
 * no flicker — cookie is read before first render in I18nProvider.
 */

import {
  type Locale,
  DEFAULT_LOCALE,
  LOCALE_COOKIE_NAME,
  isSupportedLocale,
  resolveLocale,
} from "./config";

// ─────────────────────────────────────────────────────────────────────────────
// Cookie helpers (client-only, safe in SSR context when guarded)
// ─────────────────────────────────────────────────────────────────────────────

export function getLocaleCookie(): Locale | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.split(";").find(c => c.trim().startsWith(`${LOCALE_COOKIE_NAME}=`));
  if (!match) return undefined;
  const value = match.split("=")[1]?.trim();
  return isSupportedLocale(value) ? value : undefined;
}

export function setLocaleCookie(locale: Locale): void {
  if (typeof document === "undefined") return;
  const maxAge = 60 * 60 * 24 * 365;
  document.cookie = `${LOCALE_COOKIE_NAME}=${locale};path=/;max-age=${maxAge};SameSite=Lax`;
}

export function clearLocaleCookie(): void {
  if (typeof document === "undefined") return;
  document.cookie = `${LOCALE_COOKIE_NAME}=;path=/;max-age=0;SameSite=Lax`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser Accept-Language parsing
// ─────────────────────────────────────────────────────────────────────────────

export function resolveLocaleFromBrowser(): Locale | undefined {
  if (typeof navigator === "undefined") return undefined;
  const langs = navigator.languages ?? [navigator.language];
  for (const lang of langs) {
    // Match full locale ("da-DK") and base ("da")
    const base = lang.split("-")[0].toLowerCase();
    if (isSupportedLocale(base)) return base;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tenant default locale hook (future-ready)
// ─────────────────────────────────────────────────────────────────────────────

export function resolveTenantLocale(): Locale | undefined {
  // TODO Phase 50+: fetch from tenant settings when multi-locale tenants are supported
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main resolution function
// ─────────────────────────────────────────────────────────────────────────────

export interface LocaleResolutionOptions {
  /** Explicit locale override (highest priority) */
  explicit?: string;
  /** User preference stored in DB/profile (from auth context) */
  userPreference?: string;
}

export function resolveLocaleFromRequest(options: LocaleResolutionOptions = {}): Locale {
  // 1. Explicit override
  if (options.explicit && isSupportedLocale(options.explicit)) {
    return options.explicit;
  }

  // 2. User preference
  if (options.userPreference && isSupportedLocale(options.userPreference)) {
    return options.userPreference;
  }

  // 3. Tenant default
  const tenantLocale = resolveTenantLocale();
  if (tenantLocale) return tenantLocale;

  // 4. Cookie
  const cookieLocale = getLocaleCookie();
  if (cookieLocale) return cookieLocale;

  // 5. Browser Accept-Language
  const browserLocale = resolveLocaleFromBrowser();
  if (browserLocale) return browserLocale;

  // 6. Platform default
  return DEFAULT_LOCALE;
}

/**
 * Resolves locale from a URL path prefix, e.g. "/da/dashboard" → "da".
 * Returns undefined if no locale prefix found.
 */
export function resolveLocaleFromPath(pathname: string): Locale | undefined {
  const segment = pathname.split("/").filter(Boolean)[0];
  return isSupportedLocale(segment) ? segment : undefined;
}

export { resolveLocale, isSupportedLocale, DEFAULT_LOCALE };
