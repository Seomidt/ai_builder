/**
 * Phase 16 Migration — AI Cost Governance Platform
 * Creates 4 tables: tenant_ai_budgets, tenant_ai_usage_snapshots,
 *                   ai_usage_alerts, gov_anomaly_events
 * Enables RLS + service-role policies on all 4 tables.
 */

import pg from "pg";

async function main() {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres\n");

  try {
    // ── tenant_ai_budgets ──────────────────────────────────────────────────────
    console.log("── tenant_ai_budgets ──");
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_ai_budgets (
        id             VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id      TEXT NOT NULL UNIQUE,
        monthly_budget_usd NUMERIC(12,4),
        daily_budget_usd   NUMERIC(12,4),
        soft_limit_percent NUMERIC(5,2) DEFAULT 80,
        hard_limit_percent NUMERIC(5,2) DEFAULT 100,
        created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS tab_tenant_idx ON tenant_ai_budgets(tenant_id)`);
    console.log("  ✔ tenant_ai_budgets ready\n");

    // ── tenant_ai_usage_snapshots ─────────────────────────────────────────────
    console.log("── tenant_ai_usage_snapshots ──");
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_ai_usage_snapshots (
        id         VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id  TEXT NOT NULL,
        period     TEXT NOT NULL,
        tokens_in  INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        cost_usd   NUMERIC(12,6) DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS taus_tenant_period_idx ON tenant_ai_usage_snapshots(tenant_id, period)`);
    await client.query(`CREATE INDEX IF NOT EXISTS taus_tenant_created_idx ON tenant_ai_usage_snapshots(tenant_id, created_at)`);
    console.log("  ✔ tenant_ai_usage_snapshots ready\n");

    // ── ai_usage_alerts ───────────────────────────────────────────────────────
    console.log("── ai_usage_alerts ──");
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_usage_alerts (
        id                 VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id          TEXT NOT NULL,
        alert_type         TEXT NOT NULL,
        threshold_percent  NUMERIC(10,4) NOT NULL,
        usage_percent      NUMERIC(10,4) NOT NULL,
        triggered_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // Widen precision if table was created with old NUMERIC(5,2) — supports usagePercent > 999
    await client.query(`
      ALTER TABLE ai_usage_alerts
        ALTER COLUMN threshold_percent TYPE NUMERIC(10,4),
        ALTER COLUMN usage_percent     TYPE NUMERIC(10,4)
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS aua_tenant_triggered_idx ON ai_usage_alerts(tenant_id, triggered_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aua_tenant_type_idx ON ai_usage_alerts(tenant_id, alert_type)`);
    console.log("  ✔ ai_usage_alerts ready\n");

    // ── gov_anomaly_events ─────────────────────────────────────────────────────
    console.log("── gov_anomaly_events ──");
    await client.query(`
      CREATE TABLE IF NOT EXISTS gov_anomaly_events (
        id                  VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           TEXT NOT NULL,
        event_type          TEXT NOT NULL,
        usage_spike_percent NUMERIC(8,2),
        metadata            JSONB,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS aae_tenant_created_idx ON gov_anomaly_events(tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aae_tenant_type_idx ON gov_anomaly_events(tenant_id, event_type)`);
    console.log("  ✔ gov_anomaly_events ready\n");

    // ── Enable RLS ────────────────────────────────────────────────────────────
    console.log("── Enabling RLS ──");
    const tables = [
      "tenant_ai_budgets",
      "tenant_ai_usage_snapshots",
      "ai_usage_alerts",
      "gov_anomaly_events",
    ];
    for (const t of tables) {
      await client.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_policies WHERE tablename='${t}' AND policyname='service_role_all_${t}'
          ) THEN
            EXECUTE 'CREATE POLICY service_role_all_${t} ON ${t} FOR ALL TO service_role USING (true) WITH CHECK (true)';
          END IF;
        END $$
      `);
      console.log(`  ✔ RLS enabled: ${t}`);
    }

    // ── Verification ──────────────────────────────────────────────────────────
    console.log("\n── Verification ──");
    const res = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
      [tables],
    );
    const found = res.rows.map((r: any) => r.table_name);
    console.log(`  ✔ Tables verified: ${found.length}/${tables.length}`);
    for (const t of found.sort()) console.log(`    - ${t}`);

    const rlsRes = await client.query(
      `SELECT relname FROM pg_class WHERE relrowsecurity = true AND relname = ANY($1)`,
      [tables],
    );
    console.log(`  ✔ RLS enabled (${rlsRes.rows.length}/${tables.length} tables)`);

    // ── Test insert + cleanup ─────────────────────────────────────────────────
    console.log("\n── Test insert + cleanup ──");
    await client.query(
      `INSERT INTO tenant_ai_budgets(tenant_id, monthly_budget_usd) VALUES('__test_p16__', 100)`,
    );
    await client.query(`DELETE FROM tenant_ai_budgets WHERE tenant_id='__test_p16__'`);
    console.log("  ✔ Test insert + cleanup successful");

    console.log("\n✔ Phase 16 migration complete");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("✗ Migration failed:", err.message);
  process.exit(1);
});
