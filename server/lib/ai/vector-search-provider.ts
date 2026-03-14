/**
 * vector-search-provider.ts — Phase 5D
 *
 * pgvector-backed search provider.
 *
 * All pgvector SQL is ISOLATED here. Application code must never contain raw
 * pgvector SQL — always go through this boundary.
 *
 * Design:
 *   - Cosine similarity by default (embeddings are normalized during ingest)
 *   - Full lifecycle + version + index-state + tenant safety filtering
 *   - Deterministic ranking for debuggability
 *   - Never silently widens scope (INV-VEC8)
 *
 * SQL approach: Drizzle sql`` template for parameterized inputs;
 * sql.raw() only for the vector literal (after full numeric validation).
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";
import { createHash } from "crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export type SimilarityMetric = "cosine" | "l2" | "inner_product";

export interface PgvectorSearchOptions {
  tenantId: string;
  knowledgeBaseId: string;
  topK: number;
  metric?: SimilarityMetric;
  similarityThreshold?: number;
}

export interface PgvectorSearchRow {
  embeddingId: string;
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  knowledgeBaseId: string;
  tenantId: string;
  chunkText: string | null;
  chunkIndex: number;
  chunkKey: string;
  sourcePageStart: number | null;
  sourceHeadingPath: string | null;
  contentHash: string | null;
  embeddingDimensions: number | null;
  similarityScore: number;
  similarityMetric: SimilarityMetric;
}

export interface PgvectorSearchResult {
  rows: PgvectorSearchRow[];
  candidatesSearched: number;
  queryHash: string;
  metric: SimilarityMetric;
  topKRequested: number;
  topKReturned: number;
  searchDurationMs: number;
  filterSummary: Record<string, unknown>;
}

export interface ExclusionCheckRow {
  embeddingId: string;
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  isActive: boolean;
  embeddingStatus: string;
  chunkActive: boolean;
  docLifecycleState: string;
  docStatus: string;
  isCurrentVersion: boolean;
  indexState: string | null;
  kbLifecycleState: string;
  exclusionReasons: string[];
}

// ─── Hash utility ─────────────────────────────────────────────────────────────

export function computeQueryHash(queryVector: number[]): string {
  const sample = queryVector.slice(0, 16).join(",");
  return createHash("sha256")
    .update(`dim:${queryVector.length}|sample:${sample}`)
    .digest("hex")
    .slice(0, 32);
}

// ─── Score normalization ──────────────────────────────────────────────────────

export function normalizeSimilarityScore(distance: number, metric: SimilarityMetric): number {
  if (metric === "cosine") return Math.max(0, Math.min(1, 1 - distance));
  if (metric === "inner_product") return Math.max(0, Math.min(1, (1 + distance) / 2));
  if (metric === "l2") return Math.max(0, 1 / (1 + distance));
  return 0;
}

// ─── Filter summary ───────────────────────────────────────────────────────────

export function buildVectorSearchFilterSummary(
  options: PgvectorSearchOptions,
): Record<string, unknown> {
  return {
    tenantId: options.tenantId,
    knowledgeBaseId: options.knowledgeBaseId,
    embeddingStatus: "completed",
    isActive: true,
    chunkActive: true,
    kbLifecycleState: "active",
    docLifecycleState: "active",
    docStatus: "ready",
    currentVersionOnly: true,
    indexState: "indexed",
    similarityMetric: options.metric ?? "cosine",
    topK: options.topK,
  };
}

// ─── Vector literal builder (safe: validates all values are finite) ────────────

function buildVectorLiteral(vector: number[]): string {
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) {
      throw new Error(`[vector-search-provider] Invalid value at index ${i}: ${vector[i]}`);
    }
  }
  return `[${vector.join(",")}]`;
}

// ─── Main search execution ────────────────────────────────────────────────────

export async function searchPgvector(
  queryVector: number[],
  options: PgvectorSearchOptions,
): Promise<PgvectorSearchResult> {
  const { tenantId, knowledgeBaseId, topK, metric = "cosine", similarityThreshold } = options;

  if (!tenantId) throw new Error("[vector-search-provider] INV-VEC1: tenantId is required");
  if (!knowledgeBaseId) throw new Error("[vector-search-provider] INV-VEC1: knowledgeBaseId is required");
  if (!queryVector || queryVector.length === 0) {
    throw new Error("[vector-search-provider] INV-VEC11: query embedding must not be empty");
  }
  if (topK < 1) throw new Error("[vector-search-provider] topK must be >= 1");

  const vecLit = buildVectorLiteral(queryVector);
  const queryHash = computeQueryHash(queryVector);
  const filterSummary = buildVectorSearchFilterSummary(options);
  const startMs = Date.now();

  // pgvector operators:
  //   <=>  cosine distance  (0=identical, 2=opposite)
  //   <->  L2 distance
  //   <#>  negative inner product  (order DESC)
  const vecRaw = sql.raw(`'${vecLit}'::vector`);

  let queryResult: { rows: Record<string, unknown>[] };

  if (metric === "cosine") {
    queryResult = await db.execute(sql`
      SELECT
        ke.id                              AS embedding_id,
        ke.knowledge_chunk_id              AS chunk_id,
        ke.knowledge_document_id           AS document_id,
        ke.knowledge_document_version_id   AS document_version_id,
        ke.knowledge_base_id               AS knowledge_base_id,
        ke.tenant_id                       AS tenant_id,
        ke.embedding_dimensions            AS embedding_dimensions,
        ke.content_hash                    AS content_hash,
        kc.chunk_text                      AS chunk_text,
        kc.chunk_index                     AS chunk_index,
        kc.chunk_key                       AS chunk_key,
        kc.source_page_start               AS source_page_start,
        kc.source_heading_path             AS source_heading_path,
        1 - (ke.embedding_vector::vector <=> ${vecRaw})  AS similarity_score
      FROM knowledge_embeddings ke
      JOIN knowledge_chunks kc
        ON kc.id = ke.knowledge_chunk_id AND kc.tenant_id = ke.tenant_id
      JOIN knowledge_documents kd
        ON kd.id = ke.knowledge_document_id AND kd.tenant_id = ke.tenant_id
      JOIN knowledge_document_versions kdv
        ON kdv.id = ke.knowledge_document_version_id AND kdv.tenant_id = ke.tenant_id
      JOIN knowledge_index_state kis
        ON kis.knowledge_document_version_id = ke.knowledge_document_version_id
        AND kis.tenant_id = ke.tenant_id
      JOIN knowledge_bases kb
        ON kb.id = ke.knowledge_base_id AND kb.tenant_id = ke.tenant_id
      WHERE ke.tenant_id = ${tenantId}
        AND ke.knowledge_base_id = ${knowledgeBaseId}
        AND ke.embedding_status = 'completed'
        AND ke.is_active = true
        AND ke.embedding_vector IS NOT NULL
        AND kc.chunk_active = true
        AND kd.lifecycle_state = 'active'
        AND kd.document_status = 'ready'
        AND kd.current_version_id = ke.knowledge_document_version_id
        AND kdv.tenant_id = ${tenantId}
        AND kis.index_state = 'indexed'
        AND kb.lifecycle_state = 'active'
      ORDER BY ke.embedding_vector::vector <=> ${vecRaw}
      LIMIT ${topK}
    `);
  } else if (metric === "l2") {
    queryResult = await db.execute(sql`
      SELECT
        ke.id                              AS embedding_id,
        ke.knowledge_chunk_id              AS chunk_id,
        ke.knowledge_document_id           AS document_id,
        ke.knowledge_document_version_id   AS document_version_id,
        ke.knowledge_base_id               AS knowledge_base_id,
        ke.tenant_id                       AS tenant_id,
        ke.embedding_dimensions            AS embedding_dimensions,
        ke.content_hash                    AS content_hash,
        kc.chunk_text                      AS chunk_text,
        kc.chunk_index                     AS chunk_index,
        kc.chunk_key                       AS chunk_key,
        kc.source_page_start               AS source_page_start,
        kc.source_heading_path             AS source_heading_path,
        1 / (1 + (ke.embedding_vector::vector <-> ${vecRaw}))  AS similarity_score
      FROM knowledge_embeddings ke
      JOIN knowledge_chunks kc
        ON kc.id = ke.knowledge_chunk_id AND kc.tenant_id = ke.tenant_id
      JOIN knowledge_documents kd
        ON kd.id = ke.knowledge_document_id AND kd.tenant_id = ke.tenant_id
      JOIN knowledge_document_versions kdv
        ON kdv.id = ke.knowledge_document_version_id AND kdv.tenant_id = ke.tenant_id
      JOIN knowledge_index_state kis
        ON kis.knowledge_document_version_id = ke.knowledge_document_version_id
        AND kis.tenant_id = ke.tenant_id
      JOIN knowledge_bases kb
        ON kb.id = ke.knowledge_base_id AND kb.tenant_id = ke.tenant_id
      WHERE ke.tenant_id = ${tenantId}
        AND ke.knowledge_base_id = ${knowledgeBaseId}
        AND ke.embedding_status = 'completed'
        AND ke.is_active = true
        AND ke.embedding_vector IS NOT NULL
        AND kc.chunk_active = true
        AND kd.lifecycle_state = 'active'
        AND kd.document_status = 'ready'
        AND kd.current_version_id = ke.knowledge_document_version_id
        AND kdv.tenant_id = ${tenantId}
        AND kis.index_state = 'indexed'
        AND kb.lifecycle_state = 'active'
      ORDER BY ke.embedding_vector::vector <-> ${vecRaw}
      LIMIT ${topK}
    `);
  } else {
    // inner_product: <#> returns negative inner product; ORDER BY ASC gives highest similarity first
    queryResult = await db.execute(sql`
      SELECT
        ke.id                              AS embedding_id,
        ke.knowledge_chunk_id              AS chunk_id,
        ke.knowledge_document_id           AS document_id,
        ke.knowledge_document_version_id   AS document_version_id,
        ke.knowledge_base_id               AS knowledge_base_id,
        ke.tenant_id                       AS tenant_id,
        ke.embedding_dimensions            AS embedding_dimensions,
        ke.content_hash                    AS content_hash,
        kc.chunk_text                      AS chunk_text,
        kc.chunk_index                     AS chunk_index,
        kc.chunk_key                       AS chunk_key,
        kc.source_page_start               AS source_page_start,
        kc.source_heading_path             AS source_heading_path,
        (ke.embedding_vector::vector <#> ${vecRaw}) * -1  AS similarity_score
      FROM knowledge_embeddings ke
      JOIN knowledge_chunks kc
        ON kc.id = ke.knowledge_chunk_id AND kc.tenant_id = ke.tenant_id
      JOIN knowledge_documents kd
        ON kd.id = ke.knowledge_document_id AND kd.tenant_id = ke.tenant_id
      JOIN knowledge_document_versions kdv
        ON kdv.id = ke.knowledge_document_version_id AND kdv.tenant_id = ke.tenant_id
      JOIN knowledge_index_state kis
        ON kis.knowledge_document_version_id = ke.knowledge_document_version_id
        AND kis.tenant_id = ke.tenant_id
      JOIN knowledge_bases kb
        ON kb.id = ke.knowledge_base_id AND kb.tenant_id = ke.tenant_id
      WHERE ke.tenant_id = ${tenantId}
        AND ke.knowledge_base_id = ${knowledgeBaseId}
        AND ke.embedding_status = 'completed'
        AND ke.is_active = true
        AND ke.embedding_vector IS NOT NULL
        AND kc.chunk_active = true
        AND kd.lifecycle_state = 'active'
        AND kd.document_status = 'ready'
        AND kd.current_version_id = ke.knowledge_document_version_id
        AND kdv.tenant_id = ${tenantId}
        AND kis.index_state = 'indexed'
        AND kb.lifecycle_state = 'active'
      ORDER BY ke.embedding_vector::vector <#> ${vecRaw}
      LIMIT ${topK}
    `);
  }

  const rows = queryResult.rows as Record<string, unknown>[];
  const searchDurationMs = Date.now() - startMs;

  // Apply optional similarity threshold post-filter (non-widening: only reduces results)
  const filtered =
    similarityThreshold != null
      ? rows.filter((r) => Number(r.similarity_score) >= similarityThreshold)
      : rows;

  const mapped: PgvectorSearchRow[] = filtered.map((r) => ({
    embeddingId: String(r.embedding_id),
    chunkId: String(r.chunk_id),
    documentId: String(r.document_id),
    documentVersionId: String(r.document_version_id),
    knowledgeBaseId: String(r.knowledge_base_id),
    tenantId: String(r.tenant_id),
    chunkText: r.chunk_text != null ? String(r.chunk_text) : null,
    chunkIndex: Number(r.chunk_index),
    chunkKey: String(r.chunk_key),
    sourcePageStart: r.source_page_start != null ? Number(r.source_page_start) : null,
    sourceHeadingPath: r.source_heading_path != null ? String(r.source_heading_path) : null,
    contentHash: r.content_hash != null ? String(r.content_hash) : null,
    embeddingDimensions: r.embedding_dimensions != null ? Number(r.embedding_dimensions) : null,
    similarityScore: Number(r.similarity_score),
    similarityMetric: metric,
  }));

  return {
    rows: mapped,
    candidatesSearched: mapped.length,
    queryHash,
    metric,
    topKRequested: topK,
    topKReturned: mapped.length,
    searchDurationMs,
    filterSummary,
  };
}

// ─── Exclusion check helper ───────────────────────────────────────────────────

export async function checkChunkExclusion(
  chunkId: string,
  tenantId: string,
): Promise<ExclusionCheckRow | null> {
  const result = await db.execute(sql`
    SELECT
      ke.id                           AS embedding_id,
      ke.knowledge_chunk_id           AS chunk_id,
      ke.knowledge_document_id        AS document_id,
      ke.knowledge_document_version_id AS document_version_id,
      ke.is_active                    AS is_active,
      ke.embedding_status             AS embedding_status,
      kc.chunk_active                 AS chunk_active,
      kd.lifecycle_state              AS doc_lifecycle_state,
      kd.document_status              AS doc_status,
      (kd.current_version_id = ke.knowledge_document_version_id) AS is_current_version,
      kis.index_state                 AS index_state,
      kb.lifecycle_state              AS kb_lifecycle_state
    FROM knowledge_chunks kc
    LEFT JOIN knowledge_embeddings ke
      ON ke.knowledge_chunk_id = kc.id AND ke.tenant_id = kc.tenant_id
    LEFT JOIN knowledge_documents kd
      ON kd.id = kc.knowledge_document_id AND kd.tenant_id = kc.tenant_id
    LEFT JOIN knowledge_index_state kis
      ON kis.knowledge_document_version_id = kc.knowledge_document_version_id
      AND kis.tenant_id = kc.tenant_id
    LEFT JOIN knowledge_bases kb
      ON kb.id = kc.knowledge_base_id AND kb.tenant_id = kc.tenant_id
    WHERE kc.id = ${chunkId}
      AND kc.tenant_id = ${tenantId}
    LIMIT 1
  `);

  const rows = result.rows as Record<string, unknown>[];
  if (!rows.length) return null;

  const r = rows[0];
  const reasons: string[] = [];
  const isActive = Boolean(r.is_active);
  const embeddingStatus = String(r.embedding_status ?? "missing");
  const chunkActive = Boolean(r.chunk_active);
  const docLifecycle = String(r.doc_lifecycle_state ?? "missing");
  const docStatus = String(r.doc_status ?? "missing");
  const isCurrent = Boolean(r.is_current_version);
  const indexState = r.index_state != null ? String(r.index_state) : null;
  const kbLifecycle = String(r.kb_lifecycle_state ?? "missing");

  if (!isActive) reasons.push("embedding.is_active=false");
  if (embeddingStatus !== "completed") reasons.push(`embedding.embedding_status=${embeddingStatus}`);
  if (!chunkActive) reasons.push("chunk.chunk_active=false");
  if (docLifecycle !== "active") reasons.push(`document.lifecycle_state=${docLifecycle}`);
  if (docStatus !== "ready") reasons.push(`document.document_status=${docStatus}`);
  if (!isCurrent) reasons.push("chunk version is not current_version_id");
  if (indexState !== "indexed") reasons.push(`index_state.index_state=${indexState ?? "null"}`);
  if (kbLifecycle !== "active") reasons.push(`knowledge_base.lifecycle_state=${kbLifecycle}`);

  return {
    embeddingId: r.embedding_id != null ? String(r.embedding_id) : "",
    chunkId: String(r.chunk_id ?? chunkId),
    documentId: r.document_id != null ? String(r.document_id) : "",
    documentVersionId: r.document_version_id != null ? String(r.document_version_id) : "",
    isActive,
    embeddingStatus,
    chunkActive,
    docLifecycleState: docLifecycle,
    docStatus,
    isCurrentVersion: isCurrent,
    indexState,
    kbLifecycleState: kbLifecycle,
    exclusionReasons: reasons,
  };
}

// ─── Explain search ───────────────────────────────────────────────────────────

export function explainPgvectorSearch(
  queryVector: number[],
  options: PgvectorSearchOptions,
  result: PgvectorSearchResult,
): Record<string, unknown> {
  return {
    queryHash: result.queryHash,
    queryDimensions: queryVector.length,
    metric: result.metric,
    topKRequested: result.topKRequested,
    topKReturned: result.topKReturned,
    searchDurationMs: result.searchDurationMs,
    appliedFilters: result.filterSummary,
    topCandidates: result.rows.slice(0, 5).map((r, idx) => ({
      rank: idx + 1,
      chunkId: r.chunkId,
      documentId: r.documentId,
      similarityScore: r.similarityScore,
      chunkIndex: r.chunkIndex,
      chunkTextPreview: r.chunkText ? r.chunkText.slice(0, 120) : null,
    })),
    note:
      result.topKReturned === 0
        ? "No retrieval-safe candidates found. All candidates excluded by safety filters."
        : `${result.topKReturned} retrieval-safe candidates returned.`,
  };
}
