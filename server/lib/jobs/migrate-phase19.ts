/**
 * Phase 19 — DB Migration
 * Background Jobs & Queue Platform
 *
 * Run: npx tsx server/lib/jobs/migrate-phase19.ts
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

  // ── jobs ─────────────────────────────────────────────────────────────────
  section("jobs");
  await client.query(`
    CREATE TABLE IF NOT EXISTS jobs (
      id               VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      job_type         TEXT NOT NULL,
      tenant_id        TEXT,
      payload          JSONB,
      status           TEXT NOT NULL DEFAULT 'pending',
      priority         INTEGER NOT NULL DEFAULT 5,
      idempotency_key  TEXT,
      max_attempts     INTEGER NOT NULL DEFAULT 3,
      retry_policy     JSONB,
      scheduled_at     TIMESTAMP,
      created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ok("jobs ready");

  // ── job_runs ─────────────────────────────────────────────────────────────
  section("job_runs");
  await client.query(`
    CREATE TABLE IF NOT EXISTS job_runs (
      id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id          VARCHAR NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      run_status      TEXT NOT NULL DEFAULT 'running',
      attempt_count   INTEGER NOT NULL DEFAULT 0,
      error_message   TEXT,
      started_at      TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at    TIMESTAMP,
      duration_ms     INTEGER
    )
  `);
  ok("job_runs ready");

  // ── job_attempts ─────────────────────────────────────────────────────────
  section("job_attempts");
  await client.query(`
    CREATE TABLE IF NOT EXISTS job_attempts (
      id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      run_id          VARCHAR NOT NULL REFERENCES job_runs(id) ON DELETE CASCADE,
      attempt_number  INTEGER NOT NULL,
      status          TEXT NOT NULL,
      error           TEXT,
      started_at      TIMESTAMP NOT NULL DEFAULT NOW(),
      completed_at    TIMESTAMP,
      duration_ms     INTEGER,
      metadata        JSONB
    )
  `);
  ok("job_attempts ready");

  // ── job_schedules ─────────────────────────────────────────────────────────
  section("job_schedules");
  await client.query(`
    CREATE TABLE IF NOT EXISTS job_schedules (
      id               VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      job_type         TEXT NOT NULL,
      schedule_cron    TEXT NOT NULL,
      tenant_id        TEXT,
      active           BOOLEAN NOT NULL DEFAULT true,
      payload_template JSONB,
      last_run_at      TIMESTAMP,
      next_run_at      TIMESTAMP,
      created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ok("job_schedules ready");

  // ── Indexes ──────────────────────────────────────────────────────────────
  section("Indexes");
  const indexes = [
    { name: "j_tenant_created_idx",   sql: "CREATE INDEX IF NOT EXISTS j_tenant_created_idx ON jobs (tenant_id, created_at)" },
    { name: "j_status_created_idx",   sql: "CREATE INDEX IF NOT EXISTS j_status_created_idx ON jobs (status, created_at)" },
    { name: "j_type_status_idx",      sql: "CREATE INDEX IF NOT EXISTS j_type_status_idx ON jobs (job_type, status)" },
    { name: "j_idempotency_idx",      sql: "CREATE INDEX IF NOT EXISTS j_idempotency_idx ON jobs (idempotency_key)" },
    { name: "j_scheduled_idx",        sql: "CREATE INDEX IF NOT EXISTS j_scheduled_idx ON jobs (scheduled_at)" },
    { name: "jr_job_id_idx",          sql: "CREATE INDEX IF NOT EXISTS jr_job_id_idx ON job_runs (job_id, started_at)" },
    { name: "jr_status_started_idx",  sql: "CREATE INDEX IF NOT EXISTS jr_status_started_idx ON job_runs (run_status, started_at)" },
    { name: "ja_run_attempt_idx",     sql: "CREATE INDEX IF NOT EXISTS ja_run_attempt_idx ON job_attempts (run_id, attempt_number)" },
    { name: "ja_status_started_idx",  sql: "CREATE INDEX IF NOT EXISTS ja_status_started_idx ON job_attempts (status, started_at)" },
    { name: "js_active_type_idx",     sql: "CREATE INDEX IF NOT EXISTS js_active_type_idx ON job_schedules (active, job_type)" },
    { name: "js_tenant_idx",          sql: "CREATE INDEX IF NOT EXISTS js_tenant_idx ON job_schedules (tenant_id)" },
    { name: "js_next_run_idx",        sql: "CREATE INDEX IF NOT EXISTS js_next_run_idx ON job_schedules (next_run_at)" },
  ];
  for (const idx of indexes) {
    await client.query(idx.sql);
    ok(`Index: ${idx.name}`);
  }

  // ── RLS ──────────────────────────────────────────────────────────────────
  section("Enabling RLS");
  const rlsTables = ["jobs", "job_runs", "job_attempts", "job_schedules"];
  for (const t of rlsTables) {
    await client.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    ok(`RLS enabled: ${t}`);
  }

  // ── Verification ─────────────────────────────────────────────────────────
  section("Verification");
  const tableCheck = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('jobs', 'job_runs', 'job_attempts', 'job_schedules')
    ORDER BY table_name
  `);
  ok(`Tables verified: ${tableCheck.rows.length}/4`);
  tableCheck.rows.forEach((r: Record<string, unknown>) => ok(`  - ${r.table_name}`));

  const idxCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN ('jobs', 'job_runs', 'job_attempts', 'job_schedules')
  `);
  ok(`Indexes: ${idxCheck.rows[0].cnt} found`);

  const rlsCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('jobs', 'job_runs', 'job_attempts', 'job_schedules')
      AND rowsecurity = true
  `);
  ok(`RLS enabled (${rlsCheck.rows[0].cnt}/4 tables)`);

  // ── Test insert + cleanup ─────────────────────────────────────────────────
  section("Test insert + cleanup");
  const ins = await client.query(`
    INSERT INTO jobs (job_type, status) VALUES ('__migration_test__', 'pending') RETURNING id
  `);
  await client.query(`DELETE FROM jobs WHERE id = $1`, [ins.rows[0].id]);
  ok("Test insert + cleanup successful");

  await client.end();
  console.log("\n✔ Phase 19 migration complete");
}

main().catch((err) => {
  console.error("✗ Migration failed:", err.message);
  process.exit(1);
});
