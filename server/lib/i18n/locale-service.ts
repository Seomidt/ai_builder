import { pool } from "../../db";

export interface TenantLocale {
  language: string;
  locale:   string;
  currency: string;
  timezone: string;
}

const DEFAULT_LOCALE: TenantLocale = {
  language: "en",
  locale:   "en-US",
  currency: "USD",
  timezone: "UTC",
};

export async function getTenantLocale(_tenantId: string): Promise<TenantLocale> {
  return DEFAULT_LOCALE;
}

export async function updateTenantLocale(
  tenantId: string,
  update: Partial<TenantLocale>,
): Promise<void> {
  const fields = Object.keys(update) as (keyof TenantLocale)[];
  if (fields.length === 0) return;
  const sets   = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
  const values = fields.map((f) => update[f]);
  await pool.query(
    `UPDATE organizations SET ${sets} WHERE id = $1`,
    [tenantId, ...values],
  );
}

const ISO_639  = /^[a-z]{2,3}(-[A-Z]{2,4})?$/;
const BCP47    = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/;
const ISO_4217 = /^[A-Z]{3}$/;

export function isValidLanguage(code: string): boolean { return ISO_639.test(code); }
export function isValidLocale(code: string): boolean   { return BCP47.test(code); }
export function isValidCurrency(code: string): boolean { return ISO_4217.test(code); }
export function isValidTimezone(tz: string): boolean {
  try { Intl.DateTimeFormat(undefined, { timeZone: tz }); return true; } catch { return false; }
}
