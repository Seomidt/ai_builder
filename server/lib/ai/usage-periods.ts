/**
 * AI Usage Period Helper
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Centralises usage period calculation so no other module needs to
 * hardcode calendar-month logic. Callers receive explicit periodStart
 * and periodEnd values — they never compute date boundaries themselves.
 *
 * Current implementation: calendar month periods.
 * Design is ready for later billing-cycle flexibility — change only this file.
 *
 * Phase 3G.1
 */

export interface UsagePeriod {
  /** Inclusive start of the current usage period */
  periodStart: Date;
  /** Exclusive end of the current usage period */
  periodEnd: Date;
}

/**
 * Return the current usage period boundaries.
 *
 * Current policy: calendar month (UTC-local boundary).
 *   periodStart = first moment of this calendar month
 *   periodEnd   = first moment of next calendar month (exclusive)
 *
 * Queries must use:
 *   created_at >= periodStart AND created_at < periodEnd
 */
export function getCurrentPeriod(): UsagePeriod {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  const periodStart = new Date(year, month, 1);
  const periodEnd = new Date(year, month + 1, 1);

  return { periodStart, periodEnd };
}
