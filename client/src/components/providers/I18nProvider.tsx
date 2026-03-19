/**
 * I18nProvider — React context for internationalization
 *
 * Resolves locale on mount (cookie → browser → default).
 * Lazily loads translation dictionaries on demand.
 * Provides locale, setLocale, and per-namespace translation access.
 *
 * Usage:
 *   const { locale, t, setLocale } = useI18n();
 *   const { t } = useI18nNamespace("dashboard");
 */

import { createContext, useContext, useEffect, useState, useCallback, type ReactNode } from "react";
import {
  type Locale,
  type Namespace,
  DEFAULT_LOCALE,
} from "@/lib/i18n/config";
import {
  resolveLocaleFromRequest,
  setLocaleCookie,
  getLocaleCookie,
} from "@/lib/i18n/resolve-locale";
import {
  loadDictionary,
  type DictionaryMap,
} from "@/lib/i18n/load-dictionary";
import { createTranslator, type TranslatorFn, type Dictionary } from "@/lib/i18n/translator";

// ─────────────────────────────────────────────────────────────────────────────
// Context types
// ─────────────────────────────────────────────────────────────────────────────

interface I18nContextValue {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  /** Get a typed translator for a specific namespace */
  getTranslator: (ns: Namespace) => TranslatorFn;
  /** Shorthand: t("common:nav.dashboard") or t("nav.dashboard") in "common" ns */
  t: (key: string, vars?: Record<string, string | number>, fallback?: string) => string;
  /** Whether dictionaries are loading */
  isLoading: boolean;
}

const I18nContext = createContext<I18nContextValue | null>(null);

// ─────────────────────────────────────────────────────────────────────────────
// Provider
// ─────────────────────────────────────────────────────────────────────────────

const PRELOAD_NAMESPACES: Namespace[] = ["common"];

interface I18nProviderProps {
  children: ReactNode;
  initialLocale?: Locale;
}

export function I18nProvider({ children, initialLocale }: I18nProviderProps) {
  // Resolve locale synchronously from cookie (avoids flicker)
  const [locale, setLocaleState] = useState<Locale>(() => {
    if (initialLocale) return initialLocale;
    return resolveLocaleFromRequest({});
  });

  const [dictionaries, setDictionaries] = useState<DictionaryMap>({});
  const [isLoading, setIsLoading] = useState(true);

  // Load namespace for current locale
  const loadNs = useCallback(async (ns: Namespace, loc: Locale) => {
    const dict = await loadDictionary(loc, ns);
    setDictionaries(prev => ({ ...prev, [`${loc}:${ns}`]: dict }));
  }, []);

  // Preload core namespaces on mount and locale change
  useEffect(() => {
    setIsLoading(true);
    Promise.all(PRELOAD_NAMESPACES.map(ns => loadNs(ns, locale))).finally(() => {
      setIsLoading(false);
    });
  }, [locale, loadNs]);

  const setLocale = useCallback((newLocale: Locale) => {
    setLocaleCookie(newLocale);
    setLocaleState(newLocale);
    document.documentElement.lang = newLocale;
  }, []);

  const getTranslator = useCallback((ns: Namespace): TranslatorFn => {
    const key = `${locale}:${ns}`;
    const dict = (dictionaries[key] ?? {}) as Dictionary;
    // Trigger async load if not cached
    if (!dictionaries[key]) loadNs(ns, locale);
    return createTranslator(dict, ns, locale);
  }, [dictionaries, locale, loadNs]);

  // Default translator bound to "common" namespace
  const t = useCallback((
    key: string,
    vars?: Record<string, string | number>,
    fallback?: string
  ): string => {
    const translator = getTranslator("common");
    return translator(key, vars, fallback);
  }, [getTranslator]);

  // Set html[lang] attribute
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  return (
    <I18nContext.Provider value={{ locale, setLocale, getTranslator, t, isLoading }}>
      {children}
    </I18nContext.Provider>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hooks
// ─────────────────────────────────────────────────────────────────────────────

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within <I18nProvider>");
  return ctx;
}

/**
 * Shorthand hook for a specific namespace.
 * Returns a translator function and current locale.
 */
export function useI18nNamespace(ns: Namespace): { t: TranslatorFn; locale: Locale } {
  const { getTranslator, locale } = useI18n();
  return { t: getTranslator(ns), locale };
}
