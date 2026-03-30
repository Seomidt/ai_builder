/**
 * Phase 10 — Knowledge Embeddings Service
 * INV-KNW5: Embeddings must be tenant-scoped and linked to chunks.
 * INV-KNW6: Embedding generation must be idempotent per chunk/model pair.
 * INV-KNW8: Embedding events must be audited.
 */

import pg from "pg";
import { logAuditBestEffort } from "../audit/audit-log.ts";
import { updateChunkEmbeddingStatus } from "./knowledge-chunking.ts";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

export interface IngestionEmbeddingRecord {
  id: string;
  tenantId: string;
  chunkId: string;
  embeddingModel: string;
  embeddingStatus: "pending" | "generating" | "completed" | "failed";
  dimensions: number | null;
  vectorReference: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

function rowToEmbedding(r: Record<string, unknown>): IngestionEmbeddingRecord {
  return {
    id: r["id"] as string,
    tenantId: r["tenant_id"] as string,
    chunkId: r["chunk_id"] as string,
    embeddingModel: r["embedding_model"] as string,
    embeddingStatus: r["embedding_status"] as IngestionEmbeddingRecord["embeddingStatus"],
    dimensions: (r["dimensions"] as number) ?? null,
    vectorReference: (r["vector_reference"] as string) ?? null,
    errorMessage: (r["error_message"] as string) ?? null,
    metadata: (r["metadata"] as Record<string, unknown>) ?? null,
    createdAt: new Date(r["created_at"] as string),
    updatedAt: new Date(r["updated_at"] as string),
  };
}

// ─── generateEmbeddings ───────────────────────────────────────────────────────
// INV-KNW6: Idempotent — returns existing if same chunk+model exists.
// Simulates embedding generation (no external API call in this layer).

export async function generateEmbeddings(params: {
  tenantId: string;
  chunkId: string;
  embeddingModel: string;
  dimensions?: number;
  vectorReference?: string;
  actorId?: string;
}): Promise<IngestionEmbeddingRecord> {
  const { tenantId, chunkId, embeddingModel, dimensions, vectorReference, actorId } = params;

  const client = getClient();
  await client.connect();
  try {
    // INV-KNW6: Idempotent check
    const existing = await client.query(
      `SELECT * FROM public.ingestion_embeddings WHERE chunk_id = $1 AND embedding_model = $2 AND tenant_id = $3 AND embedding_status = 'completed' LIMIT 1`,
      [chunkId, embeddingModel, tenantId],
    );
    if (existing.rows.length > 0) return rowToEmbedding(existing.rows[0]);

    // Create embedding record in 'generating' state
    const row = await client.query(
      `INSERT INTO public.ingestion_embeddings (id, tenant_id, chunk_id, embedding_model, embedding_status, dimensions, vector_reference)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'generating', $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [tenantId, chunkId, embeddingModel, dimensions ?? null, vectorReference ?? null],
    );

    if (row.rows.length === 0) {
      // Race: another request already created it
      const fallback = await client.query(
        `SELECT * FROM public.ingestion_embeddings WHERE chunk_id = $1 AND embedding_model = $2 AND tenant_id = $3 ORDER BY created_at DESC LIMIT 1`,
        [chunkId, embeddingModel, tenantId],
      );
      return rowToEmbedding(fallback.rows[0]);
    }

    // Simulate completion (real pipeline would call OpenAI here)
    const completedRow = await client.query(
      `UPDATE public.ingestion_embeddings SET embedding_status = 'completed', dimensions = COALESCE(dimensions, 1536), updated_at = NOW()
       WHERE id = $1 RETURNING *`,
      [row.rows[0].id],
    );
    const embedding = rowToEmbedding(completedRow.rows[0]);

    // Update chunk status
    await updateChunkEmbeddingStatus(chunkId, "completed", tenantId);

    await logAuditBestEffort({
      tenantId,
      action: "knowledge.embedding.generated",
      resourceType: "ingestion_embedding",
      resourceId: embedding.id,
      actorId: actorId ?? "system",
      actorType: actorId ? "user" : "system",
      summary: `Embedding generated for chunk '${chunkId}' using model '${embeddingModel}'`,
      metadata: { chunkId, embeddingModel, dimensions: embedding.dimensions },
    });

    return embedding;
  } finally {
    await client.end();
  }
}

// ─── generateEmbeddingsForDocument ───────────────────────────────────────────
// Uses a single connection to avoid per-chunk connection overhead.

export async function generateEmbeddingsForDocument(params: {
  tenantId: string;
  documentId: string;
  embeddingModel: string;
  actorId?: string;
}): Promise<{ generated: number; failed: number; skipped: number }> {
  const { tenantId, documentId, embeddingModel, actorId } = params;

  const client = getClient();
  await client.connect();
  try {
    const chunks = await client.query(
      `SELECT id FROM public.ingestion_chunks WHERE document_id = $1 AND tenant_id = $2 ORDER BY chunk_index ASC`,
      [documentId, tenantId],
    );

    let generated = 0; let failed = 0; let skipped = 0;
    for (const chunk of chunks.rows) {
      try {
        // Idempotent check inline — no new connection needed
        const existing = await client.query(
          `SELECT id, embedding_status FROM public.ingestion_embeddings WHERE chunk_id = $1 AND embedding_model = $2 AND tenant_id = $3 AND embedding_status = 'completed' LIMIT 1`,
          [chunk.id, embeddingModel, tenantId],
        );
        if (existing.rows.length > 0) { skipped++; continue; }

        // Insert + complete inline
        const inserted = await client.query(
          `INSERT INTO public.ingestion_embeddings (id, tenant_id, chunk_id, embedding_model, embedding_status, dimensions)
           VALUES (gen_random_uuid()::text, $1, $2, $3, 'completed', 1536)
           ON CONFLICT DO NOTHING RETURNING id`,
          [tenantId, chunk.id, embeddingModel],
        );
        if (inserted.rows.length === 0) { skipped++; continue; }

        // Update chunk status
        await client.query(`UPDATE public.ingestion_chunks SET embedding_status = 'completed' WHERE id = $1 AND tenant_id = $2`, [chunk.id, tenantId]);

        // Audit best-effort — fire-and-forget to avoid connection overhead per chunk (INV-AUD4)
        logAuditBestEffort({
          tenantId,
          action: "knowledge.embedding.generated",
          resourceType: "ingestion_embedding",
          resourceId: inserted.rows[0].id,
          actorId: actorId ?? "system",
          actorType: actorId ? "user" : "system",
          summary: `Embedding generated for chunk '${chunk.id}' using model '${embeddingModel}'`,
          metadata: { chunkId: chunk.id, embeddingModel },
        }).catch(() => {});
        generated++;
      } catch { failed++; }
    }
    return { generated, failed, skipped };
  } finally {
    await client.end();
  }
}

// ─── getEmbeddingsByChunkId ───────────────────────────────────────────────────

export async function getEmbeddingsByChunkId(chunkId: string, tenantId: string): Promise<IngestionEmbeddingRecord[]> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.ingestion_embeddings WHERE chunk_id = $1 AND tenant_id = $2 ORDER BY created_at DESC`,
      [chunkId, tenantId],
    );
    return row.rows.map(rowToEmbedding);
  } finally {
    await client.end();
  }
}

// ─── markEmbeddingFailed ──────────────────────────────────────────────────────

export async function markEmbeddingFailed(embeddingId: string, errorMessage: string, tenantId: string): Promise<IngestionEmbeddingRecord> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `UPDATE public.ingestion_embeddings SET embedding_status = 'failed', error_message = $1, updated_at = NOW()
       WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [errorMessage, embeddingId, tenantId],
    );
    if (row.rows.length === 0) throw new Error(`Embedding '${embeddingId}' not found for tenant '${tenantId}'`);

    // Mark chunk as failed
    await updateChunkEmbeddingStatus(row.rows[0].chunk_id as string, "failed", tenantId);
    return rowToEmbedding(row.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── retryFailedEmbeddings ────────────────────────────────────────────────────

export async function retryFailedEmbeddings(params: {
  tenantId: string;
  documentId: string;
  embeddingModel: string;
  maxRetries?: number;
}): Promise<{ retried: number; succeeded: number; stillFailed: number }> {
  const { tenantId, documentId, embeddingModel, maxRetries = 3 } = params;

  const client = getClient();
  await client.connect();
  try {
    const failedChunks = await client.query(
      `SELECT ic.id as chunk_id FROM public.ingestion_chunks ic
       WHERE ic.document_id = $1 AND ic.tenant_id = $2 AND ic.embedding_status = 'failed'
       ORDER BY ic.chunk_index ASC LIMIT $3`,
      [documentId, tenantId, maxRetries],
    );

    let succeeded = 0; let stillFailed = 0;
    for (const row of failedChunks.rows) {
      try {
        // Reset failed embedding record
        await client.query(
          `UPDATE public.ingestion_embeddings SET embedding_status = 'pending', error_message = NULL, updated_at = NOW()
           WHERE chunk_id = $1 AND tenant_id = $2 AND embedding_status = 'failed'`,
          [row.chunk_id, tenantId],
        );
        await generateEmbeddings({ tenantId, chunkId: row.chunk_id, embeddingModel });
        succeeded++;
      } catch { stillFailed++; }
    }
    return { retried: failedChunks.rows.length, succeeded, stillFailed };
  } finally {
    await client.end();
  }
}
