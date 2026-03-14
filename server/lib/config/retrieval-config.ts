/**
 * retrieval-config.ts — Phase 5P
 *
 * Centralised retrieval configuration.
 *
 * All previously hardcoded retrieval constants are exposed here
 * so they can be tested, overridden in tests, and made configurable
 * per deployment without code changes.
 *
 * Design rules:
 *   - All defaults are production-safe
 *   - Shortlist ordering remains: ORDER BY fused_score DESC, chunk_id ASC
 *   - Config is read-only at runtime (no mutable globals)
 */

// ── Shortlist ─────────────────────────────────────────────────────────────────

/** Maximum number of fused candidates sent to the heavy reranker. */
export const ADVANCED_RERANK_SHORTLIST_SIZE = 20;

/** Minimum shortlist size accepted; below this advanced reranking is skipped. */
export const ADVANCED_RERANK_SHORTLIST_MIN = 1;

/** Maximum shortlist size allowed; prevents over-spending on reranking. */
export const ADVANCED_RERANK_SHORTLIST_MAX = 50;

// ── Provider ──────────────────────────────────────────────────────────────────

/** Default reranking model. */
export const ADVANCED_RERANK_MODEL = "gpt-4o-mini";

/** Max characters per candidate text sent to the reranking provider. */
export const ADVANCED_RERANK_MAX_CANDIDATE_CHARS = 400;

/** Provider request timeout in milliseconds. */
export const ADVANCED_RERANK_TIMEOUT_MS = 15_000;

// ── Score calibration ─────────────────────────────────────────────────────────

/** Weight assigned to heavy_rerank_score in the final_score formula. */
export const ADVANCED_RERANK_WEIGHT = 0.7;

/** Weight assigned to fused_score in the final_score formula. */
export const FUSED_SCORE_WEIGHT = 1 - ADVANCED_RERANK_WEIGHT;

// ── Answer generation ─────────────────────────────────────────────────────────

/** Default model for grounded answer generation. */
export const ANSWER_GENERATION_MODEL = "gpt-4o-mini";

/** Max context characters passed to the answer generation model. */
export const ANSWER_GENERATION_MAX_CONTEXT_CHARS = 12_000;

/** Max answer generation timeout in milliseconds. */
export const ANSWER_GENERATION_TIMEOUT_MS = 30_000;

/** Max characters of chunk text included in a citation preview. */
export const CITATION_PREVIEW_CHARS = 200;

// ── Validation helper ─────────────────────────────────────────────────────────

export function clampShortlistSize(size: number): number {
  return Math.max(ADVANCED_RERANK_SHORTLIST_MIN, Math.min(ADVANCED_RERANK_SHORTLIST_MAX, size));
}

export function describeRetrievalConfig(): Record<string, unknown> {
  return {
    advancedRerankShortlistSize: ADVANCED_RERANK_SHORTLIST_SIZE,
    advancedRerankShortlistMin: ADVANCED_RERANK_SHORTLIST_MIN,
    advancedRerankShortlistMax: ADVANCED_RERANK_SHORTLIST_MAX,
    advancedRerankModel: ADVANCED_RERANK_MODEL,
    advancedRerankMaxCandidateChars: ADVANCED_RERANK_MAX_CANDIDATE_CHARS,
    advancedRerankTimeoutMs: ADVANCED_RERANK_TIMEOUT_MS,
    advancedRerankWeight: ADVANCED_RERANK_WEIGHT,
    fusedScoreWeight: FUSED_SCORE_WEIGHT,
    answerGenerationModel: ANSWER_GENERATION_MODEL,
    answerGenerationMaxContextChars: ANSWER_GENERATION_MAX_CONTEXT_CHARS,
    answerGenerationTimeoutMs: ANSWER_GENERATION_TIMEOUT_MS,
    citationPreviewChars: CITATION_PREVIEW_CHARS,
  };
}
