/**
 * Phase 10 — Knowledge Sources Service
 * INV-KNW1: Every knowledge source must be tenant-scoped.
 * INV-KNW8: Source changes must be audited.
 */

import pg from "pg";
import { logAuditBestEffort } from "../audit/audit-log";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

export type SourceType = "file_upload" | "web_crawl" | "api_ingestion" | "manual";
export type SourceStatus = "pending" | "active" | "syncing" | "error" | "disabled";

export interface KnowledgeSourceRecord {
  id: string;
  tenantId: string;
  sourceType: SourceType;
  name: string;
  status: SourceStatus;
  lastSyncAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

function rowToSource(r: Record<string, unknown>): KnowledgeSourceRecord {
  return {
    id: r["id"] as string,
    tenantId: r["tenant_id"] as string,
    sourceType: r["source_type"] as SourceType,
    name: r["name"] as string,
    status: r["status"] as SourceStatus,
    lastSyncAt: r["last_sync_at"] ? new Date(r["last_sync_at"] as string) : null,
    metadata: (r["metadata"] as Record<string, unknown>) ?? null,
    createdAt: new Date(r["created_at"] as string),
    updatedAt: new Date(r["updated_at"] as string),
  };
}

// ─── createKnowledgeSource ────────────────────────────────────────────────────

export async function createKnowledgeSource(params: {
  tenantId: string;
  sourceType: SourceType;
  name: string;
  status?: SourceStatus;
  metadata?: Record<string, unknown>;
  actorId?: string;
}): Promise<KnowledgeSourceRecord> {
  const { tenantId, sourceType, name, status = "active", metadata, actorId } = params;

  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `INSERT INTO public.knowledge_sources (id, tenant_id, source_type, name, status, metadata)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5) RETURNING *`,
      [tenantId, sourceType, name, status, metadata ? JSON.stringify(metadata) : null],
    );
    const source = rowToSource(row.rows[0]);

    await logAuditBestEffort({
      tenantId,
      action: "knowledge.source.created",
      resourceType: "knowledge_source",
      resourceId: source.id,
      actorId: actorId ?? "system",
      actorType: actorId ? "user" : "system",
      summary: `Knowledge source '${name}' (${sourceType}) created`,
      metadata: { sourceType, status },
    });

    return source;
  } finally {
    await client.end();
  }
}

// ─── getKnowledgeSourceById ───────────────────────────────────────────────────

export async function getKnowledgeSourceById(sourceId: string, tenantId: string): Promise<KnowledgeSourceRecord | null> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.knowledge_sources WHERE id = $1 AND tenant_id = $2`,
      [sourceId, tenantId],
    );
    if (row.rows.length === 0) return null;
    return rowToSource(row.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── listKnowledgeSources ─────────────────────────────────────────────────────

export async function listKnowledgeSources(params: {
  tenantId: string;
  status?: SourceStatus;
  sourceType?: SourceType;
  limit?: number;
  offset?: number;
}): Promise<KnowledgeSourceRecord[]> {
  const { tenantId, status, sourceType, limit = 50, offset = 0 } = params;
  const client = getClient();
  await client.connect();
  try {
    const conds: string[] = ["tenant_id = $1"];
    const vals: unknown[] = [tenantId];
    if (status) { conds.push(`status = $${vals.length + 1}`); vals.push(status); }
    if (sourceType) { conds.push(`source_type = $${vals.length + 1}`); vals.push(sourceType); }
    vals.push(Math.min(limit, 200));
    vals.push(offset);
    const row = await client.query(
      `SELECT * FROM public.knowledge_sources WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals,
    );
    return row.rows.map(rowToSource);
  } finally {
    await client.end();
  }
}

// ─── updateKnowledgeSourceStatus ─────────────────────────────────────────────

export async function updateKnowledgeSourceStatus(sourceId: string, newStatus: SourceStatus, tenantId: string): Promise<KnowledgeSourceRecord> {
  const client = getClient();
  await client.connect();
  try {
    const extra = newStatus === "syncing" ? ", last_sync_at = NOW()" : "";
    const row = await client.query(
      `UPDATE public.knowledge_sources SET status = $1, updated_at = NOW()${extra} WHERE id = $2 AND tenant_id = $3 RETURNING *`,
      [newStatus, sourceId, tenantId],
    );
    if (row.rows.length === 0) throw new Error(`Knowledge source '${sourceId}' not found for tenant '${tenantId}'`);
    return rowToSource(row.rows[0]);
  } finally {
    await client.end();
  }
}
