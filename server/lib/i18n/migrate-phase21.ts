/**
 * Phase 21 — DB Migration
 * Internationalization, Locale & Currency Platform
 *
 * Run: npx tsx server/lib/i18n/migrate-phase21.ts
 */

import pg from "pg";
import { SEED_LANGUAGES } from "./language-service.ts";
import { SEED_CURRENCIES } from "./currency-service.ts";

const DB_URL = process.env.SUPABASE_DB_POOL_URL ?? process.env.DATABASE_URL;
if (!DB_URL) throw new Error("SUPABASE_DB_POOL_URL or DATABASE_URL is required");

const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const section = (msg: string) => console.log(`\n── ${msg} ──`);

async function main() {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  ok("Connected to Supabase Postgres");

  // ── supported_languages ───────────────────────────────────────────────────
  section("supported_languages");
  await client.query(`
    CREATE TABLE IF NOT EXISTS supported_languages (
      language_code TEXT PRIMARY KEY,
      display_name  TEXT NOT NULL,
      native_name   TEXT,
      active        BOOLEAN NOT NULL DEFAULT true,
      rtl           BOOLEAN NOT NULL DEFAULT false
    )
  `);
  ok("supported_languages ready");

  // ── supported_currencies ──────────────────────────────────────────────────
  section("supported_currencies");
  await client.query(`
    CREATE TABLE IF NOT EXISTS supported_currencies (
      currency_code TEXT PRIMARY KEY,
      symbol        TEXT NOT NULL,
      display_name  TEXT NOT NULL,
      decimals      INTEGER NOT NULL DEFAULT 2,
      active        BOOLEAN NOT NULL DEFAULT true
    )
  `);
  ok("supported_currencies ready");

  // ── tenant_locales ────────────────────────────────────────────────────────
  section("tenant_locales");
  await client.query(`
    CREATE TABLE IF NOT EXISTS tenant_locales (
      id                VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id         TEXT NOT NULL UNIQUE,
      default_language  TEXT NOT NULL DEFAULT 'en',
      default_currency  TEXT NOT NULL DEFAULT 'USD',
      default_timezone  TEXT NOT NULL DEFAULT 'UTC',
      number_format     TEXT NOT NULL DEFAULT 'en-US',
      created_at        TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ok("tenant_locales ready");

  // ── user_locales ──────────────────────────────────────────────────────────
  section("user_locales");
  await client.query(`
    CREATE TABLE IF NOT EXISTS user_locales (
      id            VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id       TEXT NOT NULL UNIQUE,
      tenant_id     TEXT,
      language      TEXT NOT NULL DEFAULT 'en',
      timezone      TEXT NOT NULL DEFAULT 'UTC',
      currency      TEXT,
      number_format TEXT,
      created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ok("user_locales ready");

  // ── Indexes ───────────────────────────────────────────────────────────────
  section("Indexes");
  const indexes = [
    { name: "sl_active_idx",    sql: "CREATE INDEX IF NOT EXISTS sl_active_idx ON supported_languages (active)" },
    { name: "sc_active_idx",    sql: "CREATE INDEX IF NOT EXISTS sc_active_idx ON supported_currencies (active)" },
    { name: "tl_tenant_id_idx", sql: "CREATE INDEX IF NOT EXISTS tl_tenant_id_idx ON tenant_locales (tenant_id)" },
    { name: "ul_user_id_idx",   sql: "CREATE INDEX IF NOT EXISTS ul_user_id_idx ON user_locales (user_id)" },
    { name: "ul_tenant_id_idx", sql: "CREATE INDEX IF NOT EXISTS ul_tenant_id_idx ON user_locales (tenant_id)" },
  ];
  for (const idx of indexes) {
    await client.query(idx.sql);
    ok(`Index: ${idx.name}`);
  }

  // ── RLS ──────────────────────────────────────────────────────────────────
  section("Enabling RLS");
  const rlsTables = ["supported_languages", "supported_currencies", "tenant_locales", "user_locales"];
  for (const t of rlsTables) {
    await client.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    ok(`RLS enabled: ${t}`);
  }

  // ── Seed languages ────────────────────────────────────────────────────────
  section("Seed supported_languages");
  for (const lang of SEED_LANGUAGES) {
    await client.query(`
      INSERT INTO supported_languages (language_code, display_name, native_name, rtl, active)
      VALUES ($1, $2, $3, $4, true)
      ON CONFLICT (language_code) DO NOTHING
    `, [lang.languageCode, lang.displayName, lang.nativeName ?? null, lang.rtl]);
  }
  ok(`${SEED_LANGUAGES.length} languages seeded`);

  // ── Seed currencies ───────────────────────────────────────────────────────
  section("Seed supported_currencies");
  for (const cur of SEED_CURRENCIES) {
    await client.query(`
      INSERT INTO supported_currencies (currency_code, symbol, display_name, decimals, active)
      VALUES ($1, $2, $3, $4, true)
      ON CONFLICT (currency_code) DO NOTHING
    `, [cur.currencyCode, cur.symbol, cur.displayName, cur.decimals]);
  }
  ok(`${SEED_CURRENCIES.length} currencies seeded`);

  // ── Verification ─────────────────────────────────────────────────────────
  section("Verification");
  const tableCheck = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('supported_languages','supported_currencies','tenant_locales','user_locales')
    ORDER BY table_name
  `);
  ok(`Tables verified: ${tableCheck.rows.length}/4`);
  tableCheck.rows.forEach((r: Record<string, unknown>) => ok(`  - ${r.table_name}`));

  const idxCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('supported_languages','supported_currencies','tenant_locales','user_locales')
  `);
  ok(`Indexes: ${idxCheck.rows[0].cnt} found`);

  const rlsCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('supported_languages','supported_currencies','tenant_locales','user_locales')
      AND rowsecurity = true
  `);
  ok(`RLS enabled (${rlsCheck.rows[0].cnt}/4 tables)`);

  const langCount = await client.query(`SELECT COUNT(*) AS cnt FROM supported_languages`);
  const curCount = await client.query(`SELECT COUNT(*) AS cnt FROM supported_currencies`);
  ok(`Languages: ${langCount.rows[0].cnt}, Currencies: ${curCount.rows[0].cnt}`);

  await client.end();
  console.log("\n✔ Phase 21 migration complete");
}

main().catch((err) => {
  console.error("✗ Migration failed:", err.message);
  process.exit(1);
});
