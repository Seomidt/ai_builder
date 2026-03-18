/**
 * Phase 33 Migration — Ops AI Audit Logs
 * Creates: ops_ai_audit_logs
 * Enables RLS + service-role policy.
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
    console.log("── ops_ai_audit_logs ──");
    await client.query(`
      CREATE TABLE IF NOT EXISTS ops_ai_audit_logs (
        id               VARCHAR  PRIMARY KEY DEFAULT gen_random_uuid(),
        request_type     TEXT     NOT NULL,
        operator_id      TEXT,
        input_scope      JSONB,
        response_summary TEXT,
        confidence       TEXT,
        tokens_used      INTEGER,
        model_used       TEXT,
        created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS oaal_created_idx
        ON ops_ai_audit_logs(created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS oaal_type_idx
        ON ops_ai_audit_logs(request_type)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS oaal_operator_idx
        ON ops_ai_audit_logs(operator_id)
    `);
    console.log("  ✔ ops_ai_audit_logs ready\n");

    console.log("── RLS ──");
    await client.query(`ALTER TABLE ops_ai_audit_logs ENABLE ROW LEVEL SECURITY`);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE tablename='ops_ai_audit_logs'
            AND policyname='service_role_all_ops_ai_audit_logs'
        ) THEN
          EXECUTE 'CREATE POLICY service_role_all_ops_ai_audit_logs
            ON ops_ai_audit_logs FOR ALL TO service_role
            USING (true) WITH CHECK (true)';
        END IF;
      END $$
    `);
    console.log("  ✔ RLS enabled\n");

    console.log("── Verification ──");
    const res = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name='ops_ai_audit_logs'
    `);
    console.log(`  ✔ Table verified: ${res.rows.length === 1 ? "YES" : "NO"}`);

    const rlsRes = await client.query(`
      SELECT relname FROM pg_class
      WHERE relrowsecurity=true AND relname='ops_ai_audit_logs'
    `);
    console.log(`  ✔ RLS enabled: ${rlsRes.rows.length === 1 ? "YES" : "NO"}`);

    console.log("\n── Test insert + cleanup ──");
    await client.query(`
      INSERT INTO ops_ai_audit_logs(request_type, confidence)
      VALUES('__test_p33__', 'high')
    `);
    await client.query(`DELETE FROM ops_ai_audit_logs WHERE request_type='__test_p33__'`);
    console.log("  ✔ Test insert + cleanup OK\n");

    console.log("✔ Phase 33 migration complete");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("✗ Migration failed:", err.message);
  process.exit(1);
});
