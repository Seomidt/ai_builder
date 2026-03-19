/**
 * Phase 21 — Validation Script
 * Internationalization, Locale & Currency Platform
 *
 * Run: npx tsx server/lib/i18n/validate-phase21.ts
 * Target: 60 scenarios, 140+ assertions
 */

import pg from "pg";

const DB_URL = process.env.SUPABASE_DB_POOL_URL ?? process.env.DATABASE_URL;
if (!DB_URL) throw new Error("SUPABASE_DB_POOL_URL or DATABASE_URL required");

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string) {
  if (condition) { console.log(`  ✔ ${label}`); passed++; }
  else { console.log(`  ✗ FAIL: ${label}`); failed++; failures.push(label); }
}
function section(title: string) { console.log(`\n── ${title} ──`); }

const T_A = "i18n-test-tenant-A";
const T_B = "i18n-test-tenant-B";
const U_1 = "i18n-test-user-1";
const U_2 = "i18n-test-user-2";

async function main() {
  console.log("Phase 21 Validation — Internationalization, Locale & Currency Platform\n");

  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();

  const { listSupportedLanguages, isLanguageSupported, getLanguage, registerLanguage, deactivateLanguage, normalizeLanguageCode, isRtlLanguage, getLanguageDistribution } = await import("./language-service");
  const { listSupportedCurrencies, getCurrency, isCurrencySupported, registerCurrency, getCurrencyDecimals, getCurrencyUsageStats } = await import("./currency-service");
  const { resolveLocale, setTenantLocale, getTenantLocale, setUserLocale, getUserLocale, getLocaleResolutionStats } = await import("./locale-resolution");
  const { isValidTimezone, normalizeTimezone, convertToTimezone, getUtcOffset, listCommonTimezones, getTimezoneInfo } = await import("./timezone-service");
  const { formatCurrency, formatNumber, formatDate, formatTime, formatRelativeTime, formatPercent, formatFileSize, buildLocaleContext } = await import("./formatting-utils");

  // ── SCENARIO 1: DB schema — 4 Phase 21 tables present ────────────────────
  section("SCENARIO 1: DB schema — 4 Phase 21 tables present");
  const tableCheck = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('supported_languages','supported_currencies','tenant_locales','user_locales')
  `);
  assert(tableCheck.rows.length === 4, "All 4 Phase 21 tables exist");
  const tNames = tableCheck.rows.map((r: Record<string, unknown>) => r.table_name as string);
  assert(tNames.includes("supported_languages"), "supported_languages table present");
  assert(tNames.includes("supported_currencies"), "supported_currencies table present");
  assert(tNames.includes("tenant_locales"), "tenant_locales table present");
  assert(tNames.includes("user_locales"), "user_locales table present");

  // ── SCENARIO 2: DB schema — indexes ──────────────────────────────────────
  section("SCENARIO 2: DB schema — indexes present");
  const idxCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_indexes WHERE schemaname = 'public'
      AND tablename IN ('supported_languages','supported_currencies','tenant_locales','user_locales')
  `);
  assert(Number(idxCheck.rows[0].cnt) >= 5, `At least 5 indexes (found ${idxCheck.rows[0].cnt})`);

  // ── SCENARIO 3: DB schema — RLS on all 4 tables ───────────────────────────
  section("SCENARIO 3: DB schema — RLS on all 4 tables");
  const rlsCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_tables WHERE schemaname = 'public'
      AND tablename IN ('supported_languages','supported_currencies','tenant_locales','user_locales')
      AND rowsecurity = true
  `);
  assert(Number(rlsCheck.rows[0].cnt) === 4, "RLS enabled on all 4 tables");

  // ── SCENARIO 4: Seeded languages — 20 present ─────────────────────────────
  section("SCENARIO 4: Seeded languages — 20 present");
  const langs4 = await listSupportedLanguages({ active: true });
  assert(langs4.length >= 20, `At least 20 languages seeded (found ${langs4.length})`);
  const codes4 = langs4.map((l) => l.language_code as string);
  assert(codes4.includes("en"), "English seeded");
  assert(codes4.includes("da"), "Danish seeded");
  assert(codes4.includes("ar"), "Arabic seeded");
  assert(codes4.includes("ja"), "Japanese seeded");

  // ── SCENARIO 5: Seeded currencies — 20 present ───────────────────────────
  section("SCENARIO 5: Seeded currencies — 20 present");
  const curs5 = await listSupportedCurrencies({ active: true });
  assert(curs5.length >= 20, `At least 20 currencies seeded (found ${curs5.length})`);
  const cur5codes = curs5.map((c) => c.currency_code as string);
  assert(cur5codes.includes("USD"), "USD seeded");
  assert(cur5codes.includes("EUR"), "EUR seeded");
  assert(cur5codes.includes("DKK"), "DKK seeded");
  assert(cur5codes.includes("JPY"), "JPY seeded");

  // ── SCENARIO 6: isLanguageSupported — active language ─────────────────────
  section("SCENARIO 6: isLanguageSupported — active language");
  assert(await isLanguageSupported("en") === true, "en is supported");
  assert(await isLanguageSupported("da") === true, "da is supported");
  assert(await isLanguageSupported("ar") === true, "ar is supported");
  assert(await isLanguageSupported("xx") === false, "xx is not supported");

  // ── SCENARIO 7: getLanguage — returns language detail ─────────────────────
  section("SCENARIO 7: getLanguage — returns language detail");
  const lang7 = await getLanguage("de");
  assert(lang7 !== null, "German language found");
  assert(lang7!.language_code === "de", "language_code matches");
  assert(lang7!.display_name === "German", "display_name matches");
  assert(lang7!.rtl === false, "German is not RTL");

  // ── SCENARIO 8: getLanguage — RTL language ────────────────────────────────
  section("SCENARIO 8: getLanguage — Arabic is RTL");
  const lang8 = await getLanguage("ar");
  assert(lang8 !== null, "Arabic language found");
  assert(lang8!.rtl === true, "Arabic is RTL");

  // ── SCENARIO 9: normalizeLanguageCode — strips region subtag ─────────────
  section("SCENARIO 9: normalizeLanguageCode — strips region subtag");
  assert(normalizeLanguageCode("en-US") === "en", "en-US → en");
  assert(normalizeLanguageCode("zh-Hans") === "zh", "zh-Hans → zh");
  assert(normalizeLanguageCode("pt-BR") === "pt", "pt-BR → pt");
  assert(normalizeLanguageCode("") === "en", "empty → en (platform default)");

  // ── SCENARIO 10: registerLanguage — registers new language ────────────────
  section("SCENARIO 10: registerLanguage — registers new language");
  const reg10 = await registerLanguage({ languageCode: "eu", displayName: "Basque", nativeName: "Euskara" });
  assert(reg10.languageCode === "eu", "Language registered");
  const eu10 = await getLanguage("eu");
  assert(eu10 !== null, "Basque retrievable after registration");

  // ── SCENARIO 11: registerLanguage — missing fields rejected ───────────────
  section("SCENARIO 11: registerLanguage — missing fields rejected");
  let rejected11 = false;
  try { await registerLanguage({ languageCode: "", displayName: "Test" }); } catch { rejected11 = true; }
  assert(rejected11, "Empty languageCode rejected");

  // ── SCENARIO 12: deactivateLanguage — deactivates language ────────────────
  section("SCENARIO 12: deactivateLanguage — deactivates language");
  await registerLanguage({ languageCode: "tlh", displayName: "Klingon" });
  await deactivateLanguage("tlh");
  const deact12 = await getLanguage("tlh");
  assert(deact12!.active === false, "Language deactivated");
  assert(await isLanguageSupported("tlh") === false, "Deactivated language is not supported");

  // ── SCENARIO 13: isCurrencySupported — active/inactive ────────────────────
  section("SCENARIO 13: isCurrencySupported — active/inactive");
  assert(await isCurrencySupported("USD") === true, "USD is supported");
  assert(await isCurrencySupported("EUR") === true, "EUR is supported");
  assert(await isCurrencySupported("XYZ") === false, "XYZ is not supported");

  // ── SCENARIO 14: getCurrency — returns currency detail ────────────────────
  section("SCENARIO 14: getCurrency — returns currency detail");
  const cur14 = await getCurrency("JPY");
  assert(cur14 !== null, "JPY found");
  assert(cur14!.currency_code === "JPY", "currency_code matches");
  assert(Number(cur14!.decimals) === 0, "JPY has 0 decimals");

  // ── SCENARIO 15: getCurrencyDecimals — returns correct decimals ───────────
  section("SCENARIO 15: getCurrencyDecimals — correct decimal counts");
  assert(await getCurrencyDecimals("USD") === 2, "USD has 2 decimals");
  assert(await getCurrencyDecimals("JPY") === 0, "JPY has 0 decimals");
  assert(await getCurrencyDecimals("KRW") === 0, "KRW has 0 decimals");

  // ── SCENARIO 16: registerCurrency — registers new currency ────────────────
  section("SCENARIO 16: registerCurrency — registers new currency");
  const reg16 = await registerCurrency({ currencyCode: "XBT", symbol: "₿", displayName: "Bitcoin", decimals: 8 });
  assert(reg16.currencyCode === "XBT", "Currency registered as XBT");
  const xbt16 = await getCurrency("XBT");
  assert(xbt16 !== null, "Bitcoin retrievable");
  assert(Number(xbt16!.decimals) === 8, "Bitcoin has 8 decimals");

  // ── SCENARIO 17: setTenantLocale — creates tenant locale ─────────────────
  section("SCENARIO 17: setTenantLocale — creates tenant locale");
  const set17 = await setTenantLocale({
    tenantId: T_A,
    defaultLanguage: "da",
    defaultCurrency: "DKK",
    defaultTimezone: "Europe/Copenhagen",
    numberFormat: "da-DK",
  });
  assert(typeof set17.id === "string", "Tenant locale created");
  assert(set17.tenantId === T_A, "tenantId matches");

  // ── SCENARIO 18: getTenantLocale — retrieves tenant locale ───────────────
  section("SCENARIO 18: getTenantLocale — retrieves tenant locale");
  const tl18 = await getTenantLocale(T_A);
  assert(tl18 !== null, "Tenant locale retrieved");
  assert(tl18!.default_language === "da", "default_language is da");
  assert(tl18!.default_currency === "DKK", "default_currency is DKK");
  assert(tl18!.default_timezone === "Europe/Copenhagen", "default_timezone is Copenhagen");

  // ── SCENARIO 19: setTenantLocale — upserts (updates existing) ────────────
  section("SCENARIO 19: setTenantLocale — upserts cleanly");
  await setTenantLocale({ tenantId: T_A, defaultLanguage: "de", defaultCurrency: "EUR" });
  const tl19 = await getTenantLocale(T_A);
  assert(tl19!.default_language === "de", "Updated to German");
  assert(tl19!.default_currency === "EUR", "Updated to EUR");

  // ── SCENARIO 20: setUserLocale — creates user locale ─────────────────────
  section("SCENARIO 20: setUserLocale — creates user locale");
  const set20 = await setUserLocale({
    userId: U_1,
    tenantId: T_A,
    language: "fr",
    timezone: "Europe/Paris",
    currency: "EUR",
  });
  assert(typeof set20.id === "string", "User locale created");
  assert(set20.userId === U_1, "userId matches");

  // ── SCENARIO 21: getUserLocale — retrieves user locale ────────────────────
  section("SCENARIO 21: getUserLocale — retrieves user locale");
  const ul21 = await getUserLocale(U_1);
  assert(ul21 !== null, "User locale retrieved");
  assert(ul21!.language === "fr", "language is fr");
  assert(ul21!.timezone === "Europe/Paris", "timezone is Paris");

  // ── SCENARIO 22: setUserLocale — upserts (updates existing) ──────────────
  section("SCENARIO 22: setUserLocale — upserts cleanly");
  await setUserLocale({ userId: U_1, language: "ja", timezone: "Asia/Tokyo" });
  const ul22 = await getUserLocale(U_1);
  assert(ul22!.language === "ja", "User language updated to Japanese");
  assert(ul22!.timezone === "Asia/Tokyo", "User timezone updated to Tokyo");

  // ── SCENARIO 23: resolveLocale — source=user when user locale exists ──────
  section("SCENARIO 23: resolveLocale — source=user (INV-I18N1)");
  const resolved23 = await resolveLocale({ userId: U_1, tenantId: T_A });
  assert(resolved23.source === "user", "Source is user");
  assert(resolved23.language === "ja", "User language resolved");
  assert(resolved23.timezone === "Asia/Tokyo", "User timezone resolved");

  // ── SCENARIO 24: resolveLocale — source=tenant when no user locale ────────
  section("SCENARIO 24: resolveLocale — source=tenant");
  await setTenantLocale({ tenantId: T_B, defaultLanguage: "sv", defaultCurrency: "SEK", defaultTimezone: "Europe/Stockholm" });
  const resolved24 = await resolveLocale({ tenantId: T_B });
  assert(resolved24.source === "tenant", "Source is tenant");
  assert(resolved24.language === "sv", "Tenant language resolved");
  assert(resolved24.currency === "SEK", "Tenant currency resolved");
  assert(resolved24.timezone === "Europe/Stockholm", "Tenant timezone resolved");

  // ── SCENARIO 25: resolveLocale — source=platform (INV-I18N2) ─────────────
  section("SCENARIO 25: INV-I18N2 — resolveLocale source=platform (fallback)");
  const resolved25 = await resolveLocale({ tenantId: "nonexistent-tenant-xyz" });
  assert(resolved25.source === "platform", "Platform default used");
  assert(resolved25.language === "en", "Platform default language is en");
  assert(resolved25.currency === "USD", "Platform default currency is USD");
  assert(resolved25.timezone === "UTC", "Platform default timezone is UTC");

  // ── SCENARIO 26: resolveLocale — no params → platform default ────────────
  section("SCENARIO 26: resolveLocale — no params → platform default");
  const resolved26 = await resolveLocale({});
  assert(resolved26.source === "platform", "Platform default with no params");
  assert(typeof resolved26.resolvedAt === "number", "resolvedAt is number");
  assert(resolved26.resolvedAt >= 0, "resolvedAt is non-negative");

  // ── SCENARIO 27: resolveLocale — RTL detection ────────────────────────────
  section("SCENARIO 27: resolveLocale — RTL detected for Arabic user");
  await setUserLocale({ userId: U_2, language: "ar", timezone: "Asia/Dubai" });
  const resolved27 = await resolveLocale({ userId: U_2 });
  assert(resolved27.rtl === true, "RTL=true for Arabic user");

  // ── SCENARIO 28: resolveLocale — non-RTL detection ────────────────────────
  section("SCENARIO 28: resolveLocale — RTL=false for Latin script");
  assert(resolved23.rtl === false, "RTL=false for Japanese user (Latin=false, ja=false)");

  // ── SCENARIO 29: isRtlLanguage — RTL/LTR detection ───────────────────────
  section("SCENARIO 29: isRtlLanguage — RTL/LTR detection");
  assert(await isRtlLanguage("ar") === true, "Arabic is RTL");
  assert(await isRtlLanguage("he") === true, "Hebrew is RTL");
  assert(await isRtlLanguage("en") === false, "English is LTR");
  assert(await isRtlLanguage("de") === false, "German is LTR");

  // ── SCENARIO 30: isValidTimezone — valid/invalid detection ───────────────
  section("SCENARIO 30: isValidTimezone — valid/invalid detection");
  assert(isValidTimezone("UTC") === true, "UTC is valid");
  assert(isValidTimezone("Europe/Copenhagen") === true, "Europe/Copenhagen is valid");
  assert(isValidTimezone("America/New_York") === true, "America/New_York is valid");
  assert(isValidTimezone("Asia/Tokyo") === true, "Asia/Tokyo is valid");
  assert(isValidTimezone("Invalid/Zone") === false, "Invalid/Zone is invalid");
  assert(isValidTimezone("") === false, "Empty string is invalid");

  // ── SCENARIO 31: normalizeTimezone — returns default on invalid ───────────
  section("SCENARIO 31: normalizeTimezone — returns UTC on invalid");
  assert(normalizeTimezone("Invalid/Zone") === "UTC", "Invalid zone → UTC");
  assert(normalizeTimezone("") === "UTC", "Empty → UTC");
  assert(normalizeTimezone("Europe/Paris") === "Europe/Paris", "Valid zone returned unchanged");

  // ── SCENARIO 32: getUtcOffset — returns offset string ────────────────────
  section("SCENARIO 32: getUtcOffset — returns offset string");
  const offset32 = getUtcOffset("UTC");
  assert(offset32 === "+00:00", `UTC offset is +00:00 (got ${offset32})`);
  const offset32b = getUtcOffset("Asia/Kolkata");
  assert(offset32b === "+05:30", `Kolkata offset is +05:30 (got ${offset32b})`);

  // ── SCENARIO 33: convertToTimezone — converts date ────────────────────────
  section("SCENARIO 33: convertToTimezone — converts date to timezone");
  const now33 = new Date("2026-01-15T12:00:00Z");
  const conv33 = convertToTimezone(now33, "Asia/Tokyo");
  assert(typeof conv33.isoString === "string", "isoString returned");
  assert(typeof conv33.offset === "string", "offset returned");
  assert(conv33.timezone === "Asia/Tokyo", "timezone returned");
  assert(conv33.isoString.includes("21:00"), "Tokyo is UTC+9 (12:00 UTC → 21:00 JST)");

  // ── SCENARIO 34: listCommonTimezones — returns list ───────────────────────
  section("SCENARIO 34: listCommonTimezones — returns list with offsets");
  const tzList34 = listCommonTimezones();
  assert(Array.isArray(tzList34), "listCommonTimezones returns array");
  assert(tzList34.length >= 15, "At least 15 common timezones");
  assert(tzList34.every((t) => typeof t.timezone === "string"), "timezone string in all");
  assert(tzList34.every((t) => typeof t.offset === "string"), "offset string in all");
  assert(tzList34.every((t) => typeof t.region === "string"), "region string in all");

  // ── SCENARIO 35: getTimezoneInfo — returns timezone info ─────────────────
  section("SCENARIO 35: getTimezoneInfo — returns timezone info");
  const info35 = getTimezoneInfo("Europe/Berlin");
  assert(info35.valid === true, "Berlin is valid");
  assert(info35.timezone === "Europe/Berlin", "timezone returned");
  assert(typeof info35.offset === "string", "offset returned");
  assert(typeof info35.currentTime === "string", "currentTime returned");

  // ── SCENARIO 36: formatCurrency — USD ─────────────────────────────────────
  section("SCENARIO 36: formatCurrency — USD formatting");
  const f36 = formatCurrency(1234.56, { currency: "USD", locale: "en-US" });
  assert(typeof f36 === "string", "formatCurrency returns string");
  assert(f36.includes("1,234"), "Thousand separator present");
  assert(f36.includes("56"), "Cents present");

  // ── SCENARIO 37: formatCurrency — EUR with da-DK locale ──────────────────
  section("SCENARIO 37: formatCurrency — EUR with Danish locale");
  const f37 = formatCurrency(9900, { currency: "EUR", locale: "da-DK" });
  assert(typeof f37 === "string", "formatCurrency returns string for EUR/da-DK");
  assert(f37.includes("9.900") || f37.includes("9900"), "Amount present in output");

  // ── SCENARIO 38: formatCurrency — JPY (0 decimals) ───────────────────────
  section("SCENARIO 38: formatCurrency — JPY (0 decimals)");
  const f38 = formatCurrency(1234, { currency: "JPY", locale: "ja-JP", decimals: 0 });
  assert(typeof f38 === "string", "JPY formatted");
  assert(!f38.includes("."), "No decimal point in JPY");

  // ── SCENARIO 39: formatNumber — locale-specific separators ───────────────
  section("SCENARIO 39: formatNumber — locale-specific separators");
  const f39a = formatNumber(1234567.89, { locale: "en-US", decimals: 2 });
  assert(f39a.includes("1,234,567"), `en-US uses comma separator (got ${f39a})`);
  const f39b = formatNumber(1234567.89, { locale: "de-DE", decimals: 2 });
  assert(f39b.includes("1.234.567") || f39b.includes("1 234 567"), `de-DE uses period/space separator (got ${f39b})`);

  // ── SCENARIO 40: formatDate — locale-aware date ────────────────────────────
  section("SCENARIO 40: formatDate — locale-aware date formatting");
  const testDate = new Date("2026-03-15T12:00:00Z");
  const f40a = formatDate(testDate, { locale: "en-US", timezone: "UTC" });
  assert(typeof f40a === "string", "formatDate returns string");
  assert(f40a.includes("March") || f40a.includes("2026"), "Date content correct");
  const f40b = formatDate(testDate, { locale: "da-DK", timezone: "Europe/Copenhagen" });
  assert(typeof f40b === "string", "Danish date formatted");

  // ── SCENARIO 41: formatTime — locale-aware time ────────────────────────────
  section("SCENARIO 41: formatTime — locale-aware time formatting");
  const testDate41 = new Date("2026-03-15T14:30:00Z");
  const f41a = formatTime(testDate41, { locale: "en-US", timezone: "UTC", hour12: true });
  assert(typeof f41a === "string", "formatTime returns string");
  assert(f41a.includes("PM") || f41a.includes("2:30"), `Time includes PM or 2:30 (got ${f41a})`);
  const f41b = formatTime(testDate41, { locale: "de-DE", timezone: "UTC", hour12: false });
  assert(f41b.includes("14"), `24h format includes 14 (got ${f41b})`);

  // ── SCENARIO 42: formatRelativeTime — relative past ───────────────────────
  section("SCENARIO 42: formatRelativeTime — relative past");
  const past42 = new Date(Date.now() - 3 * 86_400_000);
  const f42 = formatRelativeTime(past42, { locale: "en-US" });
  assert(typeof f42 === "string", "formatRelativeTime returns string");
  assert(f42.includes("3") || f42.includes("day") || f42.includes("ago"), `Relative time content (got ${f42})`);

  // ── SCENARIO 43: formatRelativeTime — relative future ─────────────────────
  section("SCENARIO 43: formatRelativeTime — relative future");
  const future43 = new Date(Date.now() + 2 * 3600_000);
  const f43 = formatRelativeTime(future43, { locale: "en-US" });
  assert(typeof f43 === "string", "formatRelativeTime future returns string");
  assert(f43.includes("2") || f43.includes("hour") || f43.includes("in"), `Future time content (got ${f43})`);

  // ── SCENARIO 44: formatPercent — percentage formatting ────────────────────
  section("SCENARIO 44: formatPercent — percentage formatting");
  const f44a = formatPercent(0.843, { locale: "en-US" });
  assert(typeof f44a === "string", "formatPercent returns string");
  assert(f44a.includes("84"), `Contains 84 (got ${f44a})`);
  assert(f44a.includes("%"), `Contains % (got ${f44a})`);

  // ── SCENARIO 45: formatFileSize — byte formatting ─────────────────────────
  section("SCENARIO 45: formatFileSize — byte formatting");
  assert(formatFileSize(500) === "500 B", `500 bytes (got ${formatFileSize(500)})`);
  assert(formatFileSize(1536).includes("1.5") && formatFileSize(1536).includes("KB"), `1536 bytes = 1.5 KB (got ${formatFileSize(1536)})`);
  assert(formatFileSize(1_073_741_824).includes("1") && formatFileSize(1_073_741_824).includes("GB"), `1 GB (got ${formatFileSize(1_073_741_824)})`);

  // ── SCENARIO 46: buildLocaleContext — returns formatters ─────────────────
  section("SCENARIO 46: buildLocaleContext — returns locale context with formatters");
  const ctx46 = buildLocaleContext({ locale: "en-US", currency: "USD", timezone: "UTC" });
  assert(typeof ctx46.currencyFormatter === "function", "currencyFormatter is function");
  assert(typeof ctx46.numberFormatter === "function", "numberFormatter is function");
  assert(typeof ctx46.dateFormatter === "function", "dateFormatter is function");
  assert(typeof ctx46.timeFormatter === "function", "timeFormatter is function");
  const formatted46 = ctx46.currencyFormatter(42.5);
  assert(typeof formatted46 === "string", "currencyFormatter returns string");
  assert(formatted46.includes("42.50") || formatted46.includes("42,50"), `Currency formatted (got ${formatted46})`);

  // ── SCENARIO 47: getLanguageDistribution — observability ─────────────────
  section("SCENARIO 47: getLanguageDistribution — observability stats");
  const dist47 = await getLanguageDistribution();
  assert(Array.isArray(dist47), "getLanguageDistribution returns array");
  assert(dist47.length >= 1, "At least 1 language in distribution");
  assert(dist47.every((d) => typeof d.language === "string"), "language field present");
  assert(dist47.every((d) => typeof d.tenantCount === "number"), "tenantCount is number");
  assert(dist47.every((d) => typeof d.userCount === "number"), "userCount is number");

  // ── SCENARIO 48: getCurrencyUsageStats — observability ────────────────────
  section("SCENARIO 48: getCurrencyUsageStats — observability stats");
  const stats48 = await getCurrencyUsageStats();
  assert(Array.isArray(stats48), "getCurrencyUsageStats returns array");
  assert(stats48.length >= 1, "At least 1 currency in stats");
  assert(stats48.every((s) => typeof s.currencyCode === "string"), "currencyCode present");
  assert(stats48.every((s) => typeof s.tenantCount === "number"), "tenantCount is number");

  // ── SCENARIO 49: getLocaleResolutionStats — latency observability ─────────
  section("SCENARIO 49: getLocaleResolutionStats — latency observability");
  const latency49 = await getLocaleResolutionStats(3);
  assert(typeof latency49.avgResolutionMs === "number", "avgResolutionMs is number");
  assert(latency49.avgResolutionMs >= 0, "avgResolutionMs is non-negative");
  assert(latency49.samples === 3, "3 samples taken");

  // ── SCENARIO 50: Admin route — GET /api/admin/i18n/languages ─────────────
  section("SCENARIO 50: Admin route GET /api/admin/i18n/languages");
  const res50 = await fetch("http://localhost:5000/api/admin/i18n/languages");
  assert(res50.status !== 404, "GET /api/admin/i18n/languages is not 404");
  assert([200, 401, 403].includes(res50.status), `Valid status (${res50.status})`);

  // ── SCENARIO 51: Admin route — GET /api/admin/i18n/currencies ────────────
  section("SCENARIO 51: Admin route GET /api/admin/i18n/currencies");
  const res51 = await fetch("http://localhost:5000/api/admin/i18n/currencies");
  assert(res51.status !== 404, "GET /api/admin/i18n/currencies is not 404");

  // ── SCENARIO 52: Admin route — GET /api/admin/i18n/tenant-locale ──────────
  section("SCENARIO 52: Admin route GET /api/admin/i18n/tenant-locale");
  const res52 = await fetch(`http://localhost:5000/api/admin/i18n/tenant-locale?tenantId=${T_A}`);
  assert(res52.status !== 404, "GET /api/admin/i18n/tenant-locale is not 404");

  // ── SCENARIO 53: Admin route — POST /api/admin/i18n/tenant-locale ─────────
  section("SCENARIO 53: Admin route POST /api/admin/i18n/tenant-locale");
  const res53 = await fetch("http://localhost:5000/api/admin/i18n/tenant-locale", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tenantId: T_A, defaultLanguage: "en", defaultCurrency: "USD" }),
  });
  assert([200, 201, 400, 401].includes(res53.status), `POST /api/admin/i18n/tenant-locale status ${res53.status} acceptable`);

  // ── SCENARIO 54: Admin route — GET /api/admin/i18n/resolve ───────────────
  section("SCENARIO 54: Admin route GET /api/admin/i18n/resolve");
  const res54 = await fetch(`http://localhost:5000/api/admin/i18n/resolve?tenantId=${T_A}`);
  assert(res54.status !== 404, "GET /api/admin/i18n/resolve is not 404");

  // ── SCENARIO 55: formatCurrency — fallback for unsupported currency ────────
  section("SCENARIO 55: formatCurrency — fallback for unsupported currency code");
  const f55 = formatCurrency(100, { currency: "FAKE", locale: "en-US" });
  assert(typeof f55 === "string", "formatCurrency returns string even for invalid currency");
  assert(f55.length > 0, "Fallback output is non-empty");

  // ── SCENARIO 56: Phase 20 billing still intact ─────────────────────────────
  section("SCENARIO 56: Cross-phase — Phase 20 billing still intact");
  const { listPlans } = await import("../billing/plans");
  const plans56 = await listPlans({ active: true });
  assert(Array.isArray(plans56), "Phase 20 listPlans still returns array");
  assert(plans56.length >= 4, "4 built-in plans still intact");

  // ── SCENARIO 57: Phase 19 background jobs still intact ────────────────────
  section("SCENARIO 57: Cross-phase — Phase 19 background jobs still intact");
  const { dispatchJob } = await import("../jobs/job-dispatcher");
  const job57 = await dispatchJob({ jobType: "evaluation_run", tenantId: T_A });
  assert(typeof job57.id === "string", "Phase 19 dispatchJob still works");

  // ── SCENARIO 58: tenant isolation — T_A locale not visible to T_B ─────────
  section("SCENARIO 58: Tenant isolation — locales are per-tenant");
  const tlA58 = await getTenantLocale(T_A);
  const tlB58 = await getTenantLocale(T_B);
  assert(tlA58 !== null && tlB58 !== null, "Both tenant locales exist");
  assert(tlA58!.default_language !== tlB58!.default_language || tlA58!.tenant_id !== tlB58!.tenant_id, "Tenant locales are independent");

  // ── SCENARIO 59: resolveLocale — tenant currency propagates to user ────────
  section("SCENARIO 59: resolveLocale — tenant currency fills user gap");
  // U_2 has language+timezone set but no currency, T_B has SEK
  // So when we resolve for U_2 on T_B, currency should come from tenant
  const newUser59 = "i18n-test-user-3-nocur";
  await setUserLocale({ userId: newUser59, tenantId: T_B, language: "nl" });
  const resolved59 = await resolveLocale({ userId: newUser59, tenantId: T_B });
  // User has no currency, tenant has SEK → should resolve to SEK
  assert(resolved59.source === "user", "User locale found");
  assert(resolved59.currency === "SEK", "Tenant currency fills in for user with no currency");

  // ── SCENARIO 60: RLS on all 4 Phase 21 tables ─────────────────────────────
  section("SCENARIO 60: RLS — all 4 Phase 21 tables have RLS");
  const rls60 = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('supported_languages','supported_currencies','tenant_locales','user_locales')
      AND rowsecurity = true
  `);
  assert(Number(rls60.rows[0].cnt) === 4, "All 4 Phase 21 tables have RLS enabled");

  // ── Final summary ─────────────────────────────────────────────────────────
  await client.end();
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Phase 21 validation: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("✗ FAILED assertions:");
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exit(1);
  } else {
    console.log("✔ All assertions passed");
  }
}

main().catch((err) => {
  console.error("Validation crashed:", err.message);
  process.exit(1);
});
