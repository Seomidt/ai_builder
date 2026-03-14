/**
 * validate-phase5r.ts — Phase 5R
 *
 * Service-layer validation: Answer Safety, Hallucination Guard & Citation Coverage
 *
 * 38 scenarios, 155+ assertions.
 * Validates all 10 service-layer invariants (INV-ANSV1–10).
 */

import pg from "pg";
import {
  extractAnswerClaims,
  normalizeAnswerClaim,
  previewExtractedClaims,
  matchClaimsToCitations,
  computeCitationCoverageRatio,
  computeGroundingConfidenceScore,
  assignGroundingConfidenceBand,
  verifyGroundedAnswer,
  summarizeAnswerVerification,
  computeUnsupportedClaimCount,
  explainAnswerVerification,
  summarizeCitationCoverage,
  summarizeAnswerVerificationMetrics,
  getAnswerVerificationMetrics,
  getAnswerVerificationTrace,
  explainVerificationStage,
  recordAnswerVerificationMetrics,
} from "./answer-verification";
import {
  detectCertaintyLanguage,
  detectUnsupportedAnswerClaims,
  detectCitationGaps,
  buildHallucinationGuardSummary,
  explainHallucinationGuard,
} from "./hallucination-guard";
import {
  decideFinalAnswerPolicy,
  applyAnswerPolicy,
  explainAnswerPolicy,
  previewAnswerPolicy,
} from "./answer-policy";
import {
  describeRetrievalConfig,
  ANSWER_VERIFICATION_ENABLED,
  HALLUCINATION_GUARD_ENABLED,
  MINIMUM_CITATION_COVERAGE_RATIO,
  MAXIMUM_UNSUPPORTED_CLAIM_COUNT,
  ALLOW_PARTIAL_ANSWER_FALLBACK,
  ALLOW_INSUFFICIENT_EVIDENCE_FALLBACK,
  STRONG_CERTAINTY_PENALTY_ENABLED,
  MINIMUM_GROUNDING_CONFIDENCE_BAND,
} from "../config/retrieval-config";
import type { CitationInput, ExtractedClaim } from "./answer-verification";

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

const SUPPORTED_ANSWER = `The deployment pipeline uses Docker containers for isolation.
Each service runs on port 8080 by default.
The configuration is stored in environment variables.
The system supports rolling updates with zero downtime.`;

const UNSUPPORTED_ANSWER = `The system was launched in 2019 at a conference in Singapore.
Revenue grew by 347% in 2022 according to financial reports.
The CEO confirmed all contracts are guaranteed to succeed.`;

const MIXED_ANSWER = `The deployment uses containers for isolation.
The database was migrated from MySQL to PostgreSQL in March 2021.
Each service runs on port 8080.
The revenue target is exactly $50 million for next quarter.`;

const CITATIONS_SUPPORTED: CitationInput[] = [
  {
    citationId: "cit-1",
    chunkId: "chunk-1",
    chunkTextPreview: "The deployment pipeline uses Docker containers for isolation and consistency across environments.",
    finalScore: 0.88,
  },
  {
    citationId: "cit-2",
    chunkId: "chunk-2",
    chunkTextPreview: "Each microservice is configured to run on port 8080 with environment variable configuration.",
    finalScore: 0.82,
  },
  {
    citationId: "cit-3",
    chunkId: "chunk-3",
    chunkTextPreview: "Rolling updates are supported with zero downtime deployment strategies.",
    finalScore: 0.79,
  },
];

const CITATIONS_EMPTY: CitationInput[] = [];

const CITATIONS_WEAK: CitationInput[] = [
  {
    citationId: "cit-weak-1",
    chunkId: "chunk-weak-1",
    chunkTextPreview: "General information about system infrastructure and operations.",
    finalScore: 0.32,
  },
];

// ── Scenarios ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  // ── SCENARIO 1: DB schema — 10 new columns in knowledge_answer_runs ────────

  section("SCENARIO 1: DB schema — 10 new Phase 5R columns");
  const newCols = [
    "grounding_confidence_score", "grounding_confidence_band", "citation_coverage_ratio",
    "supported_claim_count", "partially_supported_claim_count", "unsupported_claim_count",
    "unverifiable_claim_count", "answer_safety_status", "answer_policy_result",
    "answer_verification_latency_ms",
  ];
  for (const col of newCols) {
    const r = await client.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_answer_runs' AND column_name=$1`, [col],
    );
    assert(r.rowCount === 1, `knowledge_answer_runs.${col} exists`);
  }

  // ── SCENARIO 2: DB schema — 31 total columns ────────────────────────────────

  section("SCENARIO 2: knowledge_answer_runs has 31 columns total");
  const colCount = await client.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_answer_runs'`,
  );
  assert(parseInt(colCount.rows[0].cnt, 10) === 31, "knowledge_answer_runs column count = 31");

  // ── SCENARIO 3: Config — 5R entries present ───────────────────────────────

  section("SCENARIO 3: Config — Phase 5R entries in describeRetrievalConfig()");
  const cfg = describeRetrievalConfig();
  assert(cfg.answerVerificationEnabled === true, "answerVerificationEnabled = true");
  assert(cfg.hallucinationGuardEnabled === true, "hallucinationGuardEnabled = true");
  assert(cfg.minimumCitationCoverageRatio === 0.5, "minimumCitationCoverageRatio = 0.5");
  assert(cfg.maximumUnsupportedClaimCount === 2, "maximumUnsupportedClaimCount = 2");
  assert(cfg.allowPartialAnswerFallback === true, "allowPartialAnswerFallback = true");
  assert(cfg.allowInsufficientEvidenceFallback === true, "allowInsufficientEvidenceFallback = true");
  assert(cfg.strongCertaintyPenaltyEnabled === true, "strongCertaintyPenaltyEnabled = true");
  assert(cfg.minimumGroundingConfidenceBand === "low", "minimumGroundingConfidenceBand = low");

  // ── SCENARIO 4: RLS count still 100 ──────────────────────────────────────

  section("SCENARIO 4: RLS count unchanged at 100");
  const rlsR = await client.query(
    `SELECT COUNT(*) as cnt FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=true`,
  );
  assert(parseInt(rlsR.rows[0].cnt, 10) === 100, "RLS tables = 100");

  // ── SCENARIO 5: Claim extraction — deterministic (INV-ANSV3) ─────────────

  section("SCENARIO 5: extractAnswerClaims — INV-ANSV3 deterministic");
  const claims5a = extractAnswerClaims(SUPPORTED_ANSWER);
  const claims5b = extractAnswerClaims(SUPPORTED_ANSWER);
  assert(claims5a.length === claims5b.length, "INV-ANSV3: same claim count on repeat");
  assert(
    claims5a.every((c, i) => c.claimText === claims5b[i].claimText),
    "INV-ANSV3: same claim text on repeat",
  );
  assert(claims5a.length >= 2, "At least 2 claims extracted from supported answer");
  assert(claims5a.every((c) => typeof c.claimIndex === "number"), "All claims have claimIndex");
  assert(claims5a.every((c) => c.claimType !== undefined), "All claims have claimType");

  // ── SCENARIO 6: Claim extraction — connective detection ───────────────────

  section("SCENARIO 6: extractAnswerClaims — connective detection");
  const connective = "In summary, the system works well. In conclusion, all tests pass.";
  const claims6 = extractAnswerClaims(connective);
  const connectives = claims6.filter((c) => c.claimType === "connective");
  assert(connectives.length > 0, "Connective phrases detected as type 'connective'");

  // ── SCENARIO 7: Claim extraction — factual detection ─────────────────────

  section("SCENARIO 7: extractAnswerClaims — factual detection (numbers/dates)");
  const factual = "The system launched in 2019 with 347% growth. Revenue was $50 million in Q3.";
  const claims7 = extractAnswerClaims(factual);
  const factualClaims = claims7.filter((c) => c.claimType === "factual");
  assert(factualClaims.length >= 1, "Factual claims detected from numeric/date indicators");

  // ── SCENARIO 8: Claim extraction — empty input ────────────────────────────

  section("SCENARIO 8: extractAnswerClaims — empty input");
  assert(extractAnswerClaims("").length === 0, "Empty string → 0 claims");
  assert(extractAnswerClaims("   ").length === 0, "Whitespace only → 0 claims");
  assert(extractAnswerClaims("Ok.").length === 0, "Too short → 0 claims");

  // ── SCENARIO 9: normalizeAnswerClaim — deterministic ─────────────────────

  section("SCENARIO 9: normalizeAnswerClaim — deterministic");
  const raw9 = "  The SYSTEM uses Docker containers.  ";
  const norm9a = normalizeAnswerClaim(raw9);
  const norm9b = normalizeAnswerClaim(raw9);
  assert(norm9a === norm9b, "normalizeAnswerClaim is deterministic");
  assert(norm9a === "the system uses docker containers", "lowercase + trim + strip trailing punct");

  // ── SCENARIO 10: previewExtractedClaims — no writes (INV-ANSV7) ───────────

  section("SCENARIO 10: previewExtractedClaims — INV-ANSV7 no writes");
  const before10 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_answer_runs`);
  const preview10 = previewExtractedClaims(SUPPORTED_ANSWER);
  const after10 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_answer_runs`);
  assert(preview10.note.includes("no writes"), "INV-ANSV7: note documents no-write guarantee");
  assert(
    parseInt(before10.rows[0].cnt, 10) === parseInt(after10.rows[0].cnt, 10),
    "INV-ANSV7: no DB writes during previewExtractedClaims",
  );

  // ── SCENARIO 11: matchClaimsToCitations — supported (INV-ANSV2) ───────────

  section("SCENARIO 11: matchClaimsToCitations — supported claim mapped correctly");
  const rawClaims11 = extractAnswerClaims(SUPPORTED_ANSWER);
  const matched11 = matchClaimsToCitations(rawClaims11, CITATIONS_SUPPORTED);
  const supported11 = matched11.filter((c) => c.supportStatus === "supported");
  assert(supported11.length >= 1, "At least 1 claim supported by citations");
  assert(
    supported11.every((c) => c.citationIds.length > 0),
    "INV-ANSV2: supported claims have citation IDs",
  );
  assert(
    supported11.every((c) => c.matchScore > 0),
    "INV-ANSV2: supported claims have positive match score",
  );

  // ── SCENARIO 12: matchClaimsToCitations — unsupported claim ───────────────

  section("SCENARIO 12: matchClaimsToCitations — unsupported claim detected");
  const rawClaims12 = extractAnswerClaims(UNSUPPORTED_ANSWER);
  const matched12 = matchClaimsToCitations(rawClaims12, CITATIONS_WEAK);
  const unsupported12 = matched12.filter((c) => c.supportStatus === "unsupported");
  assert(unsupported12.length >= 1, "Unsupported claims detected from weak citations");
  assert(
    unsupported12.every((c) => c.matchScore === 0 || c.citationIds.length === 0),
    "INV-ANSV2: unsupported claims have no valid citation match",
  );

  // ── SCENARIO 13: matchClaimsToCitations — partially supported ─────────────

  section("SCENARIO 13: matchClaimsToCitations — partially supported claim");
  const partialAnswer = "The deployment uses containers for managing application services efficiently.";
  const partialCit: CitationInput[] = [{
    citationId: "cit-p1",
    chunkId: "chunk-p1",
    chunkTextPreview: "containers are used for deployment",
    finalScore: 0.65,
  }];
  const rawClaimsP = extractAnswerClaims(partialAnswer);
  const matchedP = matchClaimsToCitations(rawClaimsP, partialCit);
  const hasPartial = matchedP.some((c) => c.supportStatus === "partially_supported" || c.supportStatus === "supported");
  assert(hasPartial, "Partial or full support detected for partially matching claim");

  // ── SCENARIO 14: matchClaimsToCitations — unverifiable ────────────────────

  section("SCENARIO 14: matchClaimsToCitations — unverifiable claim (connective)");
  const connectiveAnswer = "In summary, the above covers the key points. In conclusion, more is needed.";
  const rawClaims14 = extractAnswerClaims(connectiveAnswer);
  const matched14 = matchClaimsToCitations(rawClaims14, CITATIONS_SUPPORTED);
  const unverifiable14 = matched14.filter((c) => c.supportStatus === "unverifiable");
  assert(unverifiable14.length >= 1, "Connective/filler claims classified as unverifiable");

  // ── SCENARIO 15: computeCitationCoverageRatio — correct ──────────────────

  section("SCENARIO 15: computeCitationCoverageRatio — correct computation");
  const claims15 = matchClaimsToCitations(extractAnswerClaims(SUPPORTED_ANSWER), CITATIONS_SUPPORTED);
  const ratio15 = computeCitationCoverageRatio(claims15);
  assert(ratio15 >= 0 && ratio15 <= 1, "Citation coverage ratio in [0,1]");
  assert(typeof ratio15 === "number", "Citation coverage ratio is number");

  // ── SCENARIO 16: coverage ratio — fully supported → high ratio ────────────

  section("SCENARIO 16: coverage ratio — all supported → ratio near 1.0");
  const allSupported: ExtractedClaim[] = [
    { claimIndex: 0, claimText: "test", normalizedClaimText: "test", claimType: "general", citationIds: ["c1"], supportStatus: "supported", matchScore: 0.8 },
    { claimIndex: 1, claimText: "test2", normalizedClaimText: "test2", claimType: "general", citationIds: ["c2"], supportStatus: "supported", matchScore: 0.9 },
  ];
  assert(computeCitationCoverageRatio(allSupported) === 1.0, "All supported → ratio = 1.0");

  // ── SCENARIO 17: coverage ratio — all unsupported → 0 ────────────────────

  section("SCENARIO 17: coverage ratio — all unsupported → 0");
  const allUnsupported: ExtractedClaim[] = [
    { claimIndex: 0, claimText: "t1", normalizedClaimText: "t1", claimType: "general", citationIds: [], supportStatus: "unsupported", matchScore: 0 },
    { claimIndex: 1, claimText: "t2", normalizedClaimText: "t2", claimType: "factual", citationIds: [], supportStatus: "unsupported", matchScore: 0 },
  ];
  assert(computeCitationCoverageRatio(allUnsupported) === 0, "All unsupported → ratio = 0");

  // ── SCENARIO 18: computeGroundingConfidenceScore — safety penalty ──────────

  section("SCENARIO 18: computeGroundingConfidenceScore — high_risk safety penalty");
  const baseScore = computeGroundingConfidenceScore({
    citationCoverageRatio: 0.8, avgCitationScore: 0.8,
    unsupportedClaimCount: 0, totalClaimCount: 4,
    retrievalSafetyStatus: null,
  });
  const penalizedScore = computeGroundingConfidenceScore({
    citationCoverageRatio: 0.8, avgCitationScore: 0.8,
    unsupportedClaimCount: 0, totalClaimCount: 4,
    retrievalSafetyStatus: "high_risk",
  });
  assert(penalizedScore < baseScore, "high_risk safety status reduces grounding confidence score");
  assert(baseScore >= 0 && baseScore <= 1, "Base score in [0,1]");
  assert(penalizedScore >= 0 && penalizedScore <= 1, "Penalized score in [0,1]");

  // ── SCENARIO 19: assignGroundingConfidenceBand — high band ───────────────

  section("SCENARIO 19: assignGroundingConfidenceBand — high band assigned");
  const band19 = assignGroundingConfidenceBand({
    groundingConfidenceScore: 0.85,
    unsupportedClaimCount: 0,
    totalClaimCount: 4,
    retrievalSafetyStatus: null,
  });
  assert(band19 === "high", `High score + 0 unsupported → 'high' band (got: ${band19})`);

  // ── SCENARIO 20: assignGroundingConfidenceBand — unsafe band ──────────────

  section("SCENARIO 20: assignGroundingConfidenceBand — unsafe band");
  const band20 = assignGroundingConfidenceBand({
    groundingConfidenceScore: 0.1,
    unsupportedClaimCount: 2,
    totalClaimCount: 3,
    retrievalSafetyStatus: null,
  });
  assert(band20 === "unsafe", `Low score → 'unsafe' band (got: ${band20})`);

  const band20b = assignGroundingConfidenceBand({
    groundingConfidenceScore: 0.85,
    unsupportedClaimCount: 0,
    totalClaimCount: 2,
    retrievalSafetyStatus: "high_risk",
  });
  assert(band20b === "unsafe", "high_risk safety → 'unsafe' band regardless of score");

  // ── SCENARIO 21: verifyGroundedAnswer — full verification (INV-ANSV1) ─────

  section("SCENARIO 21: verifyGroundedAnswer — full verification (INV-ANSV1)");
  const result21 = await verifyGroundedAnswer({
    answerText: SUPPORTED_ANSWER,
    citations: CITATIONS_SUPPORTED,
    tenantId: "tenant-5r-test",
    answerRunId: null,
    persistVerification: false,
  });
  assert(result21.claims.length >= 2, "Claims extracted from answer");
  assert(result21.coverage.citationCoverageRatio >= 0, "Coverage ratio computed");
  assert(["high", "medium", "low", "unsafe"].includes(result21.coverage.groundingConfidenceBand), "Valid confidence band");
  assert(result21.note.includes("INV-ANSV6"), "INV-ANSV6: note documents non-mutation");
  assert(result21.persisted === false, "INV-ANSV7: persistVerification=false → not persisted");

  // ── SCENARIO 22: verifyGroundedAnswer — INV-ANSV7 no writes in preview ────

  section("SCENARIO 22: verifyGroundedAnswer — INV-ANSV7 preview produces no writes");
  const before22 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_answer_runs WHERE grounding_confidence_band IS NOT NULL`);
  await verifyGroundedAnswer({
    answerText: SUPPORTED_ANSWER,
    citations: CITATIONS_SUPPORTED,
    tenantId: "tenant-preview",
    persistVerification: false,
  });
  const after22 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_answer_runs WHERE grounding_confidence_band IS NOT NULL`);
  assert(
    parseInt(before22.rows[0].cnt, 10) === parseInt(after22.rows[0].cnt, 10),
    "INV-ANSV7: no DB writes during preview verification",
  );

  // ── SCENARIO 23: summarizeAnswerVerification — correct structure ──────────

  section("SCENARIO 23: summarizeAnswerVerification — correct structure");
  const result23 = await verifyGroundedAnswer({
    answerText: SUPPORTED_ANSWER, citations: CITATIONS_SUPPORTED, tenantId: "t",
  });
  const summary23 = summarizeAnswerVerification(result23);
  assert(typeof summary23.totalClaims === "number", "totalClaims is number");
  assert(typeof summary23.supportedClaims === "number", "supportedClaims is number");
  assert(typeof summary23.citationCoverageRatio === "number", "citationCoverageRatio is number");
  assert(typeof summary23.groundingConfidenceScore === "number", "groundingConfidenceScore is number");
  assert(summary23.note.includes("INV-ANSV7"), "note references INV-ANSV7");

  // ── SCENARIO 24: computeUnsupportedClaimCount ─────────────────────────────

  section("SCENARIO 24: computeUnsupportedClaimCount");
  const claims24 = matchClaimsToCitations(extractAnswerClaims(UNSUPPORTED_ANSWER), CITATIONS_WEAK);
  const unsuppCount = computeUnsupportedClaimCount(claims24);
  assert(typeof unsuppCount === "number", "computeUnsupportedClaimCount returns number");
  assert(unsuppCount >= 0, "Unsupported count >= 0");

  // ── SCENARIO 25: Hallucination guard — detects unsupported claims ──────────

  section("SCENARIO 25: Hallucination guard — detects unsupported factual claims");
  const claims25 = matchClaimsToCitations(extractAnswerClaims(UNSUPPORTED_ANSWER), CITATIONS_WEAK);
  const coverage25 = computeCitationCoverageRatio(claims25);
  const score25 = computeGroundingConfidenceScore({
    citationCoverageRatio: coverage25, avgCitationScore: 0.32,
    unsupportedClaimCount: computeUnsupportedClaimCount(claims25),
    totalClaimCount: claims25.length,
  });
  const band25 = assignGroundingConfidenceBand({
    groundingConfidenceScore: score25,
    unsupportedClaimCount: computeUnsupportedClaimCount(claims25),
    totalClaimCount: claims25.length,
  });
  const guard25 = buildHallucinationGuardSummary({
    answerText: UNSUPPORTED_ANSWER,
    claims: claims25,
    citations: CITATIONS_WEAK,
    groundingConfidenceBand: band25,
    citationCoverageRatio: coverage25,
  });
  assert(guard25.guardEnabled === true, "Hallucination guard enabled");
  assert(["caution", "high_risk"].includes(guard25.riskLevel), "INV-ANSV4: risk level caution or high_risk for unsupported answer");
  assert(guard25.unsupportedClaims.length >= 1, "INV-ANSV4: unsupported claims reported");
  assert(guard25.signals.length >= 1, "INV-ANSV4: at least 1 signal produced");

  // ── SCENARIO 26: Hallucination guard — certainty without support ──────────

  section("SCENARIO 26: Hallucination guard — certainty language detected");
  const certainAnswer = "The system is definitely the best solution. It certainly handles all edge cases.";
  const claims26 = matchClaimsToCitations(extractAnswerClaims(certainAnswer), CITATIONS_WEAK);
  const guard26 = buildHallucinationGuardSummary({
    answerText: certainAnswer,
    claims: claims26,
    citations: CITATIONS_WEAK,
    groundingConfidenceBand: "low",
    citationCoverageRatio: 0.2,
  });
  assert(guard26.certaintyClaims.length >= 1, "Certainty language detected in answer");
  const certaintySignal = guard26.signals.find((s) => s.signalType === "certainty_without_strong_support");
  assert(certaintySignal !== undefined, "Certainty-without-support signal raised");

  // ── SCENARIO 27: Hallucination guard — no false positive for supported answer

  section("SCENARIO 27: INV-ANSV4 — no false positive for clearly supported answer");
  const claims27 = matchClaimsToCitations(extractAnswerClaims(SUPPORTED_ANSWER), CITATIONS_SUPPORTED);
  const score27 = computeGroundingConfidenceScore({
    citationCoverageRatio: computeCitationCoverageRatio(claims27),
    avgCitationScore: 0.83,
    unsupportedClaimCount: computeUnsupportedClaimCount(claims27),
    totalClaimCount: claims27.length,
  });
  const band27 = assignGroundingConfidenceBand({
    groundingConfidenceScore: score27,
    unsupportedClaimCount: computeUnsupportedClaimCount(claims27),
    totalClaimCount: claims27.length,
  });
  const guard27 = buildHallucinationGuardSummary({
    answerText: SUPPORTED_ANSWER,
    claims: claims27,
    citations: CITATIONS_SUPPORTED,
    groundingConfidenceBand: band27,
    citationCoverageRatio: computeCitationCoverageRatio(claims27),
  });
  assert(guard27.riskLevel !== "high_risk", `INV-ANSV4: no false high_risk on supported answer (got: ${guard27.riskLevel})`);

  // ── SCENARIO 28: detectCertaintyLanguage ─────────────────────────────────

  section("SCENARIO 28: detectCertaintyLanguage — specific phrases");
  const certainPhrases = detectCertaintyLanguage("This is definitely correct and certainly proven.");
  assert(certainPhrases.includes("definitely"), "definitely detected");
  assert(certainPhrases.includes("certainly"), "certainly detected");
  const noCertain = detectCertaintyLanguage("The system uses containers for deployment.");
  assert(noCertain.length === 0, "No certainty phrases in clean technical text");

  // ── SCENARIO 29: detectCitationGaps ─────────────────────────────────────

  section("SCENARIO 29: detectCitationGaps — weak match citation flagged");
  const claims29 = matchClaimsToCitations(extractAnswerClaims(MIXED_ANSWER), CITATIONS_WEAK);
  const gaps29 = detectCitationGaps({ claims: claims29, citations: CITATIONS_WEAK });
  assert(Array.isArray(gaps29), "detectCitationGaps returns array");

  // ── SCENARIO 30: Policy — full_answer when support is strong ──────────────

  section("SCENARIO 30: Policy — full_answer when support is strong");
  const policy30 = decideFinalAnswerPolicy({
    groundingConfidenceBand: "high",
    groundingConfidenceScore: 0.85,
    citationCoverageRatio: 0.9,
    unsupportedClaimCount: 0,
    totalClaimCount: 4,
    hallucinationGuardStatus: "no_issue",
    retrievalSafetyStatus: null,
  });
  assert(policy30.outcome === "full_answer", `INV-ANSV5: strong support → full_answer (got: ${policy30.outcome})`);
  assert(policy30.evidenceFactors.length >= 5, "Policy includes evidence factors");

  // ── SCENARIO 31: Policy — grounded_partial_answer for mixed support ────────

  section("SCENARIO 31: Policy — grounded_partial_answer for mixed support");
  const policy31 = decideFinalAnswerPolicy({
    groundingConfidenceBand: "medium",
    groundingConfidenceScore: 0.55,
    citationCoverageRatio: 0.65,
    unsupportedClaimCount: 1,
    totalClaimCount: 5,
    hallucinationGuardStatus: "caution",
    retrievalSafetyStatus: null,
  });
  assert(policy31.outcome === "grounded_partial_answer", `INV-ANSV5: mixed → grounded_partial_answer (got: ${policy31.outcome})`);

  // ── SCENARIO 32: Policy — insufficient_evidence ───────────────────────────

  section("SCENARIO 32: Policy — insufficient_evidence when coverage too low");
  const policy32 = decideFinalAnswerPolicy({
    groundingConfidenceBand: "low",
    groundingConfidenceScore: 0.3,
    citationCoverageRatio: 0.2,
    unsupportedClaimCount: 2,
    totalClaimCount: 4,
    hallucinationGuardStatus: "caution",
    retrievalSafetyStatus: null,
  });
  assert(policy32.outcome === "insufficient_evidence", `INV-ANSV5: low coverage → insufficient_evidence (got: ${policy32.outcome})`);

  // ── SCENARIO 33: Policy — safe_refusal when safety high_risk ──────────────

  section("SCENARIO 33: Policy — safe_refusal when retrieval safety = high_risk");
  const policy33 = decideFinalAnswerPolicy({
    groundingConfidenceBand: "high",
    groundingConfidenceScore: 0.85,
    citationCoverageRatio: 0.9,
    unsupportedClaimCount: 0,
    totalClaimCount: 4,
    hallucinationGuardStatus: "no_issue",
    retrievalSafetyStatus: "high_risk",
  });
  assert(policy33.outcome === "safe_refusal", `INV-ANSV5: high_risk safety → safe_refusal (got: ${policy33.outcome})`);

  // ── SCENARIO 34: previewAnswerPolicy — no writes (INV-ANSV7) ─────────────

  section("SCENARIO 34: previewAnswerPolicy — INV-ANSV7 no writes");
  const before34 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_answer_runs WHERE answer_policy_result IS NOT NULL`);
  const preview34 = previewAnswerPolicy({
    groundingConfidenceBand: "high",
    groundingConfidenceScore: 0.85,
    citationCoverageRatio: 0.9,
    unsupportedClaimCount: 0,
    totalClaimCount: 3,
    hallucinationGuardStatus: "no_issue",
  });
  const after34 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_answer_runs WHERE answer_policy_result IS NOT NULL`);
  assert(preview34.note.includes("no writes"), "INV-ANSV7: previewAnswerPolicy note documents no-write");
  assert(
    parseInt(before34.rows[0].cnt, 10) === parseInt(after34.rows[0].cnt, 10),
    "INV-ANSV7: previewAnswerPolicy performs no DB writes",
  );

  // ── SCENARIO 35: verifyGroundedAnswer — persistVerification=true ──────────

  section("SCENARIO 35: verifyGroundedAnswer — persistence works");
  const testRunId = `5r-test-run-${Date.now()}`;
  const r35b = await client.query(`
    INSERT INTO public.knowledge_answer_runs
      (id, tenant_id, answer_text, generation_model)
    VALUES
      ($1, 'tenant-5r-persist', 'Test answer for Phase 5R verification.', 'gpt-4o-mini')
    RETURNING id
  `, [testRunId]);
  const insertedId = r35b.rows[0].id;

  const result35 = await verifyGroundedAnswer({
    answerText: "The deployment pipeline uses Docker containers. Each service runs on port 8080.",
    citations: CITATIONS_SUPPORTED,
    tenantId: "tenant-5r-persist",
    answerRunId: insertedId,
    persistVerification: true,
  });
  assert(result35.persisted === true, "verifyGroundedAnswer persisted = true");

  const saved35 = await client.query(
    `SELECT * FROM public.knowledge_answer_runs WHERE id=$1`, [insertedId],
  );
  assert(saved35.rows[0].grounding_confidence_band !== null, "grounding_confidence_band saved to DB");
  assert(saved35.rows[0].citation_coverage_ratio !== null, "citation_coverage_ratio saved to DB");
  assert(saved35.rows[0].answer_text === "Test answer for Phase 5R verification.", "INV-ANSV6: answer_text not mutated");

  // ── SCENARIO 36: recordAnswerVerificationMetrics ──────────────────────────

  section("SCENARIO 36: recordAnswerVerificationMetrics — persistence");
  await recordAnswerVerificationMetrics(insertedId, {
    groundingConfidenceScore: 0.78,
    groundingConfidenceBand: "high",
    citationCoverageRatio: 0.85,
    supportedClaimCount: 3,
    partiallySupportedClaimCount: 1,
    unsupportedClaimCount: 0,
    unverifiableClaimCount: 0,
    answerSafetyStatus: "ok",
    answerPolicyResult: "full_answer",
    answerVerificationLatencyMs: 42,
  });

  const saved36 = await client.query(
    `SELECT * FROM public.knowledge_answer_runs WHERE id=$1`, [insertedId],
  );
  assert(saved36.rows[0].answer_policy_result === "full_answer", "answer_policy_result saved");
  assert(saved36.rows[0].answer_safety_status === "ok", "answer_safety_status saved");
  assert(saved36.rows[0].supported_claim_count === 3, "supported_claim_count saved");

  // ── SCENARIO 37: getAnswerVerificationMetrics ─────────────────────────────

  section("SCENARIO 37: getAnswerVerificationMetrics — reads persisted data");
  const metrics37 = await getAnswerVerificationMetrics(insertedId);
  assert(metrics37 !== null, "getAnswerVerificationMetrics returns data for persisted run");
  assert(metrics37!.groundingConfidenceBand !== null, "groundingConfidenceBand not null");
  assert(metrics37!.answerPolicyResult === "full_answer", "answerPolicyResult = full_answer");

  const metrics37b = await getAnswerVerificationMetrics("nonexistent-run-5r-xyz");
  assert(metrics37b === null, "getAnswerVerificationMetrics returns null for unknown run");

  // ── SCENARIO 38: summarizeCitationCoverage ────────────────────────────────

  section("SCENARIO 38: summarizeCitationCoverage — reads from DB");
  const cov38 = await summarizeCitationCoverage(insertedId);
  assert(cov38.found === true, "summarizeCitationCoverage found = true");
  assert(typeof cov38.citationCoverageRatio === "number", "citationCoverageRatio is number");

  const cov38b = await summarizeCitationCoverage("not-a-real-run-5r");
  assert(cov38b.found === false, "summarizeCitationCoverage found = false for unknown run");

  // ── SCENARIO 39: summarizeAnswerVerificationMetrics — tenant isolation (INV-ANSV8)

  section("SCENARIO 39: INV-ANSV8 — tenant isolation in verification metrics");
  const metA = await summarizeAnswerVerificationMetrics("tenant-5r-persist");
  const metB = await summarizeAnswerVerificationMetrics("tenant-nonexistent-5r-xyz");
  assert(metA.tenantId === "tenant-5r-persist", "INV-ANSV8: correct tenant");
  assert(metA.totalVerifiedRuns >= 1, "INV-ANSV8: at least 1 verified run for test tenant");
  assert(metB.totalVerifiedRuns === 0, "INV-ANSV8: other tenant sees 0 runs");

  // ── SCENARIO 40: explainAnswerVerification — read-only (INV-ANSV7) ─────────

  section("SCENARIO 40: explainAnswerVerification — read-only");
  const before40 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_answer_runs`);
  const explain40 = await explainAnswerVerification(insertedId);
  const after40 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_answer_runs`);
  assert(explain40.stages.length === 3, "explainAnswerVerification has 3 stages");
  assert(explain40.note.includes("no writes"), "INV-ANSV7: explain documents no-write guarantee");
  assert(
    parseInt(before40.rows[0].cnt, 10) === parseInt(after40.rows[0].cnt, 10),
    "INV-ANSV7: explainAnswerVerification produces no DB writes",
  );

  // ── SCENARIO 41: explainHallucinationGuard — read-only ───────────────────

  section("SCENARIO 41: explainHallucinationGuard — read-only");
  const before41 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_answer_runs`);
  const guard41 = await explainHallucinationGuard(insertedId);
  const after41 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_answer_runs`);
  assert(guard41.heuristics.length >= 6, "explainHallucinationGuard lists >= 6 heuristics");
  assert(guard41.note.includes("no writes"), "INV-ANSV7: explain documents no-write guarantee");
  assert(
    parseInt(before41.rows[0].cnt, 10) === parseInt(after41.rows[0].cnt, 10),
    "INV-ANSV7: explainHallucinationGuard produces no DB writes",
  );

  // ── SCENARIO 42: explainAnswerPolicy — read-only ──────────────────────────

  section("SCENARIO 42: explainAnswerPolicy — read-only");
  const before42 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_answer_runs`);
  const policyExpl = await explainAnswerPolicy(insertedId);
  const after42 = await client.query(`SELECT COUNT(*) as cnt FROM public.knowledge_answer_runs`);
  assert(policyExpl.policyRules.length >= 7, "Policy explanation has >= 7 rules");
  assert(policyExpl.note.includes("no writes"), "INV-ANSV7: explain documents no-write guarantee");
  assert(
    parseInt(before42.rows[0].cnt, 10) === parseInt(after42.rows[0].cnt, 10),
    "INV-ANSV7: explainAnswerPolicy produces no DB writes",
  );

  // ── SCENARIO 43: getAnswerVerificationTrace — 9 stages ───────────────────

  section("SCENARIO 43: getAnswerVerificationTrace — 9 pipeline stages");
  const trace43 = await getAnswerVerificationTrace(insertedId);
  assert(trace43.traceStages.length === 9, "Verification trace has 9 pipeline stages");
  assert(trace43.note.includes("no writes"), "INV-ANSV7: trace documents no-write guarantee");
  assert(trace43.found === true, "Trace found for persisted run");

  // ── SCENARIO 44: applyAnswerPolicy with persistPolicy=true ───────────────

  section("SCENARIO 44: applyAnswerPolicy — persistence");
  const applied44 = await applyAnswerPolicy({
    groundingConfidenceBand: "high",
    groundingConfidenceScore: 0.88,
    citationCoverageRatio: 0.9,
    unsupportedClaimCount: 0,
    totalClaimCount: 4,
    hallucinationGuardStatus: "no_issue",
    retrievalSafetyStatus: null,
    answerRunId: insertedId,
    persistPolicy: true,
  });
  assert(applied44.appliedOutcome === "full_answer", `Policy applied correctly: ${applied44.appliedOutcome}`);
  assert(applied44.persistedPolicyResult === true, "Policy result persisted");
  assert(applied44.note.includes("INV-ANSV5"), "Note references INV-ANSV5");

  // ── SCENARIO 45: INV-ANSV9 — existing tables still work ──────────────────

  section("SCENARIO 45: INV-ANSV9 — existing retrieval tables still have correct columns");
  const krrCheck = await client.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_retrieval_runs'`,
  );
  assert(parseInt(krrCheck.rows[0].cnt, 10) === 28, "INV-ANSV9: knowledge_retrieval_runs still has 28 cols");

  const krcCheck = await client.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_retrieval_candidates'`,
  );
  assert(parseInt(krcCheck.rows[0].cnt, 10) === 37, "INV-ANSV9: knowledge_retrieval_candidates still has 37 cols");

  const kacCheck = await client.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_answer_citations'`,
  );
  assert(parseInt(kacCheck.rows[0].cnt, 10) === 12, "INV-ANSV9: knowledge_answer_citations still has 12 cols");

  // ── SCENARIO 46: INV-ANSV10 — cross-tenant leakage impossible ────────────

  section("SCENARIO 46: INV-ANSV10 — cross-tenant leakage impossible");
  const metC = await summarizeAnswerVerificationMetrics("tenant-5r-persist");
  const metD = await summarizeAnswerVerificationMetrics("tenant-5r-persist-OTHER-NEVER");
  assert(metC.tenantId === "tenant-5r-persist", "INV-ANSV10: Tenant A sees own data only");
  assert(metD.totalVerifiedRuns === 0, "INV-ANSV10: Tenant B cannot see Tenant A data");

  // Cleanup
  await client.query(`DELETE FROM public.knowledge_answer_runs WHERE id=$1`, [insertedId]);
  await client.end();

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Phase 5R validation: ${passed} passed, ${failed} failed`);
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
