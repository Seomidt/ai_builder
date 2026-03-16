/**
 * Phase 34 — i18n initialisation
 *
 * Uses i18next with react-i18next.
 * Language detection order: localStorage → navigator → fallback "en".
 * Translations are loaded synchronously from bundled JSON files.
 */

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./translations/en.json";
import da from "./translations/da.json";

export const SUPPORTED_LANGUAGES: Record<string, string> = {
  en: "English",
  da: "Dansk",
};

export const resources = {
  en: { translation: en },
  da: { translation: da },
};

function detectLanguage(): string {
  if (typeof window !== "undefined") {
    const stored = localStorage.getItem("app_language");
    if (stored && stored in SUPPORTED_LANGUAGES) return stored;
    const nav = navigator.language.split("-")[0];
    if (nav in SUPPORTED_LANGUAGES) return nav;
  }
  return "en";
}

if (!i18n.isInitialized) {
  i18n
    .use(initReactI18next)
    .init({
      resources,
      lng: detectLanguage(),
      fallbackLng: "en",
      interpolation: {
        escapeValue: false,
      },
      debug: false,
    });
}

export function setLanguage(lang: string): void {
  if (lang in SUPPORTED_LANGUAGES) {
    i18n.changeLanguage(lang);
    if (typeof window !== "undefined") {
      localStorage.setItem("app_language", lang);
    }
  }
}

export default i18n;
