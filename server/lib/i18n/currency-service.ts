/**
 * Phase 21 — Currency Service
 * Registry and lookup for supported currencies + observability.
 */

import { db } from "../../db.ts";
import { supportedCurrencies } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";

export const SEED_CURRENCIES = [
  { currencyCode: "USD", symbol: "$",   displayName: "US Dollar",        decimals: 2 },
  { currencyCode: "EUR", symbol: "€",   displayName: "Euro",             decimals: 2 },
  { currencyCode: "GBP", symbol: "£",   displayName: "British Pound",    decimals: 2 },
  { currencyCode: "DKK", symbol: "kr",  displayName: "Danish Krone",     decimals: 2 },
  { currencyCode: "SEK", symbol: "kr",  displayName: "Swedish Krona",    decimals: 2 },
  { currencyCode: "NOK", symbol: "kr",  displayName: "Norwegian Krone",  decimals: 2 },
  { currencyCode: "CHF", symbol: "CHF", displayName: "Swiss Franc",      decimals: 2 },
  { currencyCode: "JPY", symbol: "¥",   displayName: "Japanese Yen",     decimals: 0 },
  { currencyCode: "CNY", symbol: "¥",   displayName: "Chinese Yuan",     decimals: 2 },
  { currencyCode: "KRW", symbol: "₩",   displayName: "Korean Won",       decimals: 0 },
  { currencyCode: "INR", symbol: "₹",   displayName: "Indian Rupee",     decimals: 2 },
  { currencyCode: "CAD", symbol: "CA$", displayName: "Canadian Dollar",  decimals: 2 },
  { currencyCode: "AUD", symbol: "A$",  displayName: "Australian Dollar",decimals: 2 },
  { currencyCode: "BRL", symbol: "R$",  displayName: "Brazilian Real",   decimals: 2 },
  { currencyCode: "MXN", symbol: "MX$", displayName: "Mexican Peso",     decimals: 2 },
  { currencyCode: "PLN", symbol: "zł",  displayName: "Polish Zloty",     decimals: 2 },
  { currencyCode: "RUB", symbol: "₽",   displayName: "Russian Ruble",    decimals: 2 },
  { currencyCode: "TRY", symbol: "₺",   displayName: "Turkish Lira",     decimals: 2 },
  { currencyCode: "ILS", symbol: "₪",   displayName: "Israeli Shekel",   decimals: 2 },
  { currencyCode: "AED", symbol: "د.إ", displayName: "UAE Dirham",       decimals: 2 },
];

export const PLATFORM_DEFAULT_CURRENCY = "USD";

/**
 * List all supported currencies.
 */
export async function listSupportedCurrencies(filter?: { active?: boolean }): Promise<Array<Record<string, unknown>>> {
  const activeClause = filter?.active !== undefined ? drizzleSql`WHERE active = ${filter.active}` : drizzleSql``;
  const rows = await db.execute(drizzleSql`
    SELECT currency_code, symbol, display_name, decimals, active
    FROM supported_currencies ${activeClause}
    ORDER BY currency_code ASC
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * Get a single currency by code.
 */
export async function getCurrency(currencyCode: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM supported_currencies WHERE currency_code = ${currencyCode.toUpperCase()} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

/**
 * Check if a currency code is supported and active.
 */
export async function isCurrencySupported(currencyCode: string): Promise<boolean> {
  const rows = await db.execute(drizzleSql`
    SELECT 1 FROM supported_currencies WHERE currency_code = ${currencyCode.toUpperCase()} AND active = true LIMIT 1
  `);
  return rows.rows.length > 0;
}

/**
 * Register a new currency.
 */
export async function registerCurrency(params: {
  currencyCode: string;
  symbol: string;
  displayName: string;
  decimals?: number;
  active?: boolean;
}): Promise<{ currencyCode: string }> {
  if (!params.currencyCode?.trim()) throw new Error("currencyCode is required");
  if (!params.symbol?.trim()) throw new Error("symbol is required");
  await db.insert(supportedCurrencies).values({
    currencyCode: params.currencyCode.toUpperCase().trim(),
    symbol: params.symbol.trim(),
    displayName: params.displayName?.trim() || params.currencyCode.toUpperCase(),
    decimals: Math.max(0, params.decimals ?? 2),
    active: params.active ?? true,
  }).onConflictDoNothing();
  return { currencyCode: params.currencyCode.toUpperCase().trim() };
}

/**
 * Get the number of decimals for a currency.
 */
export async function getCurrencyDecimals(currencyCode: string): Promise<number> {
  const c = await getCurrency(currencyCode);
  return Number(c?.decimals ?? 2);
}

/**
 * Get currency usage stats across tenants (observability).
 */
export async function getCurrencyUsageStats(): Promise<Array<{
  currencyCode: string;
  tenantCount: number;
  userCount: number;
}>> {
  const rows = await db.execute(drizzleSql`
    SELECT
      sc.currency_code,
      (SELECT COUNT(*) FROM tenant_locales WHERE default_currency = sc.currency_code) AS tenant_count,
      (SELECT COUNT(*) FROM user_locales WHERE currency = sc.currency_code) AS user_count
    FROM supported_currencies sc
    WHERE sc.active = true
    ORDER BY tenant_count DESC
  `);
  return rows.rows.map((r: Record<string, unknown>) => ({
    currencyCode: r.currency_code as string,
    tenantCount: Number(r.tenant_count ?? 0),
    userCount: Number(r.user_count ?? 0),
  }));
}
