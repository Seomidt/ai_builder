/**
 * Phase 17 — Migration
 * Creates ai_eval_datasets, ai_eval_cases, ai_eval_runs, ai_eval_results, ai_eval_regressions
 * Idempotent — inspects current schema and only adds missing objects.
 * RLS enabled on all 5 tables with service-role bypass.
 */

import pg from "pg";

async function main() {
  const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres\n");

  try {
    // ── ai_eval_datasets ────────────────────────────────────────────────────────
    console.log("── ai_eval_datasets ──");
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_eval_datasets (
        id            VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id     TEXT,
        dataset_name  TEXT NOT NULL,
        dataset_type  TEXT NOT NULL,
        description   TEXT,
        is_active     BOOLEAN NOT NULL DEFAULT TRUE,
        metadata      JSONB,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS aed_tenant_created_idx ON ai_eval_datasets(tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aed_type_created_idx   ON ai_eval_datasets(dataset_type, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aed_active_created_idx ON ai_eval_datasets(is_active, created_at)`);
    console.log("  ✔ ai_eval_datasets ready\n");

    // ── ai_eval_cases ───────────────────────────────────────────────────────────
    console.log("── ai_eval_cases ──");
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_eval_cases (
        id                  VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        dataset_id          VARCHAR NOT NULL,
        tenant_id           TEXT,
        input_query         TEXT NOT NULL,
        expected_signals    JSONB,
        expected_answer     TEXT,
        expected_citations  JSONB,
        difficulty          TEXT NOT NULL DEFAULT 'medium',
        metadata            JSONB,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS aec_dataset_created_idx    ON ai_eval_cases(dataset_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aec_tenant_created_idx     ON ai_eval_cases(tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aec_difficulty_created_idx ON ai_eval_cases(difficulty, created_at)`);
    console.log("  ✔ ai_eval_cases ready\n");

    // ── ai_eval_runs ────────────────────────────────────────────────────────────
    console.log("── ai_eval_runs ──");
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_eval_runs (
        id                VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         TEXT,
        dataset_id        VARCHAR NOT NULL,
        prompt_version_id VARCHAR,
        model_id          VARCHAR,
        run_status        TEXT NOT NULL DEFAULT 'queued',
        total_cases       INTEGER NOT NULL DEFAULT 0,
        completed_cases   INTEGER NOT NULL DEFAULT 0,
        summary_scores    JSONB,
        metadata          JSONB,
        started_at        TIMESTAMPTZ,
        completed_at      TIMESTAMPTZ,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS aer_tenant_created_idx  ON ai_eval_runs(tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aer_dataset_created_idx ON ai_eval_runs(dataset_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aer_status_created_idx  ON ai_eval_runs(run_status, created_at)`);
    console.log("  ✔ ai_eval_runs ready\n");

    // ── ai_eval_results ─────────────────────────────────────────────────────────
    console.log("── ai_eval_results ──");
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_eval_results (
        id                       VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id                   VARCHAR NOT NULL,
        case_id                  VARCHAR NOT NULL,
        tenant_id                TEXT,
        answer_quality_score     NUMERIC(10,4),
        retrieval_quality_score  NUMERIC(10,4),
        grounding_score          NUMERIC(10,4),
        hallucination_risk_score NUMERIC(10,4),
        pass                     BOOLEAN NOT NULL DEFAULT FALSE,
        result_summary           JSONB,
        created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS aerr_run_created_idx    ON ai_eval_results(run_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aerr_case_created_idx   ON ai_eval_results(case_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aerr_tenant_created_idx ON ai_eval_results(tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aerr_pass_created_idx   ON ai_eval_results(pass, created_at)`);
    console.log("  ✔ ai_eval_results ready\n");

    // ── ai_eval_regressions ─────────────────────────────────────────────────────
    console.log("── ai_eval_regressions ──");
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_eval_regressions (
        id                  VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           TEXT,
        baseline_run_id     VARCHAR NOT NULL,
        candidate_run_id    VARCHAR NOT NULL,
        regression_type     TEXT NOT NULL,
        severity            TEXT NOT NULL DEFAULT 'medium',
        regression_summary  JSONB,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS aeReg_tenant_created_idx ON ai_eval_regressions(tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aeReg_type_created_idx   ON ai_eval_regressions(regression_type, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aeReg_severity_created_idx ON ai_eval_regressions(severity, created_at)`);
    console.log("  ✔ ai_eval_regressions ready\n");

    // ── Enable RLS ──────────────────────────────────────────────────────────────
    console.log("── Enabling RLS ──");
    const evalTables = [
      "ai_eval_datasets",
      "ai_eval_cases",
      "ai_eval_runs",
      "ai_eval_results",
      "ai_eval_regressions",
    ];
    for (const t of evalTables) {
      await client.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_policies
            WHERE tablename = '${t}' AND policyname = '${t}_service_role_all'
          ) THEN
            EXECUTE 'CREATE POLICY ${t}_service_role_all ON ${t} FOR ALL TO service_role USING (true) WITH CHECK (true)';
          END IF;
        END $$
      `);
      console.log(`  ✔ RLS enabled: ${t}`);
    }
    console.log();

    // ── Verification ────────────────────────────────────────────────────────────
    console.log("── Verification ──");
    const { rows: tableRows } = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('ai_eval_datasets','ai_eval_cases','ai_eval_runs','ai_eval_results','ai_eval_regressions')
      ORDER BY table_name
    `);
    console.log(`  ✔ Tables verified: ${tableRows.length}/5`);
    tableRows.forEach((r: { table_name: string }) => console.log(`    - ${r.table_name}`));

    const { rows: rlsRows } = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename IN ('ai_eval_datasets','ai_eval_cases','ai_eval_runs','ai_eval_results','ai_eval_regressions')
        AND rowsecurity = true
    `);
    console.log(`  ✔ RLS enabled (${rlsRows.length}/5 tables)\n`);

    const { rows: idxRows } = await client.query(`
      SELECT indexname FROM pg_indexes
      WHERE schemaname = 'public'
        AND tablename IN ('ai_eval_datasets','ai_eval_cases','ai_eval_runs','ai_eval_results','ai_eval_regressions')
    `);
    console.log(`  ✔ Indexes: ${idxRows.length} found\n`);

    // ── Test insert + cleanup ───────────────────────────────────────────────────
    console.log("── Test insert + cleanup ──");
    const { rows: [testDs] } = await client.query(`
      INSERT INTO ai_eval_datasets (dataset_name, dataset_type, tenant_id)
      VALUES ('__migration_test__', 'answer_quality', '__migration__')
      RETURNING id
    `);
    await client.query(`DELETE FROM ai_eval_datasets WHERE id = $1`, [testDs.id]);
    console.log("  ✔ Test insert + cleanup successful\n");

    console.log("✔ Phase 17 migration complete");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("✗ Migration failed:", err.message);
  process.exit(1);
});
