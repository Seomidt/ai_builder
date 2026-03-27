/**
 * pgvector Migration — Storage 1.4
 *
 * Idempotent. Safe to re-run on every boot.
 * Adds vector(1536) column + HNSW cosine index to knowledge_embeddings.
 * Backfills existing real[] data to the new vector column.
 *
 * Why raw SQL (not Drizzle schema):
 *   Drizzle ORM does not natively support pgvector column type.
 *   The `embedding_vector real[]` column remains for Drizzle compatibility.
 *   The new `embedding_vector_pgv vector(1536)` column handles scalable ANN search.
 */

import pg from "pg";

let _migrationDone = false;

export async function runPgvectorMigration(): Promise<void> {
  if (_migrationDone) return;

  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();

  try {
    // ── 1. Enable pgvector extension ────────────────────────────────────────
    await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
    console.log("[pgvector-migration] extension: OK");

    // ── 2. Add vector(1536) column if missing ───────────────────────────────
    await client.query(`
      ALTER TABLE knowledge_embeddings
      ADD COLUMN IF NOT EXISTS embedding_vector_pgv vector(1536)
    `);
    console.log("[pgvector-migration] column embedding_vector_pgv: OK");

    // ── 3. Backfill from real[] → vector(1536) for existing rows ────────────
    // Only rows where old column exists and new column is still NULL
    const backfill = await client.query(`
      UPDATE knowledge_embeddings
      SET embedding_vector_pgv = embedding_vector::vector
      WHERE embedding_vector IS NOT NULL
        AND embedding_vector_pgv IS NULL
    `);
    if (backfill.rowCount && backfill.rowCount > 0) {
      console.log(`[pgvector-migration] backfilled ${backfill.rowCount} existing rows`);
    }

    // ── 4. HNSW index for cosine similarity (<=> operator) ──────────────────
    // m=16, ef_construction=64 — good defaults for 1536-dim embeddings at this scale
    await client.query(`
      CREATE INDEX IF NOT EXISTS ke_embedding_vector_pgv_hnsw_cosine_idx
      ON knowledge_embeddings
      USING hnsw (embedding_vector_pgv vector_cosine_ops)
      WITH (m = 16, ef_construction = 64)
    `);
    console.log("[pgvector-migration] HNSW index: OK");

    _migrationDone = true;
    console.log("[pgvector-migration] complete");
  } catch (err) {
    console.error("[pgvector-migration] FAILED:", (err as Error).message);
    // Non-fatal — retrieval falls back to lexical if vector column missing
  } finally {
    await client.end();
  }
}

// ── Check whether pgvector column is available (used by retrieval) ──────────
export async function isPgvectorAvailable(): Promise<boolean> {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name   = 'knowledge_embeddings'
        AND column_name  = 'embedding_vector_pgv'
      LIMIT 1
    `);
    return result.rows.length > 0;
  } finally {
    await client.end();
  }
}
