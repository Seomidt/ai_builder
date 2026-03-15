/**
 * Phase 15 Migration — Observability & Telemetry Platform
 * Creates 5 observability tables with indexes and RLS.
 * Idempotent: safe to re-run.
 */

import pg from "pg";
const { Client } = pg;

async function main() {
  const client = new Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  try {
    // ── 1. obs_system_metrics ─────────────────────────────────────────────────
    console.log("\n── obs_system_metrics ──");
    await client.query(`
      CREATE TABLE IF NOT EXISTS obs_system_metrics (
        id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
        metric_type TEXT NOT NULL,
        value       NUMERIC(20,6) NOT NULL,
        metadata    JSONB,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS osm_type_created_idx
        ON obs_system_metrics (metric_type, created_at)
    `);
    console.log("  ✔ obs_system_metrics ready");

    // ── 2. obs_ai_latency_metrics ─────────────────────────────────────────────
    console.log("\n── obs_ai_latency_metrics ──");
    await client.query(`
      CREATE TABLE IF NOT EXISTS obs_ai_latency_metrics (
        id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
        tenant_id   TEXT,
        model       TEXT NOT NULL,
        provider    TEXT NOT NULL,
        latency_ms  INTEGER NOT NULL,
        tokens_in   INTEGER,
        tokens_out  INTEGER,
        cost_usd    NUMERIC(20,10),
        request_id  TEXT,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS oalm_tenant_created_idx ON obs_ai_latency_metrics (tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS oalm_provider_model_idx ON obs_ai_latency_metrics (provider, model, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS oalm_request_id_idx ON obs_ai_latency_metrics (request_id)`);
    console.log("  ✔ obs_ai_latency_metrics ready");

    // ── 3. obs_retrieval_metrics ──────────────────────────────────────────────
    console.log("\n── obs_retrieval_metrics ──");
    await client.query(`
      CREATE TABLE IF NOT EXISTS obs_retrieval_metrics (
        id               VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
        tenant_id        TEXT,
        query_length     INTEGER,
        chunks_retrieved INTEGER,
        rerank_used      BOOLEAN DEFAULT FALSE,
        latency_ms       INTEGER,
        result_count     INTEGER,
        created_at       TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS orm_tenant_created_idx ON obs_retrieval_metrics (tenant_id, created_at)`);
    console.log("  ✔ obs_retrieval_metrics ready");

    // ── 4. obs_agent_runtime_metrics ──────────────────────────────────────────
    console.log("\n── obs_agent_runtime_metrics ──");
    await client.query(`
      CREATE TABLE IF NOT EXISTS obs_agent_runtime_metrics (
        id           VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
        tenant_id    TEXT,
        agent_id     TEXT,
        run_id       TEXT,
        steps        INTEGER,
        iterations   INTEGER,
        duration_ms  INTEGER,
        status       TEXT,
        created_at   TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS oarm_tenant_created_idx ON obs_agent_runtime_metrics (tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS oarm_run_id_idx ON obs_agent_runtime_metrics (run_id)`);
    console.log("  ✔ obs_agent_runtime_metrics ready");

    // ── 5. obs_tenant_usage_metrics ───────────────────────────────────────────
    console.log("\n── obs_tenant_usage_metrics ──");
    await client.query(`
      CREATE TABLE IF NOT EXISTS obs_tenant_usage_metrics (
        id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid()::varchar,
        tenant_id   TEXT NOT NULL,
        metric_type TEXT NOT NULL,
        value       NUMERIC(20,6) NOT NULL,
        period      TEXT NOT NULL,
        created_at  TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS otum_tenant_type_period_idx ON obs_tenant_usage_metrics (tenant_id, metric_type, period)`);
    await client.query(`CREATE INDEX IF NOT EXISTS otum_tenant_created_idx ON obs_tenant_usage_metrics (tenant_id, created_at)`);
    console.log("  ✔ obs_tenant_usage_metrics ready");

    // ── 6. RLS ────────────────────────────────────────────────────────────────
    console.log("\n── Enabling RLS ──");
    const tables = [
      "obs_system_metrics",
      "obs_ai_latency_metrics",
      "obs_retrieval_metrics",
      "obs_agent_runtime_metrics",
      "obs_tenant_usage_metrics",
    ];
    for (const table of tables) {
      await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      const policyName = `${table}_service_role_policy`;
      const policyExists = await client.query(
        `SELECT policyname FROM pg_policies WHERE tablename = $1 AND policyname = $2`,
        [table, policyName],
      );
      if (policyExists.rows.length === 0) {
        await client.query(
          `CREATE POLICY ${policyName} ON ${table} USING (true) WITH CHECK (true)`,
        );
      }
      console.log(`  ✔ RLS enabled: ${table}`);
    }

    // ── 7. Verify ─────────────────────────────────────────────────────────────
    console.log("\n── Verification ──");
    const verify = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1)`,
      [tables],
    );
    console.log(`  ✔ Tables verified: ${verify.rows.length}/5`);
    for (const row of verify.rows) {
      console.log(`    - ${row.table_name}`);
    }

    // ── 8. Test insert + cleanup ──────────────────────────────────────────────
    console.log("\n── Test insert + cleanup ──");
    await client.query(
      `INSERT INTO obs_ai_latency_metrics (model, provider, latency_ms, tenant_id)
       VALUES ('gpt-4o', 'openai', 1234, 'test-phase15-verify')`,
    );
    const testRow = await client.query(
      `SELECT id, model, latency_ms FROM obs_ai_latency_metrics WHERE tenant_id = 'test-phase15-verify' LIMIT 1`,
    );
    console.log(`  ✔ Test insert: model=${testRow.rows[0].model} latency=${testRow.rows[0].latency_ms}ms`);
    await client.query(`DELETE FROM obs_ai_latency_metrics WHERE tenant_id = 'test-phase15-verify'`);
    console.log("  ✔ Test row cleaned up");

    console.log("\n✔ Phase 15 migration complete");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("✗ Migration failed:", err.message);
  process.exit(1);
});
