/**
 * Phase 21 — Locale Resolution
 * Resolves effective locale for a user/tenant using the canonical priority order:
 *   user_locale → tenant_locale → platform_default
 *
 * INV-I18N1: Resolution is deterministic and never throws.
 * INV-I18N2: Platform defaults are always the final fallback.
 */

import { db } from "../../db.ts";
import { tenantLocales, userLocales } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";
import { normalizeLanguageCode, PLATFORM_DEFAULT_LANGUAGE } from "./language-service.ts";
import { PLATFORM_DEFAULT_CURRENCY } from "./currency-service.ts";

const PLATFORM_DEFAULT_TIMEZONE = "UTC";
const PLATFORM_DEFAULT_NUMBER_FORMAT = "en-US";

export interface ResolvedLocale {
  language: string;
  currency: string;
  timezone: string;
  numberFormat: string;
  source: "user" | "tenant" | "platform";
  rtl: boolean;
  resolvedAt: number; // ms timestamp for latency tracking
}

const RTL_LANGUAGES = new Set(["ar", "he", "fa", "ur", "yi", "dv"]);

function isRtl(lang: string): boolean {
  return RTL_LANGUAGES.has(normalizeLanguageCode(lang));
}

/**
 * Resolve the effective locale for a user in a tenant context.
 * INV-I18N1: Always returns a valid locale — never throws.
 */
export async function resolveLocale(params: {
  userId?: string;
  tenantId?: string;
}): Promise<ResolvedLocale> {
  const start = Date.now();

  // 1. Try user locale
  if (params.userId) {
    try {
      const rows = await db.execute(drizzleSql`
        SELECT language, currency, timezone, number_format FROM user_locales
        WHERE user_id = ${params.userId} LIMIT 1
      `);
      const row = rows.rows[0] as Record<string, unknown> | undefined;
      if (row) {
        const lang = (row.language as string) || PLATFORM_DEFAULT_LANGUAGE;
        return {
          language: lang,
          currency: (row.currency as string) || await resolveTenantCurrency(params.tenantId) || PLATFORM_DEFAULT_CURRENCY,
          timezone: (row.timezone as string) || PLATFORM_DEFAULT_TIMEZONE,
          numberFormat: (row.number_format as string) || PLATFORM_DEFAULT_NUMBER_FORMAT,
          source: "user",
          rtl: isRtl(lang),
          resolvedAt: Date.now() - start,
        };
      }
    } catch { /* fallthrough */ }
  }

  // 2. Try tenant locale
  if (params.tenantId) {
    try {
      const tenantLocale = await getTenantLocale(params.tenantId);
      if (tenantLocale) {
        const lang = (tenantLocale.default_language as string) || PLATFORM_DEFAULT_LANGUAGE;
        return {
          language: lang,
          currency: (tenantLocale.default_currency as string) || PLATFORM_DEFAULT_CURRENCY,
          timezone: (tenantLocale.default_timezone as string) || PLATFORM_DEFAULT_TIMEZONE,
          numberFormat: (tenantLocale.number_format as string) || PLATFORM_DEFAULT_NUMBER_FORMAT,
          source: "tenant",
          rtl: isRtl(lang),
          resolvedAt: Date.now() - start,
        };
      }
    } catch { /* fallthrough */ }
  }

  // 3. Platform default (INV-I18N2)
  return {
    language: PLATFORM_DEFAULT_LANGUAGE,
    currency: PLATFORM_DEFAULT_CURRENCY,
    timezone: PLATFORM_DEFAULT_TIMEZONE,
    numberFormat: PLATFORM_DEFAULT_NUMBER_FORMAT,
    source: "platform",
    rtl: false,
    resolvedAt: Date.now() - start,
  };
}

async function resolveTenantCurrency(tenantId?: string): Promise<string | null> {
  if (!tenantId) return null;
  const tl = await getTenantLocale(tenantId);
  return (tl?.default_currency as string) ?? null;
}

/**
 * Get the tenant locale record.
 */
export async function getTenantLocale(tenantId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM tenant_locales WHERE tenant_id = ${tenantId} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

/**
 * Set (upsert) tenant locale configuration.
 */
export async function setTenantLocale(params: {
  tenantId: string;
  defaultLanguage?: string;
  defaultCurrency?: string;
  defaultTimezone?: string;
  numberFormat?: string;
}): Promise<{ id: string; tenantId: string }> {
  if (!params.tenantId?.trim()) throw new Error("tenantId is required");

  const existing = await getTenantLocale(params.tenantId);
  if (existing) {
    await db.execute(drizzleSql`
      UPDATE tenant_locales SET
        default_language = ${params.defaultLanguage ?? (existing.default_language as string)},
        default_currency = ${params.defaultCurrency ?? (existing.default_currency as string)},
        default_timezone = ${params.defaultTimezone ?? (existing.default_timezone as string)},
        number_format = ${params.numberFormat ?? (existing.number_format as string)},
        updated_at = NOW()
      WHERE tenant_id = ${params.tenantId}
    `);
    return { id: existing.id as string, tenantId: params.tenantId };
  } else {
    const rows = await db.insert(tenantLocales).values({
      tenantId: params.tenantId,
      defaultLanguage: params.defaultLanguage ?? PLATFORM_DEFAULT_LANGUAGE,
      defaultCurrency: params.defaultCurrency ?? PLATFORM_DEFAULT_CURRENCY,
      defaultTimezone: params.defaultTimezone ?? PLATFORM_DEFAULT_TIMEZONE,
      numberFormat: params.numberFormat ?? PLATFORM_DEFAULT_NUMBER_FORMAT,
    }).returning({ id: tenantLocales.id });
    return { id: rows[0].id, tenantId: params.tenantId };
  }
}

/**
 * Get the user locale record.
 */
export async function getUserLocale(userId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM user_locales WHERE user_id = ${userId} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

/**
 * Set (upsert) user locale preferences.
 */
export async function setUserLocale(params: {
  userId: string;
  tenantId?: string;
  language?: string;
  timezone?: string;
  currency?: string;
  numberFormat?: string;
}): Promise<{ id: string; userId: string }> {
  if (!params.userId?.trim()) throw new Error("userId is required");

  const existing = await getUserLocale(params.userId);
  if (existing) {
    await db.execute(drizzleSql`
      UPDATE user_locales SET
        language = ${params.language ?? (existing.language as string)},
        timezone = ${params.timezone ?? (existing.timezone as string)},
        currency = ${params.currency ?? (existing.currency as string | null) ?? null},
        number_format = ${params.numberFormat ?? (existing.number_format as string | null) ?? null},
        updated_at = NOW()
      WHERE user_id = ${params.userId}
    `);
    return { id: existing.id as string, userId: params.userId };
  } else {
    const rows = await db.insert(userLocales).values({
      userId: params.userId,
      tenantId: params.tenantId ?? null,
      language: params.language ?? PLATFORM_DEFAULT_LANGUAGE,
      timezone: params.timezone ?? PLATFORM_DEFAULT_TIMEZONE,
      currency: params.currency ?? null,
      numberFormat: params.numberFormat ?? null,
    }).returning({ id: userLocales.id });
    return { id: rows[0].id, userId: params.userId };
  }
}

/**
 * Get locale resolution latency stats (observability).
 */
export async function getLocaleResolutionStats(sampleSize: number = 10): Promise<{
  avgResolutionMs: number;
  samples: number;
}> {
  const latencies: number[] = [];
  const tenantIds = ["sample-tenant-1", "sample-tenant-2", "nonexistent-tenant"];
  for (let i = 0; i < Math.min(sampleSize, 10); i++) {
    const t0 = Date.now();
    await resolveLocale({ tenantId: tenantIds[i % tenantIds.length] });
    latencies.push(Date.now() - t0);
  }
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  return { avgResolutionMs: Math.round(avg), samples: latencies.length };
}
