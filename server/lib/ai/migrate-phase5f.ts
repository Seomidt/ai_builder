/**
 * migrate-phase5f.ts — Phase 5F: Retrieval Quality, Cache & Trust Signals
 *
 * Adds:
 *   1. knowledge_embeddings.embedding_version (nullable text)
 *   2. knowledge_retrieval_runs.embedding_version + retrieval_version (nullable text)
 *   3. retrieval_metrics table (quality telemetry per run)
 *   4. retrieval_cache_entries table (tenant+KB-scoped cache)
 *   5. document_trust_signals table (probabilistic trust signals, append-only)
 *   6. document_risk_scores table (derived risk scores)
 *
 * Run: npx tsx server/lib/ai/migrate-phase5f.ts
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";

async function migrate() {
  console.log("=== Phase 5F Migration: Retrieval Quality, Cache & Trust Signals ===\n");

  // ─── 1. knowledge_embeddings.embedding_version ──────────────────────────────
  console.log("Step 1: Adding embedding_version to knowledge_embeddings...");
  try {
    await db.execute(sql`
      ALTER TABLE knowledge_embeddings
        ADD COLUMN IF NOT EXISTS embedding_version text
    `);
    console.log("  ✓ knowledge_embeddings.embedding_version added\n");
  } catch (e) {
    console.log("  ⚠", (e as Error).message, "\n");
  }

  // ─── 2. knowledge_retrieval_runs: embedding_version + retrieval_version ──────
  console.log("Step 2: Adding version columns to knowledge_retrieval_runs...");
  try {
    await db.execute(sql`
      ALTER TABLE knowledge_retrieval_runs
        ADD COLUMN IF NOT EXISTS embedding_version text,
        ADD COLUMN IF NOT EXISTS retrieval_version text
    `);
    console.log("  ✓ knowledge_retrieval_runs version columns added\n");
  } catch (e) {
    console.log("  ⚠", (e as Error).message, "\n");
  }

  // ─── 3. retrieval_metrics ────────────────────────────────────────────────────
  console.log("Step 3: Creating retrieval_metrics table...");
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS retrieval_metrics (
        id                   varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        retrieval_run_id     varchar NOT NULL REFERENCES knowledge_retrieval_runs(id),
        tenant_id            varchar NOT NULL,
        knowledge_base_id    varchar NOT NULL,
        chunk_count          integer NOT NULL,
        unique_document_count integer NOT NULL,
        token_used           integer NOT NULL,
        token_budget         integer NOT NULL,
        dedup_removed_count  integer NOT NULL DEFAULT 0,
        avg_similarity       numeric(10,6),
        top_similarity       numeric(10,6),
        lowest_similarity    numeric(10,6),
        diversity_score      numeric(10,4),
        created_at           timestamp NOT NULL DEFAULT now(),
        CONSTRAINT rm_chunk_count_check CHECK (chunk_count >= 0),
        CONSTRAINT rm_unique_doc_count_check CHECK (unique_document_count >= 0),
        CONSTRAINT rm_token_used_check CHECK (token_used >= 0),
        CONSTRAINT rm_token_budget_check CHECK (token_budget > 0),
        CONSTRAINT rm_dedup_removed_check CHECK (dedup_removed_count >= 0)
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS rm_run_id_idx ON retrieval_metrics (retrieval_run_id)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS rm_tenant_kb_idx ON retrieval_metrics (tenant_id, knowledge_base_id, created_at)`);
    console.log("  ✓ retrieval_metrics created\n");
  } catch (e) {
    console.log("  ⚠ retrieval_metrics:", (e as Error).message, "\n");
  }

  // ─── 4. retrieval_cache_entries ──────────────────────────────────────────────
  console.log("Step 4: Creating retrieval_cache_entries table...");
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS retrieval_cache_entries (
        id                varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id         varchar NOT NULL,
        knowledge_base_id varchar NOT NULL,
        query_hash        text NOT NULL,
        query_text        text NOT NULL,
        embedding_version text,
        retrieval_version text NOT NULL,
        cache_status      text NOT NULL DEFAULT 'active',
        result_chunk_ids  jsonb NOT NULL,
        result_summary    jsonb,
        expires_at        timestamp NOT NULL,
        created_at        timestamp NOT NULL DEFAULT now(),
        updated_at        timestamp NOT NULL DEFAULT now(),
        CONSTRAINT rce_cache_status_check CHECK (cache_status IN ('active','expired','invalidated'))
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS rce_tenant_kb_hash_idx ON retrieval_cache_entries (tenant_id, knowledge_base_id, query_hash)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS rce_status_expires_idx ON retrieval_cache_entries (cache_status, expires_at)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS rce_tenant_kb_status_idx ON retrieval_cache_entries (tenant_id, knowledge_base_id, cache_status)`);
    console.log("  ✓ retrieval_cache_entries created\n");
  } catch (e) {
    console.log("  ⚠ retrieval_cache_entries:", (e as Error).message, "\n");
  }

  // ─── 5. document_trust_signals ───────────────────────────────────────────────
  console.log("Step 5: Creating document_trust_signals table...");
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS document_trust_signals (
        id                    varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id             varchar NOT NULL,
        document_id           varchar NOT NULL,
        document_version_id   varchar,
        signal_type           text NOT NULL,
        signal_source         text NOT NULL,
        confidence_score      numeric(5,4) NOT NULL,
        raw_evidence          jsonb,
        created_at            timestamp NOT NULL DEFAULT now()
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS dts_tenant_doc_idx ON document_trust_signals (tenant_id, document_id, created_at)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS dts_tenant_signal_type_idx ON document_trust_signals (tenant_id, signal_type, created_at)`);
    console.log("  ✓ document_trust_signals created\n");
  } catch (e) {
    console.log("  ⚠ document_trust_signals:", (e as Error).message, "\n");
  }

  // ─── 6. document_risk_scores ─────────────────────────────────────────────────
  console.log("Step 6: Creating document_risk_scores table...");
  try {
    await db.execute(sql`
      CREATE TABLE IF NOT EXISTS document_risk_scores (
        id                    varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id             varchar NOT NULL,
        document_id           varchar NOT NULL,
        document_version_id   varchar,
        risk_level            text NOT NULL,
        risk_score            numeric(5,4) NOT NULL,
        scoring_version       text NOT NULL,
        contributing_signals  jsonb NOT NULL,
        created_at            timestamp NOT NULL DEFAULT now(),
        CONSTRAINT drs_risk_level_check CHECK (risk_level IN ('low_risk','medium_risk','high_risk','unknown'))
      )
    `);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS drs_tenant_doc_idx ON document_risk_scores (tenant_id, document_id, created_at)`);
    await db.execute(sql`CREATE INDEX IF NOT EXISTS drs_tenant_risk_idx ON document_risk_scores (tenant_id, risk_level, created_at)`);
    console.log("  ✓ document_risk_scores created\n");
  } catch (e) {
    console.log("  ⚠ document_risk_scores:", (e as Error).message, "\n");
  }

  // ─── Verification ─────────────────────────────────────────────────────────────
  console.log("=== Verification ===\n");

  const tables = [
    "retrieval_metrics",
    "retrieval_cache_entries",
    "document_trust_signals",
    "document_risk_scores",
  ];

  for (const table of tables) {
    const res = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ${table}
    `);
    const found = (res.rows as { table_name: string }[]).length > 0;
    console.log(`${table}: ${found ? "✓ present" : "✗ MISSING"}`);
  }

  const embVerRes = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_embeddings' AND column_name = 'embedding_version'
  `);
  console.log("knowledge_embeddings.embedding_version:", (embVerRes.rows as { column_name: string }[]).length > 0 ? "✓" : "✗");

  const krrRes = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_retrieval_runs' AND column_name IN ('embedding_version','retrieval_version')
    ORDER BY column_name
  `);
  const krrCols = (krrRes.rows as { column_name: string }[]).map((r) => r.column_name);
  console.log("knowledge_retrieval_runs new cols:", krrCols.length === 2 ? `✓ [${krrCols.join(", ")}]` : `✗ found: ${krrCols.join(", ")}`);

  // Index verification
  const idxRes = await db.execute(sql`
    SELECT tablename, indexname FROM pg_indexes
    WHERE tablename IN ('retrieval_metrics','retrieval_cache_entries','document_trust_signals','document_risk_scores')
    ORDER BY tablename, indexname
  `);
  const indexes = (idxRes.rows as { tablename: string; indexname: string }[]);
  console.log("\nIndexes:");
  for (const idx of indexes) {
    console.log(`  ${idx.tablename}: ${idx.indexname}`);
  }

  // Constraint verification
  const constraintRes = await db.execute(sql`
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_name IN ('retrieval_metrics','retrieval_cache_entries','document_risk_scores')
      AND constraint_type = 'CHECK'
    ORDER BY table_name, constraint_name
  `);
  const constraints = (constraintRes.rows as { constraint_name: string }[]).map((r) => r.constraint_name);
  console.log("\nCHECK constraints:", constraints);

  console.log("\n=== Phase 5F Migration Complete ===");
}

migrate().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
