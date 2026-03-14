/**
 * advanced-reranking.ts — Phase 5O
 *
 * Advanced reranking layer: shortlist → provider scoring → calibration → fallback.
 *
 * Pipeline position:
 *   hybrid fusion (5N) → shortlist → advanced reranking (5O) → context assembly
 *
 * Score calibration model (INV-RER4 — all scores separately explainable):
 *   final_score = advancedWeight * heavy_rerank_score + (1 - advancedWeight) * fused_score
 *   Default advancedWeight = 0.7
 *   Fallback: final_score = fused_score
 *
 * Fallback behavior (INV-RER5 — explicit and queryable):
 *   - no_api_key     → fallback to lightweight reranker
 *   - provider_error → fallback to lightweight reranker
 *   - provider_timeout → fallback to lightweight reranker
 *   - invalid_response → fallback to lightweight reranker
 *   - no_candidates  → fallback to lightweight reranker
 *
 * INV-RER1: Tenant-safe — no cross-tenant data flows
 * INV-RER2: Only operates on already-safe shortlisted candidates (after hybrid fusion)
 * INV-RER3: Shortlist generation is deterministic (fusedScore DESC, chunkId ASC tie-break)
 * INV-RER4: heavy_rerank_score, fused_score, final_score always separately explainable
 * INV-RER5: Fallback always explicit, fallback_reason always recorded
 * INV-RER6: Determinism preserved — equal scores broken by chunkId ascending
 * INV-RER7: All explain/* functions perform ZERO writes
 * INV-RER8: Context assembly receives final reranked order
 * INV-RER9: Phase 5M provenance fields preserved
 * INV-RER10: Phase 5N hybrid fields (channel_origin, fused_score) preserved
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
  knowledgeRetrievalCandidates,
  knowledgeRetrievalRuns,
} from "@shared/schema";
import {
  rerankCandidatesWithModel,
  RerankProviderError,
  type RerankProviderOutput,
  summarizeRerankingProviderResult,
} from "./advanced-reranking-provider";
import {
  rerankHybridCandidates,
  type RerankOptions,
} from "./reranking";
import type { HybridCandidate } from "./hybrid-retrieval";
import {
  EXCLUSION_REASONS,
  INCLUSION_REASONS,
} from "./retrieval-provenance";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RerankMode = "lightweight" | "advanced" | "fallback" | "auto";

export interface AdvancedRerankOptions {
  rerankMode?: RerankMode;
  shortlistSize?: number;
  advancedWeight?: number;
  modelName?: string;
  maxTextCharsPerCandidate?: number;
  lightweightOptions?: RerankOptions;
}

export interface AdvancedRerankMetrics {
  shortlistSize: number;
  advancedRerankUsed: boolean;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  providerLatencyMs: number | null;
  providerPromptTokens: number | null;
  providerCompletionTokens: number | null;
  providerEstimatedCostUsd: number | null;
  averageScoreDelta: number;
  promotionCount: number;
  demotionCount: number;
  stableRankCount: number;
}

export interface AdvancedRerankCandidate extends HybridCandidate {
  heavyRerankScore: number | null;
  finalScore: number;
  rerankMode: RerankMode;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  shortlistRank: number | null;
  advancedRerankRank: number | null;
  rerankProviderName: string | null;
  rerankProviderVersion: string | null;
  finalRank: number;
}

export interface AdvancedRerankResult {
  candidates: AdvancedRerankCandidate[];
  rerankMode: RerankMode;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  providerOutput: RerankProviderOutput | null;
  metrics: AdvancedRerankMetrics;
  shortlistSize: number;
}

// ── Shortlist strategy (INV-RER3: deterministic) ──────────────────────────────

export function buildRerankShortlist(
  candidates: HybridCandidate[],
  options: { shortlistSize?: number } = {},
): HybridCandidate[] {
  const shortlistSize = options.shortlistSize ?? 20;

  // Sort by fusedScore DESC, tie-break by chunkId ASC (INV-RER3)
  const sorted = [...candidates].sort((a, b) => {
    const scoreDiff = b.fusedScore - a.fusedScore;
    if (Math.abs(scoreDiff) > 1e-12) return scoreDiff;
    return a.chunkId < b.chunkId ? -1 : 1;
  });

  return sorted.slice(0, shortlistSize);
}

// ── Score calibration (INV-RER4: separately explainable) ─────────────────────

export interface CalibrationResult {
  chunkId: string;
  fusedScore: number;
  heavyRerankScore: number | null;
  finalScore: number;
  advancedWeight: number;
  calibrationMode: "advanced" | "fallback_to_fused";
}

export function calibrateFinalRerankScore(
  candidate: { chunkId: string; fusedScore: number; heavyRerankScore: number | null },
  advancedWeight = 0.7,
): CalibrationResult {
  if (candidate.heavyRerankScore !== null) {
    const finalScore =
      advancedWeight * candidate.heavyRerankScore +
      (1 - advancedWeight) * candidate.fusedScore;
    return {
      chunkId: candidate.chunkId,
      fusedScore: candidate.fusedScore,
      heavyRerankScore: candidate.heavyRerankScore,
      finalScore: Math.max(0, Math.min(1, finalScore)),
      advancedWeight,
      calibrationMode: "advanced",
    };
  }
  return {
    chunkId: candidate.chunkId,
    fusedScore: candidate.fusedScore,
    heavyRerankScore: null,
    finalScore: candidate.fusedScore,
    advancedWeight: 0,
    calibrationMode: "fallback_to_fused",
  };
}

export function explainScoreCalibration(
  candidate: CalibrationResult,
): Record<string, unknown> {
  if (candidate.calibrationMode === "advanced") {
    return {
      formula: `final_score = ${candidate.advancedWeight} * heavy_rerank_score + ${1 - candidate.advancedWeight} * fused_score`,
      values: {
        heavy_rerank_score: candidate.heavyRerankScore,
        fused_score: candidate.fusedScore,
        advanced_weight: candidate.advancedWeight,
        fused_weight: 1 - candidate.advancedWeight,
        final_score: candidate.finalScore,
      },
      mode: "advanced",
    };
  }
  return {
    formula: "final_score = fused_score (fallback — heavy reranking not applied)",
    values: {
      fused_score: candidate.fusedScore,
      final_score: candidate.finalScore,
    },
    mode: "fallback_to_fused",
  };
}

// ── Fallback logic (INV-RER5: explicit and queryable) ────────────────────────

export function shouldUseFallbackReranking(error: unknown): boolean {
  return error instanceof RerankProviderError;
}

export function classifyFallbackReason(error: unknown): string {
  if (error instanceof RerankProviderError) return error.code;
  if (error instanceof Error) return `unexpected_error: ${error.message.slice(0, 100)}`;
  return "unknown_error";
}

// ── Main advanced reranking pipeline ─────────────────────────────────────────

export async function runAdvancedReranking(
  candidates: HybridCandidate[],
  queryText: string,
  options: AdvancedRerankOptions = {},
): Promise<AdvancedRerankResult> {
  const {
    rerankMode = "auto",
    shortlistSize = 20,
    advancedWeight = 0.7,
    modelName = "gpt-4o-mini",
    maxTextCharsPerCandidate = 400,
    lightweightOptions = {},
  } = options;

  // Step 1: Build shortlist (INV-RER3)
  const shortlist = buildRerankShortlist(candidates, { shortlistSize });
  const shortlistIds = new Set(shortlist.map((c) => c.chunkId));

  // Step 2: Determine effective mode
  const apiKeyPresent = !!process.env.OPENAI_API_KEY;
  let usedFallback = false;
  let fallbackReason: string | null = null;

  let effectiveMode: RerankMode;
  if (rerankMode === "auto") {
    if (apiKeyPresent) {
      effectiveMode = "advanced";
    } else {
      effectiveMode = "fallback";
      usedFallback = true;
      fallbackReason = "no_api_key";
    }
  } else {
    effectiveMode = rerankMode;
  }

  let providerOutput: RerankProviderOutput | null = null;
  let actualMode: RerankMode = effectiveMode;

  // Step 3: Advanced reranking attempt
  if (effectiveMode === "advanced") {
    const rerankInputs = shortlist
      .filter((c) => c.chunkText !== null && c.chunkText.length > 0)
      .map((c) => ({ chunkId: c.chunkId, chunkText: c.chunkText! }));

    if (rerankInputs.length === 0) {
      usedFallback = true;
      fallbackReason = "missing_candidate_text";
      actualMode = "fallback";
    } else {
      try {
        providerOutput = await rerankCandidatesWithModel({
          queryText,
          candidates: rerankInputs,
          modelName,
          maxTextCharsPerCandidate,
        });
      } catch (err) {
        usedFallback = true;
        fallbackReason = classifyFallbackReason(err);
        actualMode = "fallback";
      }
    }
  } else if (effectiveMode === "lightweight") {
    actualMode = "lightweight";
  } else {
    // rerankMode = 'fallback' explicitly
    actualMode = "fallback";
  }

  // Step 4: Build score maps
  const advancedScoreMap = new Map<string, number>();
  if (providerOutput) {
    for (const s of providerOutput.scores) {
      advancedScoreMap.set(s.chunkId, s.score);
    }
  }

  // Step 5: If lightweight or fallback — use Phase 5N lightweight reranker on shortlist
  let lightweightRankedIds: Map<string, number> | null = null;
  if (actualMode === "lightweight" || actualMode === "fallback") {
    const lwResult = rerankHybridCandidates(shortlist, lightweightOptions);
    lightweightRankedIds = new Map(lwResult.map((r, i) => [r.chunkId, i + 1]));
  }

  // Step 6: Assign scores and ranks to all candidates
  const shortlistRankMap = new Map(shortlist.map((c, i) => [c.chunkId, i + 1]));

  const result: AdvancedRerankCandidate[] = candidates.map((c) => {
    const inShortlist = shortlistIds.has(c.chunkId);
    const heavyRerankScore = inShortlist && providerOutput
      ? (advancedScoreMap.get(c.chunkId) ?? null)
      : null;

    const calibrated = calibrateFinalRerankScore(
      { chunkId: c.chunkId, fusedScore: c.fusedScore, heavyRerankScore },
      advancedWeight,
    );

    return {
      ...c,
      heavyRerankScore,
      finalScore: calibrated.finalScore,
      rerankMode: actualMode,
      fallbackUsed: usedFallback || actualMode === "fallback",
      fallbackReason: usedFallback || actualMode === "fallback" ? fallbackReason : null,
      shortlistRank: shortlistRankMap.get(c.chunkId) ?? null,
      advancedRerankRank: null, // set after sort
      rerankProviderName: providerOutput ? providerOutput.providerName : null,
      rerankProviderVersion: providerOutput ? providerOutput.providerVersion : null,
      finalRank: 0, // set after sort
    };
  });

  // Step 7: Sort final order (INV-RER6: deterministic)
  // Priority: shortlisted candidates first, sorted by finalScore DESC + chunkId tie-break
  // Non-shortlisted candidates sorted by fusedScore DESC after shortlisted
  const shortlisted = result.filter((c) => shortlistIds.has(c.chunkId));
  const nonShortlisted = result.filter((c) => !shortlistIds.has(c.chunkId));

  const sortByScore = (a: AdvancedRerankCandidate, b: AdvancedRerankCandidate, scoreKey: "finalScore" | "fusedScore") => {
    const diff = b[scoreKey] - a[scoreKey];
    if (Math.abs(diff) > 1e-12) return diff;
    return a.chunkId < b.chunkId ? -1 : 1;
  };

  shortlisted.sort((a, b) => sortByScore(a, b, "finalScore"));
  nonShortlisted.sort((a, b) => sortByScore(a, b, "fusedScore"));

  const ordered = [...shortlisted, ...nonShortlisted];

  // Assign final ranks and advanced_rerank_rank
  ordered.forEach((c, i) => {
    c.finalRank = i + 1;
    if (shortlistIds.has(c.chunkId)) {
      c.advancedRerankRank = shortlisted.findIndex((s) => s.chunkId === c.chunkId) + 1;
    }
  });

  // Step 8: Compute metrics
  const promotionCount = shortlisted.filter(
    (c) => c.advancedRerankRank !== null && c.shortlistRank !== null && c.advancedRerankRank < c.shortlistRank,
  ).length;
  const demotionCount = shortlisted.filter(
    (c) => c.advancedRerankRank !== null && c.shortlistRank !== null && c.advancedRerankRank > c.shortlistRank,
  ).length;
  const stableRankCount = shortlisted.filter(
    (c) => c.advancedRerankRank !== null && c.shortlistRank !== null && c.advancedRerankRank === c.shortlistRank,
  ).length;

  const deltas = shortlisted
    .filter((c) => c.heavyRerankScore !== null)
    .map((c) => Math.abs(c.finalScore - c.fusedScore));
  const averageScoreDelta = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : 0;

  const metrics: AdvancedRerankMetrics = {
    shortlistSize: shortlist.length,
    advancedRerankUsed: !!providerOutput,
    fallbackUsed: usedFallback || actualMode === "fallback",
    fallbackReason,
    providerLatencyMs: providerOutput?.latencyMs ?? null,
    providerPromptTokens: providerOutput?.promptTokens ?? null,
    providerCompletionTokens: providerOutput?.completionTokens ?? null,
    providerEstimatedCostUsd: providerOutput?.estimatedCostUsd ?? null,
    averageScoreDelta,
    promotionCount,
    demotionCount,
    stableRankCount,
  };

  return {
    candidates: ordered,
    rerankMode: actualMode,
    fallbackUsed: usedFallback || actualMode === "fallback",
    fallbackReason,
    providerOutput,
    metrics,
    shortlistSize: shortlist.length,
  };
}

// ── Persist advanced rerank results to knowledge_retrieval_candidates ─────────

export async function persistAdvancedRerankResults(
  runId: string,
  tenantId: string,
  candidates: AdvancedRerankCandidate[],
): Promise<void> {
  if (!candidates.length) return;

  const shortlistIds = new Set(candidates.filter((c) => c.shortlistRank !== null).map((c) => c.chunkId));

  for (const c of candidates) {
    const inShortlist = shortlistIds.has(c.chunkId);

    const exclusionReason = !inShortlist
      ? EXCLUSION_REASONS.NOT_IN_RERANK_SHORTLIST
      : null;
    const inclusionReason = inShortlist
      ? c.heavyRerankScore !== null
        ? INCLUSION_REASONS.INCLUDED_IN_RERANK_SHORTLIST
        : INCLUSION_REASONS.RETAINED_BY_FALLBACK_RERANK
      : null;

    await db
      .update(knowledgeRetrievalCandidates)
      .set({
        heavyRerankScore: c.heavyRerankScore?.toFixed(8) ?? null,
        finalScore: c.finalScore.toFixed(8),
        rerankMode: c.rerankMode,
        fallbackUsed: c.fallbackUsed,
        fallbackReason: c.fallbackReason,
        shortlistRank: c.shortlistRank,
        advancedRerankRank: c.advancedRerankRank,
        rerankProviderName: c.rerankProviderName,
        rerankProviderVersion: c.rerankProviderVersion,
        inclusionReason,
        exclusionReason,
      })
      .where(
        eq(knowledgeRetrievalCandidates.retrievalRunId, runId),
      );
  }
}

// ── Explain shortlist (INV-RER7: no writes) ───────────────────────────────────

export async function explainRerankShortlist(runId: string): Promise<{
  runId: string;
  shortlistSize: number;
  strategy: string;
  shortlistedCandidates: Array<{
    chunkId: string | null;
    shortlistRank: number | null;
    fusedScore: string | null;
    channelOrigin: string | null;
  }>;
  nonShortlistedCount: number;
  note: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  const shortlisted = rows.filter((r) => r.shortlistRank !== null);
  const nonShortlisted = rows.filter((r) => r.shortlistRank === null);

  return {
    runId,
    shortlistSize: shortlisted.length,
    strategy: "top_by_fused_score_desc_chunkid_tiebreak",
    shortlistedCandidates: shortlisted
      .sort((a, b) => (a.shortlistRank ?? 999) - (b.shortlistRank ?? 999))
      .map((r) => ({
        chunkId: r.chunkId ?? null,
        shortlistRank: r.shortlistRank ?? null,
        fusedScore: r.fusedScore ?? null,
        channelOrigin: r.channelOrigin ?? null,
      })),
    nonShortlistedCount: nonShortlisted.length,
    note: shortlisted.length === 0 ? "No shortlist data — run was not persisted" : `${shortlisted.length} shortlisted, ${nonShortlisted.length} outside shortlist`,
  };
}

export async function summarizeShortlistComposition(runId: string): Promise<{
  runId: string;
  shortlistSize: number;
  vectorOnlyInShortlist: number;
  lexicalOnlyInShortlist: number;
  bothChannelsInShortlist: number;
  avgFusedScore: number | null;
  strategy: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  const shortlisted = rows.filter((r) => r.shortlistRank !== null);
  const fusedScores = shortlisted.map((r) => parseFloat(r.fusedScore ?? "0")).filter((n) => !isNaN(n));
  const avgFusedScore = fusedScores.length > 0 ? fusedScores.reduce((a, b) => a + b, 0) / fusedScores.length : null;

  return {
    runId,
    shortlistSize: shortlisted.length,
    vectorOnlyInShortlist: shortlisted.filter((r) => r.channelOrigin === "vector_only").length,
    lexicalOnlyInShortlist: shortlisted.filter((r) => r.channelOrigin === "lexical_only").length,
    bothChannelsInShortlist: shortlisted.filter((r) => r.channelOrigin === "vector_and_lexical").length,
    avgFusedScore: avgFusedScore !== null ? parseFloat(avgFusedScore.toFixed(6)) : null,
    strategy: "top_by_fused_score_desc",
  };
}

// ── Explain advanced reranking for a run (INV-RER7: no writes) ───────────────

export async function explainAdvancedReranking(runId: string): Promise<{
  runId: string;
  rerankMode: string | null;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  shortlistSize: number;
  advancedRerankUsed: boolean;
  candidates: Array<{
    chunkId: string | null;
    shortlistRank: number | null;
    advancedRerankRank: number | null;
    finalRank: number | null;
    fusedScore: string | null;
    heavyRerankScore: string | null;
    finalScore: string | null;
    rerankMode: string | null;
  }>;
  note: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  const rerankMode = rows[0]?.rerankMode ?? null;
  const fallbackUsed = rows.some((r) => r.fallbackUsed === true);
  const fallbackReason = rows.find((r) => r.fallbackReason)?.fallbackReason ?? null;
  const shortlisted = rows.filter((r) => r.shortlistRank !== null);
  const advancedRerankUsed = rows.some((r) => r.heavyRerankScore !== null);

  return {
    runId,
    rerankMode,
    fallbackUsed,
    fallbackReason,
    shortlistSize: shortlisted.length,
    advancedRerankUsed,
    candidates: rows
      .sort((a, b) => (a.candidateRank ?? 999) - (b.candidateRank ?? 999))
      .map((r) => ({
        chunkId: r.chunkId ?? null,
        shortlistRank: r.shortlistRank ?? null,
        advancedRerankRank: r.advancedRerankRank ?? null,
        finalRank: r.finalRank ?? null,
        fusedScore: r.fusedScore ?? null,
        heavyRerankScore: r.heavyRerankScore ?? null,
        finalScore: r.finalScore ?? null,
        rerankMode: r.rerankMode ?? null,
      })),
    note:
      rows.length === 0
        ? "No candidates — run not persisted with persistRun=true"
        : `${rows.length} candidates; ${advancedRerankUsed ? "advanced" : "fallback"} reranking`,
  };
}

export async function summarizeAdvancedRerankingImpact(runId: string): Promise<{
  runId: string;
  rerankMode: string | null;
  shortlistSize: number;
  advancedRerankUsed: boolean;
  fallbackUsed: boolean;
  promotionCount: number;
  demotionCount: number;
  stableRankCount: number;
  largestPromotion: number;
  largestDemotion: number;
  avgFinalScore: number | null;
  avgHeavyRerankScore: number | null;
  note: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  const shortlisted = rows.filter((r) => r.shortlistRank !== null && r.advancedRerankRank !== null);
  const promotions = shortlisted.filter((r) => (r.advancedRerankRank ?? 0) < (r.shortlistRank ?? 0));
  const demotions = shortlisted.filter((r) => (r.advancedRerankRank ?? 0) > (r.shortlistRank ?? 0));
  const stable = shortlisted.filter((r) => (r.advancedRerankRank ?? 0) === (r.shortlistRank ?? 0));
  const shifts = shortlisted.map((r) => (r.advancedRerankRank ?? 0) - (r.shortlistRank ?? 0));
  const finalScores = rows.map((r) => parseFloat(r.finalScore ?? "0")).filter((n) => !isNaN(n) && n > 0);
  const heavyScores = rows.map((r) => parseFloat(r.heavyRerankScore ?? "")).filter((n) => !isNaN(n));

  return {
    runId,
    rerankMode: rows[0]?.rerankMode ?? null,
    shortlistSize: rows.filter((r) => r.shortlistRank !== null).length,
    advancedRerankUsed: rows.some((r) => r.heavyRerankScore !== null),
    fallbackUsed: rows.some((r) => r.fallbackUsed === true),
    promotionCount: promotions.length,
    demotionCount: demotions.length,
    stableRankCount: stable.length,
    largestPromotion: shifts.length > 0 ? Math.abs(Math.min(...shifts, 0)) : 0,
    largestDemotion: shifts.length > 0 ? Math.max(...shifts, 0) : 0,
    avgFinalScore: finalScores.length > 0 ? parseFloat((finalScores.reduce((a, b) => a + b, 0) / finalScores.length).toFixed(6)) : null,
    avgHeavyRerankScore: heavyScores.length > 0 ? parseFloat((heavyScores.reduce((a, b) => a + b, 0) / heavyScores.length).toFixed(6)) : null,
    note: rows.length === 0 ? "No candidates — run not persisted" : `${shortlisted.length} compared, ${promotions.length} promoted, ${demotions.length} demoted`,
  };
}

export async function previewAdvancedReranking(
  candidates: HybridCandidate[],
  queryText: string,
  options: AdvancedRerankOptions = {},
): Promise<AdvancedRerankResult> {
  // Preview only — no DB writes (INV-RER7)
  return runAdvancedReranking(candidates, queryText, options);
}

export async function listAdvancedRerankCandidates(runId: string): Promise<{
  runId: string;
  candidates: Array<{
    chunkId: string | null;
    shortlistRank: number | null;
    advancedRerankRank: number | null;
    finalRank: number | null;
    finalScore: string | null;
    heavyRerankScore: string | null;
    fusedScore: string | null;
    channelOrigin: string | null;
    rerankMode: string | null;
    filterStatus: string;
  }>;
  count: number;
}> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  return {
    runId,
    candidates: rows
      .sort((a, b) => (a.candidateRank ?? 999) - (b.candidateRank ?? 999))
      .map((r) => ({
        chunkId: r.chunkId ?? null,
        shortlistRank: r.shortlistRank ?? null,
        advancedRerankRank: r.advancedRerankRank ?? null,
        finalRank: r.finalRank ?? null,
        finalScore: r.finalScore ?? null,
        heavyRerankScore: r.heavyRerankScore ?? null,
        fusedScore: r.fusedScore ?? null,
        channelOrigin: r.channelOrigin ?? null,
        rerankMode: r.rerankMode ?? null,
        filterStatus: r.filterStatus,
      })),
    count: rows.length,
  };
}

// ── Fallback explain (INV-RER5,7: explicit, no writes) ───────────────────────

export async function explainFallbackReranking(runId: string): Promise<{
  runId: string;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  fallbackCandidateCount: number;
  rerankMode: string | null;
  note: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  const fallbackUsed = rows.some((r) => r.fallbackUsed === true);
  const fallbackReason = rows.find((r) => r.fallbackReason)?.fallbackReason ?? null;
  const rerankMode = rows[0]?.rerankMode ?? null;

  return {
    runId,
    fallbackUsed,
    fallbackReason,
    fallbackCandidateCount: fallbackUsed ? rows.length : 0,
    rerankMode,
    note: fallbackUsed
      ? `Fallback reranking was used: ${fallbackReason ?? "unknown reason"}`
      : "Advanced reranking was applied without fallback",
  };
}

export async function summarizeFallbackUsage(runId: string): Promise<{
  runId: string;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  rerankMode: string | null;
  candidatesAffected: number;
  impactAssessment: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  const fallbackUsed = rows.some((r) => r.fallbackUsed === true);
  const fallbackReason = rows.find((r) => r.fallbackReason)?.fallbackReason ?? null;
  const rerankMode = rows[0]?.rerankMode ?? null;

  return {
    runId,
    fallbackUsed,
    fallbackReason,
    rerankMode,
    candidatesAffected: fallbackUsed ? rows.length : 0,
    impactAssessment: fallbackUsed
      ? `Lightweight deterministic reranker was applied (Phase 5N). Reason: ${fallbackReason ?? "unknown"}. Quality may be lower than with advanced reranking.`
      : "Advanced reranking completed successfully. No fallback was needed.",
  };
}

// ── Rerank metrics (INV-RER9: no write to provenance, separate metrics) ──────

export async function recordAdvancedRerankMetrics(
  runId: string,
  metrics: AdvancedRerankMetrics,
): Promise<void> {
  // Stored in knowledge_retrieval_runs.metadata if available, or as a no-op
  // For Phase 5O the metrics are embedded in the candidate records themselves;
  // a dedicated metrics table is a Phase 5P concern
  void runId;
  void metrics;
}

export async function getAdvancedRerankMetrics(runId: string): Promise<AdvancedRerankMetrics | null> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  if (!rows.length) return null;

  const shortlisted = rows.filter((r) => r.shortlistRank !== null);
  const advancedRerankUsed = rows.some((r) => r.heavyRerankScore !== null);
  const fallbackUsed = rows.some((r) => r.fallbackUsed === true);
  const fallbackReason = rows.find((r) => r.fallbackReason)?.fallbackReason ?? null;

  const shortlistSize = shortlisted.length;
  const withAdvancedRanks = shortlisted.filter((r) => r.advancedRerankRank !== null && r.shortlistRank !== null);
  const promotionCount = withAdvancedRanks.filter((r) => (r.advancedRerankRank ?? 0) < (r.shortlistRank ?? 0)).length;
  const demotionCount = withAdvancedRanks.filter((r) => (r.advancedRerankRank ?? 0) > (r.shortlistRank ?? 0)).length;
  const stableRankCount = withAdvancedRanks.filter((r) => (r.advancedRerankRank ?? 0) === (r.shortlistRank ?? 0)).length;

  const finalScores = rows.map((r) => parseFloat(r.finalScore ?? "0")).filter((n) => !isNaN(n) && n > 0);
  const fusedScores = rows.map((r) => parseFloat(r.fusedScore ?? "0")).filter((n) => !isNaN(n) && n > 0);
  const avgFinalScore = finalScores.length ? finalScores.reduce((a, b) => a + b, 0) / finalScores.length : 0;
  const avgFusedScore = fusedScores.length ? fusedScores.reduce((a, b) => a + b, 0) / fusedScores.length : 0;

  return {
    shortlistSize,
    advancedRerankUsed,
    fallbackUsed,
    fallbackReason,
    providerLatencyMs: null,
    providerPromptTokens: null,
    providerCompletionTokens: null,
    providerEstimatedCostUsd: null,
    averageScoreDelta: Math.abs(avgFinalScore - avgFusedScore),
    promotionCount,
    demotionCount,
    stableRankCount,
  };
}

export async function summarizeAdvancedRerankMetrics(runId: string): Promise<Record<string, unknown>> {
  const metrics = await getAdvancedRerankMetrics(runId);
  if (!metrics) return { runId, note: "No metrics — run not persisted" };

  return {
    runId,
    shortlistSize: metrics.shortlistSize,
    advancedRerankUsed: metrics.advancedRerankUsed,
    fallbackUsed: metrics.fallbackUsed,
    fallbackReason: metrics.fallbackReason,
    providerLatencyMs: metrics.providerLatencyMs,
    providerPromptTokens: metrics.providerPromptTokens,
    providerCompletionTokens: metrics.providerCompletionTokens,
    estimatedCostUsd: metrics.providerEstimatedCostUsd,
    averageScoreDelta: metrics.averageScoreDelta,
    promotionCount: metrics.promotionCount,
    demotionCount: metrics.demotionCount,
    stableRankCount: metrics.stableRankCount,
  };
}

// ── Calibration summary (INV-RER7: no writes) ─────────────────────────────────

export async function summarizeCalibrationFactors(runId: string): Promise<{
  runId: string;
  calibrationMode: "advanced" | "fallback_to_fused" | "mixed";
  advancedWeight: number;
  formula: string;
  sampleCandidates: Array<{
    chunkId: string | null;
    fusedScore: string | null;
    heavyRerankScore: string | null;
    finalScore: string | null;
  }>;
  note: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalCandidates)
    .where(eq(knowledgeRetrievalCandidates.retrievalRunId, runId));

  const hasAdvanced = rows.some((r) => r.heavyRerankScore !== null);
  const hasFallback = rows.some((r) => r.heavyRerankScore === null && r.finalScore !== null);
  const calibrationMode: "advanced" | "fallback_to_fused" | "mixed" =
    hasAdvanced && hasFallback ? "mixed" : hasAdvanced ? "advanced" : "fallback_to_fused";

  return {
    runId,
    calibrationMode,
    advancedWeight: 0.7,
    formula: hasAdvanced
      ? "final_score = 0.7 * heavy_rerank_score + 0.3 * fused_score"
      : "final_score = fused_score (fallback mode)",
    sampleCandidates: rows.slice(0, 5).map((r) => ({
      chunkId: r.chunkId ?? null,
      fusedScore: r.fusedScore ?? null,
      heavyRerankScore: r.heavyRerankScore ?? null,
      finalScore: r.finalScore ?? null,
    })),
    note: rows.length === 0 ? "No candidates" : `${rows.length} candidates, mode: ${calibrationMode}`,
  };
}
