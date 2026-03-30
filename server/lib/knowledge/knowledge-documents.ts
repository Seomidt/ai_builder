/**
 * Phase 10 — Ingestion Document Service
 * INV-KNW2: Every ingestion document must be tenant-scoped and linked to a source.
 * INV-KNW8: Ingestion events must be audited.
 */

import pg from "pg";
import { logAuditBestEffort } from "../audit/audit-log.ts";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

export type DocumentStatus = "pending" | "processing" | "chunked" | "embedded" | "indexed" | "failed" | "archived";

export interface IngestionDocumentRecord {
  id: string;
  tenantId: string;
  sourceId: string;
  title: string;
  documentStatus: DocumentStatus;
  checksum: string | null;
  contentType: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

function rowToDocument(r: Record<string, unknown>): IngestionDocumentRecord {
  return {
    id: r["id"] as string,
    tenantId: r["tenant_id"] as string,
    sourceId: r["source_id"] as string,
    title: r["title"] as string,
    documentStatus: r["document_status"] as DocumentStatus,
    checksum: (r["checksum"] as string) ?? null,
    contentType: (r["content_type"] as string) ?? null,
    metadata: (r["metadata"] as Record<string, unknown>) ?? null,
    createdAt: new Date(r["created_at"] as string),
    updatedAt: new Date(r["updated_at"] as string),
  };
}

// ─── ingestDocument ───────────────────────────────────────────────────────────

export async function ingestDocument(params: {
  tenantId: string;
  sourceId: string;
  title: string;
  checksum?: string;
  contentType?: string;
  metadata?: Record<string, unknown>;
  actorId?: string;
}): Promise<IngestionDocumentRecord> {
  const { tenantId, sourceId, title, checksum, contentType, metadata, actorId } = params;

  const client = getClient();
  await client.connect();
  try {
    // Idempotent on checksum: if same checksum already exists, return it
    if (checksum) {
      const existing = await client.query(
        `SELECT * FROM public.ingestion_documents WHERE tenant_id = $1 AND source_id = $2 AND checksum = $3 LIMIT 1`,
        [tenantId, sourceId, checksum],
      );
      if (existing.rows.length > 0) return rowToDocument(existing.rows[0]);
    }

    const row = await client.query(
      `INSERT INTO public.ingestion_documents (id, tenant_id, source_id, title, document_status, checksum, content_type, metadata)
       VALUES (gen_random_uuid()::text, $1, $2, $3, 'pending', $4, $5, $6) RETURNING *`,
      [tenantId, sourceId, title, checksum ?? null, contentType ?? null, metadata ? JSON.stringify(metadata) : null],
    );
    const doc = rowToDocument(row.rows[0]);

    await logAuditBestEffort({
      tenantId,
      action: "knowledge.document.ingested",
      resourceType: "ingestion_document",
      resourceId: doc.id,
      actorId: actorId ?? "system",
      actorType: actorId ? "user" : "system",
      summary: `Document '${title}' ingested from source '${sourceId}'`,
      metadata: { sourceId, checksum, contentType },
    });

    return doc;
  } finally {
    await client.end();
  }
}

// ─── getIngestionDocumentById ─────────────────────────────────────────────────

export async function getIngestionDocumentById(documentId: string, tenantId: string): Promise<IngestionDocumentRecord | null> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.ingestion_documents WHERE id = $1 AND tenant_id = $2`,
      [documentId, tenantId],
    );
    if (row.rows.length === 0) return null;
    return rowToDocument(row.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── listIngestionDocuments ───────────────────────────────────────────────────

export async function listIngestionDocuments(params: {
  tenantId: string;
  sourceId?: string;
  documentStatus?: DocumentStatus;
  limit?: number;
  offset?: number;
}): Promise<IngestionDocumentRecord[]> {
  const { tenantId, sourceId, documentStatus, limit = 50, offset = 0 } = params;
  const client = getClient();
  await client.connect();
  try {
    const conds: string[] = ["tenant_id = $1"];
    const vals: unknown[] = [tenantId];
    if (sourceId) { conds.push(`source_id = $${vals.length + 1}`); vals.push(sourceId); }
    if (documentStatus) { conds.push(`document_status = $${vals.length + 1}`); vals.push(documentStatus); }
    vals.push(Math.min(limit, 200));
    vals.push(offset);
    const row = await client.query(
      `SELECT * FROM public.ingestion_documents WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals,
    );
    return row.rows.map(rowToDocument);
  } finally {
    await client.end();
  }
}

// ─── updateDocumentStatus ─────────────────────────────────────────────────────

export async function updateDocumentStatus(documentId: string, newStatus: DocumentStatus, tenantId: string): Promise<IngestionDocumentRecord> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `UPDATE public.ingestion_documents SET document_status = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [newStatus, documentId, tenantId],
    );
    if (row.rows.length === 0) throw new Error(`Ingestion document '${documentId}' not found for tenant '${tenantId}'`);
    return rowToDocument(row.rows[0]);
  } finally {
    await client.end();
  }
}
