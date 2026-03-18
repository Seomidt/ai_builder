/**
 * migrate-phase5n.ts — Phase 5N DB Migration
 *
 * Applies:
 * 1. Add searchable_text_tsv generated tsvector column to knowledge_chunks
 * 2. GIN index on searchable_text_tsv for efficient FTS (INV-HYB2)
 * 3. Supporting tenant-safe FTS index on knowledge_chunks
 * 4. Add 9 hybrid fields to knowledge_retrieval_candidates
 * 5. channel_origin CHECK constraint on knowledge_retrieval_candidates
 * 6. Index on (tenant_id, channel_origin) for hybrid summary queries
 *
 * Idempotent: all DDL wrapped in IF NOT EXISTS / DO blocks.
 */

import pg from "pg";

async function main() {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("Phase 5N migration: connected");

  try {
    // ── Step 1: Add searchable_text_tsv generated column to knowledge_chunks ──────
    console.log("Step 1: Adding searchable_text_tsv to knowledge_chunks...");

    const hasCol = await client.query(`
      SELECT COUNT(*) as cnt FROM information_schema.columns
      WHERE table_schema='public' AND table_name='knowledge_chunks'
        AND column_name='searchable_text_tsv'
    `);
    if (parseInt(hasCol.rows[0].cnt) === 0) {
      await client.query(`
        ALTER TABLE knowledge_chunks
          ADD COLUMN searchable_text_tsv tsvector
          GENERATED ALWAYS AS (to_tsvector('simple', coalesce(chunk_text, ''))) STORED
      `);
      console.log("  searchable_text_tsv: column added (generated stored tsvector)");
    } else {
      console.log("  searchable_text_tsv: already exists, skipped");
    }

    // ── Step 2: GIN index for FTS ──────────────────────────────────────────────
    console.log("Step 2: Adding GIN index on searchable_text_tsv...");
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_kchk_searchable_tsv
        ON knowledge_chunks USING GIN(searchable_text_tsv)
    `);
    console.log("  idx_kchk_searchable_tsv: GIN index created");

    // ── Step 3: Supporting FTS safety index (tenant + kb + chunk_active) ─────────
    console.log("Step 3: Adding tenant-scoped FTS composite index...");
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_kchk_fts_tenant_kb
        ON knowledge_chunks(tenant_id, knowledge_base_id, chunk_active)
        WHERE chunk_active = true
    `);
    console.log("  idx_kchk_fts_tenant_kb: composite safety index created");

    // ── Step 4: Add 9 hybrid fields to knowledge_retrieval_candidates ─────────────
    console.log("Step 4: Adding hybrid fields to knowledge_retrieval_candidates...");

    const hybridFields: Array<{ col: string; def: string }> = [
      { col: "channel_origin",          def: "text" },
      { col: "vector_score",            def: "numeric(10,8)" },
      { col: "lexical_score",           def: "numeric(10,8)" },
      { col: "fused_score",             def: "numeric(10,8)" },
      { col: "rerank_score",            def: "numeric(10,8)" },
      { col: "pre_fusion_rank_vector",  def: "integer" },
      { col: "pre_fusion_rank_lexical", def: "integer" },
      { col: "pre_rerank_rank",         def: "integer" },
      { col: "post_rerank_rank",        def: "integer" },
    ];

    for (const field of hybridFields) {
      const exists = await client.query(`
        SELECT COUNT(*) as cnt FROM information_schema.columns
        WHERE table_schema='public' AND table_name='knowledge_retrieval_candidates'
          AND column_name=$1
      `, [field.col]);
      if (parseInt(exists.rows[0].cnt) === 0) {
        await client.query(`
          ALTER TABLE knowledge_retrieval_candidates ADD COLUMN ${field.col} ${field.def}
        `);
        console.log(`  ${field.col}: added`);
      } else {
        console.log(`  ${field.col}: already exists, skipped`);
      }
    }

    // ── Step 5: Add channel_origin CHECK constraint ───────────────────────────────
    console.log("Step 5: Adding channel_origin CHECK constraint...");
    const hasConstraint = await client.query(`
      SELECT COUNT(*) as cnt FROM pg_constraint
      WHERE conname = 'krc_channel_origin_check'
        AND conrelid = 'knowledge_retrieval_candidates'::regclass
    `);
    if (parseInt(hasConstraint.rows[0].cnt) === 0) {
      await client.query(`
        ALTER TABLE knowledge_retrieval_candidates
          ADD CONSTRAINT krc_channel_origin_check
          CHECK (channel_origin IS NULL OR channel_origin IN ('vector_only','lexical_only','vector_and_lexical'))
      `);
      console.log("  krc_channel_origin_check: constraint added");
    } else {
      console.log("  krc_channel_origin_check: already exists");
    }

    // ── Step 6: Add channel_origin index ─────────────────────────────────────────
    console.log("Step 6: Adding channel_origin index...");
    await client.query(`
      CREATE INDEX IF NOT EXISTS krc_tenant_channel_idx
        ON knowledge_retrieval_candidates(tenant_id, channel_origin)
    `);
    console.log("  krc_tenant_channel_idx: index created");

    // ── Step 7: Verification ──────────────────────────────────────────────────────
    console.log("Step 7: Verifying migration...");

    // Verify searchable_text_tsv exists
    const tsv = await client.query(`
      SELECT COUNT(*) as cnt FROM information_schema.columns
      WHERE table_schema='public' AND table_name='knowledge_chunks'
        AND column_name='searchable_text_tsv'
    `);
    console.assert(parseInt(tsv.rows[0].cnt) === 1, "FAIL: searchable_text_tsv not found");
    console.log("  searchable_text_tsv: present");

    // Verify GIN index
    const ginIdx = await client.query(`
      SELECT COUNT(*) as cnt FROM pg_indexes
      WHERE schemaname='public' AND tablename='knowledge_chunks'
        AND indexname='idx_kchk_searchable_tsv'
    `);
    console.assert(parseInt(ginIdx.rows[0].cnt) === 1, "FAIL: GIN index missing");
    console.log("  GIN index: present");

    // Verify hybrid fields exist
    const hybridCols = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='knowledge_retrieval_candidates'
        AND column_name IN ('channel_origin','vector_score','lexical_score','fused_score',
          'rerank_score','pre_fusion_rank_vector','pre_fusion_rank_lexical',
          'pre_rerank_rank','post_rerank_rank')
      ORDER BY column_name
    `);
    console.log(`  Hybrid fields: ${hybridCols.rows.length}/9`);
    console.assert(hybridCols.rows.length === 9, `FAIL: expected 9 hybrid fields, got ${hybridCols.rows.length}`);

    // Verify channel_origin constraint
    const chConstraint = await client.query(`
      SELECT COUNT(*) as cnt FROM pg_constraint
      WHERE conname='krc_channel_origin_check'
    `);
    console.assert(parseInt(chConstraint.rows[0].cnt) === 1, "FAIL: channel_origin constraint missing");
    console.log("  channel_origin CHECK: present");

    // Total knowledge_retrieval_candidates columns
    const totalCols = await client.query(`
      SELECT COUNT(*) as cnt FROM information_schema.columns
      WHERE table_schema='public' AND table_name='knowledge_retrieval_candidates'
    `);
    console.log(`  Total knowledge_retrieval_candidates columns: ${totalCols.rows[0].cnt} (expected: 28)`);
    console.assert(parseInt(totalCols.rows[0].cnt) === 28, `FAIL: expected 28 columns, got ${totalCols.rows[0].cnt}`);

    // Verify FTS works
    const ftsTest = await client.query(`
      SELECT websearch_to_tsquery('simple', 'test query') IS NOT NULL AS ok
    `);
    console.assert(ftsTest.rows[0].ok === true, "FAIL: websearch_to_tsquery not available");
    console.log("  FTS (websearch_to_tsquery): available");

    // Total RLS tables (unchanged)
    const rls = await client.query(`
      SELECT COUNT(*) as cnt FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=true
    `);
    console.log(`  RLS tables: ${rls.rows[0].cnt} (expected: 97, unchanged)`);
    console.assert(parseInt(rls.rows[0].cnt) === 97, "FAIL: RLS table count changed");

    console.log("\nPhase 5N migration: COMPLETE");
  } finally {
    await client.end();
  }
}

main().then(() => process.exit(0)).catch((e: unknown) => {
  console.error("Migration failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
