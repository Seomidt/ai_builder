/**
 * retrieval-orchestrator.ts — Phase 5E
 *
 * Main retrieval orchestration entry point.
 *
 * Converts Phase 5D vector search results into structured retrieval context
 * ready for LLM usage.
 *
 * Pipeline:
 *   1. Validate tenant + KB (INV-RET1/7)
 *   2. Run vector search (Phase 5D — all safety filters enforced: INV-RET2/3/4)
 *   3. Rank + deduplicate candidates (INV-RET9)
 *   4. Assemble context window within token budget (INV-RET5)
 *   5. Optionally persist retrieval run metadata for observability
 *   6. Return structured retrieval context (INV-RET10)
 *
 * This module does NOT:
 *   - call LLM providers
 *   - generate answers
 *   - modify database lifecycle or billing state (INV-RET6)
 *   - bypass vector search safety filters (INV-RET2)
 */

import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import {
  knowledgeRetrievalRuns,
  knowledgeRetrievalCandidates,
} from "@shared/schema";
import {
  EXCLUSION_REASONS,
  INCLUSION_REASONS,
} from "./retrieval-provenance";
import {
  runVectorSearch,
  explainVectorSearch,
  previewRetrievalSafeFilterSet,
  type VectorSearchCandidate,
  VectorSearchInvariantError,
} from "./vector-search";
import {
  rankChunks,
  type RankedChunk,
  type RankingOptions,
} from "./chunk-ranking";
import {
  buildContextWindow,
  summarizeContextWindow,
  type ContextWindow,
  type ContextWindowOptions,
} from "./context-window-builder";
import {
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  formatBudgetSummary,
} from "./token-budget";

// ─── Types ────────────────────────────────────────────────────────────────────

export class RetrievalInvariantError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "RetrievalInvariantError";
  }
}

export interface RetrievalOrchestrationParams {
  tenantId: string;
  knowledgeBaseId: string;
  queryEmbedding: number[];
  topKCandidates?: number;
  maxContextTokens?: number;
  rankingOptions?: RankingOptions;
  contextOptions?: ContextWindowOptions;
  persistRun?: boolean;
  embeddingModel?: string;
  debugSearchRun?: boolean;
}

export interface RetrievalContext {
  tenantId: string;
  knowledgeBaseId: string;
  queryHash: string;
  contextWindow: ContextWindow;
  candidatesFound: number;
  candidatesRanked: number;
  chunksSkippedDuplicate: number;
  chunksSkippedBudget: number;
  chunksSkippedThreshold: number;
  totalEstimatedTokens: number;
  budgetUtilizationPct: number;
  documentCount: number;
  documentIds: string[];
  searchDurationMs: number;
  retrievalRunId: string | null;
  metric: string;
}

// ─── Main orchestration flow ──────────────────────────────────────────────────

export async function runRetrievalOrchestration(
  params: RetrievalOrchestrationParams,
): Promise<RetrievalContext> {
  const {
    tenantId,
    knowledgeBaseId,
    queryEmbedding,
    topKCandidates = 20,
    maxContextTokens = DEFAULT_CONTEXT_TOKEN_BUDGET,
    rankingOptions = {},
    contextOptions = {},
    persistRun = false,
    embeddingModel,
    debugSearchRun = false,
  } = params;

  // Step 1: Validate inputs (INV-RET1/7)
  if (!tenantId) {
    throw new RetrievalInvariantError("INV-RET7", "tenantId is required");
  }
  if (!knowledgeBaseId) {
    throw new RetrievalInvariantError("INV-RET1", "knowledgeBaseId is required");
  }
  if (!queryEmbedding || queryEmbedding.length === 0) {
    throw new RetrievalInvariantError("INV-RET1", "queryEmbedding must not be empty");
  }

  // Step 2: Vector search with all safety filters enforced (INV-RET2/3/4)
  // Phase 5D enforces: is_active, embedding_status=completed, chunk_active,
  // lifecycle=active, document_status=ready, current_version_id, index_state=indexed
  const searchResult = await runVectorSearch({
    tenantId,
    knowledgeBaseId,
    queryEmbedding,
    topK: topKCandidates,
    persistDebugRun: debugSearchRun,
    embeddingModel,
  });

  const { candidates, queryHash, searchDurationMs, metric } = searchResult;

  // Step 3: Rank + deduplicate (INV-RET9)
  const rankResult = rankChunks(candidates, rankingOptions);

  // Step 4: Context window assembly within token budget (INV-RET5)
  const contextWindow = buildContextWindow(rankResult.ranked, {
    maxTokens: maxContextTokens,
    ...contextOptions,
  });

  // Step 5: Persist retrieval run metadata (INV-RET6: no lifecycle mutation)
  let retrievalRunId: string | null = null;
  if (persistRun) {
    const [run] = await db
      .insert(knowledgeRetrievalRuns)
      .values({
        tenantId,
        knowledgeBaseId,
        queryHash,
        embeddingModel: embeddingModel ?? null,
        candidatesFound: candidates.length,
        candidatesRanked: rankResult.ranked.length,
        chunksSelected: contextWindow.chunksSelected,
        chunksSkippedDuplicate: contextWindow.chunksSkippedDuplicate + rankResult.skippedDuplicate.length,
        chunksSkippedBudget: contextWindow.chunksSkippedBudget,
        contextTokensUsed: contextWindow.totalEstimatedTokens,
        maxContextTokens,
        documentCount: contextWindow.documentCount,
      })
      .returning();
    retrievalRunId = run.id;

    // Phase 5M: Persist per-candidate provenance (best-effort, INV-PROV3/4/5)
    try {
      const selectedChunkIds = new Set(contextWindow.entries.map((e) => e.metadata.chunkId));
      const dedupChunkIds = new Set(rankResult.skippedDuplicate.map((c) => c.chunkId));
      const thresholdChunkIds = new Set(rankResult.skippedThreshold.map((c) => c.chunkId));

      // Build rank lookup for selected entries
      const selectedRankMap = new Map<string, { rank: number; tokens: number }>();
      contextWindow.entries.forEach((e, idx) => {
        selectedRankMap.set(e.metadata.chunkId, {
          rank: idx + 1,
          tokens: e.metadata.estimatedTokens,
        });
      });

      const rows = candidates.map((cand, idx) => {
        const isSelected = selectedChunkIds.has(cand.chunkId);
        const isDedupExcluded = dedupChunkIds.has(cand.chunkId);
        const isThresholdExcluded = thresholdChunkIds.has(cand.chunkId);

        let filterStatus: "selected" | "excluded" = isSelected ? "selected" : "excluded";
        let exclusionReason: string | null = null;
        let inclusionReason: string | null = null;
        let finalRank: number | null = null;
        let tokenCountEstimate: number | null = null;

        if (isSelected) {
          const sel = selectedRankMap.get(cand.chunkId);
          finalRank = sel?.rank ?? null;
          tokenCountEstimate = sel?.tokens ?? null;
          inclusionReason = [
            INCLUSION_REASONS.PASSED_SCOPE_FILTERS,
            INCLUSION_REASONS.PASSED_SIMILARITY_THRESHOLD,
            INCLUSION_REASONS.SURVIVED_DEDUP,
            INCLUSION_REASONS.INCLUDED_IN_CONTEXT_BUDGET,
          ].join(",");
        } else if (isDedupExcluded) {
          exclusionReason = EXCLUSION_REASONS.DUPLICATE_CHUNK;
        } else if (isThresholdExcluded) {
          exclusionReason = EXCLUSION_REASONS.SIMILARITY_BELOW_THRESHOLD;
        } else {
          // Ranked but didn't fit in context window = budget exceeded
          exclusionReason = EXCLUSION_REASONS.TOKEN_BUDGET_EXCEEDED;
          filterStatus = "excluded";
        }

        return {
          tenantId,
          retrievalRunId: run.id,
          chunkId: cand.chunkId,
          sourceType: null as string | null,
          similarityScore: cand.similarityScore.toFixed(8),
          filterStatus,
          exclusionReason,
          inclusionReason,
          candidateRank: idx + 1,
          finalRank,
          tokenCountEstimate,
        };
      });

      if (rows.length > 0) {
        await db.insert(knowledgeRetrievalCandidates).values(rows);
      }
    } catch {
      // Best-effort: candidate persistence failure must never abort the retrieval run
    }
  }

  return {
    tenantId,
    knowledgeBaseId,
    queryHash,
    contextWindow,
    candidatesFound: candidates.length,
    candidatesRanked: rankResult.ranked.length,
    chunksSkippedDuplicate: contextWindow.chunksSkippedDuplicate + rankResult.skippedDuplicate.length,
    chunksSkippedBudget: contextWindow.chunksSkippedBudget,
    chunksSkippedThreshold: rankResult.skippedThreshold.length,
    totalEstimatedTokens: contextWindow.totalEstimatedTokens,
    budgetUtilizationPct: contextWindow.budgetUtilizationPct,
    documentCount: contextWindow.documentCount,
    documentIds: contextWindow.documentIds,
    searchDurationMs,
    retrievalRunId,
    metric,
  };
}

// ─── Explain retrieval context ────────────────────────────────────────────────

export interface RetrievalExplainOutput {
  queryHash: string;
  candidatesFound: number;
  chunksRanked: number;
  chunksSkippedDuplicate: number;
  chunksSkippedBudget: number;
  chunksSkippedThreshold: number;
  chunksSelected: number;
  tokenBudget: number;
  tokensUsed: number;
  budgetUtilizationPct: number;
  documentCount: number;
  appliedFilters: Record<string, unknown>;
  searchDurationMs: number;
  selectionTrace: Array<{
    rank: number;
    chunkId: string;
    documentId: string;
    similarityScore: number;
    estimatedTokens: number;
    selectedReason: string;
  }>;
  exclusionTrace: Array<{
    chunkId: string;
    documentId: string;
    similarityScore: number;
    exclusionReason: "duplicate" | "budget" | "threshold";
  }>;
}

export async function explainRetrievalContext(
  params: RetrievalOrchestrationParams,
): Promise<RetrievalExplainOutput> {
  const {
    tenantId,
    knowledgeBaseId,
    queryEmbedding,
    topKCandidates = 20,
    maxContextTokens = DEFAULT_CONTEXT_TOKEN_BUDGET,
    rankingOptions = {},
    contextOptions = {},
  } = params;

  if (!tenantId) throw new RetrievalInvariantError("INV-RET7", "tenantId is required");
  if (!knowledgeBaseId) throw new RetrievalInvariantError("INV-RET1", "knowledgeBaseId is required");

  const searchResult = await runVectorSearch({
    tenantId,
    knowledgeBaseId,
    queryEmbedding,
    topK: topKCandidates,
  });

  const { candidates, queryHash, searchDurationMs } = searchResult;

  const appliedFilters = previewRetrievalSafeFilterSet({ tenantId, knowledgeBaseId, topK: topKCandidates });

  const rankResult = rankChunks(candidates, rankingOptions);
  const contextWindow = buildContextWindow(rankResult.ranked, { maxTokens: maxContextTokens, ...contextOptions });

  const { estimateChunkTokens } = await import("./token-budget");

  const selectionTrace = contextWindow.entries.map((entry) => ({
    rank: entry.metadata.rank,
    chunkId: entry.metadata.chunkId,
    documentId: entry.metadata.documentId,
    similarityScore: entry.metadata.similarityScore,
    estimatedTokens: entry.metadata.estimatedTokens,
    selectedReason: `similarity_score=${entry.metadata.similarityScore.toFixed(4)}, within token budget`,
  }));

  const exclusionTrace: RetrievalExplainOutput["exclusionTrace"] = [
    ...rankResult.skippedDuplicate.map((c) => ({
      chunkId: c.chunkId,
      documentId: c.documentId,
      similarityScore: c.similarityScore,
      exclusionReason: "duplicate" as const,
    })),
    ...rankResult.skippedThreshold.map((c) => ({
      chunkId: c.chunkId,
      documentId: c.documentId,
      similarityScore: c.similarityScore,
      exclusionReason: "threshold" as const,
    })),
    ...contextWindow.entries.slice(contextWindow.chunksSelected).map((c) => ({
      chunkId: c.metadata.chunkId,
      documentId: c.metadata.documentId,
      similarityScore: c.metadata.similarityScore,
      exclusionReason: "budget" as const,
    })),
  ];

  return {
    queryHash,
    candidatesFound: candidates.length,
    chunksRanked: rankResult.ranked.length,
    chunksSkippedDuplicate: rankResult.skippedDuplicate.length + contextWindow.chunksSkippedDuplicate,
    chunksSkippedBudget: contextWindow.chunksSkippedBudget,
    chunksSkippedThreshold: rankResult.skippedThreshold.length,
    chunksSelected: contextWindow.chunksSelected,
    tokenBudget: maxContextTokens,
    tokensUsed: contextWindow.totalEstimatedTokens,
    budgetUtilizationPct: contextWindow.budgetUtilizationPct,
    documentCount: contextWindow.documentCount,
    appliedFilters,
    searchDurationMs,
    selectionTrace,
    exclusionTrace,
  };
}

// ─── Context preview (no vector search — requires pre-searched candidates) ────

export function buildContextPreview(
  candidates: VectorSearchCandidate[],
  options: {
    maxContextTokens?: number;
    rankingOptions?: RankingOptions;
    contextOptions?: ContextWindowOptions;
  } = {},
): {
  contextWindow: ContextWindow;
  summary: Record<string, unknown>;
} {
  const rankResult = rankChunks(candidates, options.rankingOptions ?? {});
  const contextWindow = buildContextWindow(rankResult.ranked, {
    maxTokens: options.maxContextTokens ?? DEFAULT_CONTEXT_TOKEN_BUDGET,
    ...(options.contextOptions ?? {}),
  });
  return {
    contextWindow,
    summary: summarizeContextWindow(contextWindow),
  };
}

// ─── Retrieval run lookup ─────────────────────────────────────────────────────

export async function getRetrievalRun(
  runId: string,
  tenantId: string,
): Promise<Record<string, unknown>> {
  const [run] = await db
    .select()
    .from(knowledgeRetrievalRuns)
    .where(
      and(
        eq(knowledgeRetrievalRuns.id, runId),
        eq(knowledgeRetrievalRuns.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!run) {
    throw new RetrievalInvariantError(
      "INV-RET1",
      `Retrieval run ${runId} not found for tenant ${tenantId}`,
    );
  }

  return {
    runId: run.id,
    tenantId: run.tenantId,
    knowledgeBaseId: run.knowledgeBaseId,
    queryHash: run.queryHash,
    embeddingModel: run.embeddingModel,
    candidatesFound: run.candidatesFound,
    candidatesRanked: run.candidatesRanked,
    chunksSelected: run.chunksSelected,
    chunksSkippedDuplicate: run.chunksSkippedDuplicate,
    chunksSkippedBudget: run.chunksSkippedBudget,
    contextTokensUsed: run.contextTokensUsed,
    maxContextTokens: run.maxContextTokens,
    documentCount: run.documentCount,
    createdAt: run.createdAt,
  };
}
