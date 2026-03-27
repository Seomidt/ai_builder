/**
 * KB Retrieval Service — Storage 1.3
 *
 * Vector-first hybrid retrieval over knowledge_chunks + knowledge_embeddings.
 *
 * Search order (Part B):
 *  1. Embed query via OpenAI (text-embedding-3-small)
 *  2. IF embeddings exist for tenant:
 *     → Fetch all active indexed chunks WITH embeddings
 *     → Rank by cosine similarity (application-layer, real[]  storage)
 *     → Supplement with lexical fallback if vector results < topK
 *  3. IF OpenAI unavailable OR no embeddings at all:
 *     → Lexical-only (pg_trgm + ts_rank)
 *
 * Note on vector indexing (Part C):
 *   embedding_vector is stored as real[] (PostgreSQL float array), not pgvector
 *   native vector type. Cosine similarity is computed application-side.
 *   For true pgvector ANN indexing (HNSW/IVFFlat), schema migration to
 *   vector(1536) type is needed — this is documented as a future upgrade path.
 *   At current scale (<100K chunks per tenant) application-side cosine is safe.
 *
 * Part E:
 *   Only returns chunks from active, indexed documents.
 *   Archived/failed documents are excluded.
 *
 * Part F (expert-aware):
 *   Filters to knowledge bases linked to an expert via expert_knowledge_bases.
 */

import pg from "pg";
import { generateQueryEmbedding, cosineSimilarity } from "./kb-embeddings";

export interface KbSearchResult {
  chunkId:             string;
  knowledgeBaseId:     string;
  knowledgeDocumentId: string;
  assetVersionId:      string;
  chunkText:           string;
  score:               number;
  scoreVector:         number;
  scoreLexical:        number;
  retrievalChannel:    "vector" | "lexical" | "hybrid";
}

export interface KbSearchParams {
  tenantId:  string;
  queryText: string;
  topK?:     number;
  kbIds?:    string[];
  expertId?: string;
}

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ── searchKnowledge ────────────────────────────────────────────────────────────

export async function searchKnowledge(params: KbSearchParams): Promise<KbSearchResult[]> {
  const { tenantId, queryText, topK = 10, kbIds, expertId } = params;

  if (!queryText?.trim()) throw new Error("queryText is required");
  if (!tenantId?.trim())  throw new Error("tenantId is required");

  const safeTopK = Math.min(Math.max(1, topK), 100);

  // Part F — Resolve allowed KB IDs via expert filter
  let allowedKbIds: string[] | null = kbIds?.length ? [...kbIds] : null;
  if (expertId) {
    const expertKbs = await resolveExpertKbs(tenantId, expertId);
    if (expertKbs.length === 0) return [];
    allowedKbIds = allowedKbIds
      ? allowedKbIds.filter((id) => expertKbs.includes(id))
      : expertKbs;
    if (allowedKbIds.length === 0) return [];
  }

  // Part B Step 1 — Embed query first (vector-first priority)
  const queryVector = await generateQueryEmbedding(queryText);

  if (queryVector) {
    return vectorFirstSearch({ tenantId, queryText, queryVector, allowedKbIds, safeTopK });
  } else {
    // Lexical fallback — OpenAI unavailable
    return lexicalSearch({ tenantId, queryText, allowedKbIds, safeTopK });
  }
}

// ── vectorFirstSearch ─────────────────────────────────────────────────────────
// Part B: embed query first, cosine rank, supplement with lexical if needed.

async function vectorFirstSearch(params: {
  tenantId:     string;
  queryText:    string;
  queryVector:  number[];
  allowedKbIds: string[] | null;
  safeTopK:     number;
}): Promise<KbSearchResult[]> {
  const { tenantId, queryText, queryVector, allowedKbIds, safeTopK } = params;

  const client = getClient();
  await client.connect();

  // Fetch chunks that have completed embeddings — tenant-safe, indexed docs only (Part E)
  const kbFilter = allowedKbIds?.length
    ? `AND kc.knowledge_base_id = ANY($2::text[])`
    : "";
  const values: unknown[] = allowedKbIds?.length
    ? [tenantId, allowedKbIds]
    : [tenantId];

  let embRows: Array<{
    chunk_id: string; kb_id: string; doc_id: string; version_id: string;
    chunk_text: string; embedding_vector: number[];
  }> = [];

  try {
    const result = await client.query(
      `SELECT
         kc.id                            AS chunk_id,
         kc.knowledge_base_id             AS kb_id,
         kc.knowledge_document_id         AS doc_id,
         kc.knowledge_document_version_id AS version_id,
         kc.chunk_text,
         ke.embedding_vector
       FROM knowledge_chunks kc
       INNER JOIN knowledge_embeddings ke
               ON ke.knowledge_chunk_id = kc.id
              AND ke.tenant_id          = kc.tenant_id
              AND ke.embedding_status   = 'completed'
              AND ke.embedding_vector   IS NOT NULL
       INNER JOIN knowledge_documents kd
               ON kd.id        = kc.knowledge_document_id
              AND kd.document_status IN ('ready', 'active')
       WHERE kc.tenant_id    = $1
         AND kc.chunk_active = TRUE
         AND kc.chunk_text   IS NOT NULL
         ${kbFilter}
       LIMIT 2000`,
      values,
    );
    embRows = result.rows as typeof embRows;
  } finally {
    await client.end();
  }

  // Compute cosine similarity in-app and rank
  const vectorResults = embRows
    .map((r) => ({
      chunkId:             r.chunk_id,
      knowledgeBaseId:     r.kb_id,
      knowledgeDocumentId: r.doc_id,
      assetVersionId:      r.version_id,
      chunkText:           r.chunk_text,
      scoreVector:         cosineSimilarity(queryVector, r.embedding_vector),
      scoreLexical:        0,
    }))
    .sort((a, b) => b.scoreVector - a.scoreVector)
    .slice(0, safeTopK);

  // If we have enough vector results, return them
  if (vectorResults.length >= safeTopK) {
    return vectorResults.map((r) => ({
      ...r,
      score:            r.scoreVector,
      retrievalChannel: "vector" as const,
    }));
  }

  // Supplement with lexical fallback for remaining slots (Part B)
  const needed = safeTopK - vectorResults.length;
  const existingChunkIds = new Set(vectorResults.map((r) => r.chunkId));

  const lexical = await lexicalSearch({
    tenantId,
    queryText,
    allowedKbIds,
    safeTopK: needed * 3,
    excludeChunkIds: [...existingChunkIds],
  });

  const lexicalSlots = lexical.slice(0, needed);

  const combined: KbSearchResult[] = [
    ...vectorResults.map((r) => ({ ...r, score: r.scoreVector, retrievalChannel: "vector" as const })),
    ...lexicalSlots.map((r) => ({ ...r, retrievalChannel: r.scoreVector > 0 ? "hybrid" as const : "lexical" as const })),
  ];

  return combined.sort((a, b) => b.score - a.score).slice(0, safeTopK);
}

// ── lexicalSearch ─────────────────────────────────────────────────────────────
// Fallback: pg_trgm + ts_rank. Used when OpenAI unavailable or to supplement.

async function lexicalSearch(params: {
  tenantId:         string;
  queryText:        string;
  allowedKbIds:     string[] | null;
  safeTopK:         number;
  excludeChunkIds?: string[];
}): Promise<KbSearchResult[]> {
  const { tenantId, queryText, allowedKbIds, safeTopK, excludeChunkIds } = params;

  const client = getClient();
  await client.connect();

  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm").catch(() => {});

    const extraFilters: string[] = [];
    const values: unknown[] = [tenantId, queryText.slice(0, 2000), safeTopK * 3];

    if (allowedKbIds?.length) {
      values.push(allowedKbIds);
      extraFilters.push(`kc.knowledge_base_id = ANY($${values.length}::text[])`);
    }
    if (excludeChunkIds?.length) {
      values.push(excludeChunkIds);
      extraFilters.push(`kc.id != ALL($${values.length}::text[])`);
    }

    const whereClause = extraFilters.length ? "AND " + extraFilters.join(" AND ") : "";

    const result = await client.query(
      `SELECT
         kc.id                            AS chunk_id,
         kc.knowledge_base_id             AS kb_id,
         kc.knowledge_document_id         AS doc_id,
         kc.knowledge_document_version_id AS version_id,
         kc.chunk_text,
         LEAST(1.0, GREATEST(0.0,
           COALESCE(SIMILARITY(kc.chunk_text, $2), 0.0) * 0.6
           + COALESCE(
               ts_rank(to_tsvector('english', kc.chunk_text), plainto_tsquery('english', $2), 32) * 2.0,
             0.0)
         )) AS score_text
       FROM knowledge_chunks kc
       INNER JOIN knowledge_documents kd
               ON kd.id = kc.knowledge_document_id
              AND kd.document_status IN ('ready', 'active')
       WHERE kc.tenant_id    = $1
         AND kc.chunk_active = TRUE
         AND kc.chunk_text   IS NOT NULL
         ${whereClause}
       ORDER BY score_text DESC
       LIMIT $3`,
      values,
    );

    return (result.rows as Array<Record<string, unknown>>)
      .slice(0, safeTopK)
      .map((r) => ({
        chunkId:             r["chunk_id"] as string,
        knowledgeBaseId:     r["kb_id"]    as string,
        knowledgeDocumentId: r["doc_id"]   as string,
        assetVersionId:      r["version_id"] as string,
        chunkText:           r["chunk_text"] as string,
        score:               Number(r["score_text"]),
        scoreVector:         0,
        scoreLexical:        Number(r["score_text"]),
        retrievalChannel:    "lexical" as const,
      }));
  } finally {
    await client.end();
  }
}

// ── resolveExpertKbs ──────────────────────────────────────────────────────────

async function resolveExpertKbs(tenantId: string, expertId: string): Promise<string[]> {
  const client = getClient();
  await client.connect();
  try {
    const result = await client.query(
      `SELECT knowledge_base_id FROM expert_knowledge_bases
       WHERE tenant_id = $1 AND expert_id = $2`,
      [tenantId, expertId],
    );
    return result.rows.map((r: Record<string, string>) => r["knowledge_base_id"]);
  } finally {
    await client.end();
  }
}
