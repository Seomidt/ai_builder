/**
 * Phase 21 — Language Service
 * Registry and resolution for supported languages.
 */

import { db } from "../../db";
import { supportedLanguages } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";

export const SEED_LANGUAGES = [
  { languageCode: "en", displayName: "English",    nativeName: "English",      rtl: false },
  { languageCode: "da", displayName: "Danish",     nativeName: "Dansk",        rtl: false },
  { languageCode: "de", displayName: "German",     nativeName: "Deutsch",      rtl: false },
  { languageCode: "fr", displayName: "French",     nativeName: "Français",     rtl: false },
  { languageCode: "es", displayName: "Spanish",    nativeName: "Español",      rtl: false },
  { languageCode: "pt", displayName: "Portuguese", nativeName: "Português",    rtl: false },
  { languageCode: "nl", displayName: "Dutch",      nativeName: "Nederlands",   rtl: false },
  { languageCode: "it", displayName: "Italian",    nativeName: "Italiano",     rtl: false },
  { languageCode: "sv", displayName: "Swedish",    nativeName: "Svenska",      rtl: false },
  { languageCode: "no", displayName: "Norwegian",  nativeName: "Norsk",        rtl: false },
  { languageCode: "fi", displayName: "Finnish",    nativeName: "Suomi",        rtl: false },
  { languageCode: "pl", displayName: "Polish",     nativeName: "Polski",       rtl: false },
  { languageCode: "ja", displayName: "Japanese",   nativeName: "日本語",       rtl: false },
  { languageCode: "zh", displayName: "Chinese",    nativeName: "中文",          rtl: false },
  { languageCode: "ko", displayName: "Korean",     nativeName: "한국어",        rtl: false },
  { languageCode: "ar", displayName: "Arabic",     nativeName: "العربية",      rtl: true  },
  { languageCode: "he", displayName: "Hebrew",     nativeName: "עברית",        rtl: true  },
  { languageCode: "ru", displayName: "Russian",    nativeName: "Русский",      rtl: false },
  { languageCode: "tr", displayName: "Turkish",    nativeName: "Türkçe",       rtl: false },
  { languageCode: "hi", displayName: "Hindi",      nativeName: "हिन्दी",        rtl: false },
];

export const PLATFORM_DEFAULT_LANGUAGE = "en";

/**
 * Get all active supported languages.
 */
export async function listSupportedLanguages(filter?: { active?: boolean }): Promise<Array<Record<string, unknown>>> {
  const activeClause = filter?.active !== undefined ? drizzleSql`WHERE active = ${filter.active}` : drizzleSql``;
  const rows = await db.execute(drizzleSql`
    SELECT language_code, display_name, native_name, rtl, active
    FROM supported_languages ${activeClause}
    ORDER BY display_name ASC
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * Check if a language code is supported and active.
 */
export async function isLanguageSupported(languageCode: string): Promise<boolean> {
  const rows = await db.execute(drizzleSql`
    SELECT 1 FROM supported_languages WHERE language_code = ${languageCode.toLowerCase()} AND active = true LIMIT 1
  `);
  return rows.rows.length > 0;
}

/**
 * Get a single language by code.
 */
export async function getLanguage(languageCode: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM supported_languages WHERE language_code = ${languageCode.toLowerCase()} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

/**
 * Register a new language.
 */
export async function registerLanguage(params: {
  languageCode: string;
  displayName: string;
  nativeName?: string;
  rtl?: boolean;
  active?: boolean;
}): Promise<{ languageCode: string }> {
  if (!params.languageCode?.trim()) throw new Error("languageCode is required");
  if (!params.displayName?.trim()) throw new Error("displayName is required");
  await db.insert(supportedLanguages).values({
    languageCode: params.languageCode.toLowerCase().trim(),
    displayName: params.displayName.trim(),
    nativeName: params.nativeName ?? null,
    rtl: params.rtl ?? false,
    active: params.active ?? true,
  }).onConflictDoNothing();
  return { languageCode: params.languageCode.toLowerCase().trim() };
}

/**
 * Deactivate a language.
 */
export async function deactivateLanguage(languageCode: string): Promise<{ deactivated: boolean }> {
  await db.execute(drizzleSql`
    UPDATE supported_languages SET active = false WHERE language_code = ${languageCode.toLowerCase()}
  `);
  return { deactivated: true };
}

/**
 * Normalize a BCP-47 language tag to a supported code.
 * e.g. 'en-US' → 'en', 'zh-Hans' → 'zh'
 */
export function normalizeLanguageCode(raw: string): string {
  if (!raw) return PLATFORM_DEFAULT_LANGUAGE;
  const base = raw.split("-")[0].split("_")[0].toLowerCase().trim();
  return base || PLATFORM_DEFAULT_LANGUAGE;
}

/**
 * Get RTL status for a language code.
 */
export async function isRtlLanguage(languageCode: string): Promise<boolean> {
  const lang = await getLanguage(languageCode);
  return (lang?.rtl as boolean) ?? false;
}

/**
 * Get language distribution stats (observability).
 */
export async function getLanguageDistribution(): Promise<Array<{
  language: string;
  tenantCount: number;
  userCount: number;
}>> {
  const rows = await db.execute(drizzleSql`
    SELECT
      sl.language_code AS language,
      (SELECT COUNT(*) FROM tenant_locales WHERE default_language = sl.language_code) AS tenant_count,
      (SELECT COUNT(*) FROM user_locales WHERE language = sl.language_code) AS user_count
    FROM supported_languages sl
    WHERE sl.active = true
    ORDER BY tenant_count DESC, user_count DESC
  `);
  return rows.rows.map((r: Record<string, unknown>) => ({
    language: r.language as string,
    tenantCount: Number(r.tenant_count ?? 0),
    userCount: Number(r.user_count ?? 0),
  }));
}
