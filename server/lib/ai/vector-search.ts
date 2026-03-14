/**
 * vector-search.ts — Phase 5D
 *
 * Application-level vector search execution flow.
 *
 * Responsibilities:
 *   - Validate tenant ownership + KB existence + lifecycle state (INV-VEC1/2/6)
 *   - Validate query embedding dimensions (INV-VEC11)
 *   - Execute pgvector search via provider boundary
 *   - Optionally persist search run + candidates for observability
 *   - Return ranked candidates with full metadata
 *   - Provide explain / debug helpers for operations
 *
 * This file must NEVER contain raw pgvector SQL — all SQL lives in vector-search-provider.ts.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import {
  knowledgeBases,
  knowledgeDocumentVersions,
  knowledgeSearchRuns,
  knowledgeSearchCandidates,
  type KnowledgeSearchRun,
  type KnowledgeSearchCandidate,
} from "@shared/schema";
import {
  searchPgvector,
  checkChunkExclusion,
  explainPgvectorSearch,
  buildVectorSearchFilterSummary,
  computeQueryHash,
  type SimilarityMetric,
  type PgvectorSearchRow,
} from "./vector-search-provider";

// ─── Types ────────────────────────────────────────────────────────────────────

export class VectorSearchInvariantError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "VectorSearchInvariantError";
  }
}

export interface VectorSearchParams {
  tenantId: string;
  knowledgeBaseId: string;
  queryEmbedding: number[];
  topK?: number;
  metric?: SimilarityMetric;
  similarityThreshold?: number;
  persistDebugRun?: boolean;
  embeddingModel?: string;
}

export interface VectorSearchCandidate {
  rank: number;
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  knowledgeBaseId: string;
  chunkText: string | null;
  chunkIndex: number;
  chunkKey: string;
  sourcePageStart: number | null;
  sourceHeadingPath: string | null;
  similarityScore: number;
  similarityMetric: SimilarityMetric;
  contentHash: string | null;
}

export interface VectorSearchOutput {
  candidates: VectorSearchCandidate[];
  topKRequested: number;
  topKReturned: number;
  queryHash: string;
  metric: SimilarityMetric;
  searchDurationMs: number;
  filterSummary: Record<string, unknown>;
  debugRunId: string | null;
}

// ─── INV-VEC1/6: KB existence + lifecycle + tenant validation ─────────────────

async function assertKnowledgeBaseActive(knowledgeBaseId: string, tenantId: string) {
  const [kb] = await db
    .select({ id: knowledgeBases.id, lifecycleState: knowledgeBases.lifecycleState, tenantId: knowledgeBases.tenantId })
    .from(knowledgeBases)
    .where(and(eq(knowledgeBases.id, knowledgeBaseId), eq(knowledgeBases.tenantId, tenantId)))
    .limit(1);

  if (!kb) {
    throw new VectorSearchInvariantError(
      "INV-VEC1",
      `Knowledge base ${knowledgeBaseId} not found for tenant ${tenantId}`,
    );
  }
  if (kb.tenantId !== tenantId) {
    throw new VectorSearchInvariantError("INV-VEC9", "Cross-tenant knowledge base access rejected");
  }
  if (kb.lifecycleState !== "active") {
    throw new VectorSearchInvariantError(
      "INV-VEC6",
      `Knowledge base ${knowledgeBaseId} is not active (lifecycle_state=${kb.lifecycleState})`,
    );
  }
}

// ─── INV-VEC11: Dimension validation ─────────────────────────────────────────

function assertValidQueryEmbedding(embedding: number[]) {
  if (!embedding || embedding.length === 0) {
    throw new VectorSearchInvariantError("INV-VEC11", "Query embedding must not be empty");
  }
  for (let i = 0; i < embedding.length; i++) {
    if (!Number.isFinite(embedding[i])) {
      throw new VectorSearchInvariantError(
        "INV-VEC11",
        `Query embedding contains non-finite value at index ${i}: ${embedding[i]}`,
      );
    }
  }
}

// ─── Main execution flow ──────────────────────────────────────────────────────

export async function runVectorSearch(params: VectorSearchParams): Promise<VectorSearchOutput> {
  const {
    tenantId,
    knowledgeBaseId,
    queryEmbedding,
    topK = 10,
    metric = "cosine",
    similarityThreshold,
    persistDebugRun = false,
    embeddingModel,
  } = params;

  // Step 1: Validate tenant + KB + lifecycle (INV-VEC1/6)
  await assertKnowledgeBaseActive(knowledgeBaseId, tenantId);

  // Step 2: Validate query embedding (INV-VEC11)
  assertValidQueryEmbedding(queryEmbedding);

  // Step 3: Build retrieval-safe filters (enforced inside searchPgvector)
  // Step 4: Execute pgvector search through provider boundary
  const result = await searchPgvector(queryEmbedding, {
    tenantId,
    knowledgeBaseId,
    topK,
    metric,
    similarityThreshold,
  });

  // Step 5: Rank and map results
  const candidates: VectorSearchCandidate[] = result.rows.map((row, idx) => ({
    rank: idx + 1,
    chunkId: row.chunkId,
    documentId: row.documentId,
    documentVersionId: row.documentVersionId,
    knowledgeBaseId: row.knowledgeBaseId,
    chunkText: row.chunkText,
    chunkIndex: row.chunkIndex,
    chunkKey: row.chunkKey,
    sourcePageStart: row.sourcePageStart,
    sourceHeadingPath: row.sourceHeadingPath,
    similarityScore: row.similarityScore,
    similarityMetric: metric,
    contentHash: row.contentHash,
  }));

  // Step 6: Optionally persist debug run
  let debugRunId: string | null = null;
  if (persistDebugRun) {
    const [run] = await db
      .insert(knowledgeSearchRuns)
      .values({
        tenantId,
        knowledgeBaseId,
        queryHash: result.queryHash,
        embeddingModel: embeddingModel ?? null,
        topKRequested: topK,
        topKReturned: candidates.length,
        filterSummary: result.filterSummary,
        searchDurationMs: result.searchDurationMs,
      })
      .returning();

    debugRunId = run.id;

    if (candidates.length > 0) {
      await db.insert(knowledgeSearchCandidates).values(
        candidates.map((c) => ({
          knowledgeSearchRunId: run.id,
          knowledgeChunkId: c.chunkId,
          knowledgeDocumentId: c.documentId,
          knowledgeDocumentVersionId: c.documentVersionId,
          tenantId,
          rank: c.rank,
          similarityScore: c.similarityScore,
        })),
      );
    }
  }

  return {
    candidates,
    topKRequested: topK,
    topKReturned: candidates.length,
    queryHash: result.queryHash,
    metric,
    searchDurationMs: result.searchDurationMs,
    filterSummary: result.filterSummary,
    debugRunId,
  };
}

// ─── explainVectorSearch ──────────────────────────────────────────────────────

export async function explainVectorSearch(params: VectorSearchParams): Promise<Record<string, unknown>> {
  const {
    tenantId,
    knowledgeBaseId,
    queryEmbedding,
    topK = 10,
    metric = "cosine",
    similarityThreshold,
  } = params;

  await assertKnowledgeBaseActive(knowledgeBaseId, tenantId);
  assertValidQueryEmbedding(queryEmbedding);

  const result = await searchPgvector(queryEmbedding, {
    tenantId,
    knowledgeBaseId,
    topK,
    metric,
    similarityThreshold,
  });

  return explainPgvectorSearch(queryEmbedding, { tenantId, knowledgeBaseId, topK, metric, similarityThreshold }, result);
}

// ─── previewRetrievalSafeFilterSet ────────────────────────────────────────────

export function previewRetrievalSafeFilterSet(params: {
  tenantId: string;
  knowledgeBaseId: string;
  topK?: number;
  metric?: SimilarityMetric;
}): Record<string, unknown> {
  return buildVectorSearchFilterSummary({
    tenantId: params.tenantId,
    knowledgeBaseId: params.knowledgeBaseId,
    topK: params.topK ?? 10,
    metric: params.metric ?? "cosine",
  });
}

// ─── explainWhyChunkWasReturned ────────────────────────────────────────────────

export function explainWhyChunkWasReturned(
  chunkId: string,
  candidates: VectorSearchCandidate[],
): Record<string, unknown> {
  const candidate = candidates.find((c) => c.chunkId === chunkId);
  if (!candidate) {
    return {
      chunkId,
      wasReturned: false,
      reason: "Chunk was not in the returned candidate set for this search.",
    };
  }
  return {
    chunkId,
    wasReturned: true,
    rank: candidate.rank,
    similarityScore: candidate.similarityScore,
    similarityMetric: candidate.similarityMetric,
    documentId: candidate.documentId,
    documentVersionId: candidate.documentVersionId,
    chunkIndex: candidate.chunkIndex,
    chunkKey: candidate.chunkKey,
    passedFilters: [
      "embedding_status=completed",
      "is_active=true",
      "chunk_active=true",
      "document.lifecycle_state=active",
      "document.document_status=ready",
      "current_version_id matches",
      "index_state=indexed",
      "knowledge_base.lifecycle_state=active",
      "tenant_id matches",
      "knowledge_base_id matches",
    ],
  };
}

// ─── explainWhyChunkWasExcluded ───────────────────────────────────────────────

export async function explainWhyChunkWasExcluded(
  chunkId: string,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const row = await checkChunkExclusion(chunkId, tenantId);
  if (!row) {
    return {
      chunkId,
      found: false,
      reason: "Chunk not found in this tenant's context.",
    };
  }

  const isSearchSafe =
    row.isActive &&
    row.embeddingStatus === "completed" &&
    row.chunkActive &&
    row.docLifecycleState === "active" &&
    row.docStatus === "ready" &&
    row.isCurrentVersion &&
    row.indexState === "indexed" &&
    row.kbLifecycleState === "active";

  return {
    chunkId,
    found: true,
    isSearchSafe,
    exclusionReasons: row.exclusionReasons,
    details: {
      embeddingId: row.embeddingId || null,
      isActive: row.isActive,
      embeddingStatus: row.embeddingStatus,
      chunkActive: row.chunkActive,
      docLifecycleState: row.docLifecycleState,
      docStatus: row.docStatus,
      isCurrentVersion: row.isCurrentVersion,
      indexState: row.indexState,
      kbLifecycleState: row.kbLifecycleState,
    },
    note: isSearchSafe
      ? "Chunk meets all retrieval-safety criteria. It would appear in search if its embedding similarity is high enough."
      : `Chunk excluded. Reasons: ${row.exclusionReasons.join("; ")}`,
  };
}

// ─── summarizeVectorSearchRun ─────────────────────────────────────────────────

export async function summarizeVectorSearchRun(
  runId: string,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const [run] = await db
    .select()
    .from(knowledgeSearchRuns)
    .where(and(eq(knowledgeSearchRuns.id, runId), eq(knowledgeSearchRuns.tenantId, tenantId)))
    .limit(1);

  if (!run) {
    throw new VectorSearchInvariantError(
      "INV-VEC1",
      `Search run ${runId} not found for tenant ${tenantId}`,
    );
  }

  const candidates = await db
    .select()
    .from(knowledgeSearchCandidates)
    .where(eq(knowledgeSearchCandidates.knowledgeSearchRunId, runId))
    .orderBy(knowledgeSearchCandidates.rank);

  return {
    runId: run.id,
    tenantId: run.tenantId,
    knowledgeBaseId: run.knowledgeBaseId,
    queryHash: run.queryHash,
    embeddingModel: run.embeddingModel,
    topKRequested: run.topKRequested,
    topKReturned: run.topKReturned,
    filterSummary: run.filterSummary,
    searchDurationMs: run.searchDurationMs,
    createdAt: run.createdAt,
    candidateCount: candidates.length,
    topCandidates: candidates.slice(0, 5).map((c) => ({
      rank: c.rank,
      chunkId: c.knowledgeChunkId,
      documentId: c.knowledgeDocumentId,
      similarityScore: c.similarityScore,
    })),
  };
}

// ─── listVectorSearchCandidates ───────────────────────────────────────────────

export async function listVectorSearchCandidates(
  runId: string,
  tenantId: string,
): Promise<KnowledgeSearchCandidate[]> {
  const [run] = await db
    .select({ id: knowledgeSearchRuns.id, tenantId: knowledgeSearchRuns.tenantId })
    .from(knowledgeSearchRuns)
    .where(and(eq(knowledgeSearchRuns.id, runId), eq(knowledgeSearchRuns.tenantId, tenantId)))
    .limit(1);

  if (!run) {
    throw new VectorSearchInvariantError(
      "INV-VEC1",
      `Search run ${runId} not found for tenant ${tenantId}`,
    );
  }

  return db
    .select()
    .from(knowledgeSearchCandidates)
    .where(eq(knowledgeSearchCandidates.knowledgeSearchRunId, runId))
    .orderBy(knowledgeSearchCandidates.rank);
}
