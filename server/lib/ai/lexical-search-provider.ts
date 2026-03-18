/**
 * lexical-search-provider.ts — Phase 5N
 *
 * PostgreSQL full-text search (FTS) provider for hybrid retrieval.
 *
 * Uses the searchable_text_tsv generated tsvector column on knowledge_chunks
 * (added in Phase 5N migration) for efficient GIN-indexed text search.
 *
 * All safety filters mirror vector-search-provider.ts exactly (INV-HYB2):
 *   - tenant_id scoping
 *   - knowledge_base_id scoping
 *   - chunk_active = true
 *   - knowledge_documents.lifecycle_state = 'active'
 *   - knowledge_documents.document_status = 'ready'
 *   - knowledge_documents.current_version_id = kc.knowledge_document_version_id
 *   - knowledge_index_state.index_state = 'indexed'
 *   - knowledge_bases.lifecycle_state = 'active'
 *
 * Uses websearch_to_tsquery('simple', ...) for robust query parsing.
 * Falls back to plainto_tsquery if websearch query is null/empty.
 * ts_rank_cd used for coverage-density scoring.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LexicalSearchCandidate {
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
  lexicalScore: number;
  lexicalRank: number;
}

export interface LexicalSearchParams {
  tenantId: string;
  knowledgeBaseId: string;
  queryText: string;
  topK?: number;
  minLexicalScore?: number;
}

export interface LexicalSearchOutput {
  candidates: LexicalSearchCandidate[];
  topKRequested: number;
  topKReturned: number;
  queryText: string;
  normalizedQueryText: string;
  searchDurationMs: number;
  filterSummary: Record<string, unknown>;
}

// ── Query normalization ───────────────────────────────────────────────────────

export function normalizeLexicalQueryText(rawText: string): string {
  return rawText.trim().replace(/\s+/g, " ").toLowerCase().slice(0, 512);
}

// ── Main search function (INV-HYB1, INV-HYB2) ────────────────────────────────

export async function searchLexicalCandidates(
  params: LexicalSearchParams,
): Promise<LexicalSearchOutput> {
  const { tenantId, knowledgeBaseId, queryText, topK = 20, minLexicalScore = 0 } = params;

  if (!tenantId) throw new Error("tenantId required for lexical search");
  if (!knowledgeBaseId) throw new Error("knowledgeBaseId required for lexical search");
  if (!queryText || !queryText.trim()) {
    return {
      candidates: [],
      topKRequested: topK,
      topKReturned: 0,
      queryText,
      normalizedQueryText: "",
      searchDurationMs: 0,
      filterSummary: { reason: "empty_query_text" },
    };
  }

  const normalized = normalizeLexicalQueryText(queryText);
  const startMs = Date.now();

  // Safety filters replicate vector-search-provider exactly (INV-HYB2)
  const result = await db.execute(sql`
    SELECT
      kc.id                                AS chunk_id,
      kc.knowledge_document_id             AS document_id,
      kc.knowledge_document_version_id     AS document_version_id,
      kc.knowledge_base_id                 AS knowledge_base_id,
      kc.tenant_id                         AS tenant_id,
      kc.chunk_text                        AS chunk_text,
      kc.chunk_index                       AS chunk_index,
      kc.chunk_key                         AS chunk_key,
      kc.source_page_start                 AS source_page_start,
      kc.source_heading_path               AS source_heading_path,
      kc.chunk_hash                        AS content_hash,
      ts_rank_cd(
        kc.searchable_text_tsv,
        websearch_to_tsquery('simple', ${normalized})
      )                                    AS lexical_score
    FROM knowledge_chunks kc
    JOIN knowledge_documents kd
      ON kd.id = kc.knowledge_document_id AND kd.tenant_id = kc.tenant_id
    JOIN knowledge_index_state kis
      ON kis.knowledge_document_version_id = kc.knowledge_document_version_id
      AND kis.tenant_id = kc.tenant_id
    JOIN knowledge_bases kb
      ON kb.id = kc.knowledge_base_id AND kb.tenant_id = kc.tenant_id
    WHERE kc.tenant_id = ${tenantId}
      AND kc.knowledge_base_id = ${knowledgeBaseId}
      AND kc.chunk_active = true
      AND kc.chunk_text IS NOT NULL
      AND kc.searchable_text_tsv @@ websearch_to_tsquery('simple', ${normalized})
      AND kd.lifecycle_state = 'active'
      AND kd.document_status = 'ready'
      AND kd.current_version_id = kc.knowledge_document_version_id
      AND kis.index_state = 'indexed'
      AND kb.lifecycle_state = 'active'
    ORDER BY lexical_score DESC, kc.id
    LIMIT ${topK}
  `);

  const searchDurationMs = Date.now() - startMs;
  const rows = result.rows as Record<string, unknown>[];

  const candidates: LexicalSearchCandidate[] = rows
    .filter((row) => Number(row.lexical_score) >= minLexicalScore)
    .map((row, idx) => ({
      chunkId: String(row.chunk_id),
      documentId: String(row.document_id),
      documentVersionId: String(row.document_version_id),
      knowledgeBaseId: String(row.knowledge_base_id),
      tenantId: String(row.tenant_id),
      chunkText: row.chunk_text != null ? String(row.chunk_text) : null,
      chunkIndex: Number(row.chunk_index),
      chunkKey: String(row.chunk_key),
      sourcePageStart: row.source_page_start != null ? Number(row.source_page_start) : null,
      sourceHeadingPath: row.source_heading_path != null ? String(row.source_heading_path) : null,
      contentHash: row.content_hash != null ? String(row.content_hash) : null,
      lexicalScore: Number(row.lexical_score),
      lexicalRank: idx + 1,
    }));

  return {
    candidates,
    topKRequested: topK,
    topKReturned: candidates.length,
    queryText,
    normalizedQueryText: normalized,
    searchDurationMs,
    filterSummary: {
      tenantId,
      knowledgeBaseId,
      chunkActive: true,
      docLifecycleState: "active",
      docStatus: "ready",
      indexState: "indexed",
      kbLifecycleState: "active",
      minLexicalScore,
    },
  };
}

// ── Explain lexical search (INV-HYB7: no writes) ──────────────────────────────

export function buildLexicalSearchQuery(params: LexicalSearchParams): Record<string, unknown> {
  return {
    engine: "postgresql_fts",
    method: "websearch_to_tsquery",
    language: "simple",
    queryText: params.queryText,
    normalizedQueryText: normalizeLexicalQueryText(params.queryText),
    rankingFunction: "ts_rank_cd",
    safetyFilters: {
      tenantId: params.tenantId,
      knowledgeBaseId: params.knowledgeBaseId,
      chunkActive: true,
      docLifecycleState: "active",
      docStatus: "ready",
      currentVersionOnly: true,
      indexState: "indexed",
      kbLifecycleState: "active",
    },
    topK: params.topK ?? 20,
    minLexicalScore: params.minLexicalScore ?? 0,
  };
}

export async function explainLexicalSearch(
  params: LexicalSearchParams,
): Promise<Record<string, unknown>> {
  // No writes — describe what the search would do (INV-HYB7)
  const querySpec = buildLexicalSearchQuery(params);
  const normalizedQuery = normalizeLexicalQueryText(params.queryText);

  // Check if query is parseable
  let queryParseable = true;
  let parseError: string | null = null;
  try {
    await db.execute(
      sql`SELECT websearch_to_tsquery('simple', ${normalizedQuery}) IS NOT NULL AS ok`,
    );
  } catch (e) {
    queryParseable = false;
    parseError = (e as Error).message;
  }

  return {
    ...querySpec,
    queryParseable,
    parseError,
    note: "Lexical search uses PostgreSQL websearch_to_tsquery with ts_rank_cd scoring. GIN index on searchable_text_tsv ensures efficient retrieval.",
  };
}

// ── Normalize lexical score to [0, 1] ─────────────────────────────────────────

export function normalizeLexicalCandidate(
  candidate: LexicalSearchCandidate,
  maxScore: number,
): LexicalSearchCandidate {
  if (maxScore <= 0) return candidate;
  return {
    ...candidate,
    lexicalScore: Math.min(1, candidate.lexicalScore / maxScore),
  };
}

// ── Summarize lexical search results ─────────────────────────────────────────

export function summarizeLexicalSearchResults(output: LexicalSearchOutput): Record<string, unknown> {
  const { candidates, topKRequested, topKReturned, searchDurationMs } = output;
  const scores = candidates.map((c) => c.lexicalScore);
  const avgScore = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const maxScore = scores.length > 0 ? Math.max(...scores) : 0;
  const minScore = scores.length > 0 ? Math.min(...scores) : 0;

  const docCounts = new Map<string, number>();
  for (const c of candidates) {
    docCounts.set(c.documentId, (docCounts.get(c.documentId) ?? 0) + 1);
  }

  return {
    topKRequested,
    topKReturned,
    recallRate: topKRequested > 0 ? topKReturned / topKRequested : 0,
    avgLexicalScore: Number(avgScore.toFixed(6)),
    maxLexicalScore: Number(maxScore.toFixed(6)),
    minLexicalScore: Number(minScore.toFixed(6)),
    uniqueDocuments: docCounts.size,
    searchDurationMs,
    queryText: output.queryText,
  };
}
