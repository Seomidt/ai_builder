/**
 * i18n Dictionary Loader
 *
 * Loads translation namespaces dynamically.
 * Uses Vite's import.meta.glob for static analysis + code splitting.
 *
 * Fallback behavior:
 *  - If a namespace is missing for the target locale, falls back to DEFAULT_LOCALE
 *  - Fails loudly in dev, silently in production
 *
 * Design: lazy-loaded per namespace for bundle efficiency.
 */

import { DEFAULT_LOCALE, type Locale, type Namespace, NAMESPACES } from "./config";

// Vite glob import — all locale JSON files, lazily loaded
const dictionaryModules = import.meta.glob<Record<string, unknown>>(
  "../../locales/**/*.json",
  { import: "default" }
);

type DictionaryMap = Record<string, Record<string, unknown>>;

// In-process cache: locale+namespace → dictionary object
const cache: Map<string, Record<string, unknown>> = new Map();

function cacheKey(locale: Locale, ns: Namespace): string {
  return `${locale}:${ns}`;
}

function moduleKey(locale: Locale, ns: Namespace): string {
  return `../../locales/${locale}/${ns}.json`;
}

async function loadModule(locale: Locale, ns: Namespace): Promise<Record<string, unknown> | null> {
  const key = moduleKey(locale, ns);
  const loader = dictionaryModules[key];
  if (!loader) return null;
  try {
    return await loader();
  } catch {
    return null;
  }
}

/**
 * Load a single translation namespace for a locale.
 * Falls back to DEFAULT_LOCALE if the namespace is unavailable.
 */
export async function loadDictionary(
  locale: Locale,
  ns: Namespace
): Promise<Record<string, unknown>> {
  const key = cacheKey(locale, ns);
  if (cache.has(key)) return cache.get(key)!;

  let dict = await loadModule(locale, ns);

  if (!dict) {
    const msg = `[i18n] Missing namespace "${ns}" for locale "${locale}". Falling back to "${DEFAULT_LOCALE}".`;
    if (import.meta.env.DEV) console.warn(msg);

    if (locale !== DEFAULT_LOCALE) {
      dict = await loadModule(DEFAULT_LOCALE, ns);
    }
  }

  if (!dict) {
    const msg = `[i18n] Namespace "${ns}" not found even in fallback locale "${DEFAULT_LOCALE}". Returning empty dict.`;
    if (import.meta.env.DEV) console.error(msg);
    dict = {};
  }

  cache.set(key, dict);
  return dict;
}

/**
 * Load multiple namespaces for a locale, returning a merged map.
 */
export async function loadNamespaces(
  locale: Locale,
  namespaces: readonly Namespace[]
): Promise<DictionaryMap> {
  const entries = await Promise.all(
    namespaces.map(async ns => [ns, await loadDictionary(locale, ns)] as const)
  );
  return Object.fromEntries(entries);
}

/**
 * Preload all namespaces for a locale (e.g. called on locale switch).
 */
export async function preloadAllNamespaces(locale: Locale): Promise<DictionaryMap> {
  return loadNamespaces(locale, NAMESPACES);
}

/**
 * Clear the cache (useful for testing or hot reload).
 */
export function clearDictionaryCache(): void {
  cache.clear();
}

export type { DictionaryMap };
