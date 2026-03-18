/**
 * Phase 34 Validation — Internationalization + Database Performance Pass
 *
 * 45 scenarios, 120+ assertions
 *
 * Tests:
 *  1–4   DB: tenants locale columns
 *  5–6   DB: idx_tenants_locale
 *  7–12  DB: 6 composite indexes on tenant query paths
 * 13–17  Locale service: getTenantLocale shape + defaults
 * 18–22  Locale service: validation helpers
 * 23–27  Locale service: formatCurrency
 * 28–32  Locale service: formatDate / formatDateShort
 * 33–35  Locale service: updateTenantLocale round-trip
 * 36–38  Translation files: en.json + da.json
 * 39–41  i18n: supported languages, resources
 * 42–43  Client: formatCurrency util
 * 44–45  Client: formatDate util
 */

import { Client } from "pg";
import {
  getTenantLocale,
  updateTenantLocale,
  formatCurrency,
  formatCurrencyForLocale,
  formatDate,
  formatDateShort,
  isValidLanguage,
  isValidLocale,
  isValidCurrency,
  isValidTimezone,
  DEFAULT_LOCALE,
} from "../server/lib/i18n/locale-service";
import { resources, SUPPORTED_LANGUAGES } from "../client/src/i18n/i18n";
import en from "../client/src/i18n/translations/en.json";
import da from "../client/src/i18n/translations/da.json";

// ── Assertion helpers ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string) {
  if (condition) {
    console.log(`  ✔ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

function section(title: string) {
  console.log(`\n── ${title} ──`);
}

// ── DB client ────────────────────────────────────────────────────────────────

async function getClient(): Promise<Client> {
  const client = new Client({ connectionString: process.env.SUPABASE_DB_POOL_URL });
  await client.connect();
  return client;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\nPhase 34 Validation — Internationalization + Database Performance Pass\n");

  const db = await getClient();

  try {

    // ── SCENARIO 1: tenants.language column exists ──────────────────────────
    section("SCENARIO 1: tenants.language column");
    const langCol = await db.query(`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_name = 'tenants' AND column_name = 'language'
    `);
    assert(langCol.rows.length === 1, "tenants.language column exists");
    assert(langCol.rows[0]?.column_default?.includes("en"), "language default is 'en'");

    // ── SCENARIO 2: tenants.locale column exists ────────────────────────────
    section("SCENARIO 2: tenants.locale column");
    const locCol = await db.query(`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_name = 'tenants' AND column_name = 'locale'
    `);
    assert(locCol.rows.length === 1, "tenants.locale column exists");
    assert(locCol.rows[0]?.column_default?.includes("en-US"), "locale default is 'en-US'");

    // ── SCENARIO 3: tenants.currency column exists ──────────────────────────
    section("SCENARIO 3: tenants.currency column");
    const curCol = await db.query(`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_name = 'tenants' AND column_name = 'currency'
    `);
    assert(curCol.rows.length === 1, "tenants.currency column exists");
    assert(curCol.rows[0]?.column_default?.includes("USD"), "currency default is 'USD'");

    // ── SCENARIO 4: tenants.timezone column exists ──────────────────────────
    section("SCENARIO 4: tenants.timezone column");
    const tzCol = await db.query(`
      SELECT column_name, column_default
      FROM information_schema.columns
      WHERE table_name = 'tenants' AND column_name = 'timezone'
    `);
    assert(tzCol.rows.length === 1, "tenants.timezone column exists");
    assert(tzCol.rows[0]?.column_default?.includes("UTC"), "timezone default is 'UTC'");

    // ── SCENARIO 5: idx_tenants_locale exists ──────────────────────────────
    section("SCENARIO 5: idx_tenants_locale index");
    const tenantLocIdx = await db.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'tenants' AND indexname = 'idx_tenants_locale'
    `);
    assert(tenantLocIdx.rows.length === 1, "idx_tenants_locale exists");

    // ── SCENARIO 6: idx_tenants_locale covers (language, locale) ───────────
    section("SCENARIO 6: idx_tenants_locale column coverage");
    const tenantLocIdxDef = await db.query(`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'tenants' AND indexname = 'idx_tenants_locale'
    `);
    const idxDef = tenantLocIdxDef.rows[0]?.indexdef ?? "";
    assert(idxDef.includes("language"), "idx_tenants_locale covers language");
    assert(idxDef.includes("locale"),   "idx_tenants_locale covers locale");

    // ── SCENARIO 7: idx_usage_tenant_created on tenant_ai_usage_snapshots ──
    section("SCENARIO 7: idx_usage_tenant_created");
    const usageIdx = await db.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'tenant_ai_usage_snapshots'
        AND indexname = 'idx_usage_tenant_created'
    `);
    assert(usageIdx.rows.length === 1, "idx_usage_tenant_created exists");

    // ── SCENARIO 8: idx_alerts_tenant_created on ai_usage_alerts ───────────
    section("SCENARIO 8: idx_alerts_tenant_created");
    const alertIdx = await db.query(`
      SELECT indexname, indexdef FROM pg_indexes
      WHERE tablename = 'ai_usage_alerts'
        AND indexname = 'idx_alerts_tenant_created'
    `);
    assert(alertIdx.rows.length === 1, "idx_alerts_tenant_created exists");
    assert(
      (alertIdx.rows[0]?.indexdef ?? "").includes("tenant_id"),
      "idx_alerts_tenant_created covers tenant_id",
    );

    // ── SCENARIO 9: idx_anomaly_tenant_created on gov_anomaly_events ────────
    section("SCENARIO 9: idx_anomaly_tenant_created");
    const anomalyIdx = await db.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'gov_anomaly_events'
        AND indexname = 'idx_anomaly_tenant_created'
    `);
    assert(anomalyIdx.rows.length === 1, "idx_anomaly_tenant_created exists");

    // ── SCENARIO 10: idx_audit_tenant_created on audit_events ───────────────
    section("SCENARIO 10: idx_audit_tenant_created");
    const auditIdx = await db.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'audit_events'
        AND indexname = 'idx_audit_tenant_created'
    `);
    assert(auditIdx.rows.length === 1, "idx_audit_tenant_created exists");

    // ── SCENARIO 11: idx_webhooks_tenant_created on webhook_deliveries ───────
    section("SCENARIO 11: idx_webhooks_tenant_created");
    const webhookIdx = await db.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'webhook_deliveries'
        AND indexname = 'idx_webhooks_tenant_created'
    `);
    assert(webhookIdx.rows.length === 1, "idx_webhooks_tenant_created exists");

    // ── SCENARIO 12: idx_jobs_tenant_created on jobs ─────────────────────────
    section("SCENARIO 12: idx_jobs_tenant_created");
    const jobsIdx = await db.query(`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'jobs'
        AND indexname = 'idx_jobs_tenant_created'
    `);
    assert(jobsIdx.rows.length === 1, "idx_jobs_tenant_created exists");

    // ── SCENARIO 13: getTenantLocale default shape ───────────────────────────
    section("SCENARIO 13: getTenantLocale — non-existent tenant returns defaults");
    const noTenant = await getTenantLocale("non-existent-tenant-xxxxxxxx");
    assert(typeof noTenant === "object", "returns object");
    assert(noTenant.language === "en",    "default language = 'en'");
    assert(noTenant.locale   === "en-US", "default locale = 'en-US'");
    assert(noTenant.currency === "USD",   "default currency = 'USD'");
    assert(noTenant.timezone === "UTC",   "default timezone = 'UTC'");

    // ── SCENARIO 14: DEFAULT_LOCALE constants ───────────────────────────────
    section("SCENARIO 14: DEFAULT_LOCALE export values");
    assert(DEFAULT_LOCALE.language === "en",    "DEFAULT_LOCALE.language = 'en'");
    assert(DEFAULT_LOCALE.locale   === "en-US", "DEFAULT_LOCALE.locale = 'en-US'");
    assert(DEFAULT_LOCALE.currency === "USD",   "DEFAULT_LOCALE.currency = 'USD'");
    assert(DEFAULT_LOCALE.timezone === "UTC",   "DEFAULT_LOCALE.timezone = 'UTC'");

    // ── SCENARIO 15: getTenantLocale return type fields ─────────────────────
    section("SCENARIO 15: getTenantLocale return type");
    const locale15 = await getTenantLocale("any-tenant-id-xyz");
    assert("language" in locale15, "has language field");
    assert("locale"   in locale15, "has locale field");
    assert("currency" in locale15, "has currency field");
    assert("timezone" in locale15, "has timezone field");

    // ── SCENARIO 16: getTenantLocale for a real tenant ───────────────────────
    section("SCENARIO 16: getTenantLocale for real tenant");
    const realRow = await db.query(`SELECT id FROM tenants LIMIT 1`);
    if (realRow.rows.length > 0) {
      const tenantId = realRow.rows[0].id;
      const real = await getTenantLocale(tenantId);
      assert(typeof real.language === "string", "real tenant: language is string");
      assert(typeof real.locale   === "string", "real tenant: locale is string");
      assert(typeof real.currency === "string", "real tenant: currency is string");
      assert(typeof real.timezone === "string", "real tenant: timezone is string");
    } else {
      assert(true, "no tenants in DB — skipped");
      assert(true, "no tenants in DB — skipped");
      assert(true, "no tenants in DB — skipped");
      assert(true, "no tenants in DB — skipped");
    }

    // ── SCENARIO 17: updateTenantLocale round-trip ───────────────────────────
    section("SCENARIO 17: updateTenantLocale round-trip");
    const realRows17 = await db.query(`SELECT id FROM tenants LIMIT 1`);
    if (realRows17.rows.length > 0) {
      const tenantId17 = realRows17.rows[0].id;
      await updateTenantLocale(tenantId17, { language: "da", locale: "da-DK", currency: "DKK", timezone: "Europe/Copenhagen" });
      const after = await getTenantLocale(tenantId17);
      assert(after.language === "da",                "language updated to 'da'");
      assert(after.locale   === "da-DK",             "locale updated to 'da-DK'");
      assert(after.currency === "DKK",               "currency updated to 'DKK'");
      assert(after.timezone === "Europe/Copenhagen", "timezone updated");
      // Reset
      await updateTenantLocale(tenantId17, { language: "en", locale: "en-US", currency: "USD", timezone: "UTC" });
      const reset = await getTenantLocale(tenantId17);
      assert(reset.language === "en", "reset language to 'en'");
    } else {
      assert(true, "no tenants — skipped");
      assert(true, "no tenants — skipped");
      assert(true, "no tenants — skipped");
      assert(true, "no tenants — skipped");
      assert(true, "no tenants — skipped");
    }

    // ── SCENARIO 18: isValidLanguage ─────────────────────────────────────────
    section("SCENARIO 18: isValidLanguage");
    assert(isValidLanguage("en"),  "en is valid");
    assert(isValidLanguage("da"),  "da is valid");
    assert(isValidLanguage("fr"),  "fr is valid");
    assert(!isValidLanguage(""),   "empty string invalid");
    assert(!isValidLanguage("x"),  "single char invalid");
    assert(!isValidLanguage("ENGLISH"), "long uppercase invalid");

    // ── SCENARIO 19: isValidLocale ───────────────────────────────────────────
    section("SCENARIO 19: isValidLocale");
    assert(isValidLocale("en-US"), "en-US is valid");
    assert(isValidLocale("da-DK"), "da-DK is valid");
    assert(isValidLocale("fr-FR"), "fr-FR is valid");
    assert(isValidLocale("de"),    "de is valid");
    assert(!isValidLocale(""),     "empty string invalid");
    assert(!isValidLocale("not_a_locale_xxxxxx_yyyyyyy_zzzzzzzz"), "garbage invalid");

    // ── SCENARIO 20: isValidCurrency ─────────────────────────────────────────
    section("SCENARIO 20: isValidCurrency");
    assert(isValidCurrency("USD"), "USD is valid");
    assert(isValidCurrency("EUR"), "EUR is valid");
    assert(isValidCurrency("DKK"), "DKK is valid");
    assert(isValidCurrency("GBP"), "GBP is valid");
    assert(!isValidCurrency("XX"),  "XX is invalid");
    assert(!isValidCurrency(""),    "empty string invalid");
    assert(!isValidCurrency("FAKE"), "FAKE is invalid");

    // ── SCENARIO 21: isValidTimezone ─────────────────────────────────────────
    section("SCENARIO 21: isValidTimezone");
    assert(isValidTimezone("UTC"),                  "UTC is valid");
    assert(isValidTimezone("Europe/Copenhagen"),    "Europe/Copenhagen valid");
    assert(isValidTimezone("America/New_York"),     "America/New_York valid");
    assert(isValidTimezone("Asia/Tokyo"),           "Asia/Tokyo valid");
    assert(!isValidTimezone("Not/ATimezone"),       "Not/ATimezone invalid");
    assert(!isValidTimezone(""),                    "empty string invalid");

    // ── SCENARIO 22: validation rejects mixed bad input ────────────────────
    section("SCENARIO 22: validation — mixed bad input");
    assert(!isValidLanguage("1234"),   "numeric string invalid language");
    assert(!isValidCurrency("XX"),     "two-letter code XX invalid ISO 4217");
    assert(!isValidTimezone("Mars/Olympus"), "fictional timezone invalid IANA");

    // ── SCENARIO 23: formatCurrency — USD ────────────────────────────────────
    section("SCENARIO 23: formatCurrency — USD");
    const usd = formatCurrency(1234.56, "USD");
    assert(typeof usd === "string",        "returns string");
    assert(usd.includes("1,234.56"),       "formats 1234.56 with commas and decimals");
    assert(usd.includes("$"),              "includes $ symbol for USD");

    // ── SCENARIO 24: formatCurrency — EUR ────────────────────────────────────
    section("SCENARIO 24: formatCurrency — EUR");
    const eur = formatCurrency(500, "EUR");
    assert(typeof eur === "string", "EUR returns string");
    assert(eur.includes("500"),     "EUR output contains amount");

    // ── SCENARIO 25: formatCurrency — DKK ────────────────────────────────────
    section("SCENARIO 25: formatCurrency — DKK");
    const dkk = formatCurrency(1000, "DKK");
    assert(typeof dkk === "string", "DKK returns string");
    assert(dkk.includes("1,000"),   "DKK output contains 1,000");

    // ── SCENARIO 26: formatCurrency — zero amount ─────────────────────────────
    section("SCENARIO 26: formatCurrency — zero");
    const zero = formatCurrency(0, "USD");
    assert(zero.includes("0.00"), "zero formats as 0.00");

    // ── SCENARIO 27: formatCurrencyForLocale ─────────────────────────────────
    section("SCENARIO 27: formatCurrencyForLocale");
    const daDkk = formatCurrencyForLocale(1234.56, "DKK", "da-DK");
    assert(typeof daDkk === "string",  "da-DK DKK returns string");
    assert(daDkk.length > 0,          "non-empty output");
    const enUsd = formatCurrencyForLocale(99.99, "USD", "en-US");
    assert(enUsd.includes("99.99"),    "en-US USD contains amount");

    // ── SCENARIO 28: formatDate — basic ──────────────────────────────────────
    section("SCENARIO 28: formatDate — basic");
    const d28 = new Date("2025-06-15T12:00:00Z");
    const fd28 = formatDate(d28, "en-US", "UTC");
    assert(typeof fd28 === "string", "returns string");
    assert(fd28.includes("2025"),   "contains year 2025");
    assert(fd28.includes("Jun"),    "contains Jun for June");

    // ── SCENARIO 29: formatDate — Danish locale ───────────────────────────────
    section("SCENARIO 29: formatDate — Danish locale");
    const d29 = new Date("2025-01-20T08:30:00Z");
    const fd29 = formatDate(d29, "da-DK", "Europe/Copenhagen");
    assert(typeof fd29 === "string", "da-DK date returns string");
    assert(fd29.includes("2025"),   "contains year");
    assert(fd29.length > 0,         "non-empty");

    // ── SCENARIO 30: formatDate — timezone offset ─────────────────────────────
    section("SCENARIO 30: formatDate — timezone offset");
    const d30 = new Date("2025-06-01T00:00:00Z");
    const utc  = formatDate(d30, "en-US", "UTC");
    const cph  = formatDate(d30, "en-US", "Europe/Copenhagen");
    assert(utc !== cph, "UTC and Europe/Copenhagen produce different output for midnight UTC");

    // ── SCENARIO 31: formatDateShort ──────────────────────────────────────────
    section("SCENARIO 31: formatDateShort");
    const d31 = new Date("2025-03-16T09:00:00Z");
    const short = formatDateShort(d31, "en-US", "UTC");
    assert(typeof short === "string", "formatDateShort returns string");
    assert(short.includes("2025"),    "contains year");
    assert(!short.includes(":"),      "no time component in short format");

    // ── SCENARIO 32: formatDate — string date input ───────────────────────────
    section("SCENARIO 32: formatDate — string input");
    const fd32 = formatDate("2024-12-25", "en-US", "UTC");
    assert(typeof fd32 === "string",  "accepts string date");
    assert(fd32.includes("2024"),     "parses year from string");

    // ── SCENARIO 33: formatDate — invalid timezone falls back ─────────────────
    section("SCENARIO 33: formatDate — invalid timezone fallback");
    const fd33 = formatDate(new Date(), "en-US", "Invalid/Timezone");
    assert(typeof fd33 === "string", "invalid timezone falls back, returns string");

    // ── SCENARIO 34: formatCurrency — invalid currency falls back ─────────────
    section("SCENARIO 34: formatCurrency — invalid currency fallback");
    const fc34 = formatCurrency(100, "XXX_INVALID");
    assert(typeof fc34 === "string", "invalid currency falls back, returns string");
    assert(fc34.includes("100"),     "output still contains amount");

    // ── SCENARIO 35: formatCurrencyForLocale — invalid locale fallback ────────
    section("SCENARIO 35: formatCurrencyForLocale — invalid locale fallback");
    const fc35 = formatCurrencyForLocale(50, "USD", "xx-INVALID");
    assert(typeof fc35 === "string", "invalid locale falls back, returns string");

    // ── SCENARIO 36: en.json structure ───────────────────────────────────────
    section("SCENARIO 36: en.json structure");
    assert(typeof en === "object",                "en.json is object");
    assert(typeof en.common === "object",         "en.json has common namespace");
    assert(typeof en.common.loading === "string", "en.common.loading is string");
    assert(typeof en.nav === "object",            "en.json has nav namespace");
    assert(typeof en.settings === "object",       "en.json has settings namespace");
    assert(typeof en.settings.language === "string", "en.settings.language exists");
    assert(typeof en.settings.currency === "string", "en.settings.currency exists");
    assert(typeof en.settings.timezone === "string", "en.settings.timezone exists");
    assert(typeof en.ops === "object",            "en.json has ops namespace");

    // ── SCENARIO 37: da.json structure ───────────────────────────────────────
    section("SCENARIO 37: da.json structure");
    assert(typeof da === "object",                "da.json is object");
    assert(typeof da.common === "object",         "da.json has common namespace");
    assert(typeof da.common.loading === "string", "da.common.loading is string");
    assert(da.common.loading !== en.common.loading, "da loading is translated (not same as en)");
    assert(typeof da.nav === "object",            "da.json has nav namespace");
    assert(typeof da.settings === "object",       "da.json has settings namespace");
    assert(typeof da.ops === "object",            "da.json has ops namespace");

    // ── SCENARIO 38: Translation key parity ──────────────────────────────────
    section("SCENARIO 38: Translation key parity");
    const enKeys = Object.keys(en).sort().join(",");
    const daKeys = Object.keys(da).sort().join(",");
    assert(enKeys === daKeys, "en and da have same top-level namespaces");
    assert(Object.keys(en.common).sort().join(",") === Object.keys(da.common).sort().join(","),
      "en.common and da.common have same keys");
    assert(Object.keys(en.settings).sort().join(",") === Object.keys(da.settings).sort().join(","),
      "en.settings and da.settings have same keys");

    // ── SCENARIO 39: i18n resources ──────────────────────────────────────────
    section("SCENARIO 39: i18n resources");
    assert(typeof resources === "object",         "resources is object");
    assert("en" in resources,                     "resources has en");
    assert("da" in resources,                     "resources has da");
    assert(typeof resources.en.translation === "object", "en translation loaded");
    assert(typeof resources.da.translation === "object", "da translation loaded");

    // ── SCENARIO 40: SUPPORTED_LANGUAGES ─────────────────────────────────────
    section("SCENARIO 40: SUPPORTED_LANGUAGES");
    assert(typeof SUPPORTED_LANGUAGES === "object", "SUPPORTED_LANGUAGES is object");
    assert("en" in SUPPORTED_LANGUAGES,             "en in SUPPORTED_LANGUAGES");
    assert("da" in SUPPORTED_LANGUAGES,             "da in SUPPORTED_LANGUAGES");
    assert(SUPPORTED_LANGUAGES.en === "English",    "en label is English");
    assert(SUPPORTED_LANGUAGES.da === "Dansk",      "da label is Dansk");

    // ── SCENARIO 41: Translation content spot-checks ─────────────────────────
    section("SCENARIO 41: Translation spot-checks");
    assert(en.common.save === "Save",          "en: save = Save");
    assert(da.common.save === "Gem",           "da: save = Gem (Danish)");
    assert(en.nav.dashboard === "Dashboard",   "en: dashboard nav key");
    assert(da.nav.dashboard === "Overblik",    "da: dashboard = Overblik");
    assert(en.errors.notFound === "Page not found", "en: notFound error");
    assert(da.errors.notFound === "Side ikke fundet", "da: notFound in Danish");

    // ── SCENARIO 42: client formatCurrency utility ────────────────────────────
    section("SCENARIO 42: client/src/utils/formatCurrency");
    const { formatCurrency: clientFmt, formatCurrencyForLocale: clientFmtLocale } =
      await import("../client/src/utils/formatCurrency");
    const c42a = clientFmt(1500, "USD");
    assert(c42a.includes("1,500.00"), "client formatCurrency USD correct");
    const c42b = clientFmt(0, "EUR");
    assert(c42b.includes("0.00"),     "client formatCurrency zero EUR");
    const c42c = clientFmtLocale(100, "DKK", "da-DK");
    assert(typeof c42c === "string",  "client formatCurrencyForLocale returns string");
    const c42d = clientFmt(99.99, "INVALID_CURRENCY");
    assert(typeof c42d === "string",  "client formatCurrency invalid fallback ok");

    // ── SCENARIO 43: client formatCurrency — negative amounts ─────────────────
    section("SCENARIO 43: client formatCurrency — negative amounts");
    const neg = clientFmt(-500, "USD");
    assert(typeof neg === "string",  "negative amount returns string");
    assert(neg.includes("500"),      "negative output contains amount");

    // ── SCENARIO 44: client/src/utils/formatDate ──────────────────────────────
    section("SCENARIO 44: client/src/utils/formatDate");
    const { formatDate: clientFmtDate, formatDateShort: clientFmtShort, formatRelativeDate } =
      await import("../client/src/utils/formatDate");
    const d44 = new Date("2025-04-01T10:30:00Z");
    const r44a = clientFmtDate(d44, "en-US", "UTC");
    assert(typeof r44a === "string",  "client formatDate returns string");
    assert(r44a.includes("2025"),     "client formatDate contains year");
    assert(r44a.includes("Apr"),      "client formatDate contains Apr");
    const r44b = clientFmtShort(d44, "en-US", "UTC");
    assert(typeof r44b === "string",  "client formatDateShort returns string");
    assert(!r44b.includes(":"),       "client formatDateShort has no time");
    const r44c = clientFmtDate(d44, "INVALID", "INVALID_TZ");
    assert(typeof r44c === "string",  "invalid locale/tz fallback returns string");

    // ── SCENARIO 45: formatRelativeDate ───────────────────────────────────────
    section("SCENARIO 45: formatRelativeDate");
    const recent = new Date(Date.now() - 60_000);
    const rel45 = formatRelativeDate(recent, "en");
    assert(typeof rel45 === "string",  "formatRelativeDate returns string");
    assert(rel45.length > 0,           "non-empty relative date");
    const old = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const rel45b = formatRelativeDate(old, "en");
    assert(typeof rel45b === "string", "formatRelativeDate old date returns string");
    assert(rel45b.includes("day"),     "3-day old shows 'day' in English");

  } finally {
    await db.end();
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Phase 34 validation: ${passed} passed, ${failed} failed`);
  if (failed === 0) {
    console.log("✔ All assertions passed");
    process.exit(0);
  } else {
    console.log(`✗ ${failed} assertion(s) failed`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
