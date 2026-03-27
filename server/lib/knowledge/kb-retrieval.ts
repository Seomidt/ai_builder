/**
 * KB Retrieval Service — Storage 1.2
 *
 * Searches knowledge_chunks (and knowledge_embeddings) for a given tenant.
 * Part D+F: tenant-scoped, expert-aware, no duplicate pipeline.
 *
 * Strategy:
 *  1. Text similarity (pg_trgm) as primary retrieval signal — works without vectors
 *  2. If query embedding available (OpenAI), rerank top candidates by cosine similarity
 *  3. Expert-aware: filter to knowledge bases linked to an expert
 */

import pg from "pg";
import { generateQueryEmbedding, cosineSimilarity } from "./kb-embeddings";
import type { PgSqlType } from "drizzle-orm/pg-core";

export interface KbSearchResult {
  chunkId:            string;
  knowledgeBaseId:    string;
  knowledgeDocumentId: string;
  assetVersionId:     string;
  chunkText:          string;
  score:              number;
  scoreText:          number;
  scoreVector:        number;
}

export interface KbSearchParams {
  tenantId:     string;
  queryText:    string;
  topK?:        number;
  kbIds?:       string[];     // filter to specific knowledge bases
  expertId?:    string;       // filter to knowledge bases linked to this expert
  sourceIds?:   string[];     // filter to specific data source IDs
}

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ── searchKnowledge ────────────────────────────────────────────────────────────

export async function searchKnowledge(params: KbSearchParams): Promise<KbSearchResult[]> {
  const { tenantId, queryText, topK = 10, kbIds, expertId, sourceIds } = params;

  if (!queryText?.trim()) throw new Error("queryText is required");
  if (!tenantId?.trim())  throw new Error("tenantId is required");

  const safeTopK = Math.min(Math.max(1, topK), 100);

  // ── Step 1: Resolve allowed knowledge base IDs ────────────────────────────
  let allowedKbIds: string[] | null = kbIds?.length ? [...kbIds] : null;

  if (expertId) {
    const expertKbs = await resolveExpertKbs(tenantId, expertId);
    if (expertKbs.length === 0) return []; // expert has no linked KBs
    allowedKbIds = allowedKbIds
      ? allowedKbIds.filter((id) => expertKbs.includes(id))
      : expertKbs;
    if (allowedKbIds.length === 0) return [];
  }

  // ── Step 2: Text similarity search on knowledge_chunks ──────────────────
  const client = getClient();
  await client.connect();

  let candidates: Array<{
    chunk_id: string; kb_id: string; doc_id: string; version_id: string;
    chunk_text: string; score_text: number;
  }> = [];

  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm").catch(() => {});

    // Build optional filters
    const extraFilters: string[] = [];
    const values: unknown[] = [tenantId, queryText.slice(0, 2000), safeTopK * 5]; // fetch 5x for reranking

    if (allowedKbIds?.length) {
      values.push(allowedKbIds);
      extraFilters.push(`kc.knowledge_base_id = ANY($${values.length}::text[])`);
    }

    const whereClause = extraFilters.length
      ? "AND " + extraFilters.join(" AND ")
      : "";

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
               ts_rank(
                 to_tsvector('english', kc.chunk_text),
                 plainto_tsquery('english', $2),
                 32
               ) * 2.0,
             0.0)
         )) AS score_text
       FROM knowledge_chunks kc
       WHERE kc.tenant_id = $1
         AND kc.chunk_active = TRUE
         AND kc.chunk_text IS NOT NULL
         ${whereClause}
       ORDER BY score_text DESC
       LIMIT $3`,
      values,
    );

    candidates = result.rows as typeof candidates;
  } finally {
    await client.end();
  }

  if (candidates.length === 0) return [];

  // ── Step 3: Rerank with real embeddings if available ─────────────────────
  let queryVector: number[] | null = null;
  try {
    queryVector = await generateQueryEmbedding(queryText);
  } catch {}

  let results: KbSearchResult[];

  if (queryVector && candidates.length > 0) {
    results = await rerankByEmbedding(tenantId, queryVector, candidates, safeTopK);
  } else {
    // Fall back to text-only scoring
    results = candidates.slice(0, safeTopK).map((c) => ({
      chunkId:             c.chunk_id,
      knowledgeBaseId:     c.kb_id,
      knowledgeDocumentId: c.doc_id,
      assetVersionId:      c.version_id,
      chunkText:           c.chunk_text,
      score:               c.score_text,
      scoreText:           c.score_text,
      scoreVector:         0,
    }));
  }

  return results.sort((a, b) => b.score - a.score).slice(0, safeTopK);
}

// ── rerankByEmbedding ─────────────────────────────────────────────────────────
// Fetches stored embedding vectors for candidates and reranks by cosine similarity.

async function rerankByEmbedding(
  tenantId:    string,
  queryVector: number[],
  candidates:  Array<{ chunk_id: string; kb_id: string; doc_id: string; version_id: string; chunk_text: string; score_text: number }>,
  topK:        number,
): Promise<KbSearchResult[]> {
  const chunkIds = candidates.map((c) => c.chunk_id);

  const client = getClient();
  await client.connect();

  let embRows: Array<{ chunk_id: string; embedding_vector: number[] }> = [];
  try {
    const result = await client.query(
      `SELECT knowledge_chunk_id AS chunk_id, embedding_vector
       FROM knowledge_embeddings
       WHERE tenant_id = $1
         AND knowledge_chunk_id = ANY($2::text[])
         AND embedding_status = 'completed'
         AND embedding_vector IS NOT NULL`,
      [tenantId, chunkIds],
    );
    embRows = result.rows as typeof embRows;
  } finally {
    await client.end();
  }

  const vectorMap = new Map(embRows.map((r) => [r.chunk_id, r.embedding_vector]));

  return candidates.map((c) => {
    const vec = vectorMap.get(c.chunk_id);
    const scoreVector = vec ? cosineSimilarity(queryVector, vec) : 0;
    const combined    = vec
      ? scoreVector * 0.7 + c.score_text * 0.3
      : c.score_text;

    return {
      chunkId:             c.chunk_id,
      knowledgeBaseId:     c.kb_id,
      knowledgeDocumentId: c.doc_id,
      assetVersionId:      c.version_id,
      chunkText:           c.chunk_text,
      score:               combined,
      scoreText:           c.score_text,
      scoreVector,
    };
  });
}

// ── resolveExpertKbs ──────────────────────────────────────────────────────────
// Part F: returns knowledge base IDs linked to an expert.

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
