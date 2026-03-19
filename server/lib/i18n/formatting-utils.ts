/**
 * Phase 21 — Formatting Utilities
 * Locale-aware formatters for currency, numbers, dates, and time.
 */

import { normalizeTimezone } from "./timezone-service";

export interface FormatOptions {
  locale?: string;       // BCP-47, e.g. "en-US", "da-DK"
  timezone?: string;     // IANA, e.g. "Europe/Copenhagen"
  currency?: string;     // ISO 4217, e.g. "DKK"
  decimals?: number;
}

/**
 * Format a monetary amount with currency symbol.
 *
 * @example formatCurrency(9900, { currency: "DKK", locale: "da-DK" }) → "9.900,00 kr."
 */
export function formatCurrency(
  amount: number,
  options: FormatOptions = {},
): string {
  const currency = options.currency?.toUpperCase() || "USD";
  const locale = options.locale || "en-US";
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: options.decimals ?? 2,
      maximumFractionDigits: options.decimals ?? 2,
    }).format(amount);
  } catch {
    // Fallback for unsupported currencies
    return `${currency} ${amount.toFixed(options.decimals ?? 2)}`;
  }
}

/**
 * Format a number with locale-specific separators.
 *
 * @example formatNumber(1234567.89, { locale: "de-DE" }) → "1.234.567,89"
 */
export function formatNumber(
  value: number,
  options: FormatOptions = {},
): string {
  const locale = options.locale || "en-US";
  try {
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: options.decimals ?? 0,
      maximumFractionDigits: options.decimals ?? 2,
    }).format(value);
  } catch {
    return value.toFixed(options.decimals ?? 2);
  }
}

/**
 * Format a date in the given locale and timezone.
 *
 * @example formatDate(new Date(), { locale: "da-DK", timezone: "Europe/Copenhagen" }) → "15. marts 2026"
 */
export function formatDate(
  date: Date | string | number,
  options: FormatOptions = {},
): string {
  const d = date instanceof Date ? date : new Date(date);
  const locale = options.locale || "en-US";
  const tz = normalizeTimezone(options.timezone || "UTC");
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: tz,
      year: "numeric",
      month: "long",
      day: "numeric",
    }).format(d);
  } catch {
    return d.toDateString();
  }
}

/**
 * Format a time in the given locale and timezone.
 *
 * @example formatTime(new Date(), { locale: "en-US", timezone: "America/New_York" }) → "2:30 PM"
 */
export function formatTime(
  date: Date | string | number,
  options: FormatOptions & { hour12?: boolean } = {},
): string {
  const d = date instanceof Date ? date : new Date(date);
  const locale = options.locale || "en-US";
  const tz = normalizeTimezone(options.timezone || "UTC");
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: options.hour12 ?? true,
    }).format(d);
  } catch {
    return d.toTimeString().slice(0, 8);
  }
}

/**
 * Format a relative time (e.g. "3 days ago", "in 2 hours").
 * Uses Intl.RelativeTimeFormat when available.
 */
export function formatRelativeTime(
  date: Date | string | number,
  options: FormatOptions = {},
): string {
  const d = date instanceof Date ? date : new Date(date);
  const locale = options.locale || "en-US";
  const diffMs = d.getTime() - Date.now();
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHour = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHour / 24);

  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    if (Math.abs(diffDay) >= 1) return rtf.format(diffDay, "day");
    if (Math.abs(diffHour) >= 1) return rtf.format(diffHour, "hour");
    if (Math.abs(diffMin) >= 1) return rtf.format(diffMin, "minute");
    return rtf.format(diffSec, "second");
  } catch {
    if (diffMs < 0) return `${Math.abs(diffDay)} days ago`;
    return `in ${diffDay} days`;
  }
}

/**
 * Format a percentage value.
 *
 * @example formatPercent(0.843, { locale: "de-DE" }) → "84,3 %"
 */
export function formatPercent(
  value: number,
  options: FormatOptions & { maximumFractionDigits?: number } = {},
): string {
  const locale = options.locale || "en-US";
  try {
    return new Intl.NumberFormat(locale, {
      style: "percent",
      minimumFractionDigits: options.decimals ?? 1,
      maximumFractionDigits: options.maximumFractionDigits ?? options.decimals ?? 1,
    }).format(value);
  } catch {
    return `${(value * 100).toFixed(options.decimals ?? 1)}%`;
  }
}

/**
 * Format a file size in human-readable form.
 */
export function formatFileSize(bytes: number, locale: string = "en-US"): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = -1;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const formatted = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  return `${formatted} ${units[unitIndex]}`;
}

/**
 * Compact locale info for a resolved locale — used for API responses.
 */
export function buildLocaleContext(params: {
  locale: string;
  currency: string;
  timezone: string;
}): {
  locale: string;
  currency: string;
  timezone: string;
  currencyFormatter: (amount: number) => string;
  numberFormatter: (value: number) => string;
  dateFormatter: (date: Date) => string;
  timeFormatter: (date: Date) => string;
} {
  return {
    locale: params.locale,
    currency: params.currency,
    timezone: params.timezone,
    currencyFormatter: (amount) => formatCurrency(amount, { locale: params.locale, currency: params.currency }),
    numberFormatter: (value) => formatNumber(value, { locale: params.locale }),
    dateFormatter: (date) => formatDate(date, { locale: params.locale, timezone: params.timezone }),
    timeFormatter: (date) => formatTime(date, { locale: params.locale, timezone: params.timezone }),
  };
}
