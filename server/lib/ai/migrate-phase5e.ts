/**
 * migrate-phase5e.ts — Phase 5E: Retrieval Orchestration Layer
 *
 * Adds:
 *   1. knowledge_retrieval_runs table (observability log for retrieval runs)
 *
 * Run: npx tsx server/lib/ai/migrate-phase5e.ts
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";

async function migrate() {
  console.log("=== Phase 5E Migration: Retrieval Orchestration Layer ===\n");

  // 1. knowledge_retrieval_runs table
  console.log("Step 1: Creating knowledge_retrieval_runs table...");
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS knowledge_retrieval_runs (
        id                      varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id               varchar NOT NULL,
        knowledge_base_id       varchar NOT NULL REFERENCES knowledge_bases(id),
        query_hash              text NOT NULL,
        embedding_model         text,
        candidates_found        integer NOT NULL DEFAULT 0,
        candidates_ranked       integer NOT NULL DEFAULT 0,
        chunks_selected         integer NOT NULL DEFAULT 0,
        chunks_skipped_duplicate integer NOT NULL DEFAULT 0,
        chunks_skipped_budget   integer NOT NULL DEFAULT 0,
        context_tokens_used     integer NOT NULL DEFAULT 0,
        max_context_tokens      integer NOT NULL,
        document_count          integer NOT NULL DEFAULT 0,
        created_at              timestamp NOT NULL DEFAULT now(),
        CONSTRAINT krr_max_context_check CHECK (max_context_tokens > 0)
      )
    `);
    console.log("  ✓ knowledge_retrieval_runs created\n");
  } catch (e) {
    console.log("  ⚠ knowledge_retrieval_runs:", (e as Error).message, "\n");
  }

  // 2. Indexes
  console.log("Step 2: Adding indexes for knowledge_retrieval_runs...");
  try {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS krr_tenant_kb_idx
        ON knowledge_retrieval_runs (tenant_id, knowledge_base_id, created_at)
    `);
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS krr_tenant_created_idx
        ON knowledge_retrieval_runs (tenant_id, created_at)
    `);
    console.log("  ✓ krr indexes added\n");
  } catch (e) {
    console.log("  ⚠ krr indexes:", (e as Error).message, "\n");
  }

  // ─── Verification ──────────────────────────────────────────────────────────

  console.log("=== Verification ===\n");

  const tableRes = await db.execute(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'knowledge_retrieval_runs'
  `);
  const tableFound = (tableRes.rows as { table_name: string }[]).length > 0;
  console.log("knowledge_retrieval_runs:", tableFound ? "✓ present" : "✗ MISSING");

  const colsRes = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_retrieval_runs'
    ORDER BY ordinal_position
  `);
  const cols = (colsRes.rows as { column_name: string }[]).map((r) => r.column_name);
  console.log("Columns:", cols);

  const idxRes = await db.execute(sql`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'knowledge_retrieval_runs'
    ORDER BY indexname
  `);
  const indexes = (idxRes.rows as { indexname: string }[]).map((r) => r.indexname);
  console.log("Indexes:", indexes);

  const constraintRes = await db.execute(sql`
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_name = 'knowledge_retrieval_runs'
      AND constraint_name = 'krr_max_context_check'
  `);
  const constraintFound = (constraintRes.rows as { constraint_name: string }[]).length > 0;
  console.log("krr_max_context_check constraint:", constraintFound ? "✓ present" : "✗ MISSING");

  const pgvectorRes = await db.execute(sql`SELECT extname FROM pg_extension WHERE extname = 'vector'`);
  console.log("pgvector:", (pgvectorRes.rows as { extname: string }[]).length > 0 ? "✓ enabled" : "✗ NOT FOUND");

  console.log("\n=== Phase 5E Migration Complete ===");
}

migrate().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
