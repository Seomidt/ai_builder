/**
 * hybrid-retrieval.ts — Phase 5N
 *
 * Hybrid retrieval layer combining vector and lexical search.
 *
 * Pipeline:
 *   1. Vector search (Phase 5D)
 *   2. Lexical FTS search (Phase 5N)
 *   3. Deterministic RRF fusion (INV-HYB3)
 *   4. Channel-origin assignment (INV-HYB4)
 *   5. Deduplication (by chunkId)
 *   6. Optional reranking (Phase 5N)
 *   7. Context window assembly
 *   8. Optional run + candidate persistence
 *
 * INV-HYB3: Fusion is deterministic (RRF + chunkId tie-breaking)
 * INV-HYB4: Channel origin is always explicit
 * INV-HYB5: All scores (vector, lexical, fused) are preserved and explainable
 * INV-HYB7: explainHybridFusion / summarizeHybridRetrieval perform NO writes
 * INV-HYB8: Channel counts correctly reflect vector_only / lexical_only / both
 */

import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import {
  knowledgeRetrievalCandidates,
  knowledgeRetrievalRuns,
} from "@shared/schema";
import {
  runVectorSearch,
  type VectorSearchCandidate,
} from "./vector-search";
import {
  searchLexicalCandidates,
  type LexicalSearchCandidate,
} from "./lexical-search-provider";
import {
  rankChunks,
  type RankingOptions,
} from "./chunk-ranking";
import {
  buildContextWindow,
  type ContextWindowOptions,
  type ContextWindow,
} from "./context-window-builder";
import {
  DEFAULT_CONTEXT_TOKEN_BUDGET,
} from "./token-budget";
import {
  EXCLUSION_REASONS,
  INCLUSION_REASONS,
} from "./retrieval-provenance";
import {
  rerankHybridCandidates,
  type RerankOptions,
} from "./reranking";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ChannelOrigin = "vector_only" | "lexical_only" | "vector_and_lexical";

export interface HybridCandidate {
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  knowledgeBaseId: string;
  chunkText: string | null;
  chunkIndex: number;
  chunkKey: string;
  sourcePageStart: number | null;
  sourceHeadingPath: string | null;
  contentHash: string | null;
  channelOrigin: ChannelOrigin;
  vectorScore: number | null;
  lexicalScore: number | null;
  fusedScore: number;
  preFusionRankVector: number | null;
  preFusionRankLexical: number | null;
  postFusionRank: number;
  rerankScore: number | null;
  preRerankRank: number | null;
  postRerankRank: number | null;
}

export interface RRFOptions {
  k?: number;
  vectorWeight?: number;
  lexicalWeight?: number;
}

export interface HybridRetrievalParams {
  tenantId: string;
  knowledgeBaseId: string;
  queryEmbedding: number[];
  queryText: string;
  mode?: "hybrid" | "vector_only" | "lexical_only";
  topKVector?: number;
  topKLexical?: number;
  maxContextTokens?: number;
  rankingOptions?: RankingOptions;
  contextOptions?: ContextWindowOptions;
  rerankOptions?: RerankOptions;
  rrfOptions?: RRFOptions;
  persistRun?: boolean;
  embeddingModel?: string;
  similarityThreshold?: number;
}

export interface HybridRetrievalResult {
  tenantId: string;
  knowledgeBaseId: string;
  mode: "hybrid" | "vector_only" | "lexical_only";
  queryHash: string;
  contextWindow: ContextWindow;
  hybridCandidates: HybridCandidate[];
  totalVectorCandidates: number;
  totalLexicalCandidates: number;
  totalFusedCandidates: number;
  totalVectorOnly: number;
  totalLexicalOnly: number;
  totalBothChannels: number;
  fusionStrategy: string;
  rerankingEnabled: boolean;
  retrievalRunId: string | null;
  searchDurationMs: number;
}

// ── RRF fusion (INV-HYB3) ─────────────────────────────────────────────────────

export function fuseVectorAndLexicalCandidates(
  vectorCandidates: VectorSearchCandidate[],
  lexicalCandidates: LexicalSearchCandidate[],
  options: RRFOptions = {},
): HybridCandidate[] {
  const { k = 60, vectorWeight = 1, lexicalWeight = 1 } = options;

  // Build rank maps (1-indexed)
  const vectorRankMap = new Map<string, { rank: number; candidate: VectorSearchCandidate }>();
  for (let i = 0; i < vectorCandidates.length; i++) {
    vectorRankMap.set(vectorCandidates[i].chunkId, { rank: i + 1, candidate: vectorCandidates[i] });
  }

  const lexicalRankMap = new Map<string, { rank: number; candidate: LexicalSearchCandidate }>();
  for (let i = 0; i < lexicalCandidates.length; i++) {
    lexicalRankMap.set(lexicalCandidates[i].chunkId, {
      rank: i + 1,
      candidate: lexicalCandidates[i],
    });
  }

  // Union of all chunk IDs
  const allChunkIds = Array.from(
    new Set([
      ...vectorCandidates.map((c) => c.chunkId),
      ...lexicalCandidates.map((c) => c.chunkId),
    ]),
  );

  const fused: HybridCandidate[] = [];

  for (const chunkId of allChunkIds) {
    const vEntry = vectorRankMap.get(chunkId) ?? null;
    const lEntry = lexicalRankMap.get(chunkId) ?? null;

    const vectorRrf = vEntry ? vectorWeight / (k + vEntry.rank) : 0;
    const lexicalRrf = lEntry ? lexicalWeight / (k + lEntry.rank) : 0;
    const fusedScore = vectorRrf + lexicalRrf;

    const channelOrigin: ChannelOrigin =
      vEntry && lEntry ? "vector_and_lexical" : vEntry ? "vector_only" : "lexical_only";

    // Use vector candidate metadata as primary source; fall back to lexical
    const base = vEntry?.candidate ?? lEntry!.candidate;
    const baseChunkText = vEntry?.candidate.chunkText ?? lEntry?.candidate.chunkText ?? null;
    const baseContentHash = vEntry?.candidate.contentHash ?? lEntry?.candidate.contentHash ?? null;
    const baseSourcePage = vEntry?.candidate.sourcePageStart ?? lEntry?.candidate.sourcePageStart ?? null;
    const baseHeadingPath = vEntry?.candidate.sourceHeadingPath ?? lEntry?.candidate.sourceHeadingPath ?? null;

    fused.push({
      chunkId,
      documentId: base.documentId,
      documentVersionId: base.documentVersionId,
      knowledgeBaseId: base.knowledgeBaseId,
      chunkText: baseChunkText,
      chunkIndex: base.chunkIndex,
      chunkKey: base.chunkKey,
      sourcePageStart: baseSourcePage,
      sourceHeadingPath: baseHeadingPath,
      contentHash: baseContentHash,
      channelOrigin,
      vectorScore: vEntry?.candidate.similarityScore ?? null,
      lexicalScore: lEntry?.candidate.lexicalScore ?? null,
      fusedScore,
      preFusionRankVector: vEntry?.rank ?? null,
      preFusionRankLexical: lEntry?.rank ?? null,
      postFusionRank: 0, // set after sort
      rerankScore: null,
      preRerankRank: null,
      postRerankRank: null,
    });
  }

  // Sort by fusedScore DESC, then by chunkId for deterministic tie-breaking (INV-HYB3)
  fused.sort((a, b) => {
    const scoreDiff = b.fusedScore - a.fusedScore;
    if (Math.abs(scoreDiff) > 1e-12) return scoreDiff;
    return a.chunkId < b.chunkId ? -1 : 1;
  });

  // Assign postFusionRank
  fused.forEach((c, i) => { c.postFusionRank = i + 1; });

  return fused;
}

// ── Normalize hybrid scores to [0, 1] ─────────────────────────────────────────

export function normalizeHybridScores(candidates: HybridCandidate[]): HybridCandidate[] {
  const maxFused = Math.max(...candidates.map((c) => c.fusedScore), 1e-12);
  return candidates.map((c) => ({
    ...c,
    fusedScore: c.fusedScore / maxFused,
    vectorScore: c.vectorScore,
    lexicalScore: c.lexicalScore,
  }));
}

// ── Convert HybridCandidate to VectorSearchCandidate-compatible for ranking ───

function toRankableCandidate(c: HybridCandidate): VectorSearchCandidate {
  return {
    rank: c.postFusionRank,
    chunkId: c.chunkId,
    documentId: c.documentId,
    documentVersionId: c.documentVersionId,
    knowledgeBaseId: c.knowledgeBaseId,
    chunkText: c.chunkText,
    chunkIndex: c.chunkIndex,
    chunkKey: c.chunkKey,
    sourcePageStart: c.sourcePageStart,
    sourceHeadingPath: c.sourceHeadingPath,
    similarityScore: c.fusedScore,
    similarityMetric: "cosine",
    contentHash: c.contentHash,
  };
}

// ── Main hybrid retrieval entry point ─────────────────────────────────────────

export async function runHybridRetrieval(
  params: HybridRetrievalParams,
): Promise<HybridRetrievalResult> {
  const {
    tenantId,
    knowledgeBaseId,
    queryEmbedding,
    queryText,
    mode = "hybrid",
    topKVector = 20,
    topKLexical = 20,
    maxContextTokens = DEFAULT_CONTEXT_TOKEN_BUDGET,
    rankingOptions = {},
    contextOptions = {},
    rerankOptions = {},
    rrfOptions = {},
    persistRun = false,
    embeddingModel,
  } = params;

  const startMs = Date.now();

  // Step 1: Vector search
  let vectorCandidates: VectorSearchCandidate[] = [];
  let queryHash = "";
  let searchDurationMs = 0;

  if (mode === "hybrid" || mode === "vector_only") {
    const vectorResult = await runVectorSearch({
      tenantId,
      knowledgeBaseId,
      queryEmbedding,
      topK: topKVector,
      embeddingModel,
    });
    vectorCandidates = vectorResult.candidates;
    queryHash = vectorResult.queryHash;
    searchDurationMs = vectorResult.searchDurationMs;
  }

  // Step 2: Lexical search
  let lexicalCandidates: LexicalSearchCandidate[] = [];

  if (mode === "hybrid" || mode === "lexical_only") {
    const lexicalResult = await searchLexicalCandidates({
      tenantId,
      knowledgeBaseId,
      queryText,
      topK: topKLexical,
    });
    lexicalCandidates = lexicalResult.candidates;
    if (!queryHash) {
      const { createHash } = await import("crypto");
      queryHash = createHash("sha256").update(queryText).digest("hex").slice(0, 32);
    }
  }

  // Step 3: Fuse candidates
  let hybridCandidates: HybridCandidate[];

  if (mode === "vector_only") {
    hybridCandidates = vectorCandidates.map((c, i) => ({
      chunkId: c.chunkId,
      documentId: c.documentId,
      documentVersionId: c.documentVersionId,
      knowledgeBaseId: c.knowledgeBaseId,
      chunkText: c.chunkText,
      chunkIndex: c.chunkIndex,
      chunkKey: c.chunkKey,
      sourcePageStart: c.sourcePageStart,
      sourceHeadingPath: c.sourceHeadingPath,
      contentHash: c.contentHash,
      channelOrigin: "vector_only" as ChannelOrigin,
      vectorScore: c.similarityScore,
      lexicalScore: null,
      fusedScore: c.similarityScore,
      preFusionRankVector: i + 1,
      preFusionRankLexical: null,
      postFusionRank: i + 1,
      rerankScore: null,
      preRerankRank: null,
      postRerankRank: null,
    }));
  } else if (mode === "lexical_only") {
    hybridCandidates = lexicalCandidates.map((c, i) => ({
      chunkId: c.chunkId,
      documentId: c.documentId,
      documentVersionId: c.documentVersionId,
      knowledgeBaseId: c.knowledgeBaseId,
      chunkText: c.chunkText,
      chunkIndex: c.chunkIndex,
      chunkKey: c.chunkKey,
      sourcePageStart: c.sourcePageStart,
      sourceHeadingPath: c.sourceHeadingPath,
      contentHash: c.contentHash,
      channelOrigin: "lexical_only" as ChannelOrigin,
      vectorScore: null,
      lexicalScore: c.lexicalScore,
      fusedScore: c.lexicalScore,
      preFusionRankVector: null,
      preFusionRankLexical: i + 1,
      postFusionRank: i + 1,
      rerankScore: null,
      preRerankRank: null,
      postRerankRank: null,
    }));
  } else {
    hybridCandidates = fuseVectorAndLexicalCandidates(
      vectorCandidates,
      lexicalCandidates,
      rrfOptions,
    );
  }

  // Step 4: Reranking (INV-HYB6)
  const rerankingEnabled = Object.keys(rerankOptions).length > 0;
  if (rerankingEnabled) {
    const reranked = rerankHybridCandidates(hybridCandidates, rerankOptions);
    for (let i = 0; i < reranked.length; i++) {
      const c = reranked[i];
      const original = hybridCandidates.find((h) => h.chunkId === c.chunkId);
      if (original) {
        original.rerankScore = c.rerankScore;
        original.preRerankRank = c.preRerankRank;
        original.postRerankRank = i + 1;
      }
    }
    // Re-sort by rerank score
    hybridCandidates.sort((a, b) => {
      const aDiff = (b.rerankScore ?? b.fusedScore) - (a.rerankScore ?? a.fusedScore);
      if (Math.abs(aDiff) > 1e-12) return aDiff;
      return a.chunkId < b.chunkId ? -1 : 1;
    });
  }

  // Step 5: Build context window via chunk-ranking
  const rankableForContext = hybridCandidates.map(toRankableCandidate);
  const rankResult = rankChunks(rankableForContext, rankingOptions);
  const contextWindow = buildContextWindow(rankResult.ranked, {
    maxTokens: maxContextTokens,
    ...contextOptions,
  });

  // Step 6: Persist run + candidates
  let retrievalRunId: string | null = null;
  if (persistRun) {
    const [run] = await db
      .insert(knowledgeRetrievalRuns)
      .values({
        tenantId,
        knowledgeBaseId,
        queryHash,
        embeddingModel: embeddingModel ?? null,
        candidatesFound: hybridCandidates.length,
        candidatesRanked: rankResult.ranked.length,
        chunksSelected: contextWindow.chunksSelected,
        chunksSkippedDuplicate: contextWindow.chunksSkippedDuplicate + rankResult.skippedDuplicate.length,
        chunksSkippedBudget: contextWindow.chunksSkippedBudget,
        contextTokensUsed: contextWindow.totalEstimatedTokens,
        maxContextTokens,
        documentCount: contextWindow.documentCount,
        retrievalVersion: "5n",
      })
      .returning();
    retrievalRunId = run.id;

    // Persist hybrid candidate provenance (best-effort)
    try {
      const selectedChunkIds = new Set(contextWindow.entries.map((e) => e.metadata.chunkId));
      const dedupChunkIds = new Set(rankResult.skippedDuplicate.map((c) => c.chunkId));
      const selectedRankMap = new Map<string, { rank: number; tokens: number }>();
      contextWindow.entries.forEach((e, i) => {
        selectedRankMap.set(e.metadata.chunkId, { rank: i + 1, tokens: e.metadata.estimatedTokens });
      });

      const rows = hybridCandidates.map((hc, idx) => {
        const isSelected = selectedChunkIds.has(hc.chunkId);
        const isDedup = dedupChunkIds.has(hc.chunkId);
        const sel = selectedRankMap.get(hc.chunkId);

        let filterStatus: "selected" | "excluded" = isSelected ? "selected" : "excluded";
        let exclusionReason: string | null = null;
        let inclusionReason: string | null = null;
        let finalRank: number | null = null;
        let tokenCountEstimate: number | null = null;

        if (isSelected) {
          finalRank = sel?.rank ?? null;
          tokenCountEstimate = sel?.tokens ?? null;
          const channelInclusion =
            hc.channelOrigin === "vector_only"
              ? INCLUSION_REASONS.SELECTED_BY_VECTOR_CHANNEL
              : hc.channelOrigin === "lexical_only"
              ? INCLUSION_REASONS.SELECTED_BY_LEXICAL_CHANNEL
              : INCLUSION_REASONS.SELECTED_BY_BOTH_CHANNELS;
          inclusionReason = [channelInclusion, INCLUSION_REASONS.INCLUDED_IN_CONTEXT_BUDGET].join(",");
        } else if (isDedup) {
          exclusionReason = EXCLUSION_REASONS.DUPLICATE_CHUNK;
        } else {
          exclusionReason = EXCLUSION_REASONS.TOKEN_BUDGET_EXCEEDED;
          filterStatus = "excluded";
        }

        return {
          tenantId,
          retrievalRunId: run.id,
          chunkId: hc.chunkId,
          sourceType: null as string | null,
          channelOrigin: hc.channelOrigin,
          vectorScore: hc.vectorScore?.toFixed(8) ?? null,
          lexicalScore: hc.lexicalScore?.toFixed(8) ?? null,
          fusedScore: hc.fusedScore.toFixed(8),
          rerankScore: hc.rerankScore?.toFixed(8) ?? null,
          preFusionRankVector: hc.preFusionRankVector,
          preFusionRankLexical: hc.preFusionRankLexical,
          preRerankRank: hc.preRerankRank,
          postRerankRank: hc.postRerankRank,
          similarityScore: hc.vectorScore?.toFixed(8) ?? hc.fusedScore.toFixed(8),
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
      // Best-effort: candidate persistence must never abort retrieval
    }
  }

  const searchTotal = Date.now() - startMs;

  return {
    tenantId,
    knowledgeBaseId,
    mode,
    queryHash,
    contextWindow,
    hybridCandidates,
    totalVectorCandidates: vectorCandidates.length,
    totalLexicalCandidates: lexicalCandidates.length,
    totalFusedCandidates: hybridCandidates.length,
    totalVectorOnly: hybridCandidates.filter((c) => c.channelOrigin === "vector_only").length,
    totalLexicalOnly: hybridCandidates.filter((c) => c.channelOrigin === "lexical_only").length,
    totalBothChannels: hybridCandidates.filter((c) => c.channelOrigin === "vector_and_lexical").length,
    fusionStrategy: mode === "hybrid" ? "reciprocal_rank_fusion" : mode,
    rerankingEnabled,
    retrievalRunId,
    searchDurationMs: searchDurationMs || searchTotal,
  };
}

// ── Explain hybrid fusion for a run (INV-HYB5,7) ────────────────────────────

export async function explainHybridFusion(runId: string): Promise<{
  runId: string;
  fusionStrategy: string;
  channelBreakdown: Record<ChannelOrigin, number>;
  candidates: Array<{
    chunkId: string | null;
    channelOrigin: string | null;
    vectorScore: string | null;
    lexicalScore: string | null;
    fusedScore: string | null;
    preFusionRankVector: number | null;
    preFusionRankLexical: number | null;
    postFusionRank: number | null;
    filterStatus: string;
  }>;
  note: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  const breakdown: Record<ChannelOrigin, number> = {
    vector_only: 0,
    lexical_only: 0,
    vector_and_lexical: 0,
  };
  for (const r of rows) {
    const ch = (r.channelOrigin ?? "vector_only") as ChannelOrigin;
    if (ch in breakdown) breakdown[ch]++;
  }

  return {
    runId,
    fusionStrategy: "reciprocal_rank_fusion",
    channelBreakdown: breakdown,
    candidates: rows
      .sort((a, b) => (a.candidateRank ?? 999) - (b.candidateRank ?? 999))
      .map((c) => ({
        chunkId: c.chunkId ?? null,
        channelOrigin: c.channelOrigin ?? null,
        vectorScore: c.vectorScore ?? null,
        lexicalScore: c.lexicalScore ?? null,
        fusedScore: c.fusedScore ?? null,
        preFusionRankVector: c.preFusionRankVector ?? null,
        preFusionRankLexical: c.preFusionRankLexical ?? null,
        postFusionRank: c.postRerankRank ?? c.finalRank ?? null,
        filterStatus: c.filterStatus,
      })),
    note:
      rows.length === 0
        ? "No candidates found — run was not persisted with persistRun=true"
        : `${rows.length} candidate records`,
  };
}

// ── Summarize hybrid retrieval (INV-HYB8) ────────────────────────────────────

export async function summarizeHybridRetrieval(runId: string): Promise<{
  runId: string;
  tenantId: string;
  knowledgeBaseId: string;
  totalCandidates: number;
  totalVectorOnly: number;
  totalLexicalOnly: number;
  totalBothChannels: number;
  totalFusedCandidates: number;
  totalSelected: number;
  totalExcluded: number;
  fusionStrategy: string;
  rerankingEnabled: boolean;
  dominantChannel: ChannelOrigin | null;
  hybridExplainabilityCompleteness: "full" | "partial" | "none";
  note: string;
}> {
  const runRows = await db
    .select()
    .from(knowledgeRetrievalRuns)
    .where(eq(knowledgeRetrievalRuns.id, runId))
    .limit(1);
  if (!runRows.length) throw new Error(`Retrieval run not found: ${runId}`);
  const run = runRows[0];

  const candidates = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  const vectorOnly = candidates.filter((c) => c.channelOrigin === "vector_only").length;
  const lexicalOnly = candidates.filter((c) => c.channelOrigin === "lexical_only").length;
  const both = candidates.filter((c) => c.channelOrigin === "vector_and_lexical").length;
  const selected = candidates.filter((c) => c.filterStatus === "selected").length;
  const excluded = candidates.filter((c) => c.filterStatus === "excluded").length;
  const rerankingEnabled = candidates.some((c) => c.rerankScore !== null);

  const dominantChannel: ChannelOrigin | null =
    candidates.length === 0
      ? null
      : vectorOnly >= lexicalOnly && vectorOnly >= both
      ? "vector_only"
      : lexicalOnly >= both
      ? "lexical_only"
      : "vector_and_lexical";

  const hasChannelOrigins = candidates.every((c) => c.channelOrigin !== null);
  const hybridExplainabilityCompleteness: "full" | "partial" | "none" =
    candidates.length === 0 ? "none" : hasChannelOrigins ? "full" : "partial";

  return {
    runId,
    tenantId: run.tenantId,
    knowledgeBaseId: run.knowledgeBaseId,
    totalCandidates: candidates.length,
    totalVectorOnly: vectorOnly,
    totalLexicalOnly: lexicalOnly,
    totalBothChannels: both,
    totalFusedCandidates: candidates.length,
    totalSelected: selected,
    totalExcluded: excluded,
    fusionStrategy: run.retrievalVersion === "5n" ? "reciprocal_rank_fusion" : "vector_only",
    rerankingEnabled,
    dominantChannel,
    hybridExplainabilityCompleteness,
    note:
      candidates.length === 0
        ? "No candidates found — run was not persisted with persistRun=true"
        : `${candidates.length} candidates, ${selected} selected`,
  };
}

// ── List hybrid candidate sources (INV-HYB4,7) ───────────────────────────────

export async function listHybridCandidateSources(runId: string): Promise<{
  runId: string;
  sources: Array<{
    chunkId: string | null;
    channelOrigin: string | null;
    vectorScore: string | null;
    lexicalScore: string | null;
    fusedScore: string | null;
    filterStatus: string;
    finalRank: number | null;
  }>;
  count: number;
}> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  return {
    runId,
    sources: rows
      .sort((a, b) => (a.candidateRank ?? 999) - (b.candidateRank ?? 999))
      .map((c) => ({
        chunkId: c.chunkId ?? null,
        channelOrigin: c.channelOrigin ?? null,
        vectorScore: c.vectorScore ?? null,
        lexicalScore: c.lexicalScore ?? null,
        fusedScore: c.fusedScore ?? null,
        filterStatus: c.filterStatus,
        finalRank: c.finalRank ?? null,
      })),
    count: rows.length,
  };
}

// ── Explain fusion strategy (no writes) ──────────────────────────────────────

export function explainFusionStrategy(options: RRFOptions = {}): Record<string, unknown> {
  const { k = 60, vectorWeight = 1, lexicalWeight = 1 } = options;
  return {
    name: "Reciprocal Rank Fusion (RRF)",
    formula: "rrf_score = (vectorWeight / (k + rank_vector)) + (lexicalWeight / (k + rank_lexical))",
    parameters: { k, vectorWeight, lexicalWeight },
    properties: {
      deterministic: true,
      tieBreaking: "chunkId ascending",
      handlesOneChannelOnly: true,
      scoreRange: "(0, vectorWeight/k + lexicalWeight/k]",
    },
    notes: [
      "Higher k reduces the impact of rank differences (smoother)",
      "k=60 is a standard industry default",
      "Candidates only in one channel get contribution from that channel only",
    ],
  };
}

export function previewFusionOutcome(
  vectorCandidates: VectorSearchCandidate[],
  lexicalCandidates: LexicalSearchCandidate[],
  options: RRFOptions = {},
): HybridCandidate[] {
  // Preview only — no side effects, no DB calls
  return fuseVectorAndLexicalCandidates(vectorCandidates, lexicalCandidates, options);
}
