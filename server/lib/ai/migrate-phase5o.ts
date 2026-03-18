/**
 * migrate-phase5o.ts — Phase 5O
 *
 * Idempotent migration: Advanced Reranking Layer
 *
 * Adds 9 new columns to knowledge_retrieval_candidates:
 *   heavy_rerank_score  numeric(10,8)
 *   final_score         numeric(10,8)
 *   rerank_mode         text CHECK IN ('lightweight','advanced','fallback')
 *   fallback_used       boolean DEFAULT false
 *   fallback_reason     text
 *   shortlist_rank      integer
 *   advanced_rerank_rank integer
 *   rerank_provider_name text
 *   rerank_provider_version text
 *
 * Adds CHECK constraint: krc_rerank_mode_check
 * Adds 4 indexes: krc_tenant_rerank_mode_idx, krc_tenant_fallback_idx,
 *                 krc_tenant_shortlist_rank_idx, krc_tenant_adv_rerank_rank_idx
 *
 * All operations idempotent (IF NOT EXISTS / IF EXISTS guards).
 * RLS table count must remain 97 — no new tables created.
 */

import pg from "pg";

async function main() {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  // ── 1. New columns on knowledge_retrieval_candidates ─────────────────────

  const newColumns: Array<[string, string]> = [
    ["heavy_rerank_score",   "numeric(10,8)"],
    ["final_score",          "numeric(10,8)"],
    ["rerank_mode",          "text"],
    ["fallback_used",        "boolean DEFAULT false"],
    ["fallback_reason",      "text"],
    ["shortlist_rank",       "integer"],
    ["advanced_rerank_rank", "integer"],
    ["rerank_provider_name", "text"],
    ["rerank_provider_version", "text"],
  ];

  for (const [col, typeDef] of newColumns) {
    const exists = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema='public'
         AND table_name='knowledge_retrieval_candidates'
         AND column_name=$1`,
      [col],
    );
    if (exists.rowCount === 0) {
      await client.query(
        `ALTER TABLE public.knowledge_retrieval_candidates ADD COLUMN ${col} ${typeDef}`,
      );
      console.log(`  + Column added: ${col} ${typeDef}`);
    } else {
      console.log(`  ✓ Column already exists: ${col}`);
    }
  }

  // ── 2. CHECK constraint for rerank_mode ──────────────────────────────────

  const constraintName = "krc_rerank_mode_check";
  const constraintExists = await client.query(
    `SELECT 1 FROM pg_constraint
     WHERE conname=$1
       AND conrelid='public.knowledge_retrieval_candidates'::regclass`,
    [constraintName],
  );
  if (constraintExists.rowCount === 0) {
    await client.query(
      `ALTER TABLE public.knowledge_retrieval_candidates
       ADD CONSTRAINT ${constraintName}
       CHECK (rerank_mode IS NULL OR rerank_mode IN ('lightweight','advanced','fallback'))`,
    );
    console.log(`  + Constraint added: ${constraintName}`);
  } else {
    console.log(`  ✓ Constraint already exists: ${constraintName}`);
  }

  // ── 3. Indexes ────────────────────────────────────────────────────────────

  const indexes: Array<[string, string]> = [
    ["krc_tenant_rerank_mode_idx",    "ON public.knowledge_retrieval_candidates (tenant_id, rerank_mode)"],
    ["krc_tenant_fallback_idx",       "ON public.knowledge_retrieval_candidates (tenant_id, fallback_used)"],
    ["krc_tenant_shortlist_rank_idx", "ON public.knowledge_retrieval_candidates (tenant_id, shortlist_rank)"],
    ["krc_tenant_adv_rerank_rank_idx","ON public.knowledge_retrieval_candidates (tenant_id, advanced_rerank_rank)"],
  ];

  for (const [idxName, idxDef] of indexes) {
    const idxExists = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`,
      [idxName],
    );
    if (idxExists.rowCount === 0) {
      await client.query(`CREATE INDEX ${idxName} ${idxDef}`);
      console.log(`  + Index created: ${idxName}`);
    } else {
      console.log(`  ✓ Index already exists: ${idxName}`);
    }
  }

  // ── 4. Verify RLS tables count unchanged ─────────────────────────────────

  const rlsCount = await client.query(
    `SELECT COUNT(*) as cnt FROM pg_class c
     JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=true`,
  );
  const rls = parseInt(rlsCount.rows[0].cnt, 10);
  console.log(`\n✔ RLS-enabled tables: ${rls} (expected 97)`);
  if (rls !== 97) {
    throw new Error(`RLS table count mismatch: expected 97, got ${rls}`);
  }

  // ── 5. Verify final column count ─────────────────────────────────────────

  const colCount = await client.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns
     WHERE table_schema='public'
       AND table_name='knowledge_retrieval_candidates'`,
  );
  const cols = parseInt(colCount.rows[0].cnt, 10);
  console.log(`✔ knowledge_retrieval_candidates columns: ${cols} (expected 37)`);
  if (cols !== 37) {
    throw new Error(`Column count mismatch: expected 37, got ${cols}`);
  }

  // ── 6. Verify constraint ──────────────────────────────────────────────────

  const cVerify = await client.query(
    `SELECT 1 FROM pg_constraint
     WHERE conname='krc_rerank_mode_check'
       AND conrelid='public.knowledge_retrieval_candidates'::regclass`,
  );
  if (!cVerify.rowCount) throw new Error("krc_rerank_mode_check constraint MISSING");
  console.log("✔ krc_rerank_mode_check constraint present");

  // ── 7. Verify indexes ─────────────────────────────────────────────────────

  const expectedIndexes = [
    "krc_tenant_rerank_mode_idx",
    "krc_tenant_fallback_idx",
    "krc_tenant_shortlist_rank_idx",
    "krc_tenant_adv_rerank_rank_idx",
  ];
  for (const idx of expectedIndexes) {
    const iVerify = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`,
      [idx],
    );
    if (!iVerify.rowCount) throw new Error(`Index MISSING: ${idx}`);
    console.log(`✔ Index present: ${idx}`);
  }

  await client.end();
  console.log("\n✔ Phase 5O migration complete — all assertions passed");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("✗ Phase 5O migration failed:", err.message);
  process.exit(1);
});
