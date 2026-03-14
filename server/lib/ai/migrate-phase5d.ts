/**
 * migrate-phase5d.ts — Phase 5D: Vector Search Engine
 *
 * Adds:
 *   1. knowledge_embeddings.is_active (boolean not null default true)
 *   2. knowledge_embeddings.similarity_metric (text null, CHECK IN cosine/l2/inner_product)
 *   3. knowledge_embeddings index: ke_tenant_is_active_idx
 *   4. knowledge_embeddings constraint: ke_similarity_metric_check
 *   5. knowledge_search_runs table (observability log for vector searches)
 *   6. knowledge_search_candidates table (ranked candidate log per search run)
 *
 * Run: npx tsx server/lib/ai/migrate-phase5d.ts
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";

async function migrate() {
  console.log("=== Phase 5D Migration: Vector Search Engine ===\n");

  // 1. knowledge_embeddings.is_active
  console.log("Step 1: Adding is_active column to knowledge_embeddings...");
  try {
    await db.execute(sql`
      ALTER TABLE knowledge_embeddings
        ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true
    `);
    console.log("  ✓ is_active added\n");
  } catch (e) {
    console.log("  ⚠ is_active:", (e as Error).message, "\n");
  }

  // 2. knowledge_embeddings.similarity_metric
  console.log("Step 2: Adding similarity_metric column to knowledge_embeddings...");
  try {
    await db.execute(sql`
      ALTER TABLE knowledge_embeddings
        ADD COLUMN IF NOT EXISTS similarity_metric text
    `);
    console.log("  ✓ similarity_metric added\n");
  } catch (e) {
    console.log("  ⚠ similarity_metric:", (e as Error).message, "\n");
  }

  // 3. similarity_metric CHECK constraint
  console.log("Step 3: Adding ke_similarity_metric_check constraint...");
  try {
    await db.execute(sql`
      ALTER TABLE knowledge_embeddings
        ADD CONSTRAINT ke_similarity_metric_check
        CHECK (similarity_metric IS NULL OR similarity_metric IN ('cosine','l2','inner_product'))
    `);
    console.log("  ✓ ke_similarity_metric_check added\n");
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("already exists")) {
      console.log("  ✓ ke_similarity_metric_check already exists\n");
    } else {
      console.log("  ⚠ ke_similarity_metric_check:", msg, "\n");
    }
  }

  // 4. index on (tenant_id, is_active, embedding_status)
  console.log("Step 4: Adding ke_tenant_is_active_idx index...");
  try {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ke_tenant_is_active_idx
        ON knowledge_embeddings (tenant_id, is_active, embedding_status)
    `);
    console.log("  ✓ ke_tenant_is_active_idx added\n");
  } catch (e) {
    console.log("  ⚠ ke_tenant_is_active_idx:", (e as Error).message, "\n");
  }

  // 5. knowledge_search_runs table
  console.log("Step 5: Creating knowledge_search_runs table...");
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS knowledge_search_runs (
        id                varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         varchar NOT NULL,
        knowledge_base_id varchar NOT NULL REFERENCES knowledge_bases(id),
        query_hash        text NOT NULL,
        embedding_model   text,
        top_k_requested   integer NOT NULL,
        top_k_returned    integer NOT NULL,
        filter_summary    jsonb,
        search_duration_ms integer,
        created_at        timestamp NOT NULL DEFAULT now(),
        CONSTRAINT ksr_top_k_requested_check CHECK (top_k_requested > 0),
        CONSTRAINT ksr_top_k_returned_check CHECK (top_k_returned >= 0)
      )
    `);
    console.log("  ✓ knowledge_search_runs created\n");
  } catch (e) {
    console.log("  ⚠ knowledge_search_runs:", (e as Error).message, "\n");
  }

  // 6. Indexes for knowledge_search_runs
  console.log("Step 6: Adding indexes for knowledge_search_runs...");
  try {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ksr_tenant_kb_idx
        ON knowledge_search_runs (tenant_id, knowledge_base_id, created_at)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ksr_tenant_created_idx
        ON knowledge_search_runs (tenant_id, created_at)
    `);
    console.log("  ✓ ksr indexes added\n");
  } catch (e) {
    console.log("  ⚠ ksr indexes:", (e as Error).message, "\n");
  }

  // 7. knowledge_search_candidates table
  console.log("Step 7: Creating knowledge_search_candidates table...");
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS knowledge_search_candidates (
        id                             varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        knowledge_search_run_id        varchar NOT NULL REFERENCES knowledge_search_runs(id),
        knowledge_chunk_id             varchar NOT NULL REFERENCES knowledge_chunks(id),
        knowledge_document_id          varchar NOT NULL REFERENCES knowledge_documents(id),
        knowledge_document_version_id  varchar NOT NULL REFERENCES knowledge_document_versions(id),
        tenant_id                      varchar NOT NULL,
        rank                           integer NOT NULL,
        similarity_score               double precision NOT NULL,
        created_at                     timestamp NOT NULL DEFAULT now(),
        CONSTRAINT ksc_rank_check CHECK (rank > 0)
      )
    `);
    console.log("  ✓ knowledge_search_candidates created\n");
  } catch (e) {
    console.log("  ⚠ knowledge_search_candidates:", (e as Error).message, "\n");
  }

  // 8. Indexes for knowledge_search_candidates
  console.log("Step 8: Adding indexes for knowledge_search_candidates...");
  try {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ksc_run_idx
        ON knowledge_search_candidates (knowledge_search_run_id, rank)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS ksc_tenant_chunk_idx
        ON knowledge_search_candidates (tenant_id, knowledge_chunk_id)
    `);
    console.log("  ✓ ksc indexes added\n");
  } catch (e) {
    console.log("  ⚠ ksc indexes:", (e as Error).message, "\n");
  }

  // ─── Verification ─────────────────────────────────────────────────────────

  console.log("=== Verification ===\n");

  const keColsResult = await db.execute(sql`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'knowledge_embeddings'
      AND column_name IN ('is_active', 'similarity_metric')
    ORDER BY column_name
  `);
  const keCols = (keColsResult.rows as { column_name: string }[]).map((r) => r.column_name);
  console.log("knowledge_embeddings new cols:", keCols);
  if (keCols.includes("is_active") && keCols.includes("similarity_metric")) {
    console.log("  ✓ ke columns (2/2)\n");
  } else {
    console.log("  ✗ MISSING ke columns!\n");
  }

  const tablesResult = await db.execute(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('knowledge_search_runs', 'knowledge_search_candidates')
    ORDER BY table_name
  `);
  const tables = (tablesResult.rows as { table_name: string }[]).map((r) => r.table_name);
  console.log("New tables:", tables);
  if (tables.includes("knowledge_search_runs") && tables.includes("knowledge_search_candidates")) {
    console.log("  ✓ search tables (2/2)\n");
  } else {
    console.log("  ✗ MISSING tables!\n");
  }

  const idxResult = await db.execute(sql`
    SELECT indexname
    FROM pg_indexes
    WHERE tablename IN ('knowledge_embeddings', 'knowledge_search_runs', 'knowledge_search_candidates')
      AND indexname IN ('ke_tenant_is_active_idx', 'ksr_tenant_kb_idx', 'ksc_run_idx')
    ORDER BY indexname
  `);
  const indexes = (idxResult.rows as { indexname: string }[]).map((r) => r.indexname);
  console.log("New indexes:", indexes);
  if (indexes.length === 3) {
    console.log("  ✓ indexes (3/3)\n");
  } else {
    console.log("  ⚠ expected 3 indexes, got", indexes.length, "\n");
  }

  const pgvectorResult = await db.execute(sql`
    SELECT extname FROM pg_extension WHERE extname = 'vector'
  `);
  const pgvector = (pgvectorResult.rows as { extname: string }[]).map((r) => r.extname);
  console.log("pgvector extension:", pgvector.length > 0 ? "enabled ✓" : "NOT FOUND ✗");

  console.log("\n=== Phase 5D Migration Complete ===");
}

migrate().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
