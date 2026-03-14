/**
 * reranking.ts — Phase 5N
 *
 * Lightweight deterministic reranking foundation for hybrid retrieval.
 *
 * Phase 5N reranking is a clean foundation — intentionally simple and
 * deterministic so it can be upgraded to ML cross-encoder models later
 * without breaking existing behavior.
 *
 * Factors (configurable, all normalized to [0, 1]):
 *   1. fused_score  — primary signal (always enabled)
 *   2. source_diversity_bonus — reward chunks from underrepresented documents
 *   3. per_document_balance   — penalize over-representation from one doc
 *   4. recency_bonus          — reserved slot for future date-aware scoring
 *
 * INV-HYB6: Reranking must not silently violate deterministic retrieval
 * INV-HYB7: explainReranking / summarizeRerankingImpact perform NO writes
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  knowledgeRetrievalCandidates,
  knowledgeRetrievalRuns,
} from "@shared/schema";
import type { HybridCandidate } from "./hybrid-retrieval";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RerankOptions {
  fusedScoreWeight?: number;
  sourceDiversityBonus?: number;
  perDocumentBalancePenalty?: number;
  maxChunksPerDocumentBeforePenalty?: number;
}

export interface RerankCandidate {
  chunkId: string;
  documentId: string;
  preRerankRank: number;
  rerankScore: number;
  rerankFactors: {
    fusedScoreContribution: number;
    sourceDiversityContribution: number;
    perDocumentBalanceContribution: number;
  };
  channelOrigin: string;
  vectorScore: number | null;
  lexicalScore: number | null;
  fusedScore: number;
}

// ── Main reranking function (INV-HYB6) ───────────────────────────────────────

export function rerankHybridCandidates(
  candidates: HybridCandidate[],
  options: RerankOptions = {},
): RerankCandidate[] {
  const {
    fusedScoreWeight = 0.8,
    sourceDiversityBonus = 0.1,
    perDocumentBalancePenalty = 0.1,
    maxChunksPerDocumentBeforePenalty = 3,
  } = options;

  if (candidates.length === 0) return [];

  // Count document occurrences (to apply diversity bonus/penalty)
  const docCounts = new Map<string, number>();
  for (const c of candidates) {
    docCounts.set(c.documentId, (docCounts.get(c.documentId) ?? 0) + 1);
  }

  const totalDocs = docCounts.size;
  const avgChunksPerDoc = candidates.length / Math.max(totalDocs, 1);

  // Process each candidate
  const docSeenCount = new Map<string, number>();
  const reranked: RerankCandidate[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];

    // 1. Fused score contribution
    const fusedScoreContribution = fusedScoreWeight * c.fusedScore;

    // 2. Source diversity bonus — reward chunks from docs with fewer total chunks
    const docFrequency = (docCounts.get(c.documentId) ?? 1) / candidates.length;
    const sourceDiversityContribution = sourceDiversityBonus * (1 - docFrequency);

    // 3. Per-document balance penalty — penalize if this doc is over-represented
    const seenFromDoc = docSeenCount.get(c.documentId) ?? 0;
    const overLimit = Math.max(0, seenFromDoc - maxChunksPerDocumentBeforePenalty + 1);
    const perDocumentBalanceContribution = -perDocumentBalancePenalty * (overLimit / avgChunksPerDoc);

    docSeenCount.set(c.documentId, seenFromDoc + 1);

    const rerankScore = Math.max(
      0,
      fusedScoreContribution + sourceDiversityContribution + perDocumentBalanceContribution,
    );

    reranked.push({
      chunkId: c.chunkId,
      documentId: c.documentId,
      preRerankRank: i + 1,
      rerankScore,
      rerankFactors: {
        fusedScoreContribution,
        sourceDiversityContribution,
        perDocumentBalanceContribution,
      },
      channelOrigin: c.channelOrigin,
      vectorScore: c.vectorScore,
      lexicalScore: c.lexicalScore,
      fusedScore: c.fusedScore,
    });
  }

  // Sort by rerankScore DESC, then chunkId for determinism (INV-HYB6)
  reranked.sort((a, b) => {
    const diff = b.rerankScore - a.rerankScore;
    if (Math.abs(diff) > 1e-12) return diff;
    return a.chunkId < b.chunkId ? -1 : 1;
  });

  return reranked;
}

// ── Explain reranking for a run (INV-HYB7: no writes) ────────────────────────

export async function explainReranking(runId: string): Promise<{
  runId: string;
  rerankingEnabled: boolean;
  rerankingImpact: "none" | "minor" | "moderate" | "significant";
  candidates: Array<{
    chunkId: string | null;
    preRerankRank: number | null;
    postRerankRank: number | null;
    rerankScore: string | null;
    channelOrigin: string | null;
    rankShift: number | null;
  }>;
  averageRankShift: number | null;
  note: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  const rerankingEnabled = rows.some((r) => r.rerankScore !== null);

  let averageRankShift: number | null = null;
  if (rerankingEnabled) {
    const shifts = rows
      .filter((r) => r.preRerankRank !== null && r.postRerankRank !== null)
      .map((r) => Math.abs((r.postRerankRank ?? 0) - (r.preRerankRank ?? 0)));
    averageRankShift = shifts.length > 0 ? shifts.reduce((a, b) => a + b, 0) / shifts.length : 0;
  }

  const impact: "none" | "minor" | "moderate" | "significant" =
    !rerankingEnabled
      ? "none"
      : averageRankShift === null || averageRankShift === 0
      ? "none"
      : averageRankShift < 1
      ? "minor"
      : averageRankShift < 3
      ? "moderate"
      : "significant";

  return {
    runId,
    rerankingEnabled,
    rerankingImpact: impact,
    candidates: rows
      .sort((a, b) => (a.candidateRank ?? 999) - (b.candidateRank ?? 999))
      .map((c) => ({
        chunkId: c.chunkId ?? null,
        preRerankRank: c.preRerankRank ?? null,
        postRerankRank: c.postRerankRank ?? null,
        rerankScore: c.rerankScore ?? null,
        channelOrigin: c.channelOrigin ?? null,
        rankShift:
          c.preRerankRank !== null && c.postRerankRank !== null
            ? (c.postRerankRank ?? 0) - (c.preRerankRank ?? 0)
            : null,
      })),
    averageRankShift,
    note: rerankingEnabled
      ? `Reranking applied — impact: ${impact}, avg rank shift: ${averageRankShift?.toFixed(2) ?? "N/A"}`
      : "Reranking was not applied for this run",
  };
}

// ── Summarize reranking impact (INV-HYB7: no writes) ─────────────────────────

export async function summarizeRerankingImpact(runId: string): Promise<{
  runId: string;
  rerankingEnabled: boolean;
  candidatesAffected: number;
  candidatesPromoted: number;
  candidatesDemoted: number;
  largestPromotion: number;
  largestDemotion: number;
  factors: string[];
  note: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  const rerankingEnabled = rows.some((r) => r.rerankScore !== null);
  const affected = rows.filter((r) => r.preRerankRank !== null && r.postRerankRank !== null);
  const promoted = affected.filter(
    (r) => (r.postRerankRank ?? 0) < (r.preRerankRank ?? 0),
  );
  const demoted = affected.filter(
    (r) => (r.postRerankRank ?? 0) > (r.preRerankRank ?? 0),
  );

  const shifts = affected.map(
    (r) => (r.postRerankRank ?? 0) - (r.preRerankRank ?? 0),
  );
  const largestPromotion = shifts.length > 0 ? Math.abs(Math.min(...shifts, 0)) : 0;
  const largestDemotion = shifts.length > 0 ? Math.max(...shifts, 0) : 0;

  return {
    runId,
    rerankingEnabled,
    candidatesAffected: affected.length,
    candidatesPromoted: promoted.length,
    candidatesDemoted: demoted.length,
    largestPromotion,
    largestDemotion,
    factors: rerankingEnabled
      ? ["fused_score", "source_diversity_bonus", "per_document_balance"]
      : [],
    note: rerankingEnabled
      ? `${affected.length} candidates reranked; ${promoted.length} promoted, ${demoted.length} demoted`
      : "Reranking was not applied for this run",
  };
}

// ── Run summary model extension ───────────────────────────────────────────────

export async function buildHybridRunSummary(runId: string): Promise<{
  retrievalRunId: string;
  tenantId: string;
  knowledgeBaseId: string;
  totalVectorCandidates: number;
  totalLexicalCandidates: number;
  totalFusedCandidates: number;
  totalVectorOnly: number;
  totalLexicalOnly: number;
  totalBothChannels: number;
  fusionStrategy: string;
  rerankingEnabled: boolean;
  dominantChannel: string | null;
  lexicalQueryUsed: boolean;
  hybridExplainabilityCompleteness: "full" | "partial" | "none";
  totalSelected: number;
  totalExcluded: number;
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
  const lexicalQueryUsed = candidates.some(
    (c) => c.channelOrigin === "lexical_only" || c.channelOrigin === "vector_and_lexical",
  );

  const dominantChannel =
    candidates.length === 0
      ? null
      : vectorOnly >= lexicalOnly && vectorOnly >= both
      ? "vector_only"
      : lexicalOnly >= both
      ? "lexical_only"
      : "vector_and_lexical";

  const hasChannelOrigins = candidates.length > 0 && candidates.every((c) => c.channelOrigin !== null);

  return {
    retrievalRunId: runId,
    tenantId: run.tenantId,
    knowledgeBaseId: run.knowledgeBaseId,
    totalVectorCandidates: vectorOnly + both,
    totalLexicalCandidates: lexicalOnly + both,
    totalFusedCandidates: candidates.length,
    totalVectorOnly: vectorOnly,
    totalLexicalOnly: lexicalOnly,
    totalBothChannels: both,
    fusionStrategy: run.retrievalVersion === "5n" ? "reciprocal_rank_fusion" : "vector_only",
    rerankingEnabled,
    dominantChannel,
    lexicalQueryUsed,
    hybridExplainabilityCompleteness: candidates.length === 0 ? "none" : hasChannelOrigins ? "full" : "partial",
    totalSelected: selected,
    totalExcluded: excluded,
  };
}
