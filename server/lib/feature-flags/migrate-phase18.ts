/**
 * Phase 18 — DB Migration
 * Feature Flags & Experiment Platform
 *
 * Run: npx tsx server/lib/feature-flags/migrate-phase18.ts
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

  // ── feature_flags ────────────────────────────────────────────────────────
  section("feature_flags");
  await client.query(`
    CREATE TABLE IF NOT EXISTS feature_flags (
      id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      flag_key    TEXT NOT NULL UNIQUE,
      flag_type   TEXT NOT NULL,
      description TEXT,
      default_enabled   BOOLEAN NOT NULL DEFAULT false,
      default_config    JSONB,
      lifecycle_status  TEXT NOT NULL DEFAULT 'active',
      created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ok("feature_flags ready");

  // ── feature_flag_assignments ─────────────────────────────────────────────
  section("feature_flag_assignments");
  await client.query(`
    CREATE TABLE IF NOT EXISTS feature_flag_assignments (
      id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      flag_id         VARCHAR NOT NULL REFERENCES feature_flags(id) ON DELETE CASCADE,
      tenant_id       TEXT,
      actor_id        TEXT,
      assignment_type TEXT NOT NULL,
      enabled         BOOLEAN,
      assigned_variant TEXT,
      assigned_config  JSONB,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ok("feature_flag_assignments ready");

  // ── experiments ──────────────────────────────────────────────────────────
  section("experiments");
  await client.query(`
    CREATE TABLE IF NOT EXISTS experiments (
      id                          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      experiment_key              TEXT NOT NULL UNIQUE,
      tenant_id                   TEXT,
      subject_type                TEXT NOT NULL,
      lifecycle_status            TEXT NOT NULL DEFAULT 'draft',
      traffic_allocation_percent  NUMERIC(5,2) NOT NULL DEFAULT 100.00,
      description                 TEXT,
      metadata                    JSONB,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ok("experiments ready");

  // ── experiment_variants ──────────────────────────────────────────────────
  section("experiment_variants");
  await client.query(`
    CREATE TABLE IF NOT EXISTS experiment_variants (
      id              VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      experiment_id   VARCHAR NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
      variant_key     TEXT NOT NULL,
      traffic_percent NUMERIC(5,2) NOT NULL,
      config          JSONB,
      is_control      BOOLEAN NOT NULL DEFAULT false,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ok("experiment_variants ready");

  // ── feature_resolution_events ────────────────────────────────────────────
  section("feature_resolution_events");
  await client.query(`
    CREATE TABLE IF NOT EXISTS feature_resolution_events (
      id                VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id         TEXT,
      actor_id          TEXT,
      request_id        TEXT,
      flag_key          TEXT NOT NULL,
      resolution_source TEXT NOT NULL,
      enabled           BOOLEAN,
      resolved_variant  TEXT,
      resolved_config   JSONB,
      metadata          JSONB,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ok("feature_resolution_events ready");

  // ── rollout_audit_log (supporting table for rollout-audit.ts) ───────────
  section("rollout_audit_log");
  await client.query(`
    CREATE TABLE IF NOT EXISTS rollout_audit_log (
      id          VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
      action      TEXT NOT NULL,
      actor_id    TEXT,
      tenant_id   TEXT,
      subject_key TEXT NOT NULL,
      metadata    JSONB,
      created_at  TIMESTAMP NOT NULL DEFAULT NOW()
    )
  `);
  ok("rollout_audit_log ready");

  // ── Indexes ──────────────────────────────────────────────────────────────
  section("Indexes");
  const indexes = [
    { name: "ff_lifecycle_created_idx", sql: "CREATE INDEX IF NOT EXISTS ff_lifecycle_created_idx ON feature_flags (lifecycle_status, created_at)" },
    { name: "ff_type_created_idx", sql: "CREATE INDEX IF NOT EXISTS ff_type_created_idx ON feature_flags (flag_type, created_at)" },
    { name: "ffa_flag_created_idx", sql: "CREATE INDEX IF NOT EXISTS ffa_flag_created_idx ON feature_flag_assignments (flag_id, created_at)" },
    { name: "ffa_tenant_created_idx", sql: "CREATE INDEX IF NOT EXISTS ffa_tenant_created_idx ON feature_flag_assignments (tenant_id, created_at)" },
    { name: "ffa_actor_created_idx", sql: "CREATE INDEX IF NOT EXISTS ffa_actor_created_idx ON feature_flag_assignments (actor_id, created_at)" },
    { name: "ffa_atype_created_idx", sql: "CREATE INDEX IF NOT EXISTS ffa_atype_created_idx ON feature_flag_assignments (assignment_type, created_at)" },
    { name: "exp_tenant_created_idx", sql: "CREATE INDEX IF NOT EXISTS exp_tenant_created_idx ON experiments (tenant_id, created_at)" },
    { name: "exp_lifecycle_created_idx", sql: "CREATE INDEX IF NOT EXISTS exp_lifecycle_created_idx ON experiments (lifecycle_status, created_at)" },
    { name: "exp_subject_created_idx", sql: "CREATE INDEX IF NOT EXISTS exp_subject_created_idx ON experiments (subject_type, created_at)" },
    { name: "ev_experiment_created_idx", sql: "CREATE INDEX IF NOT EXISTS ev_experiment_created_idx ON experiment_variants (experiment_id, created_at)" },
    { name: "ev_variant_key_idx", sql: "CREATE INDEX IF NOT EXISTS ev_variant_key_idx ON experiment_variants (variant_key)" },
    { name: "fre_tenant_created_idx", sql: "CREATE INDEX IF NOT EXISTS fre_tenant_created_idx ON feature_resolution_events (tenant_id, created_at)" },
    { name: "fre_actor_created_idx", sql: "CREATE INDEX IF NOT EXISTS fre_actor_created_idx ON feature_resolution_events (actor_id, created_at)" },
    { name: "fre_request_id_idx", sql: "CREATE INDEX IF NOT EXISTS fre_request_id_idx ON feature_resolution_events (request_id)" },
    { name: "fre_flag_created_idx", sql: "CREATE INDEX IF NOT EXISTS fre_flag_created_idx ON feature_resolution_events (flag_key, created_at)" },
    { name: "fre_source_created_idx", sql: "CREATE INDEX IF NOT EXISTS fre_source_created_idx ON feature_resolution_events (resolution_source, created_at)" },
    { name: "ral_action_created_idx", sql: "CREATE INDEX IF NOT EXISTS ral_action_created_idx ON rollout_audit_log (action, created_at)" },
    { name: "ral_tenant_created_idx", sql: "CREATE INDEX IF NOT EXISTS ral_tenant_created_idx ON rollout_audit_log (tenant_id, created_at)" },
  ];
  for (const idx of indexes) {
    await client.query(idx.sql);
    ok(`Index: ${idx.name}`);
  }

  // ── RLS ──────────────────────────────────────────────────────────────────
  section("Enabling RLS");
  const rlsTables = [
    "feature_flags",
    "feature_flag_assignments",
    "experiments",
    "experiment_variants",
    "feature_resolution_events",
  ];
  for (const t of rlsTables) {
    await client.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
    ok(`RLS enabled: ${t}`);
  }

  // ── Verification ─────────────────────────────────────────────────────────
  section("Verification");
  const tableCheck = await client.query(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        'feature_flags','feature_flag_assignments','experiments',
        'experiment_variants','feature_resolution_events','rollout_audit_log'
      )
    ORDER BY table_name
  `);
  ok(`Tables verified: ${tableCheck.rows.length}/6`);
  tableCheck.rows.forEach((r: Record<string, unknown>) => ok(`  - ${r.table_name}`));

  const idxCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN (
        'feature_flags','feature_flag_assignments','experiments',
        'experiment_variants','feature_resolution_events','rollout_audit_log'
      )
  `);
  ok(`Indexes: ${idxCheck.rows[0].cnt} found`);

  const rlsCheck = await client.query(`
    SELECT COUNT(*) AS cnt FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('feature_flags','feature_flag_assignments','experiments','experiment_variants','feature_resolution_events')
      AND rowsecurity = true
  `);
  ok(`RLS enabled (${rlsCheck.rows[0].cnt}/5 tables)`);

  // ── Test insert + cleanup ─────────────────────────────────────────────────
  section("Test insert + cleanup");
  const ins = await client.query(`
    INSERT INTO feature_flags (flag_key, flag_type, lifecycle_status)
    VALUES ('__migration_test__', 'boolean', 'active')
    RETURNING id
  `);
  await client.query(`DELETE FROM feature_flags WHERE id = $1`, [ins.rows[0].id]);
  ok("Test insert + cleanup successful");

  await client.end();
  console.log("\n✔ Phase 18 migration complete");
}

main().catch((err) => {
  console.error("✗ Migration failed:", err.message);
  process.exit(1);
});
