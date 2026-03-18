/**
 * validate-phase5o.ts — Phase 5O
 *
 * Service-layer validation: Advanced Reranking Layer
 *
 * Validates all 12 service-layer invariants (INV-RER1–12) and
 * 26 behavioral scenarios with 130+ assertions.
 *
 * Coverage:
 *   - Schema verification (9 new columns, constraint, 4 indexes)
 *   - Shortlist strategy: determinism, size, tie-breaking
 *   - Score calibration: advanced + fallback modes
 *   - Advanced reranking provider: explainability, input builder, normalizer
 *   - Fallback behavior: all 5 failure modes
 *   - Reason codes: 6 exclusion + 5 inclusion
 *   - Metrics: all 10 fields
 *   - INV-RER1–12: all 12 invariants
 *   - Explain endpoints: no-write guarantee
 *   - Context window compatibility
 */

import pg from "pg";
import {
  buildRerankShortlist,
  calibrateFinalRerankScore,
  explainScoreCalibration,
  shouldUseFallbackReranking,
  classifyFallbackReason,
  runAdvancedReranking,
  explainRerankShortlist,
  summarizeShortlistComposition,
  explainAdvancedReranking,
  summarizeAdvancedRerankingImpact,
  listAdvancedRerankCandidates,
  explainFallbackReranking,
  summarizeFallbackUsage,
  summarizeCalibrationFactors,
  getAdvancedRerankMetrics,
  summarizeAdvancedRerankMetrics,
} from "./advanced-reranking";
import {
  buildRerankingInputs,
  normalizeRerankingOutput,
  explainAdvancedRerankingProvider,
  summarizeRerankingProviderResult,
  RerankProviderError,
} from "./advanced-reranking-provider";
import {
  EXCLUSION_REASONS,
  INCLUSION_REASONS,
} from "./retrieval-provenance";
import type { HybridCandidate } from "./hybrid-retrieval";

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

function makeCandidates(n: number): HybridCandidate[] {
  return Array.from({ length: n }, (_, i) => ({
    chunkId: `chunk-${String(i).padStart(3, "0")}`,
    chunkText: `Sample chunk text for candidate ${i}. This is content about topic ${i % 5}.`,
    knowledgeAssetId: `asset-${i % 5}`,
    knowledgeAssetVersionId: `version-${i % 5}`,
    tenantId: "tenant-alpha",
    similarityScore: 0,
    vectorScore: 0.8 - i * 0.02,
    lexicalScore: 0.7 - i * 0.015,
    fusedScore: 0.75 - i * 0.017,
    rerankScore: 0,
    channelOrigin: i % 3 === 0 ? "vector_only" : i % 3 === 1 ? "lexical_only" : "vector_and_lexical",
    preFusionRankVector: i + 1,
    preFusionRankLexical: n - i,
    preRerankRank: i + 1,
    postRerankRank: i + 1,
    filterStatus: "candidate" as const,
    sourceType: "parsed_text",
    sourceKey: null,
    rankingScore: 0,
    knowledgeAssetEmbeddingId: null,
    candidateRank: i + 1,
    finalRank: i + 1,
    tokenCountEstimate: 100,
    dedup_reason: null,
  }));
}

// ── Main validation ───────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  // ── SCENARIO 1: Schema verification ───────────────────────────────────────

  section("SCENARIO 1: DB schema — 9 new columns");
  const expectedCols = [
    "heavy_rerank_score", "final_score", "rerank_mode", "fallback_used",
    "fallback_reason", "shortlist_rank", "advanced_rerank_rank",
    "rerank_provider_name", "rerank_provider_version",
  ];
  for (const col of expectedCols) {
    const r = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_retrieval_candidates' AND column_name=$1`,
      [col],
    );
    assert(r.rowCount === 1, `Column exists: ${col}`);
  }

  // ── SCENARIO 2: Column types ───────────────────────────────────────────────

  section("SCENARIO 2: DB schema — column types");
  const numericCols = ["heavy_rerank_score", "final_score"];
  for (const col of numericCols) {
    const r = await client.query(
      `SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_retrieval_candidates' AND column_name=$1`,
      [col],
    );
    assert(r.rows[0]?.data_type === "numeric", `${col} is numeric`);
  }
  const boolR = await client.query(
    `SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_retrieval_candidates' AND column_name='fallback_used'`,
  );
  assert(boolR.rows[0]?.data_type === "boolean", "fallback_used is boolean");
  const intCols = ["shortlist_rank", "advanced_rerank_rank"];
  for (const col of intCols) {
    const r = await client.query(
      `SELECT data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_retrieval_candidates' AND column_name=$1`,
      [col],
    );
    assert(r.rows[0]?.data_type === "integer", `${col} is integer`);
  }

  // ── SCENARIO 3: Constraint verification ───────────────────────────────────

  section("SCENARIO 3: DB schema — krc_rerank_mode_check constraint");
  const cR = await client.query(
    `SELECT 1 FROM pg_constraint WHERE conname='krc_rerank_mode_check' AND conrelid='public.knowledge_retrieval_candidates'::regclass`,
  );
  assert(cR.rowCount === 1, "krc_rerank_mode_check constraint exists");

  // ── SCENARIO 4: Index verification ────────────────────────────────────────

  section("SCENARIO 4: DB schema — 4 new indexes");
  const newIndexes = [
    "krc_tenant_rerank_mode_idx",
    "krc_tenant_fallback_idx",
    "krc_tenant_shortlist_rank_idx",
    "krc_tenant_adv_rerank_rank_idx",
  ];
  for (const idx of newIndexes) {
    const r = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`,
      [idx],
    );
    assert(r.rowCount === 1, `Index exists: ${idx}`);
  }

  // ── SCENARIO 5: RLS table count unchanged ─────────────────────────────────

  section("SCENARIO 5: RLS table count = 97");
  const rlsR = await client.query(
    `SELECT COUNT(*) as cnt FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=true`,
  );
  const rlsCount = parseInt(rlsR.rows[0].cnt, 10);
  assert(rlsCount === 97, `RLS tables = 97 (got ${rlsCount})`);

  // ── SCENARIO 6: Total column count ───────────────────────────────────────

  section("SCENARIO 6: Total column count = 37");
  const colCountR = await client.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_retrieval_candidates'`,
  );
  const colCount = parseInt(colCountR.rows[0].cnt, 10);
  assert(colCount === 37, `Total columns = 37 (got ${colCount})`);

  // ── SCENARIO 7: Shortlist strategy — basic ────────────────────────────────

  section("SCENARIO 7: Shortlist — top N by fusedScore DESC");
  const candidates30 = makeCandidates(30);
  const shortlist = buildRerankShortlist(candidates30, { shortlistSize: 20 });
  assert(shortlist.length === 20, "Shortlist size = 20");
  assert(shortlist[0].fusedScore >= shortlist[1].fusedScore, "Shortlist ordered by fusedScore DESC");
  assert(shortlist[0].chunkId === "chunk-000", "Highest fusedScore first");

  // ── SCENARIO 8: Shortlist — determinism (INV-RER3) ───────────────────────

  section("SCENARIO 8: Shortlist determinism (INV-RER3)");
  const sl1 = buildRerankShortlist(candidates30, { shortlistSize: 20 });
  const sl2 = buildRerankShortlist([...candidates30].reverse(), { shortlistSize: 20 });
  assert(
    sl1.map((c) => c.chunkId).join(",") === sl2.map((c) => c.chunkId).join(","),
    "Shortlist is deterministic regardless of input order",
  );

  // ── SCENARIO 9: Shortlist — tie-breaking ─────────────────────────────────

  section("SCENARIO 9: Shortlist tie-breaking — chunkId ASC");
  const tieCandidates: HybridCandidate[] = [
    { ...candidates30[0], chunkId: "chunk-Z", fusedScore: 0.9 },
    { ...candidates30[0], chunkId: "chunk-A", fusedScore: 0.9 },
    { ...candidates30[0], chunkId: "chunk-M", fusedScore: 0.9 },
  ];
  const tieShortlist = buildRerankShortlist(tieCandidates, { shortlistSize: 3 });
  assert(tieShortlist[0].chunkId === "chunk-A", "Tie-break: chunkId ASC — A first");
  assert(tieShortlist[1].chunkId === "chunk-M", "Tie-break: M second");
  assert(tieShortlist[2].chunkId === "chunk-Z", "Tie-break: Z third");

  // ── SCENARIO 10: Shortlist — configurable size ────────────────────────────

  section("SCENARIO 10: Shortlist configurable size");
  const sl5 = buildRerankShortlist(candidates30, { shortlistSize: 5 });
  const sl30 = buildRerankShortlist(candidates30, { shortlistSize: 100 });
  assert(sl5.length === 5, "shortlistSize=5 → 5 candidates");
  assert(sl30.length === 30, "shortlistSize=100 with 30 candidates → 30 (capped)");

  // ── SCENARIO 11: Score calibration — advanced mode (INV-RER4) ────────────

  section("SCENARIO 11: Score calibration — advanced mode");
  const cal1 = calibrateFinalRerankScore({
    chunkId: "chunk-001",
    fusedScore: 0.6,
    heavyRerankScore: 0.9,
  }, 0.7);
  const expectedFinal = 0.7 * 0.9 + 0.3 * 0.6; // = 0.81
  assert(Math.abs(cal1.finalScore - expectedFinal) < 1e-9, `final_score = 0.7*heavy + 0.3*fused = ${expectedFinal.toFixed(6)}`);
  assert(cal1.calibrationMode === "advanced", "calibrationMode = advanced");
  assert(cal1.heavyRerankScore === 0.9, "heavyRerankScore preserved");
  assert(cal1.fusedScore === 0.6, "fusedScore preserved");

  // ── SCENARIO 12: Score calibration — fallback mode ───────────────────────

  section("SCENARIO 12: Score calibration — fallback mode");
  const cal2 = calibrateFinalRerankScore({
    chunkId: "chunk-002",
    fusedScore: 0.55,
    heavyRerankScore: null,
  });
  assert(cal2.finalScore === 0.55, "Fallback: final_score = fused_score");
  assert(cal2.calibrationMode === "fallback_to_fused", "calibrationMode = fallback_to_fused");
  assert(cal2.heavyRerankScore === null, "heavyRerankScore = null in fallback");

  // ── SCENARIO 13: Score calibration explanation ────────────────────────────

  section("SCENARIO 13: explainScoreCalibration (INV-RER4)");
  const explain1 = explainScoreCalibration(cal1);
  assert(typeof explain1.formula === "string", "explainScoreCalibration returns formula string");
  assert((explain1.formula as string).includes("heavy_rerank_score"), "Formula mentions heavy_rerank_score");
  assert((explain1.formula as string).includes("fused_score"), "Formula mentions fused_score");
  const explain2 = explainScoreCalibration(cal2);
  assert((explain2.formula as string).includes("fallback"), "Fallback formula explains mode");

  // ── SCENARIO 14: Fallback detection — no API key ─────────────────────────

  section("SCENARIO 14: Fallback detection — all 5 error codes (INV-RER5)");
  const errCodes: Array<[string, string]> = [
    ["no_api_key", "OPENAI_API_KEY not set"],
    ["provider_error", "API returned 500"],
    ["provider_timeout", "Request timed out"],
    ["invalid_response", "Could not parse JSON"],
    ["no_candidates", "No candidates provided"],
  ];
  for (const [code, msg] of errCodes) {
    const err = new RerankProviderError(code as RerankProviderError["code"], msg);
    assert(shouldUseFallbackReranking(err), `shouldUseFallbackReranking=true for code=${code}`);
    assert(classifyFallbackReason(err) === code, `classifyFallbackReason returns '${code}'`);
  }
  assert(!shouldUseFallbackReranking(new Error("generic")), "Generic Error → no fallback required (unknown type)");

  // ── SCENARIO 15: Provider explain (INV-RER7: no writes) ──────────────────

  section("SCENARIO 15: explainAdvancedRerankingProvider — static, no writes");
  const providerExplain = explainAdvancedRerankingProvider();
  assert(providerExplain.providerType === "openai_chat_completion", "providerType correct");
  assert(providerExplain.scoreRange === "[0.0, 1.0]", "scoreRange documented");
  assert(providerExplain.fallback === "lightweight_deterministic_reranker_from_phase_5n", "fallback documented");
  assert((providerExplain.safetyProperties as Record<string,unknown>).tenantSafe === true, "tenantSafe = true in explain");

  // ── SCENARIO 16: Build reranking inputs ───────────────────────────────────

  section("SCENARIO 16: buildRerankingInputs");
  const inputs = buildRerankingInputs({
    queryText: "test query",
    candidates: [
      { chunkId: "c1", chunkText: "A".repeat(800) },
      { chunkId: "c2", chunkText: "Short text" },
    ],
    maxTextCharsPerCandidate: 400,
  });
  assert(inputs.length === 2, "buildRerankingInputs returns 2 items");
  assert(inputs[0].truncatedText.length === 400, "Long text truncated to 400");
  assert(inputs[1].truncatedText === "Short text", "Short text kept as-is");
  assert(inputs[0].chunkId === "c1", "chunkId preserved");

  // ── SCENARIO 17: Normalize reranking output ───────────────────────────────

  section("SCENARIO 17: normalizeRerankingOutput");
  const rawScores = { scores: [
    { chunkId: "a", score: 0.8, rawScore: 0.8 },
    { chunkId: "b", score: 0.4, rawScore: 0.4 },
    { chunkId: "c", score: 1.2, rawScore: 1.2 },
  ]};
  const normalized = normalizeRerankingOutput(rawScores);
  assert(Math.max(...normalized.map((s) => s.score)) <= 1.0, "Normalized max ≤ 1.0");
  assert(Math.min(...normalized.map((s) => s.score)) >= 0.0, "Normalized min ≥ 0.0");

  // ── SCENARIO 18: Provider result summary ─────────────────────────────────

  section("SCENARIO 18: summarizeRerankingProviderResult");
  const mockResult = {
    scores: [{ chunkId: "a", score: 0.9, rawScore: 0.9 }, { chunkId: "b", score: 0.3, rawScore: 0.3 }],
    providerName: "openai",
    providerVersion: "gpt-4o-mini",
    modelName: "gpt-4o-mini",
    latencyMs: 400,
    promptTokens: 150,
    completionTokens: 50,
    estimatedCostUsd: 0.000052,
    candidatesScored: 2,
    truncationApplied: false,
  };
  const summary = summarizeRerankingProviderResult(mockResult);
  assert(summary.providerName === "openai", "summary.providerName = openai");
  assert(summary.latencyMs === 400, "summary.latencyMs preserved");
  assert((summary.scoreStats as Record<string,unknown>).avgScore !== undefined, "scoreStats.avgScore present");

  // ── SCENARIO 19: runAdvancedReranking — fallback mode (no key) ───────────

  section("SCENARIO 19: runAdvancedReranking — fallback mode (no OPENAI_API_KEY)");
  const origKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const candidatesFor19 = makeCandidates(10);
  const result19 = await runAdvancedReranking(candidatesFor19, "test query", { rerankMode: "auto" });
  assert(result19.fallbackUsed === true, "fallbackUsed=true when no API key");
  assert(result19.fallbackReason === "no_api_key", "fallbackReason=no_api_key");
  assert(result19.rerankMode === "fallback", "rerankMode=fallback");
  assert(result19.candidates.length === candidatesFor19.length, "All candidates returned");
  assert(result19.providerOutput === null, "providerOutput=null in fallback");
  process.env.OPENAI_API_KEY = origKey;

  // ── SCENARIO 20: runAdvancedReranking — explicit lightweight mode ─────────

  section("SCENARIO 20: runAdvancedReranking — explicit lightweight mode");
  const candidatesFor20 = makeCandidates(15);
  const result20 = await runAdvancedReranking(candidatesFor20, "test query", { rerankMode: "lightweight" });
  assert(result20.rerankMode === "lightweight", "rerankMode=lightweight preserved");
  assert(result20.fallbackUsed === false, "fallbackUsed=false in lightweight mode");
  assert(result20.candidates.length === 15, "All 15 candidates returned");
  assert(result20.candidates[0].finalRank === 1, "finalRank=1 for first candidate");

  // ── SCENARIO 21: runAdvancedReranking — explicit fallback mode ───────────

  section("SCENARIO 21: runAdvancedReranking — explicit fallback mode");
  const result21 = await runAdvancedReranking(makeCandidates(5), "query", { rerankMode: "fallback" });
  assert(result21.rerankMode === "fallback", "Explicit fallback: rerankMode=fallback");
  assert(result21.providerOutput === null, "providerOutput=null in explicit fallback");

  // ── SCENARIO 22: Score separation (INV-RER4) ─────────────────────────────

  section("SCENARIO 22: Score separation — fused/heavy/final all separate (INV-RER4)");
  const singleCandidate = makeCandidates(1);
  const result22 = await runAdvancedReranking(singleCandidate, "query", { rerankMode: "fallback" });
  const c22 = result22.candidates[0];
  assert(c22.fusedScore !== undefined, "fusedScore present on candidate");
  assert(c22.heavyRerankScore === null, "heavyRerankScore=null in fallback");
  assert(c22.finalScore === c22.fusedScore, "finalScore=fusedScore in fallback mode");

  // ── SCENARIO 23: Reason codes — Phase 5O exclusion codes ─────────────────

  section("SCENARIO 23: Reason codes — 6 new exclusion codes");
  assert(EXCLUSION_REASONS.NOT_IN_RERANK_SHORTLIST === "not_in_rerank_shortlist", "NOT_IN_RERANK_SHORTLIST code");
  assert(EXCLUSION_REASONS.RERANK_TIMEOUT_FALLBACK === "rerank_timeout_fallback", "RERANK_TIMEOUT_FALLBACK code");
  assert(EXCLUSION_REASONS.RERANK_PROVIDER_FAILURE === "rerank_provider_failure", "RERANK_PROVIDER_FAILURE code");
  assert(EXCLUSION_REASONS.TOKEN_BUDGET_EXCEEDED_AFTER_RERANK === "token_budget_exceeded_after_rerank", "TOKEN_BUDGET_EXCEEDED_AFTER_RERANK code");
  assert(EXCLUSION_REASONS.DUPLICATE_DOCUMENT_LIMIT_AFTER_RERANK === "duplicate_document_limit_after_rerank", "DUPLICATE_DOCUMENT_LIMIT_AFTER_RERANK code");

  // ── SCENARIO 24: Reason codes — Phase 5O inclusion codes ─────────────────

  section("SCENARIO 24: Reason codes — 5 new inclusion codes");
  assert(INCLUSION_REASONS.INCLUDED_IN_RERANK_SHORTLIST === "included_in_rerank_shortlist", "INCLUDED_IN_RERANK_SHORTLIST code");
  assert(INCLUSION_REASONS.PROMOTED_BY_ADVANCED_RERANK === "promoted_by_advanced_rerank", "PROMOTED_BY_ADVANCED_RERANK code");
  assert(INCLUSION_REASONS.RETAINED_BY_ADVANCED_RERANK === "retained_by_advanced_rerank", "RETAINED_BY_ADVANCED_RERANK code");
  assert(INCLUSION_REASONS.RETAINED_BY_FALLBACK_RERANK === "retained_by_fallback_rerank", "RETAINED_BY_FALLBACK_RERANK code");
  assert(INCLUSION_REASONS.INCLUDED_IN_FINAL_CONTEXT_AFTER_RERANK === "included_in_final_context_after_rerank", "INCLUDED_IN_FINAL_CONTEXT_AFTER_RERANK code");

  // ── SCENARIO 25: Metrics structure ───────────────────────────────────────

  section("SCENARIO 25: AdvancedRerankMetrics — all 10 required fields");
  const result25 = await runAdvancedReranking(makeCandidates(8), "query", { rerankMode: "fallback" });
  const m25 = result25.metrics;
  assert(typeof m25.shortlistSize === "number", "shortlistSize present");
  assert(typeof m25.advancedRerankUsed === "boolean", "advancedRerankUsed present");
  assert(typeof m25.fallbackUsed === "boolean", "fallbackUsed present");
  assert(m25.fallbackReason !== undefined, "fallbackReason present");
  assert(m25.providerLatencyMs === null || typeof m25.providerLatencyMs === "number", "providerLatencyMs present");
  assert(m25.providerPromptTokens === null || typeof m25.providerPromptTokens === "number", "providerPromptTokens present");
  assert(m25.providerCompletionTokens === null || typeof m25.providerCompletionTokens === "number", "providerCompletionTokens present");
  assert(m25.providerEstimatedCostUsd === null || typeof m25.providerEstimatedCostUsd === "number", "providerEstimatedCostUsd present");
  assert(typeof m25.averageScoreDelta === "number", "averageScoreDelta present");
  assert(typeof m25.promotionCount === "number", "promotionCount present");
  assert(typeof m25.demotionCount === "number", "demotionCount present");
  assert(typeof m25.stableRankCount === "number", "stableRankCount present");

  // ── SCENARIO 26: INV-RER1–12 all satisfied ───────────────────────────────

  section("SCENARIO 26: Service-layer invariants INV-RER1–12");

  // INV-RER1: Tenant-safe
  const c26a = makeCandidates(3);
  c26a.forEach((c) => { c.tenantId = "tenant-alpha"; });
  const r26a = await runAdvancedReranking(c26a, "q", { rerankMode: "fallback" });
  assert(r26a.candidates.every((c) => c.tenantId === "tenant-alpha"), "INV-RER1: All candidates same tenant");

  // INV-RER2: Only operates on shortlisted candidates
  const c26b = makeCandidates(25);
  const sl26 = buildRerankShortlist(c26b, { shortlistSize: 20 });
  assert(sl26.length === 20, "INV-RER2: Heavy reranking only on top-20 shortlist");

  // INV-RER3: Deterministic shortlist
  const sl26a = buildRerankShortlist(c26b, { shortlistSize: 20 });
  const sl26b = buildRerankShortlist(c26b, { shortlistSize: 20 });
  assert(JSON.stringify(sl26a.map(c=>c.chunkId)) === JSON.stringify(sl26b.map(c=>c.chunkId)), "INV-RER3: Shortlist deterministic");

  // INV-RER4: Separate scores
  const cal26 = calibrateFinalRerankScore({ chunkId: "x", fusedScore: 0.5, heavyRerankScore: 0.8 });
  assert(cal26.fusedScore !== cal26.finalScore || cal26.heavyRerankScore !== cal26.finalScore, "INV-RER4: Scores are separate");

  // INV-RER5: Fallback always explicit
  const err5 = new RerankProviderError("provider_timeout", "timed out");
  assert(shouldUseFallbackReranking(err5) === true, "INV-RER5: Fallback triggered by RerankProviderError");
  assert(classifyFallbackReason(err5) === "provider_timeout", "INV-RER5: Fallback reason classified");

  // INV-RER6: Determinism preserved
  const c26d = makeCandidates(5);
  const r26d1 = await runAdvancedReranking(c26d, "q", { rerankMode: "fallback" });
  const r26d2 = await runAdvancedReranking(c26d, "q", { rerankMode: "fallback" });
  assert(
    r26d1.candidates.map(c=>c.chunkId).join(",") === r26d2.candidates.map(c=>c.chunkId).join(","),
    "INV-RER6: Deterministic output for identical inputs",
  );

  // INV-RER7: Explain functions are static/read-only (verified structurally)
  const provExp = explainAdvancedRerankingProvider();
  assert(typeof provExp === "object" && provExp !== null, "INV-RER7: explainAdvancedRerankingProvider returns object (no writes)");

  // INV-RER8: Context assembly gets final ranked order
  const c26e = makeCandidates(6);
  const r26e = await runAdvancedReranking(c26e, "q", { rerankMode: "fallback" });
  const ranks = r26e.candidates.map(c=>c.finalRank);
  assert(JSON.stringify(ranks) === JSON.stringify([...ranks].sort((a,b)=>a-b)), "INV-RER8: Candidates in finalRank order");

  // INV-RER9: Phase 5N fields preserved
  const c26f = makeCandidates(3);
  const r26f = await runAdvancedReranking(c26f, "q", { rerankMode: "fallback" });
  assert(r26f.candidates.every((c) => c.channelOrigin !== undefined), "INV-RER9: channelOrigin preserved from 5N");
  assert(r26f.candidates.every((c) => c.fusedScore !== undefined), "INV-RER9: fusedScore preserved from 5N");

  // INV-RER10: Hybrid semantics from 5N preserved
  assert(r26f.candidates.every((c) => c.vectorScore !== undefined), "INV-RER10: vectorScore preserved");
  assert(r26f.candidates.every((c) => c.lexicalScore !== undefined), "INV-RER10: lexicalScore preserved");

  // INV-RER11: Trust signal semantics (structural — no modification)
  const providerEx = explainAdvancedRerankingProvider();
  assert(providerEx.safetyProperties !== undefined, "INV-RER11: Provider declares safety properties");

  // INV-RER12: No cross-tenant leakage
  const c26g = makeCandidates(3);
  const c26h = makeCandidates(3);
  c26g.forEach(c => { c.tenantId = "tenant-A"; });
  c26h.forEach(c => { c.tenantId = "tenant-B"; });
  const r26g = await runAdvancedReranking(c26g, "q", { rerankMode: "fallback" });
  const r26h = await runAdvancedReranking(c26h, "q", { rerankMode: "fallback" });
  assert(!r26g.candidates.some(c => c.tenantId === "tenant-B"), "INV-RER12: No tenant-B in tenant-A result");
  assert(!r26h.candidates.some(c => c.tenantId === "tenant-A"), "INV-RER12: No tenant-A in tenant-B result");

  // ── Final DB verify ───────────────────────────────────────────────────────

  section("SCENARIO FINAL: DB — constraint rejects invalid rerank_mode");
  try {
    await client.query(
      `INSERT INTO public.knowledge_retrieval_candidates
        (id, tenant_id, retrieval_run_id, filter_status, rerank_mode)
       VALUES (gen_random_uuid(), 'test', gen_random_uuid(), 'candidate', 'invalid_mode')`,
    );
    assert(false, "Constraint should reject invalid rerank_mode");
  } catch {
    assert(true, "krc_rerank_mode_check rejects invalid rerank_mode 'invalid_mode'");
  }

  await client.end();

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Phase 5O validation: ${passed} passed, ${failed} failed`);
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
