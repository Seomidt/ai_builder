/**
 * retrieval-config.ts — Phase 5P + 5Q
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

// ── Phase 5Q — Query rewriting & expansion ────────────────────────────────────

/** Maximum number of expansion terms added to the original query. */
export const MAX_QUERY_EXPANSION_TERMS = 8;

/** Whether query rewriting (LLM-assisted) is enabled. */
export const QUERY_REWRITE_ENABLED = true;

/** Whether deterministic query expansion is enabled. */
export const QUERY_EXPANSION_ENABLED = true;

/** Timeout for query rewrite LLM call in milliseconds. */
export const QUERY_REWRITE_TIMEOUT_MS = 10_000;

// ── Phase 5Q — Retrieval safety ───────────────────────────────────────────────

/** Whether retrieval safety review runs before answer generation. */
export const RETRIEVAL_SAFETY_REVIEW_ENABLED = true;

/**
 * Retrieval safety mode controls what happens to flagged chunks.
 *   monitor_only    — flag but retain all chunks
 *   downrank        — reduce score of suspicious/high_risk chunks
 *   exclude_high_risk — remove high_risk chunks; retain suspicious ones
 */
export type RetrievalSafetyMode = "monitor_only" | "downrank" | "exclude_high_risk";

export const RETRIEVAL_SAFETY_MODE: RetrievalSafetyMode = "monitor_only";

/** Minimum injection-pattern match count to mark a chunk as suspicious. */
export const SAFETY_SUSPICIOUS_THRESHOLD = 1;

/** Minimum injection-pattern match count to mark a chunk as high_risk. */
export const SAFETY_HIGH_RISK_THRESHOLD = 3;

/** Score multiplier applied to suspicious chunks in downrank mode. */
export const SAFETY_DOWNRANK_SUSPICIOUS_FACTOR = 0.5;

/** Score multiplier applied to high_risk chunks in downrank mode. */
export const SAFETY_DOWNRANK_HIGH_RISK_FACTOR = 0.1;

// ── Phase 5Q — Quality signal thresholds ─────────────────────────────────────

/** Minimum avg finalScore for "high" confidence band. */
export const QUALITY_SIGNAL_HIGH_CONFIDENCE_THRESHOLD = 0.7;

/** Minimum avg finalScore for "medium" confidence band. */
export const QUALITY_SIGNAL_MEDIUM_CONFIDENCE_THRESHOLD = 0.4;

/** Minimum document diversity score for "high" confidence (combined with score threshold). */
export const QUALITY_SIGNAL_HIGH_DIVERSITY_THRESHOLD = 0.4;

// ── Phase 5R — Answer verification & hallucination guard ──────────────────────

/** Whether answer verification runs after answer generation. */
export const ANSWER_VERIFICATION_ENABLED = true;

/** Whether hallucination guard heuristics run on each answer. */
export const HALLUCINATION_GUARD_ENABLED = true;

/** Minimum citation coverage ratio required for non-degraded answers. */
export const MINIMUM_CITATION_COVERAGE_RATIO = 0.5;

/** Maximum unsupported claim count before policy degrades the answer. */
export const MAXIMUM_UNSUPPORTED_CLAIM_COUNT = 2;

/** Whether grounded_partial_answer is allowed as a fallback outcome. */
export const ALLOW_PARTIAL_ANSWER_FALLBACK = true;

/** Whether insufficient_evidence is allowed as a fallback outcome. */
export const ALLOW_INSUFFICIENT_EVIDENCE_FALLBACK = true;

/** Whether strong certainty language (definitely, certainly, etc.) triggers a guard penalty. */
export const STRONG_CERTAINTY_PENALTY_ENABLED = true;

/**
 * Minimum grounding confidence band required to deliver any answer.
 * Answers below this band fall to safe_refusal.
 */
export const MINIMUM_GROUNDING_CONFIDENCE_BAND: "high" | "medium" | "low" | "unsafe" = "low";

// ── Validation helpers ────────────────────────────────────────────────────────

export function clampShortlistSize(size: number): number {
  return Math.max(ADVANCED_RERANK_SHORTLIST_MIN, Math.min(ADVANCED_RERANK_SHORTLIST_MAX, size));
}

export function clampExpansionTerms(n: number): number {
  return Math.max(0, Math.min(MAX_QUERY_EXPANSION_TERMS, n));
}

export function describeRetrievalConfig(): Record<string, unknown> {
  return {
    // Phase 5P
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
    // Phase 5Q
    maxQueryExpansionTerms: MAX_QUERY_EXPANSION_TERMS,
    queryRewriteEnabled: QUERY_REWRITE_ENABLED,
    queryExpansionEnabled: QUERY_EXPANSION_ENABLED,
    queryRewriteTimeoutMs: QUERY_REWRITE_TIMEOUT_MS,
    retrievalSafetyReviewEnabled: RETRIEVAL_SAFETY_REVIEW_ENABLED,
    retrievalSafetyMode: RETRIEVAL_SAFETY_MODE,
    safetySuspiciousThreshold: SAFETY_SUSPICIOUS_THRESHOLD,
    safetyHighRiskThreshold: SAFETY_HIGH_RISK_THRESHOLD,
    safetyDownrankSuspiciousFactor: SAFETY_DOWNRANK_SUSPICIOUS_FACTOR,
    safetyDownrankHighRiskFactor: SAFETY_DOWNRANK_HIGH_RISK_FACTOR,
    qualitySignalThresholds: {
      high: QUALITY_SIGNAL_HIGH_CONFIDENCE_THRESHOLD,
      medium: QUALITY_SIGNAL_MEDIUM_CONFIDENCE_THRESHOLD,
      highDiversity: QUALITY_SIGNAL_HIGH_DIVERSITY_THRESHOLD,
    },
    // Phase 5R
    answerVerificationEnabled: ANSWER_VERIFICATION_ENABLED,
    hallucinationGuardEnabled: HALLUCINATION_GUARD_ENABLED,
    minimumCitationCoverageRatio: MINIMUM_CITATION_COVERAGE_RATIO,
    maximumUnsupportedClaimCount: MAXIMUM_UNSUPPORTED_CLAIM_COUNT,
    allowPartialAnswerFallback: ALLOW_PARTIAL_ANSWER_FALLBACK,
    allowInsufficientEvidenceFallback: ALLOW_INSUFFICIENT_EVIDENCE_FALLBACK,
    strongCertaintyPenaltyEnabled: STRONG_CERTAINTY_PENALTY_ENABLED,
    minimumGroundingConfidenceBand: MINIMUM_GROUNDING_CONFIDENCE_BAND,
  };
}
