/**
 * Phase 10 — Knowledge Chunking Service
 * INV-KNW3: Chunks must be tenant-scoped and linked to a document.
 * INV-KNW4: Chunks must have deterministic chunk_index per document.
 * INV-KNW8: Chunking events must be audited.
 */

import pg from "pg";
import { logAuditBestEffort } from "../audit/audit-log.ts";
import { updateDocumentStatus } from "./knowledge-documents.ts";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

export type EmbeddingStatus = "pending" | "generating" | "completed" | "failed";

export interface IngestionChunkRecord {
  id: string;
  tenantId: string;
  documentId: string;
  chunkIndex: number;
  content: string;
  tokenCount: number | null;
  embeddingStatus: EmbeddingStatus;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

function rowToChunk(r: Record<string, unknown>): IngestionChunkRecord {
  return {
    id: r["id"] as string,
    tenantId: r["tenant_id"] as string,
    documentId: r["document_id"] as string,
    chunkIndex: r["chunk_index"] as number,
    content: r["content"] as string,
    tokenCount: (r["token_count"] as number) ?? null,
    embeddingStatus: r["embedding_status"] as EmbeddingStatus,
    metadata: (r["metadata"] as Record<string, unknown>) ?? null,
    createdAt: new Date(r["created_at"] as string),
  };
}

// ─── chunkDocument ────────────────────────────────────────────────────────────
// Splits content into chunks and persists them.
// INV-KNW3/4: All chunks get the document's tenant_id and sequential chunk_index.

export async function chunkDocument(params: {
  tenantId: string;
  documentId: string;
  content: string;
  chunkSize?: number;
  chunkOverlap?: number;
  actorId?: string;
}): Promise<IngestionChunkRecord[]> {
  const { tenantId, documentId, content, chunkSize = 512, chunkOverlap = 64, actorId } = params;

  if (!content || content.trim().length === 0) {
    throw new Error("INV-KNW4: Document content must not be empty for chunking");
  }

  // Simple word-boundary chunking
  const words = content.split(/\s+/).filter((w) => w.length > 0);
  const chunks: string[] = [];
  let start = 0;
  while (start < words.length) {
    const end = Math.min(start + chunkSize, words.length);
    chunks.push(words.slice(start, end).join(" "));
    start += Math.max(1, chunkSize - chunkOverlap);
    if (start >= words.length) break;
  }
  if (chunks.length === 0) chunks.push(content.trim());

  const client = getClient();
  await client.connect();
  try {
    // Clear existing chunks for idempotency
    await client.query(
      `DELETE FROM public.ingestion_chunks WHERE document_id = $1 AND tenant_id = $2`,
      [documentId, tenantId],
    );

    const created: IngestionChunkRecord[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunkText = chunks[i];
      const tokenCount = Math.ceil(chunkText.length / 4); // rough estimate
      const row = await client.query(
        `INSERT INTO public.ingestion_chunks (id, tenant_id, document_id, chunk_index, content, token_count, embedding_status)
         VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 'pending') RETURNING *`,
        [tenantId, documentId, i, chunkText, tokenCount],
      );
      created.push(rowToChunk(row.rows[0]));
    }

    // Update document status to chunked
    await updateDocumentStatus(documentId, "chunked", tenantId);

    logAuditBestEffort({
      tenantId,
      action: "knowledge.document.chunked",
      resourceType: "ingestion_document",
      resourceId: documentId,
      actorId: actorId ?? "system",
      actorType: actorId ? "user" : "system",
      summary: `Document '${documentId}' chunked into ${created.length} chunks`,
      metadata: { chunkCount: created.length, chunkSize, chunkOverlap },
    }).catch(() => {});

    return created;
  } finally {
    await client.end();
  }
}

// ─── getChunksByDocumentId ────────────────────────────────────────────────────

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

// ─── getChunkById ─────────────────────────────────────────────────────────────

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

// ─── updateChunkEmbeddingStatus ───────────────────────────────────────────────

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

// ─── countChunksByDocument ────────────────────────────────────────────────────

export async function countChunksByDocument(documentId: string, tenantId: string): Promise<{ total: number; byStatus: Record<string, number> }> {
  const client = getClient();
  await client.connect();
  try {
    const totalR = await client.query(
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
