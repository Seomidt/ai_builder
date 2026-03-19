/**
 * useTranslations — Convenience hook for component-level translations
 *
 * Mirrors the I18nProvider API but provides a simpler interface
 * for components that only need one namespace.
 *
 * Usage:
 *   const { t, locale } = useTranslations("dashboard");
 *   <h1>{t("title")}</h1>
 *
 * For components that need multiple namespaces, use useI18n() directly.
 */

import { useI18n, useI18nNamespace } from "@/components/providers/I18nProvider";
import type { Namespace } from "@/lib/i18n/config";
import type { TranslatorFn } from "@/lib/i18n/translator";
import type { Locale } from "@/lib/i18n/config";

export interface UseTranslationsResult {
  t: TranslatorFn;
  locale: Locale;
}

export function useTranslations(ns: Namespace = "common"): UseTranslationsResult {
  return useI18nNamespace(ns);
}

/**
 * Access the current locale and locale switcher only (no translations).
 */
export function useLocale(): { locale: Locale; setLocale: (l: Locale) => void } {
  const { locale, setLocale } = useI18n();
  return { locale, setLocale };
}

export { useI18n };
