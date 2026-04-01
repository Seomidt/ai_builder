/**
 * Phase 10 / Phase 5Z.1 — Knowledge Chunking Service (Token-Aware)
 *
 * Phase 5Z.1 upgrade: replaces naive word-based slicing with the
 * token-aware retrieval-chunker engine.  Writes to BOTH:
 *  - ingestion_chunks  (legacy Phase 10, kept for backwards compat)
 *  - knowledge_chunks  (Phase 5A+ canonical table, used for retrieval)
 *
 * Deduplication / supersession (Phase 5Z.1):
 *  - Before inserting new chunks, ALL existing active chunks for the same
 *    (tenant_id, knowledge_document_version_id) are marked chunk_active=false
 *    with replaced_at=NOW() and replaced_by_job_id=<current jobId>.
 *  - New chunks are inserted with chunk_active=true.
 *  - supersession + insert are wrapped in a single DB transaction.
 *
 * INV-KNW3:  Chunks are tenant-scoped and linked to a document.
 * INV-KNW4:  chunk_index is deterministic per (docVersionId, strategy, version).
 * INV-KNW8:  Chunking events are audited.
 * INV-DEDUP1: At most one active chunk per (docVersionId, chunkKey).
 * INV-DEDUP2: Superseded chunks are never returned by retrieval.
 */

import pg from "pg";
import { logAuditBestEffort } from "../audit/audit-log.ts";
import { updateDocumentStatus } from "./knowledge-documents.ts";
import {
  chunkText,
  DEFAULT_CHUNKING_POLICY,
  type ChunkingPolicy,
} from "../media/retrieval-chunker.ts";
import {
  buildChunkKey,
  buildChunkHash,
  buildChunkProvenance,
} from "../media/provenance-builder.ts";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

export type EmbeddingStatus = "pending" | "generating" | "completed" | "failed";

export interface IngestionChunkRecord {
  id:              string;
  tenantId:        string;
  documentId:      string;
  chunkIndex:      number;
  content:         string;
  tokenCount:      number | null;
  embeddingStatus: EmbeddingStatus;
  metadata:        Record<string, unknown> | null;
  createdAt:       Date;
}

function rowToChunk(r: Record<string, unknown>): IngestionChunkRecord {
  return {
    id:              r["id"] as string,
    tenantId:        r["tenant_id"] as string,
    documentId:      r["document_id"] as string,
    chunkIndex:      r["chunk_index"] as number,
    content:         r["content"] as string,
    tokenCount:      (r["token_count"] as number) ?? null,
    embeddingStatus: r["embedding_status"] as EmbeddingStatus,
    metadata:        (r["metadata"] as Record<string, unknown>) ?? null,
    createdAt:       new Date(r["created_at"] as string),
  };
}

// ── chunkDocument ─────────────────────────────────────────────────────────────
// Token-aware replacement of the old word-based chunker.

export async function chunkDocument(params: {
  tenantId:    string;
  documentId:  string;
  content:     string;
  /** If provided, also writes to knowledge_chunks with full provenance. */
  knowledgeDocumentVersionId?: string;
  knowledgeBaseId?:            string;
  jobId?:                      string;
  policy?:                     Partial<ChunkingPolicy>;
  actorId?:                    string;
}): Promise<IngestionChunkRecord[]> {
  const {
    tenantId, documentId, content,
    knowledgeDocumentVersionId, knowledgeBaseId, jobId,
    policy: policyOverride, actorId,
  } = params;

  if (!content || content.trim().length === 0) {
    throw new Error("INV-KNW4: Document content must not be empty for chunking");
  }

  const policy: ChunkingPolicy = { ...DEFAULT_CHUNKING_POLICY, ...policyOverride };

  // Token-aware chunking (INV-CHK1: deterministic)
  const spans = chunkText(content, policy);

  const client = getClient();
  await client.connect();

  try {
    await client.query("BEGIN");

    // 1. Supersede existing ingestion_chunks (legacy table)
    await client.query(
      `DELETE FROM public.ingestion_chunks WHERE document_id = $1 AND tenant_id = $2`,
      [documentId, tenantId],
    );

    // 2. Insert into ingestion_chunks (legacy)
    const created: IngestionChunkRecord[] = [];
    for (const span of spans) {
      const row = await client.query(
        `INSERT INTO public.ingestion_chunks
           (id, tenant_id, document_id, chunk_index, content, token_count, embedding_status)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 'pending')
         RETURNING *`,
        [tenantId, documentId, span.chunkIndex, span.text, span.tokenEstimate],
      );
      created.push(rowToChunk(row.rows[0]));
    }

    // 3. Write to knowledge_chunks if caller provides version context
    //    INV-DEDUP1 + INV-DEDUP2: supersession via chunk_active flag
    if (knowledgeDocumentVersionId && knowledgeBaseId) {
      const currentJobId = jobId ?? "system";

      // 3a. Deactivate ALL existing active chunks for this version
      await client.query(`
        UPDATE public.knowledge_chunks
        SET
          chunk_active       = false,
          replaced_at        = NOW(),
          replaced_by_job_id = $1
        WHERE tenant_id = $2
          AND knowledge_document_version_id = $3
          AND chunk_active = true
      `, [currentJobId, tenantId, knowledgeDocumentVersionId]);

      // 3b. Insert new active chunks with full provenance
      for (const span of spans) {
        const prov = buildChunkProvenance({
          tenantId,
          knowledgeBaseId,
          knowledgeDocumentId:        documentId,
          knowledgeDocumentVersionId,
          jobId:   currentJobId,
          span,
          strategy: policy.strategy,
          version:  policy.version,
        });

        await client.query(`
          INSERT INTO public.knowledge_chunks (
            id,
            tenant_id,
            knowledge_base_id,
            knowledge_document_id,
            knowledge_document_version_id,
            chunk_index,
            chunk_key,
            chunk_text,
            chunk_hash,
            chunk_active,
            chunk_strategy,
            chunk_version,
            character_start,
            character_end,
            token_estimate,
            overlap_characters,
            created_at
          ) VALUES (
            gen_random_uuid(),
            $1, $2, $3, $4, $5, $6, $7, $8,
            true, $9, $10, $11, $12, $13, $14,
            NOW()
          )
          ON CONFLICT ON CONSTRAINT kc_version_chunk_key_active_unique
          DO UPDATE SET
            chunk_text         = EXCLUDED.chunk_text,
            chunk_hash         = EXCLUDED.chunk_hash,
            token_estimate     = EXCLUDED.token_estimate,
            overlap_characters = EXCLUDED.overlap_characters,
            character_start    = EXCLUDED.character_start,
            character_end      = EXCLUDED.character_end
        `, [
          prov.tenantId,
          prov.knowledgeBaseId,
          prov.knowledgeDocumentId,
          prov.knowledgeDocumentVersionId,
          prov.chunkIndex,
          prov.chunkKey,
          span.text,
          prov.chunkHash,
          policy.strategy,
          policy.version,
          span.characterStart,
          span.characterEnd,
          span.tokenEstimate,
          span.overlapCharacters,
        ]);
      }
    }

    await client.query("COMMIT");

    await updateDocumentStatus(documentId, "chunked", tenantId);

    logAuditBestEffort({
      tenantId,
      action:       "knowledge.document.chunked",
      resourceType: "ingestion_document",
      resourceId:   documentId,
      actorId:      actorId ?? "system",
      actorType:    actorId ? "user" : "system",
      summary: `Document '${documentId}' chunked into ${created.length} token-aware chunks (v${policy.version})`,
      metadata: {
        chunkCount:   created.length,
        strategy:     policy.strategy,
        version:      policy.version,
        targetTokens: policy.targetTokens,
        maxTokens:    policy.maxTokens,
        overlapFraction: policy.overlapFraction,
        knowledgeDocumentVersionId: knowledgeDocumentVersionId ?? null,
        jobId: jobId ?? null,
      },
    }).catch(() => {});

    return created;

  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await client.end();
  }
}

// ── supersedePreviousChunks ────────────────────────────────────────────────────
// Deactivate all existing active knowledge_chunks for a document version
// before a new chunking run starts. Call from workers before inserting new chunks.
// INV-DEDUP1: prevents duplicate active chunks after retry/fallback.

export async function supersedePreviousChunks(params: {
  tenantId:                string;
  knowledgeDocumentVersionId: string;
  replacedByJobId:         string;
}): Promise<{ supersededCount: number }> {
  const { tenantId, knowledgeDocumentVersionId, replacedByJobId } = params;

  const client = getClient();
  await client.connect();
  try {
    const result = await client.query(`
      UPDATE public.knowledge_chunks
      SET
        chunk_active       = false,
        replaced_at        = NOW(),
        replaced_by_job_id = $1
      WHERE tenant_id = $2
        AND knowledge_document_version_id = $3
        AND chunk_active = true
      RETURNING id
    `, [replacedByJobId, tenantId, knowledgeDocumentVersionId]);

    return { supersededCount: result.rowCount ?? 0 };
  } finally {
    await client.end();
  }
}

// ── getActiveKnowledgeChunks ──────────────────────────────────────────────────
// Returns only ACTIVE (non-superseded) chunks from the canonical knowledge_chunks table.
// INV-DEDUP2: superseded chunks are never returned.

export async function getActiveKnowledgeChunks(params: {
  tenantId:                string;
  knowledgeDocumentVersionId: string;
}): Promise<Array<{
  id: string; chunkIndex: number; chunkKey: string; chunkText: string | null;
  tokenEstimate: number | null; chunkActive: boolean; chunkStrategy: string | null;
  chunkVersion: string | null; characterStart: number | null; characterEnd: number | null;
  overlapCharacters: number | null;
}>> {
  const client = getClient();
  await client.connect();
  try {
    const result = await client.query(`
      SELECT
        id, chunk_index, chunk_key, chunk_text, token_estimate,
        chunk_active, chunk_strategy, chunk_version,
        character_start, character_end, overlap_characters
      FROM public.knowledge_chunks
      WHERE tenant_id = $1
        AND knowledge_document_version_id = $2
        AND chunk_active = true
      ORDER BY chunk_index ASC
    `, [params.tenantId, params.knowledgeDocumentVersionId]);
    return result.rows;
  } finally {
    await client.end();
  }
}

// ── getChunksByDocumentId (legacy) ─────────────────────────────────────────────

export async function getChunksByDocumentId(documentId: string, tenantId: string): Promise<IngestionChunkRecord[]> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.ingestion_chunks WHERE document_id = $1 AND tenant_id = $2 ORDER BY chunk_index ASC`,
      [documentId, tenantId],
    );
    return row.rows.map(rowToChunk);
  } finally {
    await client.end();
  }
}

// ── getChunkById (legacy) ──────────────────────────────────────────────────────

export async function getChunkById(chunkId: string, tenantId: string): Promise<IngestionChunkRecord | null> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.ingestion_chunks WHERE id = $1 AND tenant_id = $2`,
      [chunkId, tenantId],
    );
    if (row.rows.length === 0) return null;
    return rowToChunk(row.rows[0]);
  } finally {
    await client.end();
  }
}

// ── updateChunkEmbeddingStatus ─────────────────────────────────────────────────

export async function updateChunkEmbeddingStatus(chunkId: string, status: EmbeddingStatus, tenantId: string): Promise<void> {
  const client = getClient();
  await client.connect();
  try {
    await client.query(
      `UPDATE public.ingestion_chunks SET embedding_status = $1 WHERE id = $2 AND tenant_id = $3`,
      [status, chunkId, tenantId],
    );
  } finally {
    await client.end();
  }
}

// ── countChunksByDocument ──────────────────────────────────────────────────────

export async function countChunksByDocument(documentId: string, tenantId: string): Promise<{ total: number; byStatus: Record<string, number> }> {
  const client = getClient();
  await client.connect();
  try {
    const totalR    = await client.query(
      `SELECT COUNT(*) as cnt FROM public.ingestion_chunks WHERE document_id = $1 AND tenant_id = $2`,
      [documentId, tenantId],
    );
    const byStatusR = await client.query(
      `SELECT embedding_status, COUNT(*) as cnt FROM public.ingestion_chunks WHERE document_id = $1 AND tenant_id = $2 GROUP BY embedding_status`,
      [documentId, tenantId],
    );
    const byStatus: Record<string, number> = {};
    for (const r of byStatusR.rows) byStatus[r.embedding_status] = parseInt(r.cnt, 10);
    return { total: parseInt(totalR.rows[0].cnt, 10), byStatus };
  } finally {
    await client.end();
  }
}
