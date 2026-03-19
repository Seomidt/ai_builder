/**
 * Phase 21 — Timezone Service
 * Timezone validation, normalization, and conversion helpers.
 */

// Comprehensive list of valid IANA timezone identifiers
const VALID_TIMEZONES = new Set([
  "UTC", "GMT",
  // Americas
  "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
  "America/Anchorage", "America/Honolulu", "America/Toronto", "America/Vancouver",
  "America/Mexico_City", "America/Bogota", "America/Lima", "America/Santiago",
  "America/Buenos_Aires", "America/Sao_Paulo", "America/Caracas", "America/Halifax",
  "America/Phoenix", "America/Regina", "America/Winnipeg", "America/Edmonton",
  // Europe
  "Europe/London", "Europe/Dublin", "Europe/Lisbon",
  "Europe/Paris", "Europe/Berlin", "Europe/Rome", "Europe/Madrid", "Europe/Amsterdam",
  "Europe/Brussels", "Europe/Vienna", "Europe/Zurich", "Europe/Stockholm",
  "Europe/Copenhagen", "Europe/Oslo", "Europe/Helsinki", "Europe/Warsaw",
  "Europe/Prague", "Europe/Budapest", "Europe/Bucharest", "Europe/Athens",
  "Europe/Kiev", "Europe/Moscow", "Europe/Istanbul",
  // Asia / Pacific
  "Asia/Dubai", "Asia/Karachi", "Asia/Colombo", "Asia/Kolkata",
  "Asia/Kathmandu", "Asia/Dhaka", "Asia/Yangon", "Asia/Bangkok",
  "Asia/Singapore", "Asia/Kuala_Lumpur", "Asia/Jakarta", "Asia/Hong_Kong",
  "Asia/Shanghai", "Asia/Taipei", "Asia/Tokyo", "Asia/Seoul",
  "Asia/Manila", "Asia/Riyadh", "Asia/Jerusalem", "Asia/Beirut",
  "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane",
  "Australia/Perth", "Australia/Adelaide", "Pacific/Auckland",
  "Pacific/Honolulu", "Pacific/Fiji",
  // Africa
  "Africa/Cairo", "Africa/Johannesburg", "Africa/Lagos", "Africa/Nairobi",
  "Africa/Accra", "Africa/Casablanca",
  // UTC offsets (common)
  "Etc/UTC", "Etc/GMT", "Etc/GMT+0", "Etc/GMT-1", "Etc/GMT-2",
  "Etc/GMT-3", "Etc/GMT+3", "Etc/GMT-4", "Etc/GMT-5", "Etc/GMT+5",
  "Etc/GMT-6", "Etc/GMT-7", "Etc/GMT-8", "Etc/GMT-9", "Etc/GMT-10",
  "Etc/GMT-11", "Etc/GMT-12",
]);

export const PLATFORM_DEFAULT_TIMEZONE = "UTC";

/**
 * Validate an IANA timezone string.
 */
export function isValidTimezone(timezone: string): boolean {
  if (!timezone?.trim()) return false;
  if (VALID_TIMEZONES.has(timezone)) return true;
  // Try runtime validation via Intl
  try {
    Intl.DateTimeFormat(undefined, { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalize a timezone string — returns platform default if invalid.
 */
export function normalizeTimezone(timezone: string): string {
  if (isValidTimezone(timezone)) return timezone;
  return PLATFORM_DEFAULT_TIMEZONE;
}

/**
 * Convert a UTC date to a specific timezone and return formatted string.
 */
export function convertToTimezone(date: Date, timezone: string): {
  isoString: string;
  offset: string;
  timezone: string;
} {
  const tz = normalizeTimezone(timezone);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const isoString = `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
  const offset = get("timeZoneName");
  return { isoString, offset, timezone: tz };
}

/**
 * Get the current UTC offset for a timezone (e.g., "+05:30").
 */
export function getUtcOffset(timezone: string, date: Date = new Date()): string {
  const tz = normalizeTimezone(timezone);
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "longOffset",
    });
    const parts = formatter.formatToParts(date);
    const offset = parts.find((p) => p.type === "timeZoneName")?.value ?? "UTC";
    // Extract e.g. "GMT+05:30" → "+05:30"
    const match = offset.match(/GMT([+-]\d{2}:\d{2})/);
    return match ? match[1] : "+00:00";
  } catch {
    return "+00:00";
  }
}

/**
 * List common timezones grouped by region.
 */
export function listCommonTimezones(): Array<{ region: string; timezone: string; offset: string }> {
  const zones = [
    { region: "UTC", timezone: "UTC" },
    { region: "Americas", timezone: "America/New_York" },
    { region: "Americas", timezone: "America/Chicago" },
    { region: "Americas", timezone: "America/Denver" },
    { region: "Americas", timezone: "America/Los_Angeles" },
    { region: "Americas", timezone: "America/Sao_Paulo" },
    { region: "Americas", timezone: "America/Toronto" },
    { region: "Europe", timezone: "Europe/London" },
    { region: "Europe", timezone: "Europe/Paris" },
    { region: "Europe", timezone: "Europe/Berlin" },
    { region: "Europe", timezone: "Europe/Moscow" },
    { region: "Europe", timezone: "Europe/Copenhagen" },
    { region: "Europe", timezone: "Europe/Stockholm" },
    { region: "Asia", timezone: "Asia/Dubai" },
    { region: "Asia", timezone: "Asia/Kolkata" },
    { region: "Asia", timezone: "Asia/Singapore" },
    { region: "Asia", timezone: "Asia/Shanghai" },
    { region: "Asia", timezone: "Asia/Tokyo" },
    { region: "Asia", timezone: "Asia/Seoul" },
    { region: "Pacific", timezone: "Australia/Sydney" },
    { region: "Pacific", timezone: "Pacific/Auckland" },
  ];
  return zones.map((z) => ({ ...z, offset: getUtcOffset(z.timezone) }));
}

/**
 * Get timezone info for a specific IANA identifier.
 */
export function getTimezoneInfo(timezone: string): {
  timezone: string;
  valid: boolean;
  offset: string;
  currentTime: string;
} {
  const valid = isValidTimezone(timezone);
  const tz = normalizeTimezone(timezone);
  const now = new Date();
  const info = convertToTimezone(now, tz);
  return {
    timezone: tz,
    valid,
    offset: getUtcOffset(tz),
    currentTime: info.isoString,
  };
}
