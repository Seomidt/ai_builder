/**
 * migrate-phase5r.ts — Phase 5R
 *
 * Idempotent migration: Answer Safety, Hallucination Guard & Citation Coverage
 *
 * Changes:
 *   knowledge_answer_runs — +10 nullable columns (31 total)
 *     grounding_confidence_score, grounding_confidence_band, citation_coverage_ratio,
 *     supported_claim_count, partially_supported_claim_count, unsupported_claim_count,
 *     unverifiable_claim_count, answer_safety_status, answer_policy_result,
 *     answer_verification_latency_ms
 *
 * No new tables. No RLS changes. All additions nullable.
 */

import pg from "pg";

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

async function main(): Promise<void> {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  // ── 1. Extend knowledge_answer_runs (+10 nullable cols) ───────────────────

  console.log("\n── Extending knowledge_answer_runs (+10 Phase 5R columns) ──");
  await addColumnIfMissing(client, "knowledge_answer_runs", "grounding_confidence_score", "numeric(10,6)");
  await addColumnIfMissing(client, "knowledge_answer_runs", "grounding_confidence_band", "text");
  await addColumnIfMissing(client, "knowledge_answer_runs", "citation_coverage_ratio", "numeric(10,6)");
  await addColumnIfMissing(client, "knowledge_answer_runs", "supported_claim_count", "integer");
  await addColumnIfMissing(client, "knowledge_answer_runs", "partially_supported_claim_count", "integer");
  await addColumnIfMissing(client, "knowledge_answer_runs", "unsupported_claim_count", "integer");
  await addColumnIfMissing(client, "knowledge_answer_runs", "unverifiable_claim_count", "integer");
  await addColumnIfMissing(client, "knowledge_answer_runs", "answer_safety_status", "text");
  await addColumnIfMissing(client, "knowledge_answer_runs", "answer_policy_result", "text");
  await addColumnIfMissing(client, "knowledge_answer_runs", "answer_verification_latency_ms", "integer");

  // ── 2. Verify column count ────────────────────────────────────────────────

  console.log("\n── Verification ──");
  const karCols = await client.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_answer_runs'`,
  );
  const karCount = parseInt(karCols.rows[0].cnt, 10);
  console.log(`✔ knowledge_answer_runs columns: ${karCount} (expected 31)`);
  if (karCount !== 31) {
    throw new Error(`knowledge_answer_runs column count: expected 31, got ${karCount}`);
  }

  // ── 3. Verify all 10 new columns ─────────────────────────────────────────

  const newCols = [
    "grounding_confidence_score", "grounding_confidence_band", "citation_coverage_ratio",
    "supported_claim_count", "partially_supported_claim_count", "unsupported_claim_count",
    "unverifiable_claim_count", "answer_safety_status", "answer_policy_result",
    "answer_verification_latency_ms",
  ];
  for (const col of newCols) {
    const r = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_answer_runs' AND column_name=$1`, [col],
    );
    if (!r.rowCount) throw new Error(`Column MISSING: knowledge_answer_runs.${col}`);
    console.log(`  ✔ Column present: knowledge_answer_runs.${col}`);
  }

  // ── 4. Verify existing tables still intact ────────────────────────────────

  const tableChecks: Array<[string, number]> = [
    ["knowledge_retrieval_runs", 28],
    ["knowledge_retrieval_quality_signals", 10],
    ["knowledge_answer_citations", 12],
  ];
  for (const [table, expectedCols] of tableChecks) {
    const r = await client.query(
      `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table],
    );
    const cnt = parseInt(r.rows[0].cnt, 10);
    if (cnt !== expectedCols) throw new Error(`${table}: expected ${expectedCols} cols, got ${cnt}`);
    console.log(`  ✔ ${table} still has ${expectedCols} columns`);
  }

  // ── 5. Verify RLS count unchanged at 100 ─────────────────────────────────

  const rlsTotal = await client.query(
    `SELECT COUNT(*) as cnt FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=true`,
  );
  const rlsCount = parseInt(rlsTotal.rows[0].cnt, 10);
  console.log(`✔ RLS-enabled tables: ${rlsCount} (expected 100, unchanged)`);
  if (rlsCount !== 100) throw new Error(`RLS count changed unexpectedly: expected 100, got ${rlsCount}`);

  await client.end();
  console.log("\n✔ Phase 5R migration complete — all assertions passed");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("✗ Phase 5R migration failed:", err.message);
  process.exit(1);
});
