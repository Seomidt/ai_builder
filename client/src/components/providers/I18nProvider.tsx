/**
 * Phase 34 — I18nProvider
 *
 * Wraps the app to provide translation context.
 * Detects tenant language from localStorage or navigator.
 * Falls back to English.
 */

import { useEffect, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import i18n, { setLanguage } from "@/i18n/i18n";

interface I18nProviderProps {
  children: ReactNode;
  language?: string;
}

export function I18nProvider({ children, language }: I18nProviderProps) {
  useEffect(() => {
    if (language) {
      setLanguage(language);
    }
  }, [language]);

  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}

export default I18nProvider;
