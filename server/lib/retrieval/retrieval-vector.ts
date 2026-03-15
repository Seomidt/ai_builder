/**
 * Phase 11 — Vector Search Service
 * INV-RET3: Vector search must be tenant-scoped.
 * INV-RET4: Vector scores must be in [0, 1].
 * Uses pgvector-style cosine similarity. Since Phase 10 embeddings are simulated
 * (no raw vector stored), vector scores are derived from content-query text similarity
 * using pg_trgm SIMILARITY() as a cosine-distance proxy.
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

export interface VectorHit {
  chunkId: string;
  documentId: string;
  sourceId: string;
  content: string;
  scoreVector: number;
}

// ─── vectorSearch ──────────────────────────────────────────────────────────────
// INV-RET3: Tenant isolation enforced in WHERE clause.
// INV-RET4: Score clamped to [0, 1].
// Uses ts_rank as vector-score proxy (chunks with completed embeddings only).

export async function vectorSearch(params: {
  tenantId: string;
  queryText: string;
  topK?: number;
  client?: pg.Client;
}): Promise<VectorHit[]> {
  const { tenantId, queryText, topK = 10 } = params;
  const useExternal = !params.client;
  const client = params.client ?? getClient();
  if (useExternal) await client.connect();

  try {
    // INV-RET3: Scoped to tenant's chunks with completed embeddings
    // Score: ts_rank normalized to [0,1] + trgm similarity blend as vector-proxy
    const row = await client.query(
      `SELECT
         ic.id         AS chunk_id,
         ic.document_id,
         kie.source_id,
         ic.content,
         LEAST(1.0, GREATEST(0.0,
           COALESCE(
             ts_rank(
               to_tsvector('english', ic.content),
               plainto_tsquery('english', $2),
               32
             ) * 5.0,
             0.0
           ) +
           COALESCE(SIMILARITY(ic.content, $2), 0.0) * 0.5
         )) AS score_vector
       FROM public.ingestion_chunks ic
       JOIN public.ingestion_embeddings ie ON ie.chunk_id = ic.id
       LEFT JOIN public.knowledge_index_entries kie ON kie.chunk_id = ic.id AND kie.tenant_id = $1
       WHERE ic.tenant_id = $1
         AND ie.tenant_id = $1
         AND ie.embedding_status = 'completed'
       ORDER BY score_vector DESC, ic.id ASC
       LIMIT $3`,
      [tenantId, queryText, Math.min(topK, 100)],
    );

    return row.rows.map((r) => ({
      chunkId: r["chunk_id"] as string,
      documentId: r["document_id"] as string,
      sourceId: (r["source_id"] as string) ?? "",
      content: r["content"] as string,
      scoreVector: parseFloat((r["score_vector"] as number).toString()),
    }));
  } finally {
    if (useExternal) await client.end();
  }
}

// ─── ensurePgTrgm ─────────────────────────────────────────────────────────────

export async function ensurePgTrgm(client: pg.Client): Promise<void> {
  await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`).catch(() => {});
}
