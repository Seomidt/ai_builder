/**
 * Phase 34 — Locale Service
 *
 * Reads tenant locale configuration from the `tenants` table.
 * Provides Intl-based formatting helpers.
 *
 * All functions are fail-open: if DB lookup fails, sane defaults are returned.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TenantLocale {
  language: string;
  locale: string;
  currency: string;
  timezone: string;
}

const DEFAULT_LOCALE: TenantLocale = {
  language: "en",
  locale: "en-US",
  currency: "USD",
  timezone: "UTC",
};

// ── Validation helpers ───────────────────────────────────────────────────────

export function isValidLanguage(lang: string): boolean {
  if (typeof lang !== "string" || lang.length < 2 || lang.length > 10) return false;
  return /^[a-z]{2,3}(-[A-Z]{2,4})?$/.test(lang);
}

export function isValidLocale(locale: string): boolean {
  if (typeof locale !== "string") return false;
  try {
    Intl.DateTimeFormat.supportedLocalesOf([locale]);
    return locale.length >= 2 && locale.length <= 20;
  } catch {
    return false;
  }
}

export function isValidCurrency(currency: string): boolean {
  if (typeof currency !== "string") return false;
  try {
    new Intl.NumberFormat("en", { style: "currency", currency });
    return true;
  } catch {
    return false;
  }
}

export function isValidTimezone(tz: string): boolean {
  if (typeof tz !== "string") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ── DB accessor ──────────────────────────────────────────────────────────────

export async function getTenantLocale(tenantId: string): Promise<TenantLocale> {
  try {
    const rows = await db.execute(
      sql`SELECT language, locale, currency, timezone
          FROM tenants
          WHERE id = ${tenantId}
          LIMIT 1`,
    );
    const row = rows.rows[0] as Record<string, unknown> | undefined;
    if (!row) return { ...DEFAULT_LOCALE };
    return {
      language: typeof row.language === "string" && row.language ? row.language : DEFAULT_LOCALE.language,
      locale:   typeof row.locale   === "string" && row.locale   ? row.locale   : DEFAULT_LOCALE.locale,
      currency: typeof row.currency === "string" && row.currency ? row.currency : DEFAULT_LOCALE.currency,
      timezone: typeof row.timezone === "string" && row.timezone ? row.timezone : DEFAULT_LOCALE.timezone,
    };
  } catch {
    return { ...DEFAULT_LOCALE };
  }
}

export async function updateTenantLocale(
  tenantId: string,
  update: Partial<TenantLocale>,
): Promise<void> {
  const sets: string[] = [];
  if (update.language !== undefined) sets.push(`language = '${update.language.replace(/'/g, "''")}'`);
  if (update.locale   !== undefined) sets.push(`locale   = '${update.locale.replace(/'/g, "''")}'`);
  if (update.currency !== undefined) sets.push(`currency = '${update.currency.replace(/'/g, "''")}'`);
  if (update.timezone !== undefined) sets.push(`timezone = '${update.timezone.replace(/'/g, "''")}'`);
  if (sets.length === 0) return;
  await db.execute(
    sql.raw(`UPDATE tenants SET ${sets.join(", ")}, updated_at = now() WHERE id = '${tenantId.replace(/'/g, "''")}'`),
  );
}

// ── Formatting helpers ───────────────────────────────────────────────────────

export function formatCurrency(amount: number, currency: string): string {
  const cur = isValidCurrency(currency) ? currency : DEFAULT_LOCALE.currency;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: cur,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatCurrencyForLocale(
  amount: number,
  currency: string,
  locale: string,
): string {
  const loc = isValidLocale(locale) ? locale : DEFAULT_LOCALE.locale;
  const cur = isValidCurrency(currency) ? currency : DEFAULT_LOCALE.currency;
  return new Intl.NumberFormat(loc, {
    style: "currency",
    currency: cur,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

export function formatDate(
  date: Date | string | number,
  locale: string,
  timezone: string,
): string {
  const d    = date instanceof Date ? date : new Date(date);
  const loc  = isValidLocale(locale)   ? locale   : DEFAULT_LOCALE.locale;
  const tz   = isValidTimezone(timezone) ? timezone : DEFAULT_LOCALE.timezone;
  return new Intl.DateTimeFormat(loc, {
    timeZone:    tz,
    year:        "numeric",
    month:       "short",
    day:         "numeric",
    hour:        "2-digit",
    minute:      "2-digit",
  }).format(d);
}

export function formatDateShort(
  date: Date | string | number,
  locale: string,
  timezone: string,
): string {
  const d   = date instanceof Date ? date : new Date(date);
  const loc = isValidLocale(locale)    ? locale   : DEFAULT_LOCALE.locale;
  const tz  = isValidTimezone(timezone) ? timezone : DEFAULT_LOCALE.timezone;
  return new Intl.DateTimeFormat(loc, {
    timeZone: tz,
    year:     "numeric",
    month:    "2-digit",
    day:      "2-digit",
  }).format(d);
}

export { DEFAULT_LOCALE };
