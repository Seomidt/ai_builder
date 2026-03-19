/**
 * i18n Configuration — AI Builder Platform
 *
 * Canonical locale model for multi-tenant SaaS.
 * Stack: Vite + React + Wouter (client-side SPA)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Supported locales
// ─────────────────────────────────────────────────────────────────────────────

export const SUPPORTED_LOCALES = ["en", "da"] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_COOKIE_NAME = "blissops_locale";
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

// ─────────────────────────────────────────────────────────────────────────────
// Namespaces
// ─────────────────────────────────────────────────────────────────────────────

export const NAMESPACES = ["common", "auth", "dashboard", "settings", "ops"] as const;
export type Namespace = (typeof NAMESPACES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// Locale metadata
// ─────────────────────────────────────────────────────────────────────────────

export interface LocaleMetadata {
  code: Locale;
  name: string;
  nativeName: string;
  dir: "ltr" | "rtl";
  flag: string;
}

export const LOCALE_METADATA: Record<Locale, LocaleMetadata> = {
  en: { code: "en", name: "English",  nativeName: "English", dir: "ltr", flag: "🇬🇧" },
  da: { code: "da", name: "Danish",   nativeName: "Dansk",   dir: "ltr", flag: "🇩🇰" },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function isSupportedLocale(candidate: unknown): candidate is Locale {
  return SUPPORTED_LOCALES.includes(candidate as Locale);
}

export function getFallbackLocale(): Locale {
  return DEFAULT_LOCALE;
}

export function resolveLocale(candidate: unknown): Locale {
  return isSupportedLocale(candidate) ? candidate : DEFAULT_LOCALE;
}

export function getLocaleMetadata(locale: Locale): LocaleMetadata {
  return LOCALE_METADATA[locale];
}

export function getAllLocales(): readonly Locale[] {
  return SUPPORTED_LOCALES;
}

/**
 * Validate that a string is a supported locale, throw in dev if not.
 */
export function assertLocale(candidate: unknown, context = "locale"): Locale {
  if (!isSupportedLocale(candidate)) {
    const msg = `[i18n] Unsupported ${context}: "${candidate}". Falling back to "${DEFAULT_LOCALE}".`;
    if (import.meta.env.DEV) console.warn(msg);
    return DEFAULT_LOCALE;
  }
  return candidate;
}
