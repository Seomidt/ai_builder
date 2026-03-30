/**
 * Phase 10 — Knowledge Indexing Service
 * INV-KNW7: Index entries must be tenant-scoped.
 * INV-KNW9: One canonical index entry per chunk (unique constraint).
 * INV-KNW8: Index updates must be audited.
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

export interface KnowledgeIndexEntryRecord {
  id: string;
  tenantId: string;
  chunkId: string;
  documentId: string;
  sourceId: string;
  vectorIndexed: boolean;
  lexicalIndexed: boolean;
  indexedAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

function rowToIndexEntry(r: Record<string, unknown>): KnowledgeIndexEntryRecord {
  return {
    id: r["id"] as string,
    tenantId: r["tenant_id"] as string,
    chunkId: r["chunk_id"] as string,
    documentId: r["document_id"] as string,
    sourceId: r["source_id"] as string,
    vectorIndexed: r["vector_indexed"] as boolean,
    lexicalIndexed: r["lexical_indexed"] as boolean,
    indexedAt: r["indexed_at"] ? new Date(r["indexed_at"] as string) : null,
    metadata: (r["metadata"] as Record<string, unknown>) ?? null,
    createdAt: new Date(r["created_at"] as string),
    updatedAt: new Date(r["updated_at"] as string),
  };
}

// ─── registerIndexEntry ───────────────────────────────────────────────────────
// INV-KNW9: Idempotent — upsert by chunk_id.

export async function registerIndexEntry(params: {
  tenantId: string;
  chunkId: string;
  documentId: string;
  sourceId: string;
  vectorIndexed?: boolean;
  lexicalIndexed?: boolean;
  metadata?: Record<string, unknown>;
  actorId?: string;
}): Promise<KnowledgeIndexEntryRecord> {
  const { tenantId, chunkId, documentId, sourceId, vectorIndexed = false, lexicalIndexed = false, metadata, actorId } = params;

  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `INSERT INTO public.knowledge_index_entries (id, tenant_id, chunk_id, document_id, source_id, vector_indexed, lexical_indexed, indexed_at, metadata)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, CASE WHEN $5 OR $6 THEN NOW() ELSE NULL END, $7)
       ON CONFLICT (chunk_id) DO UPDATE SET
         vector_indexed = EXCLUDED.vector_indexed OR knowledge_index_entries.vector_indexed,
         lexical_indexed = EXCLUDED.lexical_indexed OR knowledge_index_entries.lexical_indexed,
         indexed_at = CASE WHEN (EXCLUDED.vector_indexed OR EXCLUDED.lexical_indexed) THEN NOW() ELSE knowledge_index_entries.indexed_at END,
         updated_at = NOW()
       RETURNING *`,
      [tenantId, chunkId, documentId, sourceId, vectorIndexed, lexicalIndexed, metadata ? JSON.stringify(metadata) : null],
    );
    const entry = rowToIndexEntry(row.rows[0]);

    // Fire-and-forget audit (INV-AUD4) to avoid per-entry connection overhead in batch indexing
    logAuditBestEffort({
      tenantId,
      action: "knowledge.index.updated",
      resourceType: "knowledge_index_entry",
      resourceId: entry.id,
      actorId: actorId ?? "system",
      actorType: actorId ? "user" : "system",
      summary: `Index entry registered for chunk '${chunkId}' (vector=${vectorIndexed}, lexical=${lexicalIndexed})`,
      metadata: { chunkId, documentId, sourceId, vectorIndexed, lexicalIndexed },
    }).catch(() => {});

    return entry;
  } finally {
    await client.end();
  }
}

// ─── registerIndexEntriesForDocument ─────────────────────────────────────────

export async function registerIndexEntriesForDocument(params: {
  tenantId: string;
  documentId: string;
  sourceId: string;
  vectorIndexed?: boolean;
  lexicalIndexed?: boolean;
  actorId?: string;
}): Promise<{ registered: number; failed: number }> {
  const { tenantId, documentId, sourceId, vectorIndexed = true, lexicalIndexed = true, actorId } = params;

  const client = getClient();
  await client.connect();
  try {
    const chunks = await client.query(
      `SELECT id FROM public.ingestion_chunks WHERE document_id = $1 AND tenant_id = $2 AND embedding_status = 'completed' ORDER BY chunk_index ASC`,
      [documentId, tenantId],
    );

    let registered = 0; let failed = 0;
    for (const chunk of chunks.rows) {
      try {
        await registerIndexEntry({ tenantId, chunkId: chunk.id, documentId, sourceId, vectorIndexed, lexicalIndexed, actorId });
        registered++;
      } catch { failed++; }
    }

    // Update document status to indexed if all chunks registered
    if (registered > 0 && failed === 0) {
      await updateDocumentStatus(documentId, "indexed", tenantId);
    }

    return { registered, failed };
  } finally {
    await client.end();
  }
}

// ─── getIndexEntryByChunkId ───────────────────────────────────────────────────

export async function getIndexEntryByChunkId(chunkId: string, tenantId: string): Promise<KnowledgeIndexEntryRecord | null> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.knowledge_index_entries WHERE chunk_id = $1 AND tenant_id = $2`,
      [chunkId, tenantId],
    );
    if (row.rows.length === 0) return null;
    return rowToIndexEntry(row.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── listIndexEntriesByDocument ───────────────────────────────────────────────

export async function listIndexEntriesByDocument(documentId: string, tenantId: string): Promise<KnowledgeIndexEntryRecord[]> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.knowledge_index_entries WHERE document_id = $1 AND tenant_id = $2 ORDER BY created_at ASC`,
      [documentId, tenantId],
    );
    return row.rows.map(rowToIndexEntry);
  } finally {
    await client.end();
  }
}

// ─── listIndexEntriesBySource ─────────────────────────────────────────────────

export async function listIndexEntriesBySource(sourceId: string, tenantId: string): Promise<KnowledgeIndexEntryRecord[]> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.knowledge_index_entries WHERE source_id = $1 AND tenant_id = $2 ORDER BY created_at ASC`,
      [sourceId, tenantId],
    );
    return row.rows.map(rowToIndexEntry);
  } finally {
    await client.end();
  }
}

// ─── summarizeIndexState ──────────────────────────────────────────────────────

export async function summarizeIndexState(tenantId: string): Promise<{
  totalEntries: number;
  vectorIndexedCount: number;
  lexicalIndexedCount: number;
  bothIndexedCount: number;
  neitherIndexedCount: number;
}> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN vector_indexed THEN 1 ELSE 0 END) as vector_indexed,
         SUM(CASE WHEN lexical_indexed THEN 1 ELSE 0 END) as lexical_indexed,
         SUM(CASE WHEN vector_indexed AND lexical_indexed THEN 1 ELSE 0 END) as both_indexed,
         SUM(CASE WHEN NOT vector_indexed AND NOT lexical_indexed THEN 1 ELSE 0 END) as neither_indexed
       FROM public.knowledge_index_entries WHERE tenant_id = $1`,
      [tenantId],
    );
    const r = row.rows[0];
    return {
      totalEntries: parseInt(r.total, 10),
      vectorIndexedCount: parseInt(r.vector_indexed ?? "0", 10),
      lexicalIndexedCount: parseInt(r.lexical_indexed ?? "0", 10),
      bothIndexedCount: parseInt(r.both_indexed ?? "0", 10),
      neitherIndexedCount: parseInt(r.neither_indexed ?? "0", 10),
    };
  } finally {
    await client.end();
  }
}
