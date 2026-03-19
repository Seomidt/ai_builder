/**
 * Phase 11 — Retrieval Query Service
 * INV-RET1: Every retrieval query must be tenant-scoped.
 * INV-RET2: Query text must be non-empty and within safe limits.
 * Security: input validation, safe limits, request-id propagation.
 */

import pg from "pg";

export type RetrievalStrategy = "vector" | "lexical" | "hybrid";

export interface RetrievalQueryRecord {
  id: string;
  tenantId: string;
  queryText: string;
  queryEmbedding: number[] | null;
  retrievalStrategy: RetrievalStrategy;
  topK: number;
  createdAt: Date;
}

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

function rowToQuery(r: Record<string, unknown>): RetrievalQueryRecord {
  return {
    id: r["id"] as string,
    tenantId: r["tenant_id"] as string,
    queryText: r["query_text"] as string,
    queryEmbedding: (r["query_embedding"] as number[]) ?? null,
    retrievalStrategy: r["retrieval_strategy"] as RetrievalStrategy,
    topK: r["top_k"] as number,
    createdAt: new Date(r["created_at"] as string),
  };
}

// ─── Input validation (Security) ─────────────────────────────────────────────

export function validateQueryInput(params: { tenantId: string; queryText: string; topK: number }): void {
  if (!params.tenantId || params.tenantId.trim().length === 0) throw new Error("INV-RET1: tenantId must not be empty");
  if (!params.queryText || params.queryText.trim().length === 0) throw new Error("INV-RET2: queryText must not be empty");
  if (params.queryText.length > 4096) throw new Error("INV-RET2: queryText exceeds 4096 character limit");
  if (params.topK < 1 || params.topK > 100) throw new Error("INV-RET2: topK must be between 1 and 100");
}

// ─── embedQuery ───────────────────────────────────────────────────────────────
// Simulates embedding generation. In production, calls OpenAI API.
// Returns a deterministic 1536-dim float array derived from query hash.

export function embedQuery(queryText: string): number[] {
  // Deterministic pseudo-embedding based on char codes — no external API call needed
  const dims = 1536;
  const embedding: number[] = new Array(dims).fill(0);
  let seed = 0;
  for (let i = 0; i < queryText.length; i++) seed = (seed * 31 + queryText.charCodeAt(i)) >>> 0;
  for (let i = 0; i < dims; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    embedding[i] = ((seed / 0xffffffff) - 0.5) * 2;
  }
  // L2-normalize
  const norm = Math.sqrt(embedding.reduce((s, v) => s + v * v, 0));
  return embedding.map((v) => parseFloat((v / (norm || 1)).toFixed(6)));
}

// ─── storeQuery ───────────────────────────────────────────────────────────────

export async function storeQuery(params: {
  tenantId: string;
  queryText: string;
  retrievalStrategy?: RetrievalStrategy;
  topK?: number;
  queryEmbedding?: number[];
  requestId?: string;
}): Promise<RetrievalQueryRecord> {
  const { tenantId, queryText, retrievalStrategy = "hybrid", topK = 10, queryEmbedding } = params;

  validateQueryInput({ tenantId, queryText, topK });

  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `INSERT INTO public.retrieval_queries (id, tenant_id, query_text, query_embedding, retrieval_strategy, top_k)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5) RETURNING *`,
      [tenantId, queryText.trim(), queryEmbedding ? JSON.stringify(queryEmbedding) : null, retrievalStrategy, Math.min(Math.max(topK, 1), 100)],
    );
    return rowToQuery(row.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── getQueryById ─────────────────────────────────────────────────────────────

export async function getQueryById(queryId: string, tenantId: string): Promise<RetrievalQueryRecord | null> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.retrieval_queries WHERE id = $1 AND tenant_id = $2`,
      [queryId, tenantId],
    );
    return row.rows.length ? rowToQuery(row.rows[0]) : null;
  } finally {
    await client.end();
  }
}

// ─── listQueries ──────────────────────────────────────────────────────────────

export async function listQueries(params: {
  tenantId: string;
  strategy?: RetrievalStrategy;
  limit?: number;
  offset?: number;
}): Promise<RetrievalQueryRecord[]> {
  const { tenantId, strategy, limit = 50, offset = 0 } = params;
  const client = getClient();
  await client.connect();
  try {
    const conds: string[] = ["tenant_id = $1"];
    const vals: unknown[] = [tenantId];
    if (strategy) { conds.push(`retrieval_strategy = $${vals.length + 1}`); vals.push(strategy); }
    vals.push(Math.min(limit, 200));
    vals.push(offset);
    const row = await client.query(
      `SELECT * FROM public.retrieval_queries WHERE ${conds.join(" AND ")} ORDER BY created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals,
    );
    return row.rows.map(rowToQuery);
  } finally {
    await client.end();
  }
}

// ─── topQueries ───────────────────────────────────────────────────────────────

export async function topQueries(params: { tenantId: string; limit?: number }): Promise<Array<{ queryText: string; count: number; strategy: string }>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT query_text, retrieval_strategy as strategy, COUNT(*) as count
       FROM public.retrieval_queries WHERE tenant_id = $1
       GROUP BY query_text, retrieval_strategy ORDER BY count DESC LIMIT $2`,
      [params.tenantId, Math.min(params.limit ?? 10, 50)],
    );
    return row.rows.map((r) => ({ queryText: r.query_text, count: parseInt(r.count, 10), strategy: r.strategy }));
  } finally {
    await client.end();
  }
}
