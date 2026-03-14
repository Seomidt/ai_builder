/**
 * migrate-phase5q.ts — Phase 5Q
 *
 * Idempotent migration: Retrieval Quality, Query Rewriting & Safety Guards
 *
 * Changes:
 *   knowledge_retrieval_runs       — +12 nullable columns
 *   knowledge_answer_runs          — +4 nullable columns
 *   knowledge_retrieval_quality_signals — new table (10 cols) + RLS + 2 indexes
 *
 * RLS count: 99 → 100
 * No existing data modified. All new columns are nullable.
 */

import pg from "pg";

const RLS_POLICY = `
  current_setting('app.current_tenant_id', true) <> ''
  AND tenant_id::text = current_setting('app.current_tenant_id', true)
`.trim();

async function addColumnIfMissing(
  client: pg.Client,
  table: string,
  column: string,
  typeDef: string,
): Promise<void> {
  const res = await client.query(
    `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [table, column],
  );
  if (res.rowCount === 0) {
    await client.query(`ALTER TABLE public.${table} ADD COLUMN ${column} ${typeDef}`);
    console.log(`  + Column added: ${table}.${column}`);
  } else {
    console.log(`  ✓ Column exists: ${table}.${column}`);
  }
}

async function addIndexIfMissing(client: pg.Client, indexName: string, definition: string): Promise<void> {
  const res = await client.query(
    `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`, [indexName],
  );
  if (res.rowCount === 0) {
    await client.query(`CREATE INDEX ${indexName} ${definition}`);
    console.log(`  + Index created: ${indexName}`);
  } else {
    console.log(`  ✓ Index exists: ${indexName}`);
  }
}

async function addPolicyIfMissing(
  client: pg.Client,
  table: string,
  policyName: string,
  cmd: string,
  clause: string,
): Promise<void> {
  const res = await client.query(
    `SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=$1 AND policyname=$2`,
    [table, policyName],
  );
  if (res.rowCount === 0) {
    await client.query(`CREATE POLICY ${policyName} ON public.${table} FOR ${cmd} ${clause}`);
    console.log(`  + Policy created: ${policyName}`);
  } else {
    console.log(`  ✓ Policy exists: ${policyName}`);
  }
}

async function main() {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  // ── 1. Extend knowledge_retrieval_runs (12 new nullable columns) ──────────

  console.log("\n── Extending knowledge_retrieval_runs ──");
  await addColumnIfMissing(client, "knowledge_retrieval_runs", "original_query_text", "text");
  await addColumnIfMissing(client, "knowledge_retrieval_runs", "normalized_query_text", "text");
  await addColumnIfMissing(client, "knowledge_retrieval_runs", "rewritten_query_text", "text");
  await addColumnIfMissing(client, "knowledge_retrieval_runs", "expansion_terms", "jsonb");
  await addColumnIfMissing(client, "knowledge_retrieval_runs", "rewrite_strategy", "text");
  await addColumnIfMissing(client, "knowledge_retrieval_runs", "retrieval_safety_status", "text");
  await addColumnIfMissing(client, "knowledge_retrieval_runs", "query_rewrite_latency_ms", "integer");
  await addColumnIfMissing(client, "knowledge_retrieval_runs", "query_expansion_count", "integer");
  await addColumnIfMissing(client, "knowledge_retrieval_runs", "safety_review_latency_ms", "integer");
  await addColumnIfMissing(client, "knowledge_retrieval_runs", "flagged_chunk_count", "integer");
  await addColumnIfMissing(client, "knowledge_retrieval_runs", "excluded_for_safety_count", "integer");
  await addColumnIfMissing(client, "knowledge_retrieval_runs", "quality_confidence_band", "text");

  // ── 2. Extend knowledge_answer_runs (4 new nullable columns) ─────────────

  console.log("\n── Extending knowledge_answer_runs ──");
  await addColumnIfMissing(client, "knowledge_answer_runs", "retrieval_confidence_band", "text");
  await addColumnIfMissing(client, "knowledge_answer_runs", "retrieval_safety_status", "text");
  await addColumnIfMissing(client, "knowledge_answer_runs", "rewrite_strategy_used", "text");
  await addColumnIfMissing(client, "knowledge_answer_runs", "safety_flag_count", "integer");

  // ── 3. Create knowledge_retrieval_quality_signals (10 cols) ───────────────

  console.log("\n── Creating knowledge_retrieval_quality_signals ──");
  const tableExists = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='knowledge_retrieval_quality_signals'`,
  );

  if (tableExists.rowCount === 0) {
    await client.query(`
      CREATE TABLE public.knowledge_retrieval_quality_signals (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id text NOT NULL,
        retrieval_run_id varchar,
        confidence_band text,
        source_diversity_score numeric(6,4),
        document_diversity_score numeric(6,4),
        context_redundancy_score numeric(6,4),
        safety_status text,
        flagged_chunk_count integer,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    console.log("  + Table created: knowledge_retrieval_quality_signals");
  } else {
    console.log("  ✓ Table already exists: knowledge_retrieval_quality_signals");
  }

  // ── 4. Indexes for quality signals ────────────────────────────────────────

  console.log("\n── Creating indexes ──");
  await addIndexIfMissing(client, "krqs_tenant_run_idx",     "ON public.knowledge_retrieval_quality_signals (tenant_id, retrieval_run_id)");
  await addIndexIfMissing(client, "krqs_tenant_created_idx", "ON public.knowledge_retrieval_quality_signals (tenant_id, created_at)");

  // ── 5. RLS on quality signals table ──────────────────────────────────────

  console.log("\n── Enabling RLS on knowledge_retrieval_quality_signals ──");
  await client.query(`ALTER TABLE public.knowledge_retrieval_quality_signals ENABLE ROW LEVEL SECURITY`);
  console.log("  ✓ RLS enabled");

  const qsPolicies: Array<[string, string, string]> = [
    ["krqs_tenant_select", "SELECT", `USING (${RLS_POLICY})`],
    ["krqs_tenant_insert", "INSERT", `WITH CHECK (${RLS_POLICY})`],
    ["krqs_tenant_update", "UPDATE", `USING (${RLS_POLICY})`],
    ["krqs_tenant_delete", "DELETE", `USING (${RLS_POLICY})`],
  ];

  for (const [name, cmd, clause] of qsPolicies) {
    await addPolicyIfMissing(client, "knowledge_retrieval_quality_signals", name, cmd, clause);
  }

  // ── 6. Verify RLS table count = 100 ──────────────────────────────────────

  console.log("\n── Verification ──");
  const rlsTotal = await client.query(
    `SELECT COUNT(*) as cnt FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=true`,
  );
  const rlsCount = parseInt(rlsTotal.rows[0].cnt, 10);
  console.log(`✔ RLS-enabled tables: ${rlsCount} (expected 100)`);
  if (rlsCount !== 100) {
    throw new Error(`RLS table count mismatch: expected 100, got ${rlsCount}`);
  }

  // ── 7. Verify knowledge_retrieval_runs column count ───────────────────────

  const krrCols = await client.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_retrieval_runs'`,
  );
  const krrCount = parseInt(krrCols.rows[0].cnt, 10);
  console.log(`✔ knowledge_retrieval_runs columns: ${krrCount} (expected 28)`);
  if (krrCount !== 28) {
    throw new Error(`knowledge_retrieval_runs column count: expected 28, got ${krrCount}`);
  }

  // ── 8. Verify knowledge_answer_runs column count ──────────────────────────

  const karCols = await client.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_answer_runs'`,
  );
  const karCount = parseInt(karCols.rows[0].cnt, 10);
  console.log(`✔ knowledge_answer_runs columns: ${karCount} (expected 21)`);
  if (karCount !== 21) {
    throw new Error(`knowledge_answer_runs column count: expected 21, got ${karCount}`);
  }

  // ── 9. Verify knowledge_retrieval_quality_signals column count ────────────

  const krqsCols = await client.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_retrieval_quality_signals'`,
  );
  const krqsCount = parseInt(krqsCols.rows[0].cnt, 10);
  console.log(`✔ knowledge_retrieval_quality_signals columns: ${krqsCount} (expected 10)`);
  if (krqsCount !== 10) {
    throw new Error(`knowledge_retrieval_quality_signals column count: expected 10, got ${krqsCount}`);
  }

  // ── 10. Verify all indexes ─────────────────────────────────────────────────

  const expectedIndexes = ["krqs_tenant_run_idx", "krqs_tenant_created_idx"];
  for (const idx of expectedIndexes) {
    const iR = await client.query(`SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`, [idx]);
    if (!iR.rowCount) throw new Error(`Index MISSING: ${idx}`);
    console.log(`✔ Index present: ${idx}`);
  }

  // ── 11. Verify RLS policies ───────────────────────────────────────────────

  const expectedPolicies = ["krqs_tenant_select", "krqs_tenant_insert", "krqs_tenant_update", "krqs_tenant_delete"];
  for (const pol of expectedPolicies) {
    const pR = await client.query(
      `SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='knowledge_retrieval_quality_signals' AND policyname=$1`, [pol],
    );
    if (!pR.rowCount) throw new Error(`Policy MISSING: ${pol}`);
    console.log(`✔ Policy present: ${pol}`);
  }

  // ── 12. Verify specific new columns exist ─────────────────────────────────

  const krrNewCols = ["original_query_text", "normalized_query_text", "rewritten_query_text",
    "expansion_terms", "rewrite_strategy", "retrieval_safety_status",
    "query_rewrite_latency_ms", "query_expansion_count", "safety_review_latency_ms",
    "flagged_chunk_count", "excluded_for_safety_count", "quality_confidence_band"];

  for (const col of krrNewCols) {
    const cR = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_retrieval_runs' AND column_name=$1`, [col],
    );
    if (!cR.rowCount) throw new Error(`Column MISSING: knowledge_retrieval_runs.${col}`);
    console.log(`✔ Column present: knowledge_retrieval_runs.${col}`);
  }

  const karNewCols = ["retrieval_confidence_band", "retrieval_safety_status", "rewrite_strategy_used", "safety_flag_count"];
  for (const col of karNewCols) {
    const cR = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_answer_runs' AND column_name=$1`, [col],
    );
    if (!cR.rowCount) throw new Error(`Column MISSING: knowledge_answer_runs.${col}`);
    console.log(`✔ Column present: knowledge_answer_runs.${col}`);
  }

  await client.end();
  console.log("\n✔ Phase 5Q migration complete — all assertions passed");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("✗ Phase 5Q migration failed:", err.message);
  process.exit(1);
});
