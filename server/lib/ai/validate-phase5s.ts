/**
 * validate-phase5s.ts — Phase 5S
 *
 * Retrieval Feedback Loop, Quality Evaluation & Auto-Tuning Signals.
 *
 * 42 scenarios, 170+ assertions.
 * Validates all 10 service-layer invariants (INV-FB1–10).
 */

import pg from "pg";
import {
  classifyRetrievalOutcome,
  classifyRerankEffectiveness,
  classifyCitationQuality,
  classifyRewriteEffectiveness,
  classifyAnswerSafetyOutcome,
  deriveTuningSignals,
  determineFeedbackStatus,
  buildFeedbackRecord,
  evaluateRetrievalRunFeedback,
  summarizeRetrievalFeedback,
  explainRetrievalFeedback,
  listWeakRetrievalRuns,
  listWeakPatterns,
  evaluateRewriteEffectiveness,
  compareOriginalVsRewrittenRetrieval,
  explainRewriteEffectiveness,
  evaluateRerankEffectiveness,
  explainRerankEffectiveness,
  summarizeRerankEffectiveness,
  evaluateCitationQuality,
  summarizeCitationQuality,
  explainCitationQuality,
  explainTuningSignals,
  summarizeTenantTuningSignals,
  recordFeedbackMetrics,
  getFeedbackMetrics,
  summarizeFeedbackMetrics,
} from "./retrieval-feedback";
import type {
  RetrievalRunData,
  QualitySignalData,
  AnswerRunData,
} from "./retrieval-feedback";
import { describeRetrievalConfig } from "../config/retrieval-config";

// ── Test helpers ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  ✔ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ── Sample data ───────────────────────────────────────────────────────────────

const GOOD_RUN: RetrievalRunData = {
  id: "run-good", tenantId: "tenant-5s-test",
  qualityConfidenceBand: "high", retrievalSafetyStatus: "ok",
  rewrittenQueryText: "docker container deployment", rewriteStrategy: "synonym_expansion",
  expansionTerms: ["container", "docker", "deploy"], queryExpansionCount: 3,
  flaggedChunkCount: 0, excludedForSafetyCount: 0,
  candidatesFound: 50, chunksSelected: 8, shortlistSize: 20,
};

const POOR_RUN: RetrievalRunData = {
  id: "run-poor", tenantId: "tenant-5s-test",
  qualityConfidenceBand: "low", retrievalSafetyStatus: "caution",
  rewrittenQueryText: "expanded query", rewriteStrategy: "synonym_expansion",
  expansionTerms: ["a", "b", "c", "d", "e"], queryExpansionCount: 5,
  flaggedChunkCount: 4, excludedForSafetyCount: 5,
  candidatesFound: 8, chunksSelected: 2, shortlistSize: 5,
};

const NO_REWRITE_RUN: RetrievalRunData = {
  id: "run-no-rewrite", tenantId: "tenant-5s-test",
  qualityConfidenceBand: "medium", retrievalSafetyStatus: null,
  rewrittenQueryText: null, rewriteStrategy: null,
  expansionTerms: null, queryExpansionCount: null,
  flaggedChunkCount: 0, excludedForSafetyCount: 0,
  candidatesFound: 20, chunksSelected: 5, shortlistSize: null,
};

const GOOD_QUALITY: QualitySignalData = {
  confidenceBand: "high", sourceDiversityScore: 0.8,
  documentDiversityScore: 0.7, contextRedundancyScore: 0.2,
  safetyStatus: "ok", flaggedChunkCount: 0,
};

const POOR_QUALITY: QualitySignalData = {
  confidenceBand: "low", sourceDiversityScore: 0.2,
  documentDiversityScore: 0.15, contextRedundancyScore: 0.85,
  safetyStatus: "caution", flaggedChunkCount: 3,
};

const GOOD_ANSWER: AnswerRunData = {
  id: "ans-good", tenantId: "tenant-5s-test",
  groundingConfidenceBand: "high", groundingConfidenceScore: 0.88,
  citationCoverageRatio: 0.9, supportedClaimCount: 4,
  partiallySupportedClaimCount: 1, unsupportedClaimCount: 0,
  unverifiableClaimCount: 0, answerSafetyStatus: "ok",
  answerPolicyResult: "full_answer", advancedRerankUsed: true,
  shortlistSize: 20, rerankLatencyMs: 120, rerankProviderLatencyMs: 110,
  retrievalConfidenceBand: "high", retrievalSafetyStatus: "ok",
  rewriteStrategyUsed: "synonym_expansion", safetyFlagCount: 0,
  fallbackUsed: false, fallbackReason: null,
};

const POOR_ANSWER: AnswerRunData = {
  id: "ans-poor", tenantId: "tenant-5s-test",
  groundingConfidenceBand: "unsafe", groundingConfidenceScore: 0.15,
  citationCoverageRatio: 0.1, supportedClaimCount: 1,
  partiallySupportedClaimCount: 0, unsupportedClaimCount: 3,
  unverifiableClaimCount: 1, answerSafetyStatus: "degraded",
  answerPolicyResult: "safe_refusal", advancedRerankUsed: true,
  shortlistSize: 5, rerankLatencyMs: 200, rerankProviderLatencyMs: 180,
  retrievalConfidenceBand: "low", retrievalSafetyStatus: "high_risk",
  rewriteStrategyUsed: null, safetyFlagCount: 4,
  fallbackUsed: true, fallbackReason: "rerank_timeout",
};

async function main(): Promise<void> {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  // ── SCENARIO 1: DB schema — knowledge_retrieval_feedback exists ────────────

  section("SCENARIO 1: DB schema — knowledge_retrieval_feedback (14 cols)");
  const colR = await client.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_retrieval_feedback'`,
  );
  assert(parseInt(colR.rows[0].cnt, 10) === 14, "knowledge_retrieval_feedback has 14 columns");

  const requiredCols = [
    "id", "tenant_id", "retrieval_run_id", "answer_run_id", "feedback_status",
    "retrieval_quality_band", "rerank_effectiveness_band", "citation_quality_band",
    "rewrite_effectiveness_band", "answer_safety_band", "dominant_failure_mode",
    "tuning_signals", "notes", "created_at",
  ];
  for (const col of requiredCols) {
    const r = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_retrieval_feedback' AND column_name=$1`, [col],
    );
    assert(r.rowCount === 1, `Column exists: ${col}`);
  }

  // ── SCENARIO 2: DB schema — indexes exist ─────────────────────────────────

  section("SCENARIO 2: DB schema — 5 indexes on knowledge_retrieval_feedback");
  const indexNames = [
    "krf_tenant_run_idx", "krf_tenant_answer_idx", "krf_tenant_status_idx",
    "krf_tenant_quality_idx", "krf_tenant_created_idx",
  ];
  for (const idx of indexNames) {
    const r = await client.query(`SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`, [idx]);
    assert(r.rowCount === 1, `Index exists: ${idx}`);
  }

  // ── SCENARIO 3: DB schema — RLS is 101 ────────────────────────────────────

  section("SCENARIO 3: RLS count = 101 (was 100 + knowledge_retrieval_feedback)");
  const rlsR = await client.query(
    `SELECT COUNT(*) as cnt FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=true`,
  );
  assert(parseInt(rlsR.rows[0].cnt, 10) === 101, "RLS tables = 101");

  // ── SCENARIO 4: Config — Phase 5S constants ───────────────────────────────

  section("SCENARIO 4: Config — Phase 5S entries in describeRetrievalConfig()");
  const cfg = describeRetrievalConfig();
  assert(cfg.feedbackEvaluationEnabled === true, "feedbackEvaluationEnabled = true");
  assert(typeof cfg.feedbackSignalThresholds === "object", "feedbackSignalThresholds is object");
  assert(typeof cfg.weakRunThresholds === "object", "weakRunThresholds is object");
  assert(typeof cfg.maxTuningSignalsPerRun === "number", "maxTuningSignalsPerRun is number");
  assert((cfg.maxTuningSignalsPerRun as number) === 6, "maxTuningSignalsPerRun = 6");

  // ── SCENARIO 5: classifyRetrievalOutcome — high quality ───────────────────

  section("SCENARIO 5: classifyRetrievalOutcome — high quality");
  const r5 = classifyRetrievalOutcome({
    qualityConfidenceBand: "high", qualitySignalBand: "high",
    retrievalSafetyStatus: "ok", excludedForSafetyCount: 0,
    documentDiversityScore: 0.8, contextRedundancyScore: 0.2,
  });
  assert(r5.retrievalQualityBand === "high", "High confidence → high quality band");
  assert(r5.dominantFailureModeCandidate === null, "No failure mode for high quality run");

  // ── SCENARIO 6: classifyRetrievalOutcome — poor quality ───────────────────

  section("SCENARIO 6: classifyRetrievalOutcome — poor quality (weak run)");
  const r6 = classifyRetrievalOutcome({
    qualityConfidenceBand: null, qualitySignalBand: null,
    retrievalSafetyStatus: "ok", excludedForSafetyCount: 0,
    documentDiversityScore: 0.8, contextRedundancyScore: 0.2,
  });
  assert(r6.retrievalQualityBand === "poor", "No confidence band → poor quality");

  // ── SCENARIO 7: classifyRetrievalOutcome — safety exclusion failure ────────

  section("SCENARIO 7: classifyRetrievalOutcome — high_risk safety = unsafe band");
  const r7 = classifyRetrievalOutcome({
    qualityConfidenceBand: "low", qualitySignalBand: null,
    retrievalSafetyStatus: "high_risk", excludedForSafetyCount: 5,
    documentDiversityScore: 0.5, contextRedundancyScore: 0.4,
  });
  assert(r7.dominantFailureModeCandidate === "safety_exclusion", "high_risk → safety_exclusion failure mode");

  // ── SCENARIO 8: classifyRetrievalOutcome — source dominance ───────────────

  section("SCENARIO 8: classifyRetrievalOutcome — source dominance detected");
  const r8 = classifyRetrievalOutcome({
    qualityConfidenceBand: "medium", qualitySignalBand: null,
    retrievalSafetyStatus: "ok", excludedForSafetyCount: 0,
    documentDiversityScore: 0.1, contextRedundancyScore: 0.3,
  });
  assert(r8.dominantFailureModeCandidate === "source_dominance", "Low diversity → source_dominance");

  // ── SCENARIO 9: classifyRerankEffectiveness — improved ────────────────────

  section("SCENARIO 9: classifyRerankEffectiveness — improved");
  assert(
    classifyRerankEffectiveness({ advancedRerankUsed: true, groundingConfidenceBand: "high", citationCoverageRatio: 0.85, shortlistSize: 20, fallbackUsed: false }) === "improved",
    "Advanced rerank + high confidence + good coverage → improved",
  );

  // ── SCENARIO 10: classifyRerankEffectiveness — neutral ────────────────────

  section("SCENARIO 10: classifyRerankEffectiveness — neutral");
  assert(
    classifyRerankEffectiveness({ advancedRerankUsed: true, groundingConfidenceBand: "medium", citationCoverageRatio: 0.6, shortlistSize: 20, fallbackUsed: false }) === "neutral",
    "Advanced rerank + medium confidence (not high) → neutral",
  );
  assert(
    classifyRerankEffectiveness({ advancedRerankUsed: true, groundingConfidenceBand: "high", citationCoverageRatio: 0.3, shortlistSize: 20, fallbackUsed: false }) === "neutral",
    "Advanced rerank + high confidence but low coverage → neutral",
  );

  // ── SCENARIO 11: classifyRerankEffectiveness — degraded (fallback) ─────────

  section("SCENARIO 11: classifyRerankEffectiveness — degraded (fallback used)");
  assert(
    classifyRerankEffectiveness({ advancedRerankUsed: true, groundingConfidenceBand: "high", citationCoverageRatio: 0.85, shortlistSize: 20, fallbackUsed: true }) === "degraded",
    "Fallback used → degraded",
  );

  // ── SCENARIO 12: classifyRerankEffectiveness — unknown (not used) ─────────

  section("SCENARIO 12: classifyRerankEffectiveness — unknown (not used)");
  assert(
    classifyRerankEffectiveness({ advancedRerankUsed: false, groundingConfidenceBand: "high", citationCoverageRatio: 0.85, shortlistSize: 20, fallbackUsed: false }) === "unknown",
    "INV-FB5: Not used → unknown, not fabricated",
  );
  assert(
    classifyRerankEffectiveness({ advancedRerankUsed: null, groundingConfidenceBand: null, citationCoverageRatio: null, shortlistSize: null, fallbackUsed: null }) === "unknown",
    "INV-FB5: No data → unknown",
  );

  // ── SCENARIO 13: classifyCitationQuality — strong ─────────────────────────

  section("SCENARIO 13: classifyCitationQuality — strong");
  const c13 = classifyCitationQuality({ citationCoverageRatio: 0.9, unsupportedClaimCount: 0, supportedClaimCount: 5, partiallySupportedClaimCount: 1, totalClaimCount: 6 });
  assert(c13.citationQualityBand === "strong", "Coverage 0.9 + 0 unsupported → strong");
  assert(c13.unsupportedClaimRatio === 0, "Unsupported ratio = 0");

  // ── SCENARIO 14: classifyCitationQuality — weak ───────────────────────────

  section("SCENARIO 14: classifyCitationQuality — weak");
  const c14 = classifyCitationQuality({ citationCoverageRatio: 0.3, unsupportedClaimCount: 2, supportedClaimCount: 1, partiallySupportedClaimCount: 1, totalClaimCount: 4 });
  assert(c14.citationQualityBand === "weak", "Coverage 0.3 → weak");
  assert(c14.missingCitationCount >= 1, "INV-FB6: Missing citations counted");

  // ── SCENARIO 15: classifyCitationQuality — poor ───────────────────────────

  section("SCENARIO 15: classifyCitationQuality — poor");
  const c15 = classifyCitationQuality({ citationCoverageRatio: 0.05, unsupportedClaimCount: 4, supportedClaimCount: 0, partiallySupportedClaimCount: 0, totalClaimCount: 5 });
  assert(c15.citationQualityBand === "poor", "Coverage < 0.2 → poor");
  assert(c15.unsupportedClaimRatio === 0.8, "Unsupported ratio = 0.8");

  // ── SCENARIO 16: classifyCitationQuality — multi-claim warning ────────────

  section("SCENARIO 16: classifyCitationQuality — multi-claim single-citation warning");
  const c16 = classifyCitationQuality({ citationCoverageRatio: 0.85, unsupportedClaimCount: 0, supportedClaimCount: 1, partiallySupportedClaimCount: 0, totalClaimCount: 5 });
  assert(c16.multiClaimSingleCitationWarning === true, "INV-FB6: Multi-claim single-citation warning raised");

  // ── SCENARIO 17: classifyRewriteEffectiveness — helpful ───────────────────

  section("SCENARIO 17: classifyRewriteEffectiveness — helpful");
  assert(
    classifyRewriteEffectiveness({ rewrittenQueryText: "expanded query", rewriteStrategy: "synonym_expansion", qualityConfidenceBand: "high", queryExpansionCount: 3 }) === "helpful",
    "Rewrite + high quality → helpful",
  );

  // ── SCENARIO 18: classifyRewriteEffectiveness — neutral ───────────────────

  section("SCENARIO 18: classifyRewriteEffectiveness — neutral");
  assert(
    classifyRewriteEffectiveness({ rewrittenQueryText: "expanded query", rewriteStrategy: "synonym_expansion", qualityConfidenceBand: "medium", queryExpansionCount: 2 }) === "neutral",
    "Rewrite + medium quality → neutral",
  );

  // ── SCENARIO 19: classifyRewriteEffectiveness — harmful ───────────────────

  section("SCENARIO 19: classifyRewriteEffectiveness — harmful");
  assert(
    classifyRewriteEffectiveness({ rewrittenQueryText: "expanded query", rewriteStrategy: "synonym_expansion", qualityConfidenceBand: "low", queryExpansionCount: 5 }) === "harmful",
    "INV-FB4: Rewrite + low quality → harmful (not overclaimed)",
  );

  // ── SCENARIO 20: classifyRewriteEffectiveness — unknown (no rewrite) ───────

  section("SCENARIO 20: classifyRewriteEffectiveness — unknown (no rewrite)");
  assert(
    classifyRewriteEffectiveness({ rewrittenQueryText: null, rewriteStrategy: null, qualityConfidenceBand: "high", queryExpansionCount: null }) === "unknown",
    "INV-FB4: No rewrite → unknown, not fabricated",
  );

  // ── SCENARIO 21: classifyAnswerSafetyOutcome — safe ───────────────────────

  section("SCENARIO 21: classifyAnswerSafetyOutcome — safe");
  assert(
    classifyAnswerSafetyOutcome({ answerSafetyStatus: "ok", answerPolicyResult: "full_answer", retrievalSafetyStatus: "ok" }) === "safe",
    "full_answer → safe band",
  );

  // ── SCENARIO 22: classifyAnswerSafetyOutcome — unsafe (safe_refusal) ───────

  section("SCENARIO 22: classifyAnswerSafetyOutcome — unsafe (safe_refusal)");
  assert(
    classifyAnswerSafetyOutcome({ answerSafetyStatus: null, answerPolicyResult: "safe_refusal", retrievalSafetyStatus: null }) === "unsafe",
    "safe_refusal → unsafe band",
  );
  assert(
    classifyAnswerSafetyOutcome({ answerSafetyStatus: null, answerPolicyResult: null, retrievalSafetyStatus: "high_risk" }) === "unsafe",
    "high_risk retrieval safety → unsafe",
  );

  // ── SCENARIO 23: deriveTuningSignals — increase_shortlist_size ────────────

  section("SCENARIO 23: deriveTuningSignals — increase_shortlist_size emitted");
  const signals23 = deriveTuningSignals({
    retrievalQualityBand: "low", rerankEffectivenessBand: "unknown",
    citationQualityBand: "weak", rewriteEffectivenessBand: "unknown",
    answerSafetyBand: "caution", shortlistSize: 5,
    citationCoverageRatio: 0.3, unsupportedClaimCount: 1,
    contextRedundancyScore: 0.3, documentDiversityScore: 0.6,
    excludedForSafetyCount: 0, queryExpansionCount: 2, advancedRerankUsed: null,
  });
  const signal23 = signals23.find((s) => s.signalType === "increase_shortlist_size");
  assert(signal23 !== undefined, "INV-FB3: increase_shortlist_size emitted for small shortlist + low quality");
  assert(signal23!.rationale.length > 10, "INV-FB3: Tuning signal has rationale");

  // ── SCENARIO 24: deriveTuningSignals — review_query_rewrite ───────────────

  section("SCENARIO 24: deriveTuningSignals — review_query_rewrite emitted");
  const signals24 = deriveTuningSignals({
    retrievalQualityBand: "poor", rerankEffectivenessBand: "unknown",
    citationQualityBand: "poor", rewriteEffectivenessBand: "neutral",
    answerSafetyBand: "weak", shortlistSize: 20,
    citationCoverageRatio: 0.1, unsupportedClaimCount: 3,
    contextRedundancyScore: 0.3, documentDiversityScore: 0.5,
    excludedForSafetyCount: 0, queryExpansionCount: 2, advancedRerankUsed: null,
  });
  const signal24 = signals24.find((s) => s.signalType === "review_query_rewrite" || s.signalType === "review_low_coverage_answers");
  assert(signal24 !== undefined, "INV-FB3: review_query_rewrite or review_low_coverage_answers emitted");

  // ── SCENARIO 25: deriveTuningSignals — review_source_dominance ────────────

  section("SCENARIO 25: deriveTuningSignals — review_source_dominance emitted");
  const signals25 = deriveTuningSignals({
    retrievalQualityBand: "medium", rerankEffectivenessBand: "neutral",
    citationQualityBand: "acceptable", rewriteEffectivenessBand: "neutral",
    answerSafetyBand: "safe", shortlistSize: 20,
    citationCoverageRatio: 0.6, unsupportedClaimCount: 0,
    contextRedundancyScore: 0.3, documentDiversityScore: 0.1,
    excludedForSafetyCount: 0, queryExpansionCount: 2, advancedRerankUsed: true,
  });
  const signal25 = signals25.find((s) => s.signalType === "review_source_dominance");
  assert(signal25 !== undefined, "INV-FB3: review_source_dominance emitted for low diversity");

  // ── SCENARIO 26: deriveTuningSignals — review_low_coverage_answers ─────────

  section("SCENARIO 26: deriveTuningSignals — review_low_coverage_answers emitted");
  const signals26 = deriveTuningSignals({
    retrievalQualityBand: "medium", rerankEffectivenessBand: "neutral",
    citationQualityBand: "weak", rewriteEffectivenessBand: "neutral",
    answerSafetyBand: "caution", shortlistSize: 20,
    citationCoverageRatio: 0.2, unsupportedClaimCount: 3,
    contextRedundancyScore: 0.3, documentDiversityScore: 0.5,
    excludedForSafetyCount: 0, queryExpansionCount: 2, advancedRerankUsed: null,
  });
  assert(
    signals26.some((s) => s.signalType === "review_low_coverage_answers"),
    "INV-FB3: review_low_coverage_answers emitted for low coverage",
  );

  // ── SCENARIO 27: deriveTuningSignals — max cap ────────────────────────────

  section("SCENARIO 27: deriveTuningSignals — capped at MAX_TUNING_SIGNALS_PER_RUN");
  const signals27 = deriveTuningSignals({
    retrievalQualityBand: "poor", rerankEffectivenessBand: "degraded",
    citationQualityBand: "poor", rewriteEffectivenessBand: "harmful",
    answerSafetyBand: "unsafe", shortlistSize: 3,
    citationCoverageRatio: 0.05, unsupportedClaimCount: 5,
    contextRedundancyScore: 0.9, documentDiversityScore: 0.05,
    excludedForSafetyCount: 6, queryExpansionCount: 7, advancedRerankUsed: true,
  });
  assert(signals27.length <= 6, "INV-FB3: Signals capped at MAX_TUNING_SIGNALS_PER_RUN (6)");
  assert(signals27.every((s) => typeof s.rationale === "string" && s.rationale.length > 5), "INV-FB3: All signals have rationale");
  assert(signals27.every((s) => ["high", "medium", "low"].includes(s.priority)), "INV-FB3: All signals have valid priority");

  // ── SCENARIO 28: determineFeedbackStatus — success ────────────────────────

  section("SCENARIO 28: determineFeedbackStatus — success");
  assert(
    determineFeedbackStatus({ retrievalQualityBand: "high", rerankEffectivenessBand: "improved", citationQualityBand: "strong", answerSafetyBand: "safe" }) === "success",
    "All high → success",
  );

  // ── SCENARIO 29: determineFeedbackStatus — weak ───────────────────────────

  section("SCENARIO 29: determineFeedbackStatus — weak");
  assert(
    determineFeedbackStatus({ retrievalQualityBand: "poor", rerankEffectivenessBand: "neutral", citationQualityBand: "acceptable", answerSafetyBand: "safe" }) === "weak",
    "Poor retrieval → weak",
  );

  // ── SCENARIO 30: determineFeedbackStatus — failed ─────────────────────────

  section("SCENARIO 30: determineFeedbackStatus — failed");
  assert(
    determineFeedbackStatus({ retrievalQualityBand: "poor", rerankEffectivenessBand: "degraded", citationQualityBand: "poor", answerSafetyBand: "safe" }) === "failed",
    "Poor + poor citation → failed",
  );
  assert(
    determineFeedbackStatus({ retrievalQualityBand: "high", rerankEffectivenessBand: "improved", citationQualityBand: "strong", answerSafetyBand: "unsafe" }) === "failed",
    "Unsafe answer → failed",
  );

  // ── SCENARIO 31: buildFeedbackRecord — correct structure ──────────────────

  section("SCENARIO 31: buildFeedbackRecord — INV-FB2 no writes, correct structure");
  const before31 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_retrieval_feedback`);
  const record31 = buildFeedbackRecord({
    retrievalRunId: "run-preview", answerRunId: "ans-preview",
    tenantId: "tenant-5s-test",
    retrievalRun: GOOD_RUN, qualitySignals: GOOD_QUALITY, answerRun: GOOD_ANSWER,
  });
  const after31 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_retrieval_feedback`);
  assert(parseInt(before31.rows[0].cnt, 10) === parseInt(after31.rows[0].cnt, 10), "INV-FB2/FB8: buildFeedbackRecord performs no DB writes");
  assert(record31.retrievalRunId === "run-preview", "retrievalRunId set correctly");
  assert(record31.tenantId === "tenant-5s-test", "INV-FB1: tenantId set correctly");
  assert(["success", "mixed", "weak", "failed"].includes(record31.feedbackStatus), "feedbackStatus is valid");
  assert(["high", "medium", "low", "poor"].includes(record31.retrievalQualityBand), "retrievalQualityBand is valid");
  assert(Array.isArray(record31.tuningSignals), "tuningSignals is array");
  assert(typeof record31.notes === "object", "notes is object");
  assert(record31.feedbackStatus === "success", "Good run → success status");

  // ── SCENARIO 32: buildFeedbackRecord — weak run ───────────────────────────

  section("SCENARIO 32: buildFeedbackRecord — weak run classified correctly");
  const record32 = buildFeedbackRecord({
    retrievalRunId: "run-poor", answerRunId: "ans-poor",
    tenantId: "tenant-5s-test",
    retrievalRun: POOR_RUN, qualitySignals: POOR_QUALITY, answerRun: POOR_ANSWER,
  });
  assert(["weak", "failed"].includes(record32.feedbackStatus), "Poor run → weak or failed");
  assert(record32.answerSafetyBand === "unsafe", "Poor answer → unsafe safety band");
  assert(record32.tuningSignals.length > 0, "Weak run → tuning signals generated");

  // ── SCENARIO 33: buildFeedbackRecord — links answer run correctly ──────────

  section("SCENARIO 33: buildFeedbackRecord — answer run linked correctly");
  const record33 = buildFeedbackRecord({
    retrievalRunId: "run-x", answerRunId: "ans-y",
    tenantId: "tenant-5s-test",
    retrievalRun: GOOD_RUN, qualitySignals: GOOD_QUALITY, answerRun: GOOD_ANSWER,
  });
  assert(record33.answerRunId === "ans-y", "answerRunId linked correctly");

  // ── SCENARIO 34: evaluateRetrievalRunFeedback — persist=false (INV-FB8) ────

  section("SCENARIO 34: evaluateRetrievalRunFeedback — persistFeedback=false no writes");
  const testRetrievalRunId = `5s-ret-run-${Date.now()}`;
  const testAnswerRunId = `5s-ans-run-${Date.now()}`;

  const kbRow = await client.query(`SELECT id FROM public.knowledge_bases LIMIT 1`);
  const kbId = kbRow.rows[0]?.id ?? null;
  assert(kbId !== null, "knowledge_base exists for test inserts");

  await client.query(`
    INSERT INTO public.knowledge_retrieval_runs
      (id, tenant_id, knowledge_base_id, query_hash, candidates_found, candidates_ranked, chunks_selected,
       chunks_skipped_duplicate, chunks_skipped_budget, context_tokens_used, max_context_tokens, document_count)
    VALUES ($1, 'tenant-5s-test', $2, 'hash5s', 10, 10, 5, 0, 0, 500, 4000, 3)
  `, [testRetrievalRunId, kbId]);

  await client.query(`
    INSERT INTO public.knowledge_answer_runs
      (id, tenant_id, retrieval_run_id, answer_text, generation_model)
    VALUES ($1, 'tenant-5s-test', $2, 'Test answer for 5S validation.', 'gpt-4o-mini')
  `, [testAnswerRunId, testRetrievalRunId]);

  const before34 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_retrieval_feedback`);
  const r34 = await evaluateRetrievalRunFeedback({
    retrievalRunId: testRetrievalRunId,
    answerRunId: testAnswerRunId,
    tenantId: "tenant-5s-test",
    persistFeedback: false,
  });
  const after34 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_retrieval_feedback`);
  assert(r34.persisted === false, "INV-FB8: persistFeedback=false → not persisted");
  assert(r34.note.includes("INV-FB8"), "INV-FB8: note documents no-write guarantee");
  assert(parseInt(before34.rows[0].cnt, 10) === parseInt(after34.rows[0].cnt, 10), "INV-FB8: No DB writes in preview mode");
  assert(r34.feedback.tenantId === "tenant-5s-test", "INV-FB1: tenantId correct");

  // ── SCENARIO 35: evaluateRetrievalRunFeedback — persist=true ─────────────

  section("SCENARIO 35: evaluateRetrievalRunFeedback — persistFeedback=true persists");
  const r35 = await evaluateRetrievalRunFeedback({
    retrievalRunId: testRetrievalRunId,
    answerRunId: testAnswerRunId,
    tenantId: "tenant-5s-test",
    persistFeedback: true,
  });
  assert(r35.persisted === true, "persistFeedback=true → persisted");
  const saved35 = await client.query(
    `SELECT * FROM public.knowledge_retrieval_feedback WHERE retrieval_run_id=$1`, [testRetrievalRunId],
  );
  assert(saved35.rows.length === 1, "INV-FB1: Feedback record inserted to DB");
  assert(saved35.rows[0].tenant_id === "tenant-5s-test", "INV-FB1: Tenant ID correctly stored");
  assert(saved35.rows[0].answer_run_id === testAnswerRunId, "Answer run ID linked");
  assert(saved35.rows[0].feedback_status !== null, "feedback_status stored");
  assert(saved35.rows[0].tuning_signals !== null, "tuning_signals stored");

  // ── SCENARIO 36: summarizeRetrievalFeedback — found ──────────────────────

  section("SCENARIO 36: summarizeRetrievalFeedback — found for persisted run");
  const summary36 = await summarizeRetrievalFeedback(testRetrievalRunId);
  assert(summary36.found === true, "summarizeRetrievalFeedback found = true");
  assert(summary36.feedbackStatus !== null, "feedbackStatus returned");
  assert(summary36.note.includes("no writes"), "INV-FB8: note documents no-write");

  const summary36b = await summarizeRetrievalFeedback("not-a-real-run-5s-xyz");
  assert(summary36b.found === false, "summarizeRetrievalFeedback found = false for unknown run");

  // ── SCENARIO 37: explainRetrievalFeedback — 6 stages ─────────────────────

  section("SCENARIO 37: explainRetrievalFeedback — 6 explanation stages");
  const before37 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_retrieval_feedback`);
  const explain37 = await explainRetrievalFeedback(testRetrievalRunId);
  const after37 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_retrieval_feedback`);
  assert(explain37.stages.length === 6, "explainRetrievalFeedback has 6 stages");
  assert(explain37.note.includes("no writes"), "INV-FB8: explain performs no writes");
  assert(parseInt(before37.rows[0].cnt, 10) === parseInt(after37.rows[0].cnt, 10), "INV-FB8: No DB writes from explainRetrievalFeedback");
  assert(Array.isArray(explain37.tuningSignals), "tuningSignals is array");

  // ── SCENARIO 38: listWeakRetrievalRuns — INV-FB7 tenant isolated ──────────

  section("SCENARIO 38: listWeakRetrievalRuns — INV-FB7 tenant-isolated");
  const weakRuns = await listWeakRetrievalRuns({ tenantId: "tenant-5s-test" });
  assert(weakRuns.tenantId === "tenant-5s-test", "INV-FB7: Correct tenant");
  assert(Array.isArray(weakRuns.runs), "runs is array");
  assert(weakRuns.note.includes("INV-FB7"), "INV-FB7: note documents tenant isolation");

  const weakRunsOther = await listWeakRetrievalRuns({ tenantId: "tenant-OTHER-NEVER-5s" });
  assert(weakRunsOther.count === 0, "INV-FB10: Other tenant sees 0 runs");

  // ── SCENARIO 39: listWeakPatterns ─────────────────────────────────────────

  section("SCENARIO 39: listWeakPatterns — pattern aggregation");
  const patterns = await listWeakPatterns({ tenantId: "tenant-5s-test" });
  assert(patterns.tenantId === "tenant-5s-test", "INV-FB7: Correct tenant in patterns");
  assert(Array.isArray(patterns.patterns), "patterns is array");
  assert(patterns.note.includes("INV-FB7"), "INV-FB7: note documents isolation");

  // ── SCENARIO 40: compareOriginalVsRewrittenRetrieval ─────────────────────

  section("SCENARIO 40: compareOriginalVsRewrittenRetrieval — delta computed");
  const cmp40 = compareOriginalVsRewrittenRetrieval({
    originalQualityBand: "medium", rewrittenQualityBand: "high",
    originalCandidatesFound: 15, rewrittenCandidatesFound: 25,
    rewriteStrategy: "synonym_expansion",
  });
  assert(cmp40.comparisonAvailable === true, "Comparison available when rewrite data present");
  assert(cmp40.qualityDelta === "improved", "Quality improved from medium → high");
  assert(cmp40.candidateDelta === 10, "Candidate delta = +10");

  const cmp40b = compareOriginalVsRewrittenRetrieval({
    originalQualityBand: "high", rewrittenQualityBand: "low",
    originalCandidatesFound: 30, rewrittenCandidatesFound: 5,
    rewriteStrategy: "synonym_expansion",
  });
  assert(cmp40b.qualityDelta === "degraded", "INV-FB4: Degraded correctly identified");

  const cmp40c = compareOriginalVsRewrittenRetrieval({
    originalQualityBand: "high", rewrittenQualityBand: null,
    originalCandidatesFound: null, rewrittenCandidatesFound: null,
    rewriteStrategy: null,
  });
  assert(cmp40c.comparisonAvailable === false, "INV-FB4: No rewrite → comparison not available");

  // ── SCENARIO 41: evaluateRerankEffectiveness — from DB ────────────────────

  section("SCENARIO 41: evaluateRerankEffectiveness — from persisted answer run");
  const rerank41 = await evaluateRerankEffectiveness({ answerRunId: testAnswerRunId });
  assert(["improved", "neutral", "degraded", "unknown"].includes(rerank41.effectivenessBand), "INV-FB5: Valid effectiveness band");
  assert(rerank41.note.includes("INV-FB5"), "INV-FB5: note documents no fabrication");
  assert(rerank41.note.includes("INV-FB8"), "INV-FB8: note documents no writes");

  const rerank41b = await evaluateRerankEffectiveness({ answerRunId: "nonexistent-run-5s" });
  assert(rerank41b.effectivenessBand === "unknown", "INV-FB5: Unknown for missing run");

  // ── SCENARIO 42: summarizeRerankEffectiveness — tenant aggregation ─────────

  section("SCENARIO 42: summarizeRerankEffectiveness — INV-FB7 tenant aggregation");
  const rerankSummary = await summarizeRerankEffectiveness("tenant-5s-test");
  assert(rerankSummary.tenantId === "tenant-5s-test", "INV-FB7: Correct tenant");
  assert(typeof rerankSummary.totalRuns === "number", "totalRuns is number");
  assert(rerankSummary.note.includes("INV-FB7"), "INV-FB7: note documents isolation");

  const rerankSummaryOther = await summarizeRerankEffectiveness("tenant-NONEXISTENT-5s");
  assert(rerankSummaryOther.totalRuns === 0, "INV-FB10: Other tenant sees 0 runs");

  // ── SCENARIO 43: evaluateCitationQuality — from DB ────────────────────────

  section("SCENARIO 43: evaluateCitationQuality — from persisted answer run");
  const cq43 = await evaluateCitationQuality({ answerRunId: testAnswerRunId });
  assert(["strong", "acceptable", "weak", "poor"].includes(cq43.citationQualityBand), "INV-FB6: Valid citation quality band");
  assert(cq43.note.includes("INV-FB6"), "INV-FB6: note documents evidence-based");
  assert(cq43.note.includes("INV-FB8"), "INV-FB8: note documents no writes");
  assert(typeof cq43.unsupportedClaimRatio === "number", "unsupportedClaimRatio is number");

  // ── SCENARIO 44: summarizeCitationQuality — from feedback record ──────────

  section("SCENARIO 44: summarizeCitationQuality — from persisted feedback");
  const cq44 = await summarizeCitationQuality(testRetrievalRunId);
  assert(cq44.found === true, "summarizeCitationQuality found = true");
  assert(typeof cq44.citationQualityBand === "string", "citationQualityBand is string");
  assert(cq44.note.includes("INV-FB8"), "INV-FB8: no writes");

  const cq44b = await summarizeCitationQuality("not-real-5s");
  assert(cq44b.found === false, "summarizeCitationQuality found = false for unknown run");

  // ── SCENARIO 45: explainCitationQuality — from feedback record ────────────

  section("SCENARIO 45: explainCitationQuality — read-only");
  const before45 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_retrieval_feedback`);
  const cq45 = await explainCitationQuality(testRetrievalRunId);
  const after45 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_retrieval_feedback`);
  assert(cq45.rules.length === 4, "INV-FB6: 4 classification rules explained");
  assert(cq45.note.includes("INV-FB8"), "INV-FB8: no writes");
  assert(parseInt(before45.rows[0].cnt, 10) === parseInt(after45.rows[0].cnt, 10), "INV-FB8: explainCitationQuality produces no DB writes");

  // ── SCENARIO 46: explainTuningSignals — read-only ─────────────────────────

  section("SCENARIO 46: explainTuningSignals — INV-FB3/FB8 read-only");
  const before46 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_retrieval_feedback`);
  const ts46 = await explainTuningSignals(testRetrievalRunId);
  const after46 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_retrieval_feedback`);
  assert(ts46.note.includes("INV-FB3"), "INV-FB3: note documents determinism");
  assert(ts46.note.includes("INV-FB8"), "INV-FB8: note documents no writes");
  assert(Array.isArray(ts46.tuningSignals), "tuningSignals is array");
  assert(parseInt(before46.rows[0].cnt, 10) === parseInt(after46.rows[0].cnt, 10), "INV-FB8: explainTuningSignals produces no DB writes");

  // ── SCENARIO 47: summarizeTenantTuningSignals — INV-FB7 ──────────────────

  section("SCENARIO 47: summarizeTenantTuningSignals — INV-FB7 tenant-isolated");
  const tenantSignals = await summarizeTenantTuningSignals("tenant-5s-test");
  assert(tenantSignals.tenantId === "tenant-5s-test", "INV-FB7: Correct tenant");
  assert(typeof tenantSignals.totalSignalsEmitted === "number", "totalSignalsEmitted is number");
  assert(tenantSignals.note.includes("INV-FB7"), "INV-FB7: note documents isolation");

  const otherSignals = await summarizeTenantTuningSignals("tenant-NEVER-5s-xyz");
  assert(otherSignals.totalSignalsEmitted === 0, "INV-FB10: Other tenant sees 0 signals");

  // ── SCENARIO 48: recordFeedbackMetrics — updates notes ────────────────────

  section("SCENARIO 48: recordFeedbackMetrics — updates notes field");
  const update48 = await recordFeedbackMetrics({
    retrievalRunId: testRetrievalRunId,
    tenantId: "tenant-5s-test",
    extraMetrics: { customMetric: "phase5s-test", latencyMs: 55 },
  });
  assert(update48.updated === true, "recordFeedbackMetrics updated = true");

  // ── SCENARIO 49: getFeedbackMetrics — INV-FB7 tenant-isolated ─────────────

  section("SCENARIO 49: getFeedbackMetrics — INV-FB7 tenant-isolated");
  const metrics49 = await getFeedbackMetrics("tenant-5s-test");
  assert(metrics49.tenantId === "tenant-5s-test", "INV-FB7: Correct tenant");
  assert(metrics49.feedbackRunCount >= 1, "At least 1 feedback run computed");
  assert(typeof metrics49.rerankFallbackRate === "number", "rerankFallbackRate is number");
  assert(typeof metrics49.weakRewriteRate === "number", "weakRewriteRate is number");
  assert(Array.isArray(metrics49.dominantFailureModes), "dominantFailureModes is array");

  const metrics49b = await getFeedbackMetrics("tenant-NONEXISTENT-5s-xyz");
  assert(metrics49b.feedbackRunCount === 0, "INV-FB10: Other tenant sees 0 runs");
  assert(metrics49b.unsafeAnswerRate === 0, "INV-FB10: No data leakage");

  // ── SCENARIO 50: summarizeFeedbackMetrics — structured output ─────────────

  section("SCENARIO 50: summarizeFeedbackMetrics — structured output");
  const summary50 = await summarizeFeedbackMetrics("tenant-5s-test");
  assert(summary50.tenantId === "tenant-5s-test", "tenantId correct");
  assert(typeof summary50.summary === "string" && summary50.summary.length > 5, "summary is non-empty string");
  assert(summary50.note.includes("INV-FB7"), "INV-FB7: note documents isolation");
  assert(summary50.note.includes("INV-FB8"), "INV-FB8: note documents no writes");

  // ── SCENARIO 51: INV-FB9 — existing pipeline tables intact ───────────────

  section("SCENARIO 51: INV-FB9 — existing retrieval/answer tables unchanged");
  const tableChecks: Array<[string, number]> = [
    ["knowledge_retrieval_runs", 28],
    ["knowledge_retrieval_quality_signals", 10],
    ["knowledge_answer_runs", 31],
    ["knowledge_answer_citations", 12],
  ];
  for (const [table, expectedCols] of tableChecks) {
    const r = await client.query(
      `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table],
    );
    assert(parseInt(r.rows[0].cnt, 10) === expectedCols, `INV-FB9: ${table} still has ${expectedCols} cols`);
  }

  // ── SCENARIO 52: INV-FB10 — cross-tenant leakage impossible ──────────────

  section("SCENARIO 52: INV-FB10 — cross-tenant leakage impossible");
  const metA = await getFeedbackMetrics("tenant-5s-test");
  const metB = await getFeedbackMetrics("tenant-5s-NEVER-OTHER");
  assert(metA.feedbackRunCount >= 1, "INV-FB10: Tenant A sees own data");
  assert(metB.feedbackRunCount === 0, "INV-FB10: Tenant B sees nothing");
  assert(metB.weakRunCount === 0, "INV-FB10: No weak runs leaked to Tenant B");

  // ── SCENARIO 53: explainRewriteEffectiveness — read-only ─────────────────

  section("SCENARIO 53: explainRewriteEffectiveness — read-only");
  const before53 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_retrieval_feedback`);
  const rwe53 = await explainRewriteEffectiveness(testRetrievalRunId);
  const after53 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_retrieval_feedback`);
  assert(["helpful", "neutral", "harmful", "unknown"].includes(rwe53.effectivenessBand), "INV-FB4: Valid effectiveness band");
  assert(rwe53.note.includes("INV-FB4"), "INV-FB4: note documents no overclaiming");
  assert(rwe53.note.includes("INV-FB8"), "INV-FB8: note documents no writes");
  assert(parseInt(before53.rows[0].cnt, 10) === parseInt(after53.rows[0].cnt, 10), "INV-FB8: explainRewriteEffectiveness produces no DB writes");

  // ── SCENARIO 54: explainRerankEffectiveness — read-only ──────────────────

  section("SCENARIO 54: explainRerankEffectiveness — read-only");
  const before54 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_retrieval_feedback`);
  const rre54 = await explainRerankEffectiveness(testAnswerRunId);
  const after54 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_retrieval_feedback`);
  assert(["improved", "neutral", "degraded", "unknown"].includes(rre54.effectivenessBand), "INV-FB5: Valid effectiveness band");
  assert(rre54.note.includes("INV-FB5"), "INV-FB5: note documents no fabrication");
  assert(parseInt(before54.rows[0].cnt, 10) === parseInt(after54.rows[0].cnt, 10), "INV-FB8: explainRerankEffectiveness produces no DB writes");

  // Cleanup
  await client.query(`DELETE FROM public.knowledge_retrieval_feedback WHERE retrieval_run_id=$1`, [testRetrievalRunId]);
  await client.query(`DELETE FROM public.knowledge_answer_runs WHERE id=$1`, [testAnswerRunId]);
  await client.query(`DELETE FROM public.knowledge_retrieval_runs WHERE id=$1`, [testRetrievalRunId]);
  await client.end();

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Phase 5S validation: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error(`✗ ${failed} assertion(s) FAILED`);
    process.exit(1);
  } else {
    console.log(`✔ All ${passed} assertions passed`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("✗ Validation error:", err.message);
  process.exit(1);
});
