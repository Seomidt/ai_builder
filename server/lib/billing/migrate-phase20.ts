/**
 * Phase 20 — DB Migration
 * SaaS Plans, Entitlements & Usage Quotas
 *
 * Run: npx tsx server/lib/billing/migrate-phase20.ts
 */

import pg from "pg";

const DB_URL = process.env.SUPABASE_DB_POOL_URL ?? process.env.DATABASE_URL;
if (!DB_URL) throw new Error("SUPABASE_DB_POOL_URL or DATABASE_URL is required");

const ok = (msg: string) => console.log(`  ✔ ${msg}`);
const section = (msg: string) => console.log(`\n── ${msg} ──`);

async function main() {
  const client = new pg.Client({ connectionString: DB_URL });
  await client.connect();
  ok("Connected to Supabase Postgres");

  // ── plans ─────────────────────────────────────────────────────────────────
  section("plans");
  await client.query(`
    CREATE TABLE IF NOT EXISTS plans (
      id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_key        TEXT NOT NULL UNIQUE,
      name            TEXT NOT NULL,
      description     TEXT,
      price_monthly   INTEGER NOT NULL DEFAULT 0,
      price_yearly    INTEGER NOT NULL DEFAULT 0,
      active          BOOLEAN NOT NULL DEFAULT true,
      created_at      TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ok("plans ready");

  // ── plan_features ─────────────────────────────────────────────────────────
  section("plan_features");
  await client.query(`
    CREATE TABLE IF NOT EXISTS plan_features (
      id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_id     VARCHAR NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      feature_key TEXT NOT NULL,
      enabled     BOOLEAN NOT NULL DEFAULT true,
      metadata    JSONB
    )
  `);
  ok("plan_features ready");

  // ── tenant_plans ─────────────────────────────────────────────────────────
  section("tenant_plans");
  await client.query(`
    CREATE TABLE IF NOT EXISTS tenant_plans (
      id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id   TEXT NOT NULL,
      plan_id     VARCHAR NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
      status      TEXT NOT NULL DEFAULT 'active',
      started_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      expires_at  TIMESTAMP,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ok("tenant_plans ready");

  // ── usage_quotas ──────────────────────────────────────────────────────────
  section("usage_quotas");
  await client.query(`
    CREATE TABLE IF NOT EXISTS usage_quotas (
      id            VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      plan_id       VARCHAR NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
      quota_key     TEXT NOT NULL,
      quota_limit   INTEGER NOT NULL,
      reset_period  TEXT NOT NULL DEFAULT 'monthly'
    )
  `);
  ok("usage_quotas ready");

  // ── usage_counters ────────────────────────────────────────────────────────
  section("usage_counters");
  await client.query(`
    CREATE TABLE IF NOT EXISTS usage_counters (
      id            VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id     TEXT NOT NULL,
      quota_key     TEXT NOT NULL,
      usage_value   INTEGER NOT NULL DEFAULT 0,
      period_start  TIMESTAMP NOT NULL,
      period_end    TIMESTAMP NOT NULL,
      created_at    TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ok("usage_counters ready");

  // ── Indexes ──────────────────────────────────────────────────────────────
  section("Indexes");
  const indexes = [
    { name: "p_plan_key_idx",            sql: "CREATE INDEX IF NOT EXISTS p_plan_key_idx ON plans (plan_key)" },
    { name: "p_active_idx",              sql: "CREATE INDEX IF NOT EXISTS p_active_idx ON plans (active)" },
    { name: "pf_plan_id_idx",            sql: "CREATE INDEX IF NOT EXISTS pf_plan_id_idx ON plan_features (plan_id, feature_key)" },
    { name: "pf_feature_key_idx",        sql: "CREATE INDEX IF NOT EXISTS pf_feature_key_idx ON plan_features (feature_key)" },
    { name: "tp_tenant_id_idx",          sql: "CREATE INDEX IF NOT EXISTS tp_tenant_id_idx ON tenant_plans (tenant_id, status)" },
    { name: "tp_plan_id_idx",            sql: "CREATE INDEX IF NOT EXISTS tp_plan_id_idx ON tenant_plans (plan_id)" },
    { name: "tp_expires_idx",            sql: "CREATE INDEX IF NOT EXISTS tp_expires_idx ON tenant_plans (expires_at)" },
    { name: "uq_plan_quota_idx",         sql: "CREATE INDEX IF NOT EXISTS uq_plan_quota_idx ON usage_quotas (plan_id, quota_key)" },
    { name: "uq_quota_key_idx",          sql: "CREATE INDEX IF NOT EXISTS uq_quota_key_idx ON usage_quotas (quota_key)" },
    { name: "uc_tenant_quota_period_idx",sql: "CREATE INDEX IF NOT EXISTS uc_tenant_quota_period_idx ON usage_counters (tenant_id, quota_key, period_start)" },
    { name: "uc_period_end_idx",         sql: "CREATE INDEX IF NOT EXISTS uc_period_end_idx ON usage_counters (period_end)" },
    { name: "uc_tenant_idx",             sql: "CREATE INDEX IF NOT EXISTS uc_tenant_idx ON usage_counters (tenant_id)" },
  ];
  for (const idx of indexes) {
    await client.query(idx.sql);
    ok(`Index: ${idx.name}`);
  }

  // ── RLS ──────────────────────────────────────────────────────────────────
  section("Enabling RLS");
  const rlsTables = ["plans", "plan_features", "tenant_plans", "usage_quotas", "usage_counters"];
  for (const t of rlsTables) {
    await client.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    ok(`RLS enabled: ${t}`);
  }

  // ── Seed built-in plans ──────────────────────────────────────────────────
  section("Seed built-in plans");
  const builtInPlans = [
    { planKey: "free",         name: "Free",         priceMonthly: 0,      priceYearly: 0 },
    { planKey: "starter",      name: "Starter",      priceMonthly: 2900,   priceYearly: 29000 },
    { planKey: "professional", name: "Professional", priceMonthly: 9900,   priceYearly: 99000 },
    { planKey: "enterprise",   name: "Enterprise",   priceMonthly: 49900,  priceYearly: 499000 },
  ];
  for (const p of builtInPlans) {
    await client.query(`
      INSERT INTO plans (plan_key, name, price_monthly, price_yearly, active)
      VALUES ($1, $2, $3, $4, true)
      ON CONFLICT (plan_key) DO NOTHING
    `, [p.planKey, p.name, p.priceMonthly, p.priceYearly]);
    ok(`Plan seeded: ${p.planKey}`);
  }

  // ── Verification ─────────────────────────────────────────────────────────
  section("Verification");
  const tableCheck = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('plans','plan_features','tenant_plans','usage_quotas','usage_counters')
    ORDER BY table_name
  `);
  ok(`Tables verified: ${tableCheck.rows.length}/5`);
  tableCheck.rows.forEach((r: Record<string, unknown>) => ok(`  - ${r.table_name}`));

  const idxCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('plans','plan_features','tenant_plans','usage_quotas','usage_counters')
  `);
  ok(`Indexes: ${idxCheck.rows[0].cnt} found`);

  const rlsCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('plans','plan_features','tenant_plans','usage_quotas','usage_counters')
      AND rowsecurity = true
  `);
  ok(`RLS enabled (${rlsCheck.rows[0].cnt}/5 tables)`);

  const planCount = await client.query(`SELECT COUNT(*) AS cnt FROM plans`);
  ok(`Plans seeded: ${planCount.rows[0].cnt}`);

  await client.end();
  console.log("\n✔ Phase 20 migration complete");
}

main().catch((err) => {
  console.error("✗ Migration failed:", err.message);
  process.exit(1);
});
