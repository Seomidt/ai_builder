/**
 * i18n Translator Utilities
 *
 * Provides:
 * - createTranslator(dict) → t(key, vars?, fallback?)
 * - Nested key lookup with dot-notation: t("nav.dashboard")
 * - Interpolation: t("greeting", { name: "Alice" }) → "Hello, Alice!"
 * - Pluralization hook placeholder (future-ready)
 * - Type-safe key access via generic overload
 */

import type { Namespace } from "./config";

export type TranslationVars = Record<string, string | number>;
export type Dictionary     = Record<string, unknown>;
export type DictionaryMap  = Record<Namespace | string, Dictionary>;

// ─────────────────────────────────────────────────────────────────────────────
// Nested key lookup
// ─────────────────────────────────────────────────────────────────────────────

function getNestedValue(obj: Dictionary, path: string): string | undefined {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interpolation
// ─────────────────────────────────────────────────────────────────────────────

function interpolate(template: string, vars: TranslationVars): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const val = vars[key];
    return val !== undefined ? String(val) : `{{${key}}}`;
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pluralization (future-ready placeholder)
// ─────────────────────────────────────────────────────────────────────────────

export interface PluralOptions {
  count: number;
}

function resolvePlural(
  dict: Dictionary,
  key: string,
  opts: PluralOptions
): string | undefined {
  // Future: resolve "_one", "_other", "_few" etc.
  // For now: if count === 1, try key + "_one", else key + "_other"
  const suffix = opts.count === 1 ? "_one" : "_other";
  return getNestedValue(dict, key + suffix) ?? getNestedValue(dict, key);
}

// ─────────────────────────────────────────────────────────────────────────────
// Translator factory
// ─────────────────────────────────────────────────────────────────────────────

export type TranslatorFn = {
  (key: string, vars?: TranslationVars, fallback?: string): string;
  plural(key: string, opts: PluralOptions, vars?: TranslationVars, fallback?: string): string;
  has(key: string): boolean;
};

/**
 * Create a translator bound to a single namespace dictionary.
 *
 * @param dict   - Flat or nested translation dictionary
 * @param nsName - Namespace name (for debug messages)
 * @param locale - Current locale (for debug messages)
 */
export function createTranslator(
  dict: Dictionary,
  nsName = "unknown",
  locale = "en"
): TranslatorFn {
  function t(key: string, vars?: TranslationVars, fallback?: string): string {
    const raw = getNestedValue(dict, key);
    if (raw === undefined) {
      if (import.meta.env.DEV) {
        console.warn(`[i18n][${locale}][${nsName}] Missing key: "${key}"`);
      }
      return fallback ?? key;
    }
    return vars ? interpolate(raw, vars) : raw;
  }

  function plural(
    key: string,
    opts: PluralOptions,
    vars?: TranslationVars,
    fallback?: string
  ): string {
    const raw = resolvePlural(dict, key, opts);
    if (raw === undefined) {
      if (import.meta.env.DEV) {
        console.warn(`[i18n][${locale}][${nsName}] Missing plural key: "${key}"`);
      }
      return fallback ?? key;
    }
    return vars ? interpolate(raw, { count: opts.count, ...vars }) : raw;
  }

  function has(key: string): boolean {
    return getNestedValue(dict, key) !== undefined;
  }

  t.plural = plural;
  t.has    = has;
  return t;
}

/**
 * Create a multi-namespace translator.
 * Keys are resolved as "namespace.key" or just "key" against the default namespace.
 */
export function createMultiNsTranslator(
  dicts: DictionaryMap,
  defaultNs: Namespace | string = "common",
  locale = "en"
): (key: string, vars?: TranslationVars, fallback?: string) => string {
  return function t(key: string, vars?: TranslationVars, fallback?: string): string {
    const [nsOrKey, ...rest] = key.split(":");
    const actualNs   = rest.length > 0 ? nsOrKey : defaultNs;
    const actualKey  = rest.length > 0 ? rest.join(":") : key;
    const dict       = dicts[actualNs] ?? dicts[defaultNs] ?? {};
    const raw        = getNestedValue(dict as Dictionary, actualKey);
    if (raw === undefined) {
      if (import.meta.env.DEV) {
        console.warn(`[i18n][${locale}][${actualNs}] Missing key: "${actualKey}"`);
      }
      return fallback ?? key;
    }
    return vars ? interpolate(raw, vars) : raw;
  };
}
