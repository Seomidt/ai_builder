/**
 * Phase 17 — Eval Scorer
 * Deterministic scoring functions for AI evaluation.
 *
 * INV-EVAL3: Scores are bounded [0.0000, 1.0000] and deterministic.
 * INV-EVAL7: Benchmark failures must not break production runtime.
 *
 * Scoring philosophy:
 * - All functions are pure (no DB side-effects).
 * - All scores are in [0.0000, 1.0000].
 * - Given identical input, output is always identical.
 * - Rubrics are explicitly documented.
 */

// ── Clamp helper ──────────────────────────────────────────────────────────────

/** Clamp a value to [0, 1] with 4 decimal precision. */
function clamp01(v: number): number {
  return Math.round(Math.min(1, Math.max(0, isFinite(v) ? v : 0)) * 10000) / 10000;
}

// ── Answer Quality Scoring ────────────────────────────────────────────────────

/**
 * Score answer quality deterministically.
 *
 * Rubric (each dimension contributes equally):
 *   completeness  — answer is non-empty and exceeds minimum length
 *   directness    — answer contains key terms from query
 *   policy_safe   — no known unsafe patterns present
 *   no_contradiction — answer does not explicitly contradict expected answer if provided
 *
 * Returns score in [0.0000, 1.0000].
 */
export function scoreAnswerQuality(params: {
  answerText: string;
  inputQuery: string;
  expectedAnswer?: string;
  minLength?: number;
}): { score: number; breakdown: Record<string, number>; explanation: string } {
  const { answerText, inputQuery, expectedAnswer, minLength = 20 } = params;

  // Dimension 1: completeness (answer is non-empty and meets min length)
  const completeness = answerText.trim().length >= minLength ? 1.0 : answerText.trim().length / minLength;

  // Dimension 2: directness (query key terms overlap with answer)
  const queryTokens = tokenize(inputQuery);
  const answerTokenSet = new Set(tokenize(answerText));
  const overlap = queryTokens.filter((t) => answerTokenSet.has(t)).length;
  const directness = queryTokens.length > 0 ? Math.min(1, overlap / Math.max(1, queryTokens.length * 0.5)) : 0.5;

  // Dimension 3: policy safety (no blacklisted patterns)
  const UNSAFE_PATTERNS = [/\bignore previous instructions\b/i, /\bsystem prompt\b/i, /\bact as\b.*?DAN/i];
  const policySafe = UNSAFE_PATTERNS.some((p) => p.test(answerText)) ? 0.0 : 1.0;

  // Dimension 4: no contradiction (basic string-distance check if expected provided)
  let noContradiction = 1.0;
  if (expectedAnswer && expectedAnswer.trim().length > 0) {
    const expectedTokens = new Set(tokenize(expectedAnswer));
    const answerArr = tokenize(answerText);
    const expectedHits = answerArr.filter((t) => expectedTokens.has(t)).length;
    noContradiction = expectedHits > 0 ? Math.min(1, expectedHits / Math.max(1, expectedTokens.size * 0.3)) : 0.3;
  }

  const raw = (completeness + directness + policySafe + noContradiction) / 4;
  const score = clamp01(raw);

  return {
    score,
    breakdown: { completeness, directness, policySafe, noContradiction },
    explanation: `answerQuality=${score} (completeness=${completeness.toFixed(4)}, directness=${directness.toFixed(4)}, policySafe=${policySafe.toFixed(4)}, noContradiction=${noContradiction.toFixed(4)})`,
  };
}

// ── Retrieval Quality Scoring ─────────────────────────────────────────────────

/**
 * Score retrieval quality deterministically.
 *
 * Rubric:
 *   chunk_coverage  — at least N relevant chunks found
 *   min_score       — average chunk final score ≥ threshold
 *   rerank_signal   — top chunk score is significantly higher than median
 *
 * Returns score in [0.0000, 1.0000].
 */
export function scoreRetrievalQuality(params: {
  chunks: Array<{ finalScore: number; chunkText?: string }>;
  queryText?: string;
  minChunks?: number;
  minAvgScore?: number;
}): { score: number; breakdown: Record<string, number>; explanation: string } {
  const { chunks, minChunks = 3, minAvgScore = 0.4 } = params;

  if (chunks.length === 0) {
    return { score: 0, breakdown: { chunkCoverage: 0, minScore: 0, rerankSignal: 0 }, explanation: "No chunks retrieved." };
  }

  // Dimension 1: chunk coverage
  const chunkCoverage = Math.min(1, chunks.length / minChunks);

  // Dimension 2: average score meets threshold
  const avg = chunks.reduce((s, c) => s + c.finalScore, 0) / chunks.length;
  const minScore = avg >= minAvgScore ? 1.0 : avg / minAvgScore;

  // Dimension 3: rerank signal (top vs median divergence)
  const sorted = [...chunks].sort((a, b) => b.finalScore - a.finalScore);
  const top = sorted[0].finalScore;
  const median = sorted[Math.floor(sorted.length / 2)].finalScore;
  const rerankSignal = top > 0 && median >= 0 ? Math.min(1, (top - median) / Math.max(0.01, top) + 0.5) : 0.5;

  const raw = (chunkCoverage + minScore + rerankSignal) / 3;
  const score = clamp01(raw);

  return {
    score,
    breakdown: { chunkCoverage, minScore, rerankSignal, avgFinalScore: clamp01(avg) },
    explanation: `retrievalQuality=${score} (coverage=${chunkCoverage.toFixed(4)}, avgScore=${avg.toFixed(4)}, rerankSignal=${rerankSignal.toFixed(4)})`,
  };
}

// ── Grounding Score ───────────────────────────────────────────────────────────

/**
 * Score answer grounding deterministically.
 *
 * Rubric:
 *   citation_support   — fraction of answer tokens appearing in cited chunks
 *   citation_count     — at least N citations present
 *   unsupported_ratio  — (1 - fraction of unsupported claims)
 *
 * Returns score in [0.0000, 1.0000].
 */
export function scoreGrounding(params: {
  answerText: string;
  citedChunkTexts: string[];
  unsupportedClaimCount?: number;
  totalClaimCount?: number;
  minCitations?: number;
}): { score: number; breakdown: Record<string, number>; explanation: string } {
  const { answerText, citedChunkTexts, unsupportedClaimCount = 0, totalClaimCount = 0, minCitations = 2 } = params;

  if (citedChunkTexts.length === 0) {
    return { score: 0, breakdown: { citationSupport: 0, citationCount: 0, unsupportedRatio: 1 }, explanation: "No citations provided." };
  }

  // Dimension 1: lexical overlap between answer and cited chunks
  const answerTokenArr = tokenize(answerText);
  const answerTokenSet = new Set(answerTokenArr);
  const chunkTokenSet = new Set(citedChunkTexts.flatMap(tokenize));
  const supportedTokens = answerTokenArr.filter((t) => chunkTokenSet.has(t)).length;
  const citationSupport = answerTokenSet.size > 0 ? supportedTokens / answerTokenSet.size : 0;

  // Dimension 2: sufficient citation count
  const citationCount = Math.min(1, citedChunkTexts.length / minCitations);

  // Dimension 3: unsupported claim ratio (lower is better)
  const unsupportedRatio = totalClaimCount > 0 ? 1 - unsupportedClaimCount / totalClaimCount : 1.0;

  const raw = (citationSupport + citationCount + unsupportedRatio) / 3;
  const score = clamp01(raw);

  return {
    score,
    breakdown: { citationSupport: clamp01(citationSupport), citationCount, unsupportedRatio: clamp01(unsupportedRatio) },
    explanation: `grounding=${score} (citationSupport=${citationSupport.toFixed(4)}, citationCount=${citationCount.toFixed(4)}, unsupportedRatio=${unsupportedRatio.toFixed(4)})`,
  };
}

// ── Hallucination Risk Score ──────────────────────────────────────────────────

/**
 * Score hallucination risk deterministically.
 * Higher score = HIGHER risk (contrast: other scores where higher = better).
 * Consumers should interpret: 0.0 = no risk, 1.0 = high risk.
 *
 * Rubric:
 *   unsupported_count_signal — ratio of unsupported claims to total
 *   citation_gap_signal      — fraction of claims with no citation match
 *   contradiction_signal     — presence of certainty language without backing
 *
 * Returns score in [0.0000, 1.0000].
 */
export function scoreHallucinationRisk(params: {
  answerText: string;
  unsupportedClaimCount: number;
  totalClaimCount: number;
  citationCoverageRatio: number;
  certaintyPhraseCount?: number;
  citedChunkTexts?: string[];
}): { score: number; breakdown: Record<string, number>; explanation: string } {
  const {
    unsupportedClaimCount,
    totalClaimCount,
    citationCoverageRatio,
    certaintyPhraseCount = 0,
    answerText,
  } = params;

  // Dimension 1: unsupported claim ratio
  const unsupportedSignal = totalClaimCount > 0 ? unsupportedClaimCount / totalClaimCount : 0;

  // Dimension 2: missing citation coverage (inverted — low coverage = high risk)
  const citationGapSignal = 1 - Math.min(1, Math.max(0, citationCoverageRatio));

  // Dimension 3: certainty-without-backing signal
  const wordCount = Math.max(1, answerText.split(/\s+/).length);
  const certaintySignal = Math.min(1, certaintyPhraseCount / Math.max(1, wordCount / 50));

  const raw = (unsupportedSignal + citationGapSignal + certaintySignal) / 3;
  const score = clamp01(raw);

  return {
    score,
    breakdown: { unsupportedSignal: clamp01(unsupportedSignal), citationGapSignal, certaintySignal },
    explanation: `hallucinationRisk=${score} (unsupported=${unsupportedSignal.toFixed(4)}, citationGap=${citationGapSignal.toFixed(4)}, certainty=${certaintySignal.toFixed(4)})`,
  };
}

// ── Score Aggregation ─────────────────────────────────────────────────────────

export interface EvalScoreSummary {
  answerQualityScore: number;
  retrievalQualityScore: number;
  groundingScore: number;
  hallucinationRiskScore: number;
  pass: boolean;
  overallScore: number;
  passThreshold: number;
}

/**
 * Aggregate multiple dimension scores into a run-level summary.
 * INV-EVAL3: All aggregated scores remain bounded.
 *
 * pass = true iff overall ≥ threshold AND hallucinationRisk < 0.6.
 */
export function summarizeEvalScores(params: {
  answerQualityScore: number;
  retrievalQualityScore: number;
  groundingScore: number;
  hallucinationRiskScore: number;
  passThreshold?: number;
}): EvalScoreSummary {
  const threshold = params.passThreshold ?? 0.6;
  const overall = clamp01(
    (params.answerQualityScore * 0.3 +
      params.retrievalQualityScore * 0.25 +
      params.groundingScore * 0.25 +
      (1 - params.hallucinationRiskScore) * 0.2),
  );
  const pass = overall >= threshold && params.hallucinationRiskScore < 0.6;

  return {
    answerQualityScore: clamp01(params.answerQualityScore),
    retrievalQualityScore: clamp01(params.retrievalQualityScore),
    groundingScore: clamp01(params.groundingScore),
    hallucinationRiskScore: clamp01(params.hallucinationRiskScore),
    pass,
    overallScore: overall,
    passThreshold: threshold,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Simple tokenizer: lowercase, split on non-alphanum, deduplicate short tokens. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}
