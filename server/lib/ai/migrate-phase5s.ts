/**
 * migrate-phase5s.ts — Phase 5S
 *
 * Idempotent migration: Retrieval Feedback Loop, Quality Evaluation & Auto-Tuning Signals
 *
 * Changes:
 *   knowledge_retrieval_feedback — NEW TABLE (14 cols, 5 indexes, RLS ON)
 *
 * No changes to existing tables. No breakage of prior phases.
 * RLS will be 101 tables after migration (was 100).
 */

import pg from "pg";

async function tableExists(client: pg.Client, table: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1`, [table],
  );
  return (r.rowCount ?? 0) > 0;
}

async function indexExists(client: pg.Client, indexName: string): Promise<boolean> {
  const r = await client.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`, [indexName],
  );
  return (r.rowCount ?? 0) > 0;
}

async function main(): Promise<void> {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  // ── 1. Verify prior phase tables still intact ─────────────────────────────

  console.log("\n── Verifying prior phase schema integrity ──");
  const priorChecks: Array<[string, number]> = [
    ["knowledge_retrieval_runs", 28],
    ["knowledge_retrieval_quality_signals", 10],
    ["knowledge_answer_runs", 31],
    ["knowledge_answer_citations", 12],
  ];
  for (const [table, expectedCols] of priorChecks) {
    const r = await client.query(
      `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table],
    );
    const cnt = parseInt(r.rows[0].cnt, 10);
    if (cnt !== expectedCols) throw new Error(`${table}: expected ${expectedCols} cols, got ${cnt}`);
    console.log(`  ✔ ${table} still has ${expectedCols} columns`);
  }

  // ── 2. Create knowledge_retrieval_feedback ────────────────────────────────

  console.log("\n── Creating knowledge_retrieval_feedback ──");
  const exists = await tableExists(client, "knowledge_retrieval_feedback");

  if (!exists) {
    await client.query(`
      CREATE TABLE public.knowledge_retrieval_feedback (
        id                       varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id                text NOT NULL,
        retrieval_run_id         varchar NOT NULL,
        answer_run_id            varchar,
        feedback_status          text NOT NULL,
        retrieval_quality_band   text NOT NULL,
        rerank_effectiveness_band text NOT NULL,
        citation_quality_band    text NOT NULL,
        rewrite_effectiveness_band text NOT NULL,
        answer_safety_band       text NOT NULL,
        dominant_failure_mode    text,
        tuning_signals           jsonb NOT NULL DEFAULT '[]'::jsonb,
        notes                    jsonb,
        created_at               timestamptz NOT NULL DEFAULT now()
      )
    `);
    console.log("  + Table created: knowledge_retrieval_feedback");
  } else {
    console.log("  ✓ Table exists: knowledge_retrieval_feedback");
  }

  // ── 3. Create indexes ─────────────────────────────────────────────────────

  console.log("\n── Creating indexes ──");
  const indexes: Array<[string, string]> = [
    ["krf_tenant_run_idx",     "ON public.knowledge_retrieval_feedback(tenant_id, retrieval_run_id)"],
    ["krf_tenant_answer_idx",  "ON public.knowledge_retrieval_feedback(tenant_id, answer_run_id)"],
    ["krf_tenant_status_idx",  "ON public.knowledge_retrieval_feedback(tenant_id, feedback_status)"],
    ["krf_tenant_quality_idx", "ON public.knowledge_retrieval_feedback(tenant_id, retrieval_quality_band)"],
    ["krf_tenant_created_idx", "ON public.knowledge_retrieval_feedback(tenant_id, created_at)"],
  ];
  for (const [name, def] of indexes) {
    if (!(await indexExists(client, name))) {
      await client.query(`CREATE INDEX ${name} ${def}`);
      console.log(`  + Index created: ${name}`);
    } else {
      console.log(`  ✓ Index exists: ${name}`);
    }
  }

  // ── 4. Enable RLS ─────────────────────────────────────────────────────────

  console.log("\n── Enabling RLS ──");
  await client.query(`ALTER TABLE public.knowledge_retrieval_feedback ENABLE ROW LEVEL SECURITY`);
  console.log("  ✔ RLS enabled on knowledge_retrieval_feedback");

  const policyExists = await client.query(
    `SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='knowledge_retrieval_feedback' AND policyname='krf_tenant_isolation'`,
  );
  if ((policyExists.rowCount ?? 0) === 0) {
    await client.query(`
      CREATE POLICY krf_tenant_isolation ON public.knowledge_retrieval_feedback
      USING (
        current_setting('app.current_tenant_id', true) <> '' AND
        tenant_id::text = current_setting('app.current_tenant_id', true)
      )
    `);
    console.log("  + RLS policy created: krf_tenant_isolation");
  } else {
    console.log("  ✓ RLS policy exists: krf_tenant_isolation");
  }

  // ── 5. Verify new table schema ────────────────────────────────────────────

  console.log("\n── Verifying knowledge_retrieval_feedback ──");
  const colCount = await client.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_retrieval_feedback'`,
  );
  const cnt = parseInt(colCount.rows[0].cnt, 10);
  if (cnt !== 14) throw new Error(`knowledge_retrieval_feedback: expected 14 cols, got ${cnt}`);
  console.log(`  ✔ knowledge_retrieval_feedback has ${cnt} columns`);

  const requiredCols = [
    "id", "tenant_id", "retrieval_run_id", "answer_run_id", "feedback_status",
    "retrieval_quality_band", "rerank_effectiveness_band", "citation_quality_band",
    "rewrite_effectiveness_band", "answer_safety_band", "dominant_failure_mode",
    "tuning_signals", "notes", "created_at",
  ];
  for (const col of requiredCols) {
    const r = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_retrieval_feedback' AND column_name=$1`, [col],
    );
    if (!r.rowCount) throw new Error(`Column MISSING: knowledge_retrieval_feedback.${col}`);
    console.log(`  ✔ Column: knowledge_retrieval_feedback.${col}`);
  }

  // ── 6. Verify RLS count is now 101 ───────────────────────────────────────

  console.log("\n── Verifying RLS count ──");
  const rlsR = await client.query(
    `SELECT COUNT(*) as cnt FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=true`,
  );
  const rlsCount = parseInt(rlsR.rows[0].cnt, 10);
  if (rlsCount !== 101) throw new Error(`RLS count: expected 101, got ${rlsCount}`);
  console.log(`  ✔ RLS tables: ${rlsCount} (expected 101 — +1 from knowledge_retrieval_feedback)`);

  // ── 7. Verify indexes ─────────────────────────────────────────────────────

  console.log("\n── Verifying indexes ──");
  for (const [name] of indexes) {
    if (!(await indexExists(client, name))) throw new Error(`Index missing: ${name}`);
    console.log(`  ✔ Index: ${name}`);
  }

  await client.end();
  console.log("\n✔ Phase 5S migration complete — all assertions passed");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("✗ Phase 5S migration failed:", err.message);
  process.exit(1);
});
