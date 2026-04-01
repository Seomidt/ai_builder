/**
 * KB Retrieval Service — Storage 1.4
 *
 * DB-side vector similarity using pgvector <=> cosine distance operator.
 * Falls back to app-side cosine (real[]) if pgvector column not yet migrated.
 * Falls back to lexical-only if OpenAI unavailable.
 *
 * Search order:
 *  1. Embed query (OpenAI text-embedding-3-small)
 *  2a. IF embedding_vector_pgv column available:
 *      → DB-side cosine via HNSW index (<=> operator), ORDER BY distance ASC
 *      → Supplement with lexical fallback if vector results < topK
 *  2b. IF column not yet migrated:
 *      → App-side cosine on real[] (graceful degradation)
 *  3. IF OpenAI unavailable:
 *      → Lexical-only (pg_trgm + ts_rank)
 *
 * Part E: Only returns chunks from active/ready documents. Archived excluded.
 * Part F: Expert-aware via expert_knowledge_bases.
 * Part H: Each result includes retrievalChannel + debug metadata.
 */

import pg from "pg";
import { generateQueryEmbedding, cosineSimilarity } from "./kb-embeddings.ts";

/**
 * Authoritative list of document statuses eligible for retrieval.
 * 'processing' is included (Phase 5Z.2) so that partially-ready documents
 * with active, embedded chunks can be queried before full completion.
 * 'superseded', 'failed', 'draft', 'dead_letter' are intentionally excluded.
 */
export const RETRIEVAL_ALLOWED_DOCUMENT_STATUSES = ["ready", "active", "processing"] as const;
export type RetrievalAllowedDocumentStatus = typeof RETRIEVAL_ALLOWED_DOCUMENT_STATUSES[number];

/**
 * SQL IN-clause fragment derived from RETRIEVAL_ALLOWED_DOCUMENT_STATUSES.
 * All 4 retrieval SQL gates use this constant to avoid drift between the
 * exported type and the actual SQL filter.
 * Safe for string interpolation: values are compile-time `as const` string literals.
 */
const RETRIEVAL_STATUSES_SQL = RETRIEVAL_ALLOWED_DOCUMENT_STATUSES.map((s) => `'${s}'`).join(", ");
// => "'ready', 'active', 'processing'"

export interface KbSearchResult {
  chunkId:             string;
  knowledgeBaseId:     string;
  knowledgeDocumentId: string;
  assetVersionId:      string;
  assetId:             string;
  chunkText:           string;
  score:               number;
  scoreVector:         number;
  scoreLexical:        number;
  retrievalChannel:    "vector" | "lexical" | "hybrid";
  documentType?:       string;
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

// ── pgvector column availability cache ────────────────────────────────────────
let _pgvectorAvailable: boolean | null = null;

async function checkPgvectorColumn(client: pg.Client): Promise<boolean> {
  if (_pgvectorAvailable !== null) return _pgvectorAvailable;
  const result = await client.query(`
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'knowledge_embeddings'
      AND column_name  = 'embedding_vector_pgv'
    LIMIT 1
  `);
  _pgvectorAvailable = result.rows.length > 0;
  return _pgvectorAvailable;
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

  // Step 1 — Embed query first (vector-first priority)
  const queryVector = await generateQueryEmbedding(queryText);

  if (queryVector) {
    return vectorFirstSearch({ tenantId, queryText, queryVector, allowedKbIds, safeTopK });
  }
  // Part H: log when falling back
  console.log(`[kb-retrieval] OpenAI unavailable — using lexical-only for tenant=${tenantId}`);
  return lexicalSearch({ tenantId, queryText, allowedKbIds, safeTopK });
}

// ── vectorFirstSearch ─────────────────────────────────────────────────────────
// Uses DB-side cosine via pgvector <=> operator when available.
// Falls back to app-side cosine on real[] if pgvector not migrated yet.

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

  try {
    const pgvectorReady = await checkPgvectorColumn(client);

    // Part H: debug log
    console.log(`[kb-retrieval] tenant=${tenantId} pgvector=${pgvectorReady} topK=${safeTopK}`);

    let vectorResults: KbSearchResult[] = [];

    if (pgvectorReady) {
      // ── DB-side cosine similarity (Parts C + B) ─────────────────────────
      const kbFilter = allowedKbIds?.length ? `AND kc.knowledge_base_id = ANY($3::text[])` : "";
      const values: unknown[] = allowedKbIds?.length
        ? [tenantId, `[${queryVector.join(",")}]`, allowedKbIds, safeTopK * 2]
        : [tenantId, `[${queryVector.join(",")}]`, safeTopK * 2];
      const limitParam = allowedKbIds?.length ? 4 : 3;

      const result = await client.query(
        `SELECT
           kc.id                            AS chunk_id,
           kc.knowledge_base_id             AS kb_id,
           kc.knowledge_document_id         AS doc_id,
           kc.knowledge_document_version_id AS version_id,
           kc.chunk_text,
           kd.document_type,
           1 - (ke.embedding_vector_pgv <=> $2::vector) AS score_vector
         FROM knowledge_chunks kc
         INNER JOIN knowledge_embeddings ke
                 ON ke.knowledge_chunk_id     = kc.id
                AND ke.tenant_id              = kc.tenant_id
                AND ke.embedding_status       = 'completed'
                AND ke.embedding_vector_pgv   IS NOT NULL
         INNER JOIN knowledge_documents kd
                 ON kd.id             = kc.knowledge_document_id
                AND kd.document_status IN (${RETRIEVAL_STATUSES_SQL})
         WHERE kc.tenant_id    = $1
           AND kc.chunk_active = TRUE
           AND kc.chunk_text   IS NOT NULL
           ${kbFilter}
         ORDER BY ke.embedding_vector_pgv <=> $2::vector ASC
         LIMIT $${limitParam}`,
        values,
      );

      vectorResults = (result.rows as Array<Record<string, unknown>>).map((r) => ({
        chunkId:             r["chunk_id"]     as string,
        knowledgeBaseId:     r["kb_id"]        as string,
        knowledgeDocumentId: r["doc_id"]       as string,
        assetVersionId:      r["version_id"]   as string,
        assetId:             r["doc_id"]       as string,
        chunkText:           r["chunk_text"]   as string,
        documentType:        r["document_type"] as string | undefined,
        score:               Math.max(0, Math.min(1, Number(r["score_vector"]))),
        scoreVector:         Math.max(0, Math.min(1, Number(r["score_vector"]))),
        scoreLexical:        0,
        retrievalChannel:    "vector" as const,
      }));
    } else {
      // ── Graceful degradation: app-side cosine on real[] ──────────────────
      console.log("[kb-retrieval] pgvector column not yet available — using app-side cosine");
      const kbFilter = allowedKbIds?.length ? `AND kc.knowledge_base_id = ANY($2::text[])` : "";
      const values: unknown[] = allowedKbIds?.length ? [tenantId, allowedKbIds] : [tenantId];

      const result = await client.query(
        `SELECT
           kc.id                            AS chunk_id,
           kc.knowledge_base_id             AS kb_id,
           kc.knowledge_document_id         AS doc_id,
           kc.knowledge_document_version_id AS version_id,
           kc.chunk_text,
           kd.document_type,
           ke.embedding_vector
         FROM knowledge_chunks kc
         INNER JOIN knowledge_embeddings ke
                 ON ke.knowledge_chunk_id = kc.id
                AND ke.tenant_id          = kc.tenant_id
                AND ke.embedding_status   = 'completed'
                AND ke.embedding_vector   IS NOT NULL
         INNER JOIN knowledge_documents kd
                 ON kd.id = kc.knowledge_document_id
                AND kd.document_status IN (${RETRIEVAL_STATUSES_SQL})
         WHERE kc.tenant_id    = $1
           AND kc.chunk_active = TRUE
           AND kc.chunk_text   IS NOT NULL
           ${kbFilter}
         LIMIT 2000`,
        values,
      );

      vectorResults = (result.rows as Array<Record<string, unknown>>)
        .map((r) => {
          const vec = r["embedding_vector"] as number[];
          const sim = cosineSimilarity(queryVector, vec);
          return {
            chunkId:             r["chunk_id"]     as string,
            knowledgeBaseId:     r["kb_id"]        as string,
            knowledgeDocumentId: r["doc_id"]       as string,
            assetVersionId:      r["version_id"]   as string,
            assetId:             r["doc_id"]       as string,
            chunkText:           r["chunk_text"]   as string,
            documentType:        r["document_type"] as string | undefined,
            score:               sim,
            scoreVector:         sim,
            scoreLexical:        0,
            retrievalChannel:    "vector" as const,
          };
        })
        .sort((a, b) => b.scoreVector - a.scoreVector)
        .slice(0, safeTopK);
    }

    // Supplement with lexical if vector results insufficient
    if (vectorResults.length >= safeTopK) {
      return vectorResults.slice(0, safeTopK);
    }

    const needed         = safeTopK - vectorResults.length;
    const existingIds    = new Set(vectorResults.map((r) => r.chunkId));
    const lexical        = await _lexicalSearchWithClient(client, { tenantId, queryText, allowedKbIds, safeTopK: needed * 2, excludeChunkIds: [...existingIds] });
    const lexicalSlots   = lexical.slice(0, needed);

    return [
      ...vectorResults,
      ...lexicalSlots.map((r) => ({ ...r, retrievalChannel: "hybrid" as const })),
    ].sort((a, b) => b.score - a.score).slice(0, safeTopK);
  } finally {
    await client.end();
  }
}

// ── lexicalSearch ─────────────────────────────────────────────────────────────
// Public export for lexical-only searches. Opens its own connection.

export async function lexicalSearch(params: {
  tenantId:         string;
  queryText:        string;
  allowedKbIds:     string[] | null;
  safeTopK:         number;
  excludeChunkIds?: string[];
}): Promise<KbSearchResult[]> {
  const client = getClient();
  await client.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS pg_trgm").catch(() => {});
    return _lexicalSearchWithClient(client, params);
  } finally {
    await client.end();
  }
}

// Internal: uses caller-owned client connection
async function _lexicalSearchWithClient(
  client: pg.Client,
  params: {
    tenantId:         string;
    queryText:        string;
    allowedKbIds:     string[] | null;
    safeTopK:         number;
    excludeChunkIds?: string[];
  },
): Promise<KbSearchResult[]> {
  const { tenantId, queryText, allowedKbIds, safeTopK, excludeChunkIds } = params;

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
       kd.document_type,
       LEAST(1.0, GREATEST(0.0,
         COALESCE(SIMILARITY(kc.chunk_text, $2), 0.0) * 0.6
         + COALESCE(ts_rank(to_tsvector('english', kc.chunk_text), plainto_tsquery('english', $2), 32) * 2.0, 0.0)
       )) AS score_text
     FROM knowledge_chunks kc
     INNER JOIN knowledge_documents kd
             ON kd.id = kc.knowledge_document_id
            AND kd.document_status IN (${RETRIEVAL_STATUSES_SQL})
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
      chunkId:             r["chunk_id"]      as string,
      knowledgeBaseId:     r["kb_id"]         as string,
      knowledgeDocumentId: r["doc_id"]        as string,
      assetVersionId:      r["version_id"]    as string,
      assetId:             r["doc_id"]        as string,
      chunkText:           r["chunk_text"]    as string,
      documentType:        r["document_type"] as string | undefined,
      score:               Number(r["score_text"]),
      scoreVector:         0,
      scoreLexical:        Number(r["score_text"]),
      retrievalChannel:    "lexical" as const,
    }));
}

// ── searchByAsset ─────────────────────────────────────────────────────────────
// Part E: find chunks similar to a given asset by using that asset's embeddings.

export async function searchByAsset(params: {
  tenantId:     string;
  assetId:      string;
  topK?:        number;
  kbIds?:       string[];
  expertId?:    string;
}): Promise<KbSearchResult[]> {
  const { tenantId, assetId, topK = 10, kbIds, expertId } = params;
  const safeTopK = Math.min(Math.max(1, topK), 100);

  // Get all embeddings for this asset, compute centroid
  const client = getClient();
  await client.connect();

  try {
    const pgvectorReady = await checkPgvectorColumn(client);

    if (pgvectorReady) {
      // Average embedding across all chunks of this asset as query vector
      const centroidResult = await client.query(
        `SELECT avg(embedding_vector_pgv) AS centroid
         FROM knowledge_embeddings
         WHERE tenant_id = $1
           AND knowledge_document_id = $2
           AND embedding_status = 'completed'
           AND embedding_vector_pgv IS NOT NULL`,
        [tenantId, assetId],
      );
      const centroid = centroidResult.rows[0]?.["centroid"] as string | null;
      if (!centroid) return [];

      // Search using the centroid vector (same as query search)
      const kbFilter = kbIds?.length ? `AND kc.knowledge_base_id = ANY($3::text[])` : "";
      const values: unknown[] = kbIds?.length
        ? [tenantId, centroid, kbIds, safeTopK]
        : [tenantId, centroid, safeTopK];
      const limitParam = kbIds?.length ? 4 : 3;

      const result = await client.query(
        `SELECT
           kc.id                            AS chunk_id,
           kc.knowledge_base_id             AS kb_id,
           kc.knowledge_document_id         AS doc_id,
           kc.knowledge_document_version_id AS version_id,
           kc.chunk_text,
           kd.document_type,
           1 - (ke.embedding_vector_pgv <=> $2::vector) AS score_vector
         FROM knowledge_chunks kc
         INNER JOIN knowledge_embeddings ke
                 ON ke.knowledge_chunk_id     = kc.id
                AND ke.tenant_id              = kc.tenant_id
                AND ke.embedding_status       = 'completed'
                AND ke.embedding_vector_pgv   IS NOT NULL
         INNER JOIN knowledge_documents kd
                 ON kd.id             = kc.knowledge_document_id
                AND kd.document_status IN (${RETRIEVAL_STATUSES_SQL})
         WHERE kc.tenant_id    = $1
           AND kc.knowledge_document_id != ${ kbIds?.length ? 5 : 4 }
           AND kc.chunk_active = TRUE
           ${kbFilter}
         ORDER BY ke.embedding_vector_pgv <=> $2::vector ASC
         LIMIT $${limitParam}`,
        [...values, assetId],
      );

      return (result.rows as Array<Record<string, unknown>>).map((r) => ({
        chunkId:             r["chunk_id"]      as string,
        knowledgeBaseId:     r["kb_id"]         as string,
        knowledgeDocumentId: r["doc_id"]        as string,
        assetVersionId:      r["version_id"]    as string,
        assetId:             r["doc_id"]        as string,
        chunkText:           r["chunk_text"]    as string,
        documentType:        r["document_type"] as string | undefined,
        score:               Math.max(0, Math.min(1, Number(r["score_vector"]))),
        scoreVector:         Math.max(0, Math.min(1, Number(r["score_vector"]))),
        scoreLexical:        0,
        retrievalChannel:    "vector" as const,
      }));
    }

    // Fallback — pgvector not available, use document title/type for lexical similarity
    const docResult = await client.query(
      `SELECT title FROM knowledge_documents WHERE id = $1 AND tenant_id = $2 LIMIT 1`,
      [assetId, tenantId],
    );
    const title = docResult.rows[0]?.["title"] as string | null;
    if (!title) return [];
    return lexicalSearch({ tenantId, queryText: title, allowedKbIds: kbIds ?? null, safeTopK });
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
      `SELECT knowledge_base_id FROM expert_knowledge_bases WHERE tenant_id = $1 AND expert_id = $2`,
      [tenantId, expertId],
    );
    return result.rows.map((r: Record<string, string>) => r["knowledge_base_id"]);
  } finally {
    await client.end();
  }
}
