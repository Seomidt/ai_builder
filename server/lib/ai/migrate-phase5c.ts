/**
 * Phase 5C Migration — Embedding Pipeline & Vector Preparation
 *
 * Run with: npx tsx server/lib/ai/migrate-phase5c.ts
 *
 * Adds:
 *   knowledge_embeddings: embedding_status, embedding_vector (real[]),
 *     embedding_dimensions, token_usage, estimated_cost_usd, updated_at
 *     + CHECK constraints + new index
 *   knowledge_processing_jobs: embedding_provider, embedding_model,
 *     token_usage, estimated_cost_usd + job_type CHECK update
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

async function run() {
  console.log("Phase 5C migration: Embedding Pipeline & Vector Preparation");

  // Ensure pgvector extension exists
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);
  console.log("pgvector extension: OK");

  // ─── knowledge_embeddings extensions ────────────────────────────────────────

  await db.execute(sql`
    ALTER TABLE knowledge_embeddings
      ADD COLUMN IF NOT EXISTS embedding_status text NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS embedding_vector real[],
      ADD COLUMN IF NOT EXISTS embedding_dimensions integer,
      ADD COLUMN IF NOT EXISTS token_usage integer,
      ADD COLUMN IF NOT EXISTS estimated_cost_usd numeric(12,8),
      ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now()
  `);
  console.log("knowledge_embeddings: columns added");

  await db.execute(sql`
    ALTER TABLE knowledge_embeddings
      DROP CONSTRAINT IF EXISTS ke_embedding_status_check,
      ADD CONSTRAINT ke_embedding_status_check
        CHECK (embedding_status IN ('pending','running','completed','failed'))
  `);
  console.log("knowledge_embeddings: ke_embedding_status_check OK");

  await db.execute(sql`
    ALTER TABLE knowledge_embeddings
      DROP CONSTRAINT IF EXISTS ke_embedding_dimensions_check,
      ADD CONSTRAINT ke_embedding_dimensions_check
        CHECK (embedding_dimensions IS NULL OR embedding_dimensions > 0)
  `);
  console.log("knowledge_embeddings: ke_embedding_dimensions_check OK");

  await db.execute(sql`
    ALTER TABLE knowledge_embeddings
      DROP CONSTRAINT IF EXISTS ke_token_usage_check,
      ADD CONSTRAINT ke_token_usage_check
        CHECK (token_usage IS NULL OR token_usage >= 0)
  `);
  console.log("knowledge_embeddings: ke_token_usage_check OK");

  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS ke_tenant_embedding_status_idx
      ON knowledge_embeddings (tenant_id, embedding_status, created_at)
  `);
  console.log("knowledge_embeddings: ke_tenant_embedding_status_idx OK");

  // ─── knowledge_processing_jobs extensions ────────────────────────────────────

  await db.execute(sql`
    ALTER TABLE knowledge_processing_jobs
      ADD COLUMN IF NOT EXISTS embedding_provider text,
      ADD COLUMN IF NOT EXISTS embedding_model text,
      ADD COLUMN IF NOT EXISTS token_usage integer,
      ADD COLUMN IF NOT EXISTS estimated_cost_usd numeric(12,8)
  `);
  console.log("knowledge_processing_jobs: embedding columns added");

  // Update job_type CHECK to include embedding_generate, embedding_retry
  await db.execute(sql`ALTER TABLE knowledge_processing_jobs DROP CONSTRAINT IF EXISTS kpj_job_type_check`);
  await db.execute(sql`
    ALTER TABLE knowledge_processing_jobs
      ADD CONSTRAINT kpj_job_type_check CHECK (job_type IN (
        'upload_verify','parse','chunk','embed','index','reindex','delete_index',
        'lifecycle_sync','extract_text','structured_parse','structured_chunk',
        'ocr_parse','ocr_chunk','transcript_parse','transcript_chunk',
        'import_parse','import_chunk','embedding_generate','embedding_retry'
      ))
  `);
  console.log("knowledge_processing_jobs: kpj_job_type_check updated");

  // ─── Verify ────────────────────────────────────────────────────────────────

  const keCols = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_embeddings'
      AND column_name IN (
        'embedding_status','embedding_vector','embedding_dimensions',
        'token_usage','estimated_cost_usd','updated_at'
      )
    ORDER BY column_name
  `);
  console.log(`knowledge_embeddings new cols verified: ${keCols.rows.length}/6`);

  const kpjCols = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_processing_jobs'
      AND column_name IN ('embedding_provider','embedding_model','token_usage','estimated_cost_usd')
    ORDER BY column_name
  `);
  console.log(`knowledge_processing_jobs new cols verified: ${kpjCols.rows.length}/4`);

  const constraint = await db.execute(sql`
    SELECT pg_get_constraintdef(c.oid) as def
    FROM pg_constraint c JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = 'knowledge_processing_jobs' AND c.conname = 'kpj_job_type_check'
  `);
  const def = (constraint.rows[0] as Record<string, string>)?.def ?? "";
  const hasEmbedGenerate = def.includes("embedding_generate");
  const hasEmbedRetry = def.includes("embedding_retry");
  console.log(`kpj_job_type_check: embedding_generate=${hasEmbedGenerate}, embedding_retry=${hasEmbedRetry}`);

  console.log("\nPhase 5C migration complete ✓");
  process.exit(0);
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
