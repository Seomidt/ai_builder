/**
 * Phase 11 — Lexical Search Service
 * INV-RET5: Lexical search must be tenant-scoped.
 * INV-RET6: Lexical scores must be in [0, 1].
 * Uses PostgreSQL full-text search (GIN tsvector) for ranked lexical retrieval.
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

export interface LexicalHit {
  chunkId: string;
  documentId: string;
  sourceId: string;
  content: string;
  scoreLexical: number;
}

// ─── lexicalSearch ────────────────────────────────────────────────────────────
// INV-RET5: Tenant isolation enforced in WHERE clause.
// INV-RET6: Score clamped to [0, 1].
// Uses ts_rank_cd (cover density) for deterministic BM25-style scoring.

export async function lexicalSearch(params: {
  tenantId: string;
  queryText: string;
  topK?: number;
  client?: pg.Client;
}): Promise<LexicalHit[]> {
  const { tenantId, queryText, topK = 10 } = params;
  const useExternal = !params.client;
  const client = params.client ?? getClient();
  if (useExternal) await client.connect();

  try {
    // Build tsquery safely — fall back to plain plainto_tsquery on error
    const sanitized = queryText.replace(/[^\w\s]/g, " ").trim();
    const tsq = sanitized.length > 0 ? sanitized : "unknown";

    const row = await client.query(
      `SELECT
         ic.id         AS chunk_id,
         ic.document_id,
         kie.source_id,
         ic.content,
         LEAST(1.0, GREATEST(0.0,
           ts_rank_cd(
             to_tsvector('english', ic.content),
             plainto_tsquery('english', $2),
             32
           ) * 10.0
         )) AS score_lexical
       FROM public.ingestion_chunks ic
       LEFT JOIN public.knowledge_index_entries kie ON kie.chunk_id = ic.id AND kie.tenant_id = $1
       WHERE ic.tenant_id = $1
         AND to_tsvector('english', ic.content) @@ plainto_tsquery('english', $3)
       ORDER BY score_lexical DESC, ic.id ASC
       LIMIT $4`,
      [tenantId, queryText, tsq, Math.min(topK, 100)],
    );

    return row.rows.map((r) => ({
      chunkId: r["chunk_id"] as string,
      documentId: r["document_id"] as string,
      sourceId: (r["source_id"] as string) ?? "",
      content: r["content"] as string,
      scoreLexical: parseFloat((r["score_lexical"] as number).toString()),
    }));
  } finally {
    if (useExternal) await client.end();
  }
}

// ─── lexicalSearchFallback ────────────────────────────────────────────────────
// Used when query has no FTS matches — returns scored results by ILIKE.

export async function lexicalSearchFallback(params: {
  tenantId: string;
  queryText: string;
  topK?: number;
  client?: pg.Client;
}): Promise<LexicalHit[]> {
  const { tenantId, queryText, topK = 10 } = params;
  const useExternal = !params.client;
  const client = params.client ?? getClient();
  if (useExternal) await client.connect();

  try {
    const words = queryText.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (words.length === 0) return [];

    const likeConditions = words.slice(0, 3).map((_, i) => `LOWER(ic.content) LIKE $${i + 3}`).join(" OR ");
    const likeVals = words.slice(0, 3).map((w) => `%${w}%`);

    const row = await client.query(
      `SELECT ic.id AS chunk_id, ic.document_id, kie.source_id, ic.content,
         LEAST(1.0, COALESCE(SIMILARITY(LOWER(ic.content), LOWER($2)), 0) * 0.5) AS score_lexical
       FROM public.ingestion_chunks ic
       LEFT JOIN public.knowledge_index_entries kie ON kie.chunk_id = ic.id AND kie.tenant_id = $1
       WHERE ic.tenant_id = $1 AND (${likeConditions})
       ORDER BY score_lexical DESC, ic.id ASC LIMIT $${words.slice(0,3).length + 3}`,
      [tenantId, queryText, ...likeVals, Math.min(topK, 100)],
    );

    return row.rows.map((r) => ({
      chunkId: r["chunk_id"] as string,
      documentId: r["document_id"] as string,
      sourceId: (r["source_id"] as string) ?? "",
      content: r["content"] as string,
      scoreLexical: parseFloat((r["score_lexical"] as number).toString()),
    }));
  } finally {
    if (useExternal) await client.end();
  }
}
