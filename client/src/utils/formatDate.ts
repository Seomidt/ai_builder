/**
 * Phase 34 — Date formatting utility (client-side)
 * Uses Intl.DateTimeFormat — no external dependencies.
 */

export function formatDate(
  date: Date | string | number,
  locale = "en-US",
  timezone = "UTC",
): string {
  const d = date instanceof Date ? date : new Date(date);
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(d);
  }
}

export function formatDateShort(
  date: Date | string | number,
  locale = "en-US",
  timezone = "UTC",
): string {
  const d = date instanceof Date ? date : new Date(date);
  try {
    return new Intl.DateTimeFormat(locale, {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  } catch {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d);
  }
}

export function formatRelativeDate(date: Date | string | number, locale = "en-US"): string {
  const d = date instanceof Date ? date : new Date(date);
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);
  try {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    if (diffDays > 0)  return rtf.format(-diffDays, "day");
    if (diffHours > 0) return rtf.format(-diffHours, "hour");
    if (diffMins > 0)  return rtf.format(-diffMins, "minute");
    return rtf.format(-diffSecs, "second");
  } catch {
    return formatDate(d);
  }
}
