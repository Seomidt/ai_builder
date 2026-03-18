/**
 * retrieval-feedback.ts — Phase 5S
 *
 * Retrieval Feedback Loop, Quality Evaluation & Auto-Tuning Signals.
 *
 * Combines signals from:
 *   - knowledge_retrieval_runs         (Phase 5E/5H/5Q)
 *   - knowledge_retrieval_quality_signals (Phase 5Q)
 *   - knowledge_answer_runs            (Phase 5P/5R)
 *   - knowledge_answer_citations       (Phase 5P)
 *   - knowledge_retrieval_feedback     (Phase 5S — new)
 *
 * Service-layer invariants:
 *   INV-FB1  Feedback records must be tenant-safe.
 *   INV-FB2  Feedback derived only from real persisted data or explicit preview mode.
 *   INV-FB3  Tuning signals must be deterministic and explainable.
 *   INV-FB4  Rewrite effectiveness must not be overstated when evidence is insufficient.
 *   INV-FB5  Rerank effectiveness must not fabricate improvements.
 *   INV-FB6  Citation quality evaluation must remain evidence-based.
 *   INV-FB7  Feedback metrics must be tenant-isolated.
 *   INV-FB8  Preview routes must not persist.
 *   INV-FB9  Existing retrieval, reranking, provenance, quality, safety, grounding,
 *            citations, and answer verification behavior must remain intact.
 *   INV-FB10 Cross-tenant leakage must remain impossible.
 */

import pg from "pg";
import {
  FEEDBACK_SIGNAL_THRESHOLDS,
  WEAK_RUN_THRESHOLDS,
  MAX_TUNING_SIGNALS_PER_RUN,
  FEEDBACK_EVALUATION_ENABLED,
} from "../config/retrieval-config";

// ── Shared DB client factory ──────────────────────────────────────────────────

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────

export type FeedbackStatus = "success" | "mixed" | "weak" | "failed";
export type RetrievalQualityBand = "high" | "medium" | "low" | "poor";
export type RerankEffectivenessBand = "improved" | "neutral" | "degraded" | "unknown";
export type CitationQualityBand = "strong" | "acceptable" | "weak" | "poor";
export type RewriteEffectivenessBand = "helpful" | "neutral" | "harmful" | "unknown";
export type AnswerSafetyBand = "safe" | "caution" | "weak" | "unsafe";

export type TuningSignalType =
  | "increase_shortlist_size"
  | "decrease_shortlist_size"
  | "increase_lexical_weight"
  | "increase_vector_weight"
  | "review_query_rewrite"
  | "rewrite_not_helpful"
  | "review_synonym_map"
  | "review_alias_map"
  | "improve_chunking"
  | "review_source_dominance"
  | "review_context_redundancy"
  | "review_safety_threshold"
  | "review_rerank_timeout"
  | "review_low_coverage_answers";

export interface TuningSignal {
  signalType: TuningSignalType;
  rationale: string;
  priority: "high" | "medium" | "low";
}

export interface FeedbackRecord {
  retrievalRunId: string;
  answerRunId: string | null;
  tenantId: string;
  feedbackStatus: FeedbackStatus;
  retrievalQualityBand: RetrievalQualityBand;
  rerankEffectivenessBand: RerankEffectivenessBand;
  citationQualityBand: CitationQualityBand;
  rewriteEffectivenessBand: RewriteEffectivenessBand;
  answerSafetyBand: AnswerSafetyBand;
  dominantFailureMode: string | null;
  tuningSignals: TuningSignal[];
  notes: Record<string, unknown>;
}

export interface RetrievalRunData {
  id: string;
  tenantId: string;
  qualityConfidenceBand: string | null;
  retrievalSafetyStatus: string | null;
  rewrittenQueryText: string | null;
  rewriteStrategy: string | null;
  expansionTerms: unknown | null;
  queryExpansionCount: number | null;
  flaggedChunkCount: number | null;
  excludedForSafetyCount: number | null;
  candidatesFound: number | null;
  chunksSelected: number | null;
  shortlistSize: number | null;
}

export interface QualitySignalData {
  confidenceBand: string | null;
  sourceDiversityScore: number | null;
  documentDiversityScore: number | null;
  contextRedundancyScore: number | null;
  safetyStatus: string | null;
  flaggedChunkCount: number | null;
}

export interface AnswerRunData {
  id: string;
  tenantId: string;
  groundingConfidenceBand: string | null;
  groundingConfidenceScore: number | null;
  citationCoverageRatio: number | null;
  supportedClaimCount: number | null;
  partiallySupportedClaimCount: number | null;
  unsupportedClaimCount: number | null;
  unverifiableClaimCount: number | null;
  answerSafetyStatus: string | null;
  answerPolicyResult: string | null;
  advancedRerankUsed: boolean | null;
  shortlistSize: number | null;
  rerankLatencyMs: number | null;
  rerankProviderLatencyMs: number | null;
  retrievalConfidenceBand: string | null;
  retrievalSafetyStatus: string | null;
  rewriteStrategyUsed: string | null;
  safetyFlagCount: number | null;
  fallbackUsed: boolean | null;
  fallbackReason: string | null;
}

// ── DB fetch helpers ──────────────────────────────────────────────────────────

async function fetchRetrievalRun(runId: string): Promise<RetrievalRunData | null> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT id, tenant_id, quality_confidence_band, retrieval_safety_status,
              rewritten_query_text, rewrite_strategy, expansion_terms,
              query_expansion_count, flagged_chunk_count, excluded_for_safety_count,
              candidates_found, chunks_selected
       FROM public.knowledge_retrieval_runs WHERE id=$1`,
      [runId],
    );
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      qualityConfidenceBand: row.quality_confidence_band,
      retrievalSafetyStatus: row.retrieval_safety_status,
      rewrittenQueryText: row.rewritten_query_text,
      rewriteStrategy: row.rewrite_strategy,
      expansionTerms: row.expansion_terms,
      queryExpansionCount: row.query_expansion_count,
      flaggedChunkCount: row.flagged_chunk_count,
      excludedForSafetyCount: row.excluded_for_safety_count,
      candidatesFound: row.candidates_found,
      chunksSelected: row.chunks_selected,
      shortlistSize: null,
    };
  } finally {
    await client.end();
  }
}

async function fetchQualitySignals(retrievalRunId: string): Promise<QualitySignalData | null> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT confidence_band, source_diversity_score, document_diversity_score,
              context_redundancy_score, safety_status, flagged_chunk_count
       FROM public.knowledge_retrieval_quality_signals WHERE retrieval_run_id=$1 LIMIT 1`,
      [retrievalRunId],
    );
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return {
      confidenceBand: row.confidence_band,
      sourceDiversityScore: row.source_diversity_score ? parseFloat(row.source_diversity_score) : null,
      documentDiversityScore: row.document_diversity_score ? parseFloat(row.document_diversity_score) : null,
      contextRedundancyScore: row.context_redundancy_score ? parseFloat(row.context_redundancy_score) : null,
      safetyStatus: row.safety_status,
      flaggedChunkCount: row.flagged_chunk_count,
    };
  } finally {
    await client.end();
  }
}

async function fetchAnswerRun(answerRunId: string): Promise<AnswerRunData | null> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT id, tenant_id, grounding_confidence_band, grounding_confidence_score,
              citation_coverage_ratio, supported_claim_count, partially_supported_claim_count,
              unsupported_claim_count, unverifiable_claim_count, answer_safety_status,
              answer_policy_result, advanced_rerank_used, shortlist_size, rerank_latency_ms,
              rerank_provider_latency_ms, retrieval_confidence_band, retrieval_safety_status,
              rewrite_strategy_used, safety_flag_count, fallback_used, fallback_reason
       FROM public.knowledge_answer_runs WHERE id=$1`,
      [answerRunId],
    );
    if (!r.rows[0]) return null;
    const row = r.rows[0];
    return {
      id: row.id,
      tenantId: row.tenant_id,
      groundingConfidenceBand: row.grounding_confidence_band,
      groundingConfidenceScore: row.grounding_confidence_score ? parseFloat(row.grounding_confidence_score) : null,
      citationCoverageRatio: row.citation_coverage_ratio ? parseFloat(row.citation_coverage_ratio) : null,
      supportedClaimCount: row.supported_claim_count,
      partiallySupportedClaimCount: row.partially_supported_claim_count,
      unsupportedClaimCount: row.unsupported_claim_count,
      unverifiableClaimCount: row.unverifiable_claim_count,
      answerSafetyStatus: row.answer_safety_status,
      answerPolicyResult: row.answer_policy_result,
      advancedRerankUsed: row.advanced_rerank_used,
      shortlistSize: row.shortlist_size,
      rerankLatencyMs: row.rerank_latency_ms,
      rerankProviderLatencyMs: row.rerank_provider_latency_ms,
      retrievalConfidenceBand: row.retrieval_confidence_band,
      retrievalSafetyStatus: row.retrieval_safety_status,
      rewriteStrategyUsed: row.rewrite_strategy_used,
      safetyFlagCount: row.safety_flag_count,
      fallbackUsed: row.fallback_used,
      fallbackReason: row.fallback_reason,
    };
  } finally {
    await client.end();
  }
}

// ── Classification functions ──────────────────────────────────────────────────

/**
 * Classify retrieval quality from run + quality signals.
 * INV-FB3: Deterministic.
 */
export function classifyRetrievalOutcome(params: {
  qualityConfidenceBand: string | null;
  qualitySignalBand: string | null;
  retrievalSafetyStatus: string | null;
  excludedForSafetyCount: number | null;
  documentDiversityScore: number | null;
  contextRedundancyScore: number | null;
}): { retrievalQualityBand: RetrievalQualityBand; dominantFailureModeCandidate: string | null } {
  const {
    qualityConfidenceBand, qualitySignalBand, retrievalSafetyStatus,
    excludedForSafetyCount, documentDiversityScore, contextRedundancyScore,
  } = params;

  const effectiveBand = qualityConfidenceBand ?? qualitySignalBand ?? null;

  let retrievalQualityBand: RetrievalQualityBand;
  if (effectiveBand === "high") {
    retrievalQualityBand = "high";
  } else if (effectiveBand === "medium") {
    retrievalQualityBand = "medium";
  } else if (effectiveBand === "low") {
    retrievalQualityBand = "low";
  } else {
    retrievalQualityBand = "poor";
  }

  let dominantFailureModeCandidate: string | null = null;
  if (retrievalSafetyStatus === "high_risk") {
    dominantFailureModeCandidate = "safety_exclusion";
  } else if ((excludedForSafetyCount ?? 0) > FEEDBACK_SIGNAL_THRESHOLDS.maxSafetyExclusionsBeforeReview) {
    dominantFailureModeCandidate = "excessive_safety_exclusion";
  } else if ((documentDiversityScore ?? 1) < FEEDBACK_SIGNAL_THRESHOLDS.weakDocumentDiversityScore) {
    dominantFailureModeCandidate = "source_dominance";
  } else if ((contextRedundancyScore ?? 0) > FEEDBACK_SIGNAL_THRESHOLDS.highContextRedundancyScore) {
    dominantFailureModeCandidate = "context_redundancy";
  } else if (retrievalQualityBand === "poor") {
    dominantFailureModeCandidate = "low_retrieval_quality";
  }

  return { retrievalQualityBand, dominantFailureModeCandidate };
}

/**
 * Classify rerank effectiveness from answer run data.
 * INV-FB5: Must not fabricate improvements.
 */
export function classifyRerankEffectiveness(params: {
  advancedRerankUsed: boolean | null;
  groundingConfidenceBand: string | null;
  citationCoverageRatio: number | null;
  shortlistSize: number | null;
  fallbackUsed: boolean | null;
}): RerankEffectivenessBand {
  const { advancedRerankUsed, groundingConfidenceBand, citationCoverageRatio, shortlistSize, fallbackUsed } = params;

  if (advancedRerankUsed === null || advancedRerankUsed === false) return "unknown";

  if (fallbackUsed) return "degraded";

  if (
    groundingConfidenceBand === "high" &&
    (citationCoverageRatio ?? 0) >= FEEDBACK_SIGNAL_THRESHOLDS.weakCitationCoverageRatio
  ) {
    return "improved";
  }

  if (
    groundingConfidenceBand === "low" ||
    groundingConfidenceBand === "unsafe" ||
    (citationCoverageRatio ?? 1) < FEEDBACK_SIGNAL_THRESHOLDS.failedCitationCoverageRatio
  ) {
    return "degraded";
  }

  return "neutral";
}

/**
 * Classify citation quality from answer run data.
 * INV-FB6: Evidence-based only.
 */
export function classifyCitationQuality(params: {
  citationCoverageRatio: number | null;
  unsupportedClaimCount: number | null;
  supportedClaimCount: number | null;
  partiallySupportedClaimCount: number | null;
  totalClaimCount: number | null;
}): {
  citationQualityBand: CitationQualityBand;
  unsupportedClaimRatio: number;
  missingCitationCount: number;
  weakCitationCount: number;
  multiClaimSingleCitationWarning: boolean;
} {
  const { citationCoverageRatio, unsupportedClaimCount, supportedClaimCount, partiallySupportedClaimCount, totalClaimCount } = params;

  const coverage = citationCoverageRatio ?? 0;
  const total = totalClaimCount ?? 0;
  const unsupported = unsupportedClaimCount ?? 0;
  const partial = partiallySupportedClaimCount ?? 0;
  const supported = supportedClaimCount ?? 0;
  const unsupportedRatio = total > 0 ? unsupported / total : 0;

  let citationQualityBand: CitationQualityBand;
  if (coverage >= 0.8 && unsupportedRatio < 0.2) {
    citationQualityBand = "strong";
  } else if (coverage >= 0.5 && unsupportedRatio < 0.4) {
    citationQualityBand = "acceptable";
  } else if (coverage >= 0.2) {
    citationQualityBand = "weak";
  } else {
    citationQualityBand = "poor";
  }

  const missingCitationCount = Math.max(0, unsupported);
  const weakCitationCount = Math.max(0, partial);
  const multiClaimSingleCitationWarning = total > 0 && supported === 1 && total >= 3;

  return { citationQualityBand, unsupportedClaimRatio: unsupportedRatio, missingCitationCount, weakCitationCount, multiClaimSingleCitationWarning };
}

/**
 * Classify query rewrite effectiveness from retrieval run.
 * INV-FB4: Must not overstate when evidence is insufficient.
 */
export function classifyRewriteEffectiveness(params: {
  rewrittenQueryText: string | null;
  rewriteStrategy: string | null;
  qualityConfidenceBand: string | null;
  queryExpansionCount: number | null;
}): RewriteEffectivenessBand {
  const { rewrittenQueryText, rewriteStrategy, qualityConfidenceBand, queryExpansionCount } = params;

  if (!rewrittenQueryText && !rewriteStrategy) return "unknown";
  if (!rewrittenQueryText) return "unknown";

  if (qualityConfidenceBand === "high") return "helpful";
  if (qualityConfidenceBand === "medium") return "neutral";

  if (qualityConfidenceBand === "low") {
    if (rewriteStrategy && rewriteStrategy !== "none") return "harmful";
    return "neutral";
  }

  if (qualityConfidenceBand === null) return "unknown";

  return "neutral";
}

/**
 * Classify answer safety outcome from answer run.
 * INV-FB3: Deterministic.
 */
export function classifyAnswerSafetyOutcome(params: {
  answerSafetyStatus: string | null;
  answerPolicyResult: string | null;
  retrievalSafetyStatus: string | null;
}): AnswerSafetyBand {
  const { answerPolicyResult, retrievalSafetyStatus } = params;

  if (retrievalSafetyStatus === "high_risk") return "unsafe";
  if (answerPolicyResult === "safe_refusal") return "unsafe";
  if (answerPolicyResult === "insufficient_evidence") return "weak";
  if (answerPolicyResult === "grounded_partial_answer") return "caution";
  if (answerPolicyResult === "full_answer") return "safe";
  return "caution";
}

/**
 * Derive deterministic tuning signals from combined evaluation signals.
 * INV-FB3: Deterministic. INV-FB8: Signals only — no auto-apply.
 */
export function deriveTuningSignals(params: {
  retrievalQualityBand: RetrievalQualityBand;
  rerankEffectivenessBand: RerankEffectivenessBand;
  citationQualityBand: CitationQualityBand;
  rewriteEffectivenessBand: RewriteEffectivenessBand;
  answerSafetyBand: AnswerSafetyBand;
  shortlistSize: number | null;
  citationCoverageRatio: number | null;
  unsupportedClaimCount: number | null;
  contextRedundancyScore: number | null;
  documentDiversityScore: number | null;
  excludedForSafetyCount: number | null;
  queryExpansionCount: number | null;
  advancedRerankUsed: boolean | null;
}): TuningSignal[] {
  const signals: TuningSignal[] = [];

  const {
    retrievalQualityBand, rerankEffectivenessBand, citationQualityBand,
    rewriteEffectivenessBand, shortlistSize, citationCoverageRatio,
    unsupportedClaimCount, contextRedundancyScore, documentDiversityScore,
    excludedForSafetyCount, queryExpansionCount, advancedRerankUsed,
  } = params;

  if (
    (shortlistSize ?? 20) < WEAK_RUN_THRESHOLDS.minShortlistSizeForSignal &&
    (retrievalQualityBand === "low" || retrievalQualityBand === "poor")
  ) {
    signals.push({
      signalType: "increase_shortlist_size",
      rationale: `Shortlist size ${shortlistSize ?? "unknown"} < ${WEAK_RUN_THRESHOLDS.minShortlistSizeForSignal} combined with ${retrievalQualityBand} quality band.`,
      priority: "high",
    });
  }

  if (
    (shortlistSize ?? 0) > WEAK_RUN_THRESHOLDS.maxShortlistSizeForSignal &&
    (contextRedundancyScore ?? 0) > FEEDBACK_SIGNAL_THRESHOLDS.highContextRedundancyScore
  ) {
    signals.push({
      signalType: "decrease_shortlist_size",
      rationale: `Shortlist size ${shortlistSize} > ${WEAK_RUN_THRESHOLDS.maxShortlistSizeForSignal} with high context redundancy score ${contextRedundancyScore?.toFixed(2)}.`,
      priority: "low",
    });
  }

  if ((contextRedundancyScore ?? 0) > FEEDBACK_SIGNAL_THRESHOLDS.highContextRedundancyScore) {
    signals.push({
      signalType: "review_context_redundancy",
      rationale: `Context redundancy score ${contextRedundancyScore?.toFixed(2)} exceeds threshold ${FEEDBACK_SIGNAL_THRESHOLDS.highContextRedundancyScore}. Consider chunking strategy.`,
      priority: "medium",
    });
  }

  if ((documentDiversityScore ?? 1) < FEEDBACK_SIGNAL_THRESHOLDS.weakDocumentDiversityScore) {
    signals.push({
      signalType: "review_source_dominance",
      rationale: `Document diversity score ${documentDiversityScore?.toFixed(2)} < ${FEEDBACK_SIGNAL_THRESHOLDS.weakDocumentDiversityScore}. One or few sources may dominate context.`,
      priority: "high",
    });
  }

  if (
    (citationCoverageRatio ?? 1) < FEEDBACK_SIGNAL_THRESHOLDS.weakCitationCoverageRatio ||
    (unsupportedClaimCount ?? 0) >= WEAK_RUN_THRESHOLDS.maxUnsupportedClaimCount
  ) {
    signals.push({
      signalType: "review_low_coverage_answers",
      rationale: `Citation coverage ratio ${citationCoverageRatio?.toFixed(2) ?? "unknown"} is below acceptable threshold. Unsupported claims: ${unsupportedClaimCount ?? 0}.`,
      priority: "high",
    });
  }

  if (rewriteEffectivenessBand === "harmful") {
    signals.push({
      signalType: "rewrite_not_helpful",
      rationale: "Query rewrite was attempted but retrieval quality band is low. Rewrite may have degraded precision.",
      priority: "medium",
    });
  }

  if (
    rewriteEffectivenessBand === "neutral" &&
    (retrievalQualityBand === "low" || retrievalQualityBand === "poor")
  ) {
    signals.push({
      signalType: "review_query_rewrite",
      rationale: `Rewrite was ${rewriteEffectivenessBand} and retrieval quality is ${retrievalQualityBand}. Consider reviewing rewrite strategy.`,
      priority: "medium",
    });
  }

  if (
    (queryExpansionCount ?? 0) >= 5 &&
    (retrievalQualityBand === "low" || retrievalQualityBand === "poor")
  ) {
    signals.push({
      signalType: "review_synonym_map",
      rationale: `${queryExpansionCount} expansion terms generated but quality band remains ${retrievalQualityBand}. Synonym map may need review.`,
      priority: "low",
    });
  }

  if ((excludedForSafetyCount ?? 0) > FEEDBACK_SIGNAL_THRESHOLDS.maxSafetyExclusionsBeforeReview) {
    signals.push({
      signalType: "review_safety_threshold",
      rationale: `${excludedForSafetyCount} chunks excluded for safety. Safety threshold may be too aggressive if quality is impacted.`,
      priority: "medium",
    });
  }

  if (
    advancedRerankUsed === true &&
    rerankEffectivenessBand === "degraded" &&
    citationQualityBand === "poor"
  ) {
    signals.push({
      signalType: "review_rerank_timeout",
      rationale: "Advanced reranking was used but citation quality is poor and effectiveness is degraded. Rerank provider timeout may have triggered fallback.",
      priority: "high",
    });
  }

  return signals.slice(0, MAX_TUNING_SIGNALS_PER_RUN);
}

/**
 * Determine overall feedback status from bands.
 * INV-FB3: Deterministic.
 */
export function determineFeedbackStatus(params: {
  retrievalQualityBand: RetrievalQualityBand;
  rerankEffectivenessBand: RerankEffectivenessBand;
  citationQualityBand: CitationQualityBand;
  answerSafetyBand: AnswerSafetyBand;
}): FeedbackStatus {
  const { retrievalQualityBand, citationQualityBand, answerSafetyBand } = params;

  if (answerSafetyBand === "unsafe" || (citationQualityBand === "poor" && retrievalQualityBand === "poor")) {
    return "failed";
  }
  if (retrievalQualityBand === "poor" || citationQualityBand === "poor" || answerSafetyBand === "weak") {
    return "weak";
  }
  if (retrievalQualityBand === "low" || citationQualityBand === "weak" || answerSafetyBand === "caution") {
    return "mixed";
  }
  return "success";
}

/**
 * Build a feedback record from raw params without any DB writes.
 * INV-FB2: Must use real persisted data or preview mode.
 * INV-FB8: No DB writes.
 */
export function buildFeedbackRecord(params: {
  retrievalRunId: string;
  answerRunId: string | null;
  tenantId: string;
  retrievalRun: RetrievalRunData;
  qualitySignals: QualitySignalData | null;
  answerRun: AnswerRunData | null;
}): FeedbackRecord {
  const { retrievalRunId, answerRunId, tenantId, retrievalRun, qualitySignals, answerRun } = params;

  const { retrievalQualityBand, dominantFailureModeCandidate } = classifyRetrievalOutcome({
    qualityConfidenceBand: retrievalRun.qualityConfidenceBand,
    qualitySignalBand: qualitySignals?.confidenceBand ?? null,
    retrievalSafetyStatus: retrievalRun.retrievalSafetyStatus,
    excludedForSafetyCount: retrievalRun.excludedForSafetyCount,
    documentDiversityScore: qualitySignals?.documentDiversityScore ?? null,
    contextRedundancyScore: qualitySignals?.contextRedundancyScore ?? null,
  });

  const rerankEffectivenessBand = classifyRerankEffectiveness({
    advancedRerankUsed: answerRun?.advancedRerankUsed ?? null,
    groundingConfidenceBand: answerRun?.groundingConfidenceBand ?? null,
    citationCoverageRatio: answerRun?.citationCoverageRatio ?? null,
    shortlistSize: answerRun?.shortlistSize ?? null,
    fallbackUsed: answerRun?.fallbackUsed ?? null,
  });

  const citationResult = classifyCitationQuality({
    citationCoverageRatio: answerRun?.citationCoverageRatio ?? null,
    unsupportedClaimCount: answerRun?.unsupportedClaimCount ?? null,
    supportedClaimCount: answerRun?.supportedClaimCount ?? null,
    partiallySupportedClaimCount: answerRun?.partiallySupportedClaimCount ?? null,
    totalClaimCount:
      (answerRun?.supportedClaimCount ?? 0) +
      (answerRun?.partiallySupportedClaimCount ?? 0) +
      (answerRun?.unsupportedClaimCount ?? 0) +
      (answerRun?.unverifiableClaimCount ?? 0) || null,
  });

  const rewriteEffectivenessBand = classifyRewriteEffectiveness({
    rewrittenQueryText: retrievalRun.rewrittenQueryText,
    rewriteStrategy: retrievalRun.rewriteStrategy ?? (answerRun?.rewriteStrategyUsed ?? null),
    qualityConfidenceBand: retrievalRun.qualityConfidenceBand ?? qualitySignals?.confidenceBand ?? null,
    queryExpansionCount: retrievalRun.queryExpansionCount,
  });

  const answerSafetyBand = classifyAnswerSafetyOutcome({
    answerSafetyStatus: answerRun?.answerSafetyStatus ?? null,
    answerPolicyResult: answerRun?.answerPolicyResult ?? null,
    retrievalSafetyStatus: retrievalRun.retrievalSafetyStatus ?? answerRun?.retrievalSafetyStatus ?? null,
  });

  const tuningSignals = deriveTuningSignals({
    retrievalQualityBand,
    rerankEffectivenessBand,
    citationQualityBand: citationResult.citationQualityBand,
    rewriteEffectivenessBand,
    answerSafetyBand,
    shortlistSize: answerRun?.shortlistSize ?? retrievalRun.shortlistSize,
    citationCoverageRatio: answerRun?.citationCoverageRatio ?? null,
    unsupportedClaimCount: answerRun?.unsupportedClaimCount ?? null,
    contextRedundancyScore: qualitySignals?.contextRedundancyScore ?? null,
    documentDiversityScore: qualitySignals?.documentDiversityScore ?? null,
    excludedForSafetyCount: retrievalRun.excludedForSafetyCount,
    queryExpansionCount: retrievalRun.queryExpansionCount,
    advancedRerankUsed: answerRun?.advancedRerankUsed ?? null,
  });

  const feedbackStatus = determineFeedbackStatus({
    retrievalQualityBand,
    rerankEffectivenessBand,
    citationQualityBand: citationResult.citationQualityBand,
    answerSafetyBand,
  });

  let dominantFailureMode = dominantFailureModeCandidate;
  if (!dominantFailureMode) {
    if (feedbackStatus === "failed" || feedbackStatus === "weak") {
      dominantFailureMode = tuningSignals[0]?.signalType ?? null;
    }
  }

  return {
    retrievalRunId,
    answerRunId,
    tenantId,
    feedbackStatus,
    retrievalQualityBand,
    rerankEffectivenessBand,
    citationQualityBand: citationResult.citationQualityBand,
    rewriteEffectivenessBand,
    answerSafetyBand,
    dominantFailureMode,
    tuningSignals,
    notes: {
      citationCoverageRatio: answerRun?.citationCoverageRatio ?? null,
      unsupportedClaimRatio: citationResult.unsupportedClaimRatio,
      missingCitationCount: citationResult.missingCitationCount,
      weakCitationCount: citationResult.weakCitationCount,
      multiClaimSingleCitationWarning: citationResult.multiClaimSingleCitationWarning,
      contextRedundancyScore: qualitySignals?.contextRedundancyScore ?? null,
      documentDiversityScore: qualitySignals?.documentDiversityScore ?? null,
      excludedForSafetyCount: retrievalRun.excludedForSafetyCount,
    },
  };
}

// ── Core evaluation function ──────────────────────────────────────────────────

/**
 * Evaluate a retrieval run and optionally persist the feedback record.
 * INV-FB1: Tenant-safe. INV-FB2: Real data only.
 */
export async function evaluateRetrievalRunFeedback(params: {
  retrievalRunId: string;
  answerRunId?: string | null;
  tenantId: string;
  persistFeedback?: boolean;
}): Promise<{ feedback: FeedbackRecord; persisted: boolean; note: string }> {
  const { retrievalRunId, answerRunId = null, tenantId, persistFeedback = false } = params;

  const [retrievalRun, qualitySignals] = await Promise.all([
    fetchRetrievalRun(retrievalRunId),
    fetchQualitySignals(retrievalRunId),
  ]);

  if (!retrievalRun) {
    throw new Error(`Retrieval run not found: ${retrievalRunId}`);
  }

  if (retrievalRun.tenantId !== tenantId) {
    throw new Error(`INV-FB1: Tenant mismatch. Run belongs to ${retrievalRun.tenantId}, not ${tenantId}`);
  }

  let answerRun: AnswerRunData | null = null;
  if (answerRunId) {
    answerRun = await fetchAnswerRun(answerRunId);
    if (answerRun && answerRun.tenantId !== tenantId) {
      throw new Error(`INV-FB1: Tenant mismatch on answer run.`);
    }
  }

  const feedback = buildFeedbackRecord({ retrievalRunId, answerRunId, tenantId, retrievalRun, qualitySignals, answerRun });

  if (!persistFeedback) {
    return { feedback, persisted: false, note: "INV-FB8: persistFeedback=false — no DB writes performed." };
  }

  const client = getClient();
  await client.connect();
  try {
    await client.query(
      `INSERT INTO public.knowledge_retrieval_feedback
         (tenant_id, retrieval_run_id, answer_run_id, feedback_status,
          retrieval_quality_band, rerank_effectiveness_band, citation_quality_band,
          rewrite_effectiveness_band, answer_safety_band, dominant_failure_mode,
          tuning_signals, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        tenantId, retrievalRunId, answerRunId, feedback.feedbackStatus,
        feedback.retrievalQualityBand, feedback.rerankEffectivenessBand,
        feedback.citationQualityBand, feedback.rewriteEffectivenessBand,
        feedback.answerSafetyBand, feedback.dominantFailureMode,
        JSON.stringify(feedback.tuningSignals), JSON.stringify(feedback.notes),
      ],
    );
    return { feedback, persisted: true, note: "INV-FB1: Feedback persisted. INV-FB2: Derived from real data." };
  } finally {
    await client.end();
  }
}

// ── Feedback summary / explain ────────────────────────────────────────────────

/**
 * Summarize persisted feedback for a retrieval run.
 * INV-FB7: Tenant-isolated. INV-FB9: No writes.
 */
export async function summarizeRetrievalFeedback(runId: string): Promise<{
  found: boolean;
  retrievalRunId: string;
  feedbackStatus: string | null;
  retrievalQualityBand: string | null;
  citationQualityBand: string | null;
  answerSafetyBand: string | null;
  dominantFailureMode: string | null;
  tuningSignalCount: number;
  note: string;
}> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT * FROM public.knowledge_retrieval_feedback WHERE retrieval_run_id=$1 LIMIT 1`,
      [runId],
    );
    if (!r.rows[0]) {
      return {
        found: false, retrievalRunId: runId, feedbackStatus: null,
        retrievalQualityBand: null, citationQualityBand: null,
        answerSafetyBand: null, dominantFailureMode: null,
        tuningSignalCount: 0, note: "INV-FB8: No writes. No feedback record found.",
      };
    }
    const row = r.rows[0];
    const signals = Array.isArray(row.tuning_signals) ? row.tuning_signals : [];
    return {
      found: true, retrievalRunId: runId,
      feedbackStatus: row.feedback_status,
      retrievalQualityBand: row.retrieval_quality_band,
      citationQualityBand: row.citation_quality_band,
      answerSafetyBand: row.answer_safety_band,
      dominantFailureMode: row.dominant_failure_mode,
      tuningSignalCount: signals.length,
      note: "INV-FB8: Read-only. no writes performed.",
    };
  } finally {
    await client.end();
  }
}

/**
 * Explain persisted feedback with staged reasoning.
 * INV-FB8: No writes.
 */
export async function explainRetrievalFeedback(runId: string): Promise<{
  retrievalRunId: string;
  stages: Array<{ stage: string; outcome: string; explanation: string }>;
  tuningSignals: TuningSignal[];
  note: string;
}> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT * FROM public.knowledge_retrieval_feedback WHERE retrieval_run_id=$1 LIMIT 1`,
      [runId],
    );
    if (!r.rows[0]) {
      return {
        retrievalRunId: runId,
        stages: [{ stage: "lookup", outcome: "not_found", explanation: "No feedback record for this run." }],
        tuningSignals: [],
        note: "INV-FB8: No writes. Feedback not yet computed.",
      };
    }
    const row = r.rows[0];
    const signals: TuningSignal[] = Array.isArray(row.tuning_signals) ? row.tuning_signals : [];
    return {
      retrievalRunId: runId,
      stages: [
        { stage: "retrieval_quality", outcome: row.retrieval_quality_band, explanation: `Retrieval quality classified as ${row.retrieval_quality_band} based on confidence band and safety signals.` },
        { stage: "rerank_effectiveness", outcome: row.rerank_effectiveness_band, explanation: `Reranking effectiveness classified as ${row.rerank_effectiveness_band}.` },
        { stage: "citation_quality", outcome: row.citation_quality_band, explanation: `Citation quality classified as ${row.citation_quality_band} based on coverage ratio and claim support.` },
        { stage: "rewrite_effectiveness", outcome: row.rewrite_effectiveness_band, explanation: `Query rewrite classified as ${row.rewrite_effectiveness_band} based on quality signal alignment.` },
        { stage: "answer_safety", outcome: row.answer_safety_band, explanation: `Answer safety classified as ${row.answer_safety_band} from policy outcome.` },
        { stage: "overall_feedback", outcome: row.feedback_status, explanation: `Overall feedback status: ${row.feedback_status}. Dominant failure: ${row.dominant_failure_mode ?? "none"}.` },
      ],
      tuningSignals: signals,
      note: "INV-FB8: Read-only. no writes performed.",
    };
  } finally {
    await client.end();
  }
}

/**
 * List weak or failed retrieval runs for a tenant.
 * INV-FB7: Tenant-isolated. INV-FB10: Cross-tenant leakage impossible.
 */
export async function listWeakRetrievalRuns(params: {
  tenantId: string;
  statusFilter?: ("weak" | "failed")[];
  limit?: number;
}): Promise<{
  tenantId: string;
  runs: Array<{
    retrievalRunId: string;
    feedbackStatus: string;
    retrievalQualityBand: string;
    dominantFailureMode: string | null;
    createdAt: string;
  }>;
  count: number;
  note: string;
}> {
  const { tenantId, statusFilter = ["weak", "failed"], limit = 20 } = params;
  const client = getClient();
  await client.connect();
  try {
    const placeholders = statusFilter.map((_, i) => `$${i + 2}`).join(",");
    const r = await client.query(
      `SELECT retrieval_run_id, feedback_status, retrieval_quality_band, dominant_failure_mode, created_at
       FROM public.knowledge_retrieval_feedback
       WHERE tenant_id=$1 AND feedback_status IN (${placeholders})
       ORDER BY created_at DESC LIMIT ${limit}`,
      [tenantId, ...statusFilter],
    );
    return {
      tenantId,
      runs: r.rows.map((row) => ({
        retrievalRunId: row.retrieval_run_id,
        feedbackStatus: row.feedback_status,
        retrievalQualityBand: row.retrieval_quality_band,
        dominantFailureMode: row.dominant_failure_mode,
        createdAt: row.created_at,
      })),
      count: r.rows.length,
      note: "INV-FB7: Tenant-isolated. INV-FB10: Cross-tenant leakage impossible.",
    };
  } finally {
    await client.end();
  }
}

/**
 * Summarize dominant failure patterns for a tenant.
 * INV-FB7: Tenant-isolated.
 */
export async function listWeakPatterns(params: { tenantId: string }): Promise<{
  tenantId: string;
  patterns: Array<{ dominantFailureMode: string; count: number }>;
  totalWeakRuns: number;
  note: string;
}> {
  const { tenantId } = params;
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT dominant_failure_mode, COUNT(*) as cnt
       FROM public.knowledge_retrieval_feedback
       WHERE tenant_id=$1 AND feedback_status IN ('weak','failed') AND dominant_failure_mode IS NOT NULL
       GROUP BY dominant_failure_mode ORDER BY cnt DESC`,
      [tenantId],
    );
    const total = r.rows.reduce((s: number, row: any) => s + parseInt(row.cnt, 10), 0);
    return {
      tenantId,
      patterns: r.rows.map((row: any) => ({ dominantFailureMode: row.dominant_failure_mode, count: parseInt(row.cnt, 10) })),
      totalWeakRuns: total,
      note: "INV-FB7: Tenant-isolated patterns only.",
    };
  } finally {
    await client.end();
  }
}

// ── Rewrite effectiveness evaluation ─────────────────────────────────────────

/**
 * Evaluate rewrite effectiveness from persisted run data.
 * INV-FB4: Must not overstate.
 */
export async function evaluateRewriteEffectiveness(params: {
  retrievalRunId: string;
}): Promise<{
  retrievalRunId: string;
  rewriteAttempted: boolean;
  effectiveness: RewriteEffectivenessBand;
  rationale: string;
  note: string;
}> {
  const run = await fetchRetrievalRun(params.retrievalRunId);
  if (!run) {
    return { retrievalRunId: params.retrievalRunId, rewriteAttempted: false, effectiveness: "unknown", rationale: "Retrieval run not found.", note: "INV-FB4: Unknown — no data." };
  }

  const band = classifyRewriteEffectiveness({
    rewrittenQueryText: run.rewrittenQueryText,
    rewriteStrategy: run.rewriteStrategy,
    qualityConfidenceBand: run.qualityConfidenceBand,
    queryExpansionCount: run.queryExpansionCount,
  });

  const rationale = band === "unknown"
    ? "No rewrite was attempted or insufficient signal to evaluate."
    : `Rewrite strategy '${run.rewriteStrategy ?? "none"}' combined with quality band '${run.qualityConfidenceBand ?? "unknown"}' yields effectiveness: ${band}.`;

  return {
    retrievalRunId: params.retrievalRunId,
    rewriteAttempted: !!run.rewrittenQueryText,
    effectiveness: band,
    rationale,
    note: "INV-FB4: No fabricated certainty. INV-FB8: No writes.",
  };
}

/**
 * Compare original vs rewritten retrieval — inferring from signals.
 * INV-FB4: Deterministic and honest.
 */
export function compareOriginalVsRewrittenRetrieval(params: {
  originalQualityBand: string | null;
  rewrittenQualityBand: string | null;
  originalCandidatesFound: number | null;
  rewrittenCandidatesFound: number | null;
  rewriteStrategy: string | null;
}): {
  comparisonAvailable: boolean;
  qualityDelta: "improved" | "degraded" | "unchanged" | "unknown";
  candidateDelta: number | null;
  note: string;
} {
  const { originalQualityBand, rewrittenQualityBand, originalCandidatesFound, rewrittenCandidatesFound, rewriteStrategy } = params;

  if (!rewriteStrategy || !rewrittenQualityBand) {
    return { comparisonAvailable: false, qualityDelta: "unknown", candidateDelta: null, note: "INV-FB4: No rewrite data available for comparison." };
  }

  const bandOrder = ["poor", "low", "medium", "high"];
  const origIdx = bandOrder.indexOf(originalQualityBand ?? "");
  const rewritIdx = bandOrder.indexOf(rewrittenQualityBand ?? "");

  let qualityDelta: "improved" | "degraded" | "unchanged" | "unknown" = "unknown";
  if (origIdx >= 0 && rewritIdx >= 0) {
    if (rewritIdx > origIdx) qualityDelta = "improved";
    else if (rewritIdx < origIdx) qualityDelta = "degraded";
    else qualityDelta = "unchanged";
  }

  const candidateDelta = (originalCandidatesFound !== null && rewrittenCandidatesFound !== null)
    ? rewrittenCandidatesFound - originalCandidatesFound
    : null;

  return { comparisonAvailable: true, qualityDelta, candidateDelta, note: "INV-FB4: Inferred from persisted signals. No fabrication." };
}

/**
 * Explain rewrite effectiveness for a persisted feedback record.
 * INV-FB8: No writes.
 */
export async function explainRewriteEffectiveness(runId: string): Promise<{
  retrievalRunId: string;
  rewriteAttempted: boolean;
  effectivenessBand: string;
  explanation: string;
  note: string;
}> {
  const run = await fetchRetrievalRun(runId);
  if (!run) {
    return { retrievalRunId: runId, rewriteAttempted: false, effectivenessBand: "unknown", explanation: "No retrieval run found.", note: "INV-FB8: No writes." };
  }
  const band = classifyRewriteEffectiveness({
    rewrittenQueryText: run.rewrittenQueryText,
    rewriteStrategy: run.rewriteStrategy,
    qualityConfidenceBand: run.qualityConfidenceBand,
    queryExpansionCount: run.queryExpansionCount,
  });
  return {
    retrievalRunId: runId,
    rewriteAttempted: !!run.rewrittenQueryText,
    effectivenessBand: band,
    explanation: `Rewrite strategy: ${run.rewriteStrategy ?? "none"}. Quality band: ${run.qualityConfidenceBand ?? "unknown"}. Expansion terms: ${run.queryExpansionCount ?? 0}. Effectiveness: ${band}.`,
    note: "INV-FB4: No fabricated certainty. INV-FB8: No writes.",
  };
}

// ── Rerank effectiveness evaluation ──────────────────────────────────────────

/**
 * Evaluate rerank effectiveness from persisted answer run.
 * INV-FB5: Must not fabricate improvements.
 */
export async function evaluateRerankEffectiveness(params: {
  answerRunId: string;
}): Promise<{
  answerRunId: string;
  rerankUsed: boolean;
  effectivenessBand: RerankEffectivenessBand;
  rationale: string;
  note: string;
}> {
  const run = await fetchAnswerRun(params.answerRunId);
  if (!run) {
    return { answerRunId: params.answerRunId, rerankUsed: false, effectivenessBand: "unknown", rationale: "Answer run not found.", note: "INV-FB5: Unknown — no data." };
  }

  const band = classifyRerankEffectiveness({
    advancedRerankUsed: run.advancedRerankUsed,
    groundingConfidenceBand: run.groundingConfidenceBand,
    citationCoverageRatio: run.citationCoverageRatio,
    shortlistSize: run.shortlistSize,
    fallbackUsed: run.fallbackUsed,
  });

  const rationale = run.advancedRerankUsed
    ? `Advanced reranking used. Grounding band: ${run.groundingConfidenceBand ?? "unknown"}. Coverage: ${run.citationCoverageRatio?.toFixed(2) ?? "unknown"}. Fallback: ${run.fallbackUsed ? "yes" : "no"}.`
    : "Advanced reranking not used.";

  return {
    answerRunId: params.answerRunId,
    rerankUsed: run.advancedRerankUsed ?? false,
    effectivenessBand: band,
    rationale,
    note: "INV-FB5: No fabricated improvements. INV-FB8: No writes.",
  };
}

/**
 * Explain rerank effectiveness for a persisted answer run.
 * INV-FB8: No writes.
 */
export async function explainRerankEffectiveness(runId: string): Promise<{
  answerRunId: string;
  rerankUsed: boolean;
  effectivenessBand: string;
  explanation: string;
  note: string;
}> {
  const run = await fetchAnswerRun(runId);
  if (!run) {
    return { answerRunId: runId, rerankUsed: false, effectivenessBand: "unknown", explanation: "No answer run found.", note: "INV-FB8: No writes." };
  }
  const band = classifyRerankEffectiveness({
    advancedRerankUsed: run.advancedRerankUsed,
    groundingConfidenceBand: run.groundingConfidenceBand,
    citationCoverageRatio: run.citationCoverageRatio,
    shortlistSize: run.shortlistSize,
    fallbackUsed: run.fallbackUsed,
  });
  return {
    answerRunId: runId,
    rerankUsed: run.advancedRerankUsed ?? false,
    effectivenessBand: band,
    explanation: `Rerank used: ${run.advancedRerankUsed ? "yes" : "no"}. Grounding: ${run.groundingConfidenceBand ?? "unknown"}. Coverage: ${run.citationCoverageRatio?.toFixed(2) ?? "unknown"}. Fallback: ${run.fallbackUsed ? "yes" : "no"}.`,
    note: "INV-FB5: No fabricated improvements. INV-FB8: No writes.",
  };
}

/**
 * Aggregate rerank effectiveness across all runs for a tenant.
 * INV-FB7: Tenant-isolated.
 */
export async function summarizeRerankEffectiveness(tenantId: string): Promise<{
  tenantId: string;
  totalRuns: number;
  improvedCount: number;
  neutralCount: number;
  degradedCount: number;
  unknownCount: number;
  note: string;
}> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT rerank_effectiveness_band, COUNT(*) as cnt
       FROM public.knowledge_retrieval_feedback WHERE tenant_id=$1 GROUP BY rerank_effectiveness_band`,
      [tenantId],
    );
    let improved = 0, neutral = 0, degraded = 0, unknown = 0;
    for (const row of r.rows) {
      const cnt = parseInt(row.cnt, 10);
      if (row.rerank_effectiveness_band === "improved") improved = cnt;
      else if (row.rerank_effectiveness_band === "neutral") neutral = cnt;
      else if (row.rerank_effectiveness_band === "degraded") degraded = cnt;
      else unknown += cnt;
    }
    return {
      tenantId, totalRuns: improved + neutral + degraded + unknown,
      improvedCount: improved, neutralCount: neutral, degradedCount: degraded, unknownCount: unknown,
      note: "INV-FB5: No fabrication. INV-FB7: Tenant-isolated.",
    };
  } finally {
    await client.end();
  }
}

// ── Citation quality evaluation ───────────────────────────────────────────────

/**
 * Evaluate citation quality from answer run data.
 * INV-FB6: Evidence-based only.
 */
export async function evaluateCitationQuality(params: {
  answerRunId: string;
}): Promise<{
  answerRunId: string;
  citationQualityBand: CitationQualityBand;
  unsupportedClaimRatio: number;
  missingCitationCount: number;
  weakCitationCount: number;
  multiClaimSingleCitationWarning: boolean;
  note: string;
}> {
  const run = await fetchAnswerRun(params.answerRunId);
  if (!run) {
    return { answerRunId: params.answerRunId, citationQualityBand: "poor", unsupportedClaimRatio: 1, missingCitationCount: 0, weakCitationCount: 0, multiClaimSingleCitationWarning: false, note: "INV-FB6: Answer run not found." };
  }
  const total = (run.supportedClaimCount ?? 0) + (run.partiallySupportedClaimCount ?? 0) + (run.unsupportedClaimCount ?? 0) + (run.unverifiableClaimCount ?? 0);
  const result = classifyCitationQuality({
    citationCoverageRatio: run.citationCoverageRatio,
    unsupportedClaimCount: run.unsupportedClaimCount,
    supportedClaimCount: run.supportedClaimCount,
    partiallySupportedClaimCount: run.partiallySupportedClaimCount,
    totalClaimCount: total || null,
  });
  return { answerRunId: params.answerRunId, ...result, note: "INV-FB6: Evidence-based from real answer run data. INV-FB8: No writes." };
}

/**
 * Summarize citation quality for a persisted feedback run.
 * INV-FB8: No writes.
 */
export async function summarizeCitationQuality(runId: string): Promise<{
  retrievalRunId: string;
  found: boolean;
  citationQualityBand: string | null;
  note: string;
}> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT citation_quality_band FROM public.knowledge_retrieval_feedback WHERE retrieval_run_id=$1 LIMIT 1`,
      [runId],
    );
    if (!r.rows[0]) {
      return { retrievalRunId: runId, found: false, citationQualityBand: null, note: "INV-FB8: No writes. Feedback not computed yet." };
    }
    return { retrievalRunId: runId, found: true, citationQualityBand: r.rows[0].citation_quality_band, note: "INV-FB6: Evidence-based. INV-FB8: No writes." };
  } finally {
    await client.end();
  }
}

/**
 * Explain citation quality for a persisted feedback run.
 * INV-FB8: No writes.
 */
export async function explainCitationQuality(runId: string): Promise<{
  retrievalRunId: string;
  citationQualityBand: string;
  explanation: string;
  rules: string[];
  note: string;
}> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT citation_quality_band, notes FROM public.knowledge_retrieval_feedback WHERE retrieval_run_id=$1 LIMIT 1`,
      [runId],
    );
    if (!r.rows[0]) {
      return { retrievalRunId: runId, citationQualityBand: "unknown", explanation: "No feedback record found.", rules: [], note: "INV-FB8: No writes." };
    }
    const band = r.rows[0].citation_quality_band;
    const notes = r.rows[0].notes ?? {};
    return {
      retrievalRunId: runId,
      citationQualityBand: band,
      explanation: `Citation quality band: ${band}. Coverage: ${notes.citationCoverageRatio ?? "unknown"}. Unsupported ratio: ${notes.unsupportedClaimRatio ?? "unknown"}.`,
      rules: [
        "strong: coverage >= 0.8 and unsupportedRatio < 0.2",
        "acceptable: coverage >= 0.5 and unsupportedRatio < 0.4",
        "weak: coverage >= 0.2",
        "poor: coverage < 0.2",
      ],
      note: "INV-FB6: Evidence-based. INV-FB8: No writes.",
    };
  } finally {
    await client.end();
  }
}

// ── Tuning signals ────────────────────────────────────────────────────────────

/**
 * Explain tuning signals for a persisted feedback run.
 * INV-FB3: Deterministic. INV-FB8: No writes.
 */
export async function explainTuningSignals(runId: string): Promise<{
  retrievalRunId: string;
  tuningSignals: TuningSignal[];
  signalCount: number;
  note: string;
}> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT tuning_signals FROM public.knowledge_retrieval_feedback WHERE retrieval_run_id=$1 LIMIT 1`,
      [runId],
    );
    if (!r.rows[0]) {
      return { retrievalRunId: runId, tuningSignals: [], signalCount: 0, note: "INV-FB3: No signals — feedback not computed. INV-FB8: No writes." };
    }
    const signals: TuningSignal[] = Array.isArray(r.rows[0].tuning_signals) ? r.rows[0].tuning_signals : [];
    return { retrievalRunId: runId, tuningSignals: signals, signalCount: signals.length, note: "INV-FB3: Signals are deterministic and explainable. INV-FB8: No writes." };
  } finally {
    await client.end();
  }
}

/**
 * Aggregate tuning signals for a tenant across all feedback runs.
 * INV-FB3: Deterministic. INV-FB7: Tenant-isolated.
 */
export async function summarizeTenantTuningSignals(tenantId: string): Promise<{
  tenantId: string;
  signalCounts: Record<string, number>;
  totalSignalsEmitted: number;
  topSignal: string | null;
  note: string;
}> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT tuning_signals FROM public.knowledge_retrieval_feedback WHERE tenant_id=$1`,
      [tenantId],
    );
    const counts: Record<string, number> = {};
    for (const row of r.rows) {
      const signals: TuningSignal[] = Array.isArray(row.tuning_signals) ? row.tuning_signals : [];
      for (const s of signals) {
        counts[s.signalType] = (counts[s.signalType] ?? 0) + 1;
      }
    }
    const totalSignalsEmitted = Object.values(counts).reduce((a, b) => a + b, 0);
    const topSignal = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    return { tenantId, signalCounts: counts, totalSignalsEmitted, topSignal, note: "INV-FB3: Deterministic. INV-FB7: Tenant-isolated." };
  } finally {
    await client.end();
  }
}

// ── Feedback metrics ──────────────────────────────────────────────────────────

/**
 * Record feedback metrics from a computed feedback record (does NOT double-persist).
 * This updates the notes JSONB field on an existing feedback record.
 * INV-FB7: Tenant-isolated.
 */
export async function recordFeedbackMetrics(params: {
  retrievalRunId: string;
  tenantId: string;
  extraMetrics: Record<string, unknown>;
}): Promise<{ updated: boolean }> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `UPDATE public.knowledge_retrieval_feedback
       SET notes = COALESCE(notes, '{}'::jsonb) || $1::jsonb
       WHERE retrieval_run_id=$2 AND tenant_id=$3`,
      [JSON.stringify(params.extraMetrics), params.retrievalRunId, params.tenantId],
    );
    return { updated: (r.rowCount ?? 0) > 0 };
  } finally {
    await client.end();
  }
}

/**
 * Get aggregated feedback metrics for a tenant.
 * INV-FB7: Tenant-isolated. INV-FB10: Cross-tenant impossible.
 */
export async function getFeedbackMetrics(tenantId: string): Promise<{
  tenantId: string;
  feedbackRunCount: number;
  weakRunCount: number;
  failedRunCount: number;
  avgCoverageRatio: number | null;
  avgGroundingConfidence: number | null;
  rerankFallbackRate: number;
  weakRewriteRate: number;
  unsafeAnswerRate: number;
  dominantFailureModes: Array<{ mode: string; count: number }>;
  tuningSignalCounts: Record<string, number>;
}> {
  const client = getClient();
  await client.connect();
  try {
    const [statsR, failModeR, sigR] = await Promise.all([
      client.query(
        `SELECT
           COUNT(*) as total,
           COALESCE(SUM(CASE WHEN feedback_status='weak' THEN 1 ELSE 0 END), 0) as weak_count,
           COALESCE(SUM(CASE WHEN feedback_status='failed' THEN 1 ELSE 0 END), 0) as failed_count,
           COALESCE(SUM(CASE WHEN rerank_effectiveness_band='degraded' THEN 1 ELSE 0 END), 0) as rerank_fallback,
           COALESCE(SUM(CASE WHEN rewrite_effectiveness_band IN ('harmful','neutral') THEN 1 ELSE 0 END), 0) as weak_rewrite,
           COALESCE(SUM(CASE WHEN answer_safety_band IN ('unsafe','weak') THEN 1 ELSE 0 END), 0) as unsafe_answer
         FROM public.knowledge_retrieval_feedback WHERE tenant_id=$1`,
        [tenantId],
      ),
      client.query(
        `SELECT dominant_failure_mode, COUNT(*) as cnt
         FROM public.knowledge_retrieval_feedback WHERE tenant_id=$1 AND dominant_failure_mode IS NOT NULL
         GROUP BY dominant_failure_mode ORDER BY cnt DESC LIMIT 5`,
        [tenantId],
      ),
      client.query(
        `SELECT tuning_signals FROM public.knowledge_retrieval_feedback WHERE tenant_id=$1`,
        [tenantId],
      ),
    ]);

    const stats = statsR.rows[0];
    const total = parseInt(stats.total, 10);
    const weakCount = parseInt(stats.weak_count, 10);
    const failedCount = parseInt(stats.failed_count, 10);
    const rerankFallback = parseInt(stats.rerank_fallback, 10);
    const weakRewrite = parseInt(stats.weak_rewrite, 10);
    const unsafeAnswer = parseInt(stats.unsafe_answer, 10);

    const counts: Record<string, number> = {};
    for (const row of sigR.rows) {
      const signals: TuningSignal[] = Array.isArray(row.tuning_signals) ? row.tuning_signals : [];
      for (const s of signals) {
        counts[s.signalType] = (counts[s.signalType] ?? 0) + 1;
      }
    }

    return {
      tenantId,
      feedbackRunCount: total,
      weakRunCount: weakCount,
      failedRunCount: failedCount,
      avgCoverageRatio: null,
      avgGroundingConfidence: null,
      rerankFallbackRate: total > 0 ? rerankFallback / total : 0,
      weakRewriteRate: total > 0 ? weakRewrite / total : 0,
      unsafeAnswerRate: total > 0 ? unsafeAnswer / total : 0,
      dominantFailureModes: failModeR.rows.map((r: any) => ({ mode: r.dominant_failure_mode, count: parseInt(r.cnt, 10) })),
      tuningSignalCounts: counts,
    };
  } finally {
    await client.end();
  }
}

/**
 * Summarize feedback metrics for a tenant in a human-readable format.
 * INV-FB7: Tenant-isolated.
 */
export async function summarizeFeedbackMetrics(tenantId: string): Promise<{
  tenantId: string;
  summary: string;
  metrics: Awaited<ReturnType<typeof getFeedbackMetrics>>;
  note: string;
}> {
  const metrics = await getFeedbackMetrics(tenantId);
  const { feedbackRunCount, weakRunCount, failedRunCount, topSignal } = {
    ...metrics,
    topSignal: Object.entries(metrics.tuningSignalCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none",
  };
  const summary = feedbackRunCount === 0
    ? `No feedback runs for tenant ${tenantId}.`
    : `${feedbackRunCount} runs evaluated. ${weakRunCount} weak, ${failedRunCount} failed. Top tuning signal: ${Object.entries(metrics.tuningSignalCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "none"}.`;
  return { tenantId, summary, metrics, note: "INV-FB7: Tenant-isolated metrics. INV-FB8: No writes." };
}
