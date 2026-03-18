/**
 * answer-verification.ts — Phase 5R
 *
 * Answer verification layer: claim extraction, citation matching, coverage scoring.
 *
 * Pipeline position:
 *   answer generation → citation extraction → [answer-verification] → policy engine
 *
 * Design invariants:
 *   INV-ANSV1  Verification operates only on real answer + citation + context data
 *   INV-ANSV2  Claims never marked supported without evidence
 *   INV-ANSV3  Citation coverage scoring is deterministic
 *   INV-ANSV6  Original answer text / historical citations never mutated
 *   INV-ANSV7  Preview endpoints perform no writes
 *   INV-ANSV8  Verification metrics are tenant-isolated
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { knowledgeAnswerRuns } from "@shared/schema";
import {
  QUALITY_SIGNAL_HIGH_CONFIDENCE_THRESHOLD,
  QUALITY_SIGNAL_MEDIUM_CONFIDENCE_THRESHOLD,
} from "../config/retrieval-config";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ClaimSupportStatus = "supported" | "partially_supported" | "unsupported" | "unverifiable";
export type ClaimType = "factual" | "general" | "connective";
export type GroundingConfidenceBand = "high" | "medium" | "low" | "unsafe";

export interface ExtractedClaim {
  claimIndex: number;
  claimText: string;
  normalizedClaimText: string;
  claimType: ClaimType;
  citationIds: string[];
  supportStatus: ClaimSupportStatus;
  matchScore: number;
}

export interface CitationInput {
  citationId: string;
  chunkId: string;
  chunkTextPreview: string;
  finalScore?: number | string | null;
  contextPosition?: number | null;
}

export interface VerificationParams {
  answerText: string;
  citations: CitationInput[];
  contextChunks?: Array<{ chunkId: string; chunkText: string; score?: number }>;
  retrievalConfidenceBand?: string | null;
  retrievalSafetyStatus?: string | null;
  tenantId?: string;
  answerRunId?: string | null;
  persistVerification?: boolean;
}

export interface CitationCoverageMetrics {
  totalClaimCount: number;
  supportedClaimCount: number;
  partiallySupportedClaimCount: number;
  unsupportedClaimCount: number;
  unverifiableClaimCount: number;
  citationCoverageRatio: number;
  groundingConfidenceScore: number;
  groundingConfidenceBand: GroundingConfidenceBand;
}

export interface AnswerVerificationResult {
  answerRunId: string | null;
  tenantId: string;
  claims: ExtractedClaim[];
  coverage: CitationCoverageMetrics;
  verificationLatencyMs: number;
  persisted: boolean;
  note: string;
}

export interface AnswerVerificationMetricsRecord {
  groundingConfidenceScore: number;
  groundingConfidenceBand: GroundingConfidenceBand;
  citationCoverageRatio: number;
  supportedClaimCount: number;
  partiallySupportedClaimCount: number;
  unsupportedClaimCount: number;
  unverifiableClaimCount: number;
  answerSafetyStatus?: string;
  answerPolicyResult?: string;
  answerVerificationLatencyMs: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CONNECTIVE_PHRASES = new Set([
  "in summary", "in conclusion", "furthermore", "additionally", "however",
  "therefore", "consequently", "as a result", "in contrast", "on the other hand",
  "in other words", "for example", "such as", "for instance", "in addition",
  "the above", "as mentioned", "the following", "as described",
]);

const FACTUAL_INDICATORS = /\b(\d{4}|\d+\.\d+|\d+%|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "must", "can", "could", "this", "that",
  "these", "those", "it", "its", "they", "their", "there", "here",
  "when", "where", "which", "who", "how", "what", "why", "and", "or",
  "but", "if", "then", "than", "so", "as", "at", "by", "for", "in",
  "of", "on", "to", "up", "with", "from", "into", "through", "during",
  "not", "no", "nor", "yet", "both", "either", "neither", "each",
  "few", "more", "most", "other", "some", "such", "only", "own", "same",
]);

// ── Claim extraction ──────────────────────────────────────────────────────────

/**
 * Normalize a claim: lowercase, trim, collapse whitespace, strip trailing punctuation.
 * INV-ANSV3: deterministic.
 */
export function normalizeAnswerClaim(claim: string): string {
  return claim
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?]+$/, "")
    .trim();
}

/**
 * Extract factual claims from answer text using deterministic sentence segmentation.
 * INV-ANSV3: deterministic — same input always produces same output.
 */
export function extractAnswerClaims(
  answerText: string,
): Array<Omit<ExtractedClaim, "citationIds" | "supportStatus" | "matchScore">> {
  if (!answerText || answerText.trim().length === 0) return [];

  const raw = answerText
    .replace(/\[C\d+\]/g, "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 15);

  const claims: Array<Omit<ExtractedClaim, "citationIds" | "supportStatus" | "matchScore">> = [];
  let idx = 0;

  for (const sentence of raw) {
    const normalized = normalizeAnswerClaim(sentence);
    if (normalized.length < 10) continue;

    const isConnective = Array.from(CONNECTIVE_PHRASES).some((phrase) => normalized.startsWith(phrase));
    const isFactual = !isConnective && FACTUAL_INDICATORS.test(sentence);
    const claimType: ClaimType = isConnective ? "connective" : isFactual ? "factual" : "general";

    claims.push({
      claimIndex: idx++,
      claimText: sentence,
      normalizedClaimText: normalized,
      claimType,
    });
  }

  return claims;
}

/**
 * Match extracted claims to citations using deterministic keyword overlap.
 * INV-ANSV2: claims never marked supported without evidence.
 */
export function matchClaimsToCitations(
  claims: Array<Omit<ExtractedClaim, "citationIds" | "supportStatus" | "matchScore">>,
  citations: CitationInput[],
  contextChunks?: Array<{ chunkId: string; chunkText: string }>,
): ExtractedClaim[] {
  return claims.map((claim) => {
    if (claim.claimType === "connective") {
      return { ...claim, citationIds: [], supportStatus: "unverifiable", matchScore: 0 };
    }

    const claimWords = new Set(
      claim.normalizedClaimText.split(/\s+/).filter((w) => w.length > 4 && !STOP_WORDS.has(w)),
    );

    if (claimWords.size === 0) {
      return { ...claim, citationIds: [], supportStatus: "unverifiable", matchScore: 0 };
    }

    const matchedCitationIds: string[] = [];
    let bestMatchRatio = 0;

    for (const citation of citations) {
      const citText = (citation.chunkTextPreview ?? "").toLowerCase();
      const ctx = contextChunks?.find((c) => c.chunkId === citation.chunkId);
      const extText = ctx ? ctx.chunkText.toLowerCase() : "";
      const combined = citText + " " + extText;

      let matchCount = 0;
      for (const word of claimWords) {
        if (combined.includes(word)) matchCount++;
      }

      const ratio = matchCount / claimWords.size;
      if (ratio > 0) {
        matchedCitationIds.push(citation.citationId);
        if (ratio > bestMatchRatio) bestMatchRatio = ratio;
      }
    }

    let supportStatus: ClaimSupportStatus;
    if (matchedCitationIds.length === 0) {
      supportStatus = "unsupported";
    } else if (bestMatchRatio >= 0.5) {
      supportStatus = "supported";
    } else {
      supportStatus = "partially_supported";
    }

    return { ...claim, citationIds: matchedCitationIds, supportStatus, matchScore: bestMatchRatio };
  });
}

// ── Coverage scoring ──────────────────────────────────────────────────────────

/**
 * Compute citation coverage ratio from matched claims.
 * INV-ANSV3: deterministic.
 */
export function computeCitationCoverageRatio(claims: ExtractedClaim[]): number {
  if (claims.length === 0) return 0;
  const verifiable = claims.filter((c) => c.claimType !== "connective");
  if (verifiable.length === 0) return 1;

  const supported = verifiable.filter((c) => c.supportStatus === "supported").length;
  const partial = verifiable.filter((c) => c.supportStatus === "partially_supported").length;
  return Math.min(1, (supported + partial * 0.5) / verifiable.length);
}

/**
 * Compute grounding confidence score.
 * INV-ANSV3: deterministic.
 */
export function computeGroundingConfidenceScore(params: {
  citationCoverageRatio: number;
  avgCitationScore: number;
  unsupportedClaimCount: number;
  totalClaimCount: number;
  retrievalSafetyStatus?: string | null;
}): number {
  const { citationCoverageRatio, avgCitationScore, unsupportedClaimCount, totalClaimCount, retrievalSafetyStatus } = params;
  let score = citationCoverageRatio * 0.6 + avgCitationScore * 0.4;

  if (totalClaimCount > 0) {
    const unsupportedRatio = unsupportedClaimCount / totalClaimCount;
    score *= Math.max(0, 1 - unsupportedRatio);
  }

  if (retrievalSafetyStatus === "high_risk") score *= 0.3;
  else if (retrievalSafetyStatus === "suspicious") score *= 0.7;

  return Math.max(0, Math.min(1, score));
}

/**
 * Assign grounding confidence band from score.
 * INV-ANSV3: deterministic.
 */
export function assignGroundingConfidenceBand(params: {
  groundingConfidenceScore: number;
  unsupportedClaimCount: number;
  totalClaimCount: number;
  retrievalSafetyStatus?: string | null;
}): GroundingConfidenceBand {
  const { groundingConfidenceScore, unsupportedClaimCount, totalClaimCount, retrievalSafetyStatus } = params;

  if (retrievalSafetyStatus === "high_risk" || groundingConfidenceScore < 0.2) return "unsafe";

  const unsupportedRatio = totalClaimCount > 0 ? unsupportedClaimCount / totalClaimCount : 0;

  if (groundingConfidenceScore >= QUALITY_SIGNAL_HIGH_CONFIDENCE_THRESHOLD && unsupportedRatio === 0) return "high";
  if (groundingConfidenceScore >= QUALITY_SIGNAL_MEDIUM_CONFIDENCE_THRESHOLD && unsupportedRatio <= 0.25) return "medium";
  if (groundingConfidenceScore >= 0.2 && unsupportedRatio <= 0.5) return "low";
  return "unsafe";
}

// ── Avg citation score helper ─────────────────────────────────────────────────

function avgCitationScoreFromInputs(citations: CitationInput[]): number {
  if (citations.length === 0) return 0;
  const total = citations.reduce((sum, c) => {
    const v = typeof c.finalScore === "number" ? c.finalScore : parseFloat(String(c.finalScore ?? "0")) || 0;
    return sum + v;
  }, 0);
  return total / citations.length;
}

// ── Main verification entry point ─────────────────────────────────────────────

/**
 * Verify a grounded answer against its citations and context.
 * INV-ANSV1: operates on real data only.
 * INV-ANSV6: does not mutate original answer / citations.
 */
export async function verifyGroundedAnswer(params: VerificationParams): Promise<AnswerVerificationResult> {
  const t0 = Date.now();
  const {
    answerText, citations, contextChunks,
    retrievalSafetyStatus, tenantId = "unknown",
    answerRunId = null, persistVerification = false,
  } = params;

  const rawClaims = extractAnswerClaims(answerText);
  const matchedClaims = matchClaimsToCitations(rawClaims, citations, contextChunks);

  const coverageRatio = computeCitationCoverageRatio(matchedClaims);
  const supportedCount = matchedClaims.filter((c) => c.supportStatus === "supported").length;
  const partialCount = matchedClaims.filter((c) => c.supportStatus === "partially_supported").length;
  const unsupportedCount = matchedClaims.filter((c) => c.supportStatus === "unsupported").length;
  const unverifiableCount = matchedClaims.filter((c) => c.supportStatus === "unverifiable").length;

  const avgScore = avgCitationScoreFromInputs(citations);
  const groundingConfidenceScore = computeGroundingConfidenceScore({
    citationCoverageRatio: coverageRatio,
    avgCitationScore: avgScore,
    unsupportedClaimCount: unsupportedCount,
    totalClaimCount: matchedClaims.length,
    retrievalSafetyStatus,
  });
  const groundingConfidenceBand = assignGroundingConfidenceBand({
    groundingConfidenceScore,
    unsupportedClaimCount: unsupportedCount,
    totalClaimCount: matchedClaims.length,
    retrievalSafetyStatus,
  });

  const coverage: CitationCoverageMetrics = {
    totalClaimCount: matchedClaims.length,
    supportedClaimCount: supportedCount,
    partiallySupportedClaimCount: partialCount,
    unsupportedClaimCount: unsupportedCount,
    unverifiableClaimCount: unverifiableCount,
    citationCoverageRatio: coverageRatio,
    groundingConfidenceScore,
    groundingConfidenceBand,
  };

  const verificationLatencyMs = Date.now() - t0;

  let persisted = false;
  if (persistVerification && answerRunId) {
    try {
      await db.update(knowledgeAnswerRuns).set({
        groundingConfidenceScore: groundingConfidenceScore.toFixed(6),
        groundingConfidenceBand,
        citationCoverageRatio: coverageRatio.toFixed(6),
        supportedClaimCount: supportedCount,
        partiallySupportedClaimCount: partialCount,
        unsupportedClaimCount: unsupportedCount,
        unverifiableClaimCount: unverifiableCount,
        answerVerificationLatencyMs: verificationLatencyMs,
      }).where(eq(knowledgeAnswerRuns.id, answerRunId));
      persisted = true;
    } catch {
      persisted = false;
    }
  }

  return {
    answerRunId, tenantId, claims: matchedClaims, coverage,
    verificationLatencyMs, persisted,
    note: "INV-ANSV6: original answer_text and citations not mutated. INV-ANSV7: preview performs no writes.",
  };
}

// ── Summary / explain ─────────────────────────────────────────────────────────

/**
 * Summarize verification result.
 * INV-ANSV7: no writes.
 */
export function summarizeAnswerVerification(result: AnswerVerificationResult): {
  answerRunId: string | null;
  totalClaims: number;
  supportedClaims: number;
  unsupportedClaims: number;
  citationCoverageRatio: number;
  groundingConfidenceBand: GroundingConfidenceBand;
  groundingConfidenceScore: number;
  latencyMs: number;
  note: string;
} {
  return {
    answerRunId: result.answerRunId,
    totalClaims: result.coverage.totalClaimCount,
    supportedClaims: result.coverage.supportedClaimCount,
    unsupportedClaims: result.coverage.unsupportedClaimCount,
    citationCoverageRatio: result.coverage.citationCoverageRatio,
    groundingConfidenceBand: result.coverage.groundingConfidenceBand,
    groundingConfidenceScore: result.coverage.groundingConfidenceScore,
    latencyMs: result.verificationLatencyMs,
    note: "INV-ANSV7: no writes. INV-ANSV3: deterministic.",
  };
}

/**
 * Preview extracted claims — no writes (INV-ANSV7).
 */
export function previewExtractedClaims(answerText: string): {
  claims: Array<Omit<ExtractedClaim, "citationIds" | "supportStatus" | "matchScore">>;
  claimCount: number;
  note: string;
} {
  const claims = extractAnswerClaims(answerText);
  return {
    claims, claimCount: claims.length,
    note: "INV-ANSV7: no writes performed. INV-ANSV3: deterministic extraction.",
  };
}

/**
 * Count unsupported claims.
 */
export function computeUnsupportedClaimCount(claims: ExtractedClaim[]): number {
  return claims.filter((c) => c.supportStatus === "unsupported").length;
}

/**
 * Explain answer verification for a run.
 * INV-ANSV7: no writes.
 */
export async function explainAnswerVerification(runId: string): Promise<{
  runId: string;
  stages: Array<{ stage: string; description: string; result: string | null }>;
  groundingConfidenceBand: string | null;
  citationCoverageRatio: string | null;
  unsupportedClaimCount: number | null;
  found: boolean;
  note: string;
}> {
  const rows = await db.select().from(knowledgeAnswerRuns).where(eq(knowledgeAnswerRuns.id, runId)).limit(1);
  const run = rows[0];

  return {
    runId,
    stages: [
      {
        stage: "claim_extraction",
        description: "Deterministic sentence segmentation to identify factual assertions",
        result: run ? `${run.supportedClaimCount ?? 0} supported, ${run.unsupportedClaimCount ?? 0} unsupported` : null,
      },
      {
        stage: "citation_matching",
        description: "Keyword overlap between claim text and citation previews",
        result: run ? `Coverage ratio: ${run.citationCoverageRatio ?? "not computed"}` : null,
      },
      {
        stage: "confidence_scoring",
        description: "Grounding confidence from coverage, citation scores, and safety status",
        result: run ? `Band: ${run.groundingConfidenceBand ?? "not computed"}, Score: ${run.groundingConfidenceScore ?? "not computed"}` : null,
      },
    ],
    groundingConfidenceBand: run?.groundingConfidenceBand ?? null,
    citationCoverageRatio: run?.citationCoverageRatio ? String(run.citationCoverageRatio) : null,
    unsupportedClaimCount: run?.unsupportedClaimCount ?? null,
    found: !!run,
    note: "INV-ANSV7: no writes performed. INV-ANSV3: deterministic.",
  };
}

/**
 * Summarize citation coverage for an answer run.
 * INV-ANSV7: no writes.
 */
export async function summarizeCitationCoverage(runId: string): Promise<{
  runId: string;
  found: boolean;
  citationCoverageRatio: number | null;
  supportedClaimCount: number | null;
  unsupportedClaimCount: number | null;
  groundingConfidenceBand: string | null;
  note: string;
}> {
  const rows = await db.select().from(knowledgeAnswerRuns).where(eq(knowledgeAnswerRuns.id, runId)).limit(1);
  const run = rows[0];
  return {
    runId, found: !!run,
    citationCoverageRatio: run?.citationCoverageRatio ? parseFloat(run.citationCoverageRatio) : null,
    supportedClaimCount: run?.supportedClaimCount ?? null,
    unsupportedClaimCount: run?.unsupportedClaimCount ?? null,
    groundingConfidenceBand: run?.groundingConfidenceBand ?? null,
    note: "INV-ANSV7: no writes performed.",
  };
}

/**
 * Tenant-level verification metrics.
 * INV-ANSV8: tenant-isolated.
 */
export async function summarizeAnswerVerificationMetrics(tenantId: string): Promise<{
  tenantId: string;
  totalVerifiedRuns: number;
  avgCitationCoverageRatio: number;
  avgGroundingConfidenceScore: number;
  highBandCount: number;
  mediumBandCount: number;
  lowBandCount: number;
  unsafeBandCount: number;
}> {
  const rows = await db.select().from(knowledgeAnswerRuns).where(eq(knowledgeAnswerRuns.tenantId, tenantId));
  const verified = rows.filter((r) => r.groundingConfidenceBand !== null);
  const avg = (vals: number[]) => vals.length === 0 ? 0 : vals.reduce((s, v) => s + v, 0) / vals.length;

  return {
    tenantId,
    totalVerifiedRuns: verified.length,
    avgCitationCoverageRatio: avg(verified.map((r) => r.citationCoverageRatio ? parseFloat(r.citationCoverageRatio) : 0)),
    avgGroundingConfidenceScore: avg(verified.map((r) => r.groundingConfidenceScore ? parseFloat(r.groundingConfidenceScore) : 0)),
    highBandCount: verified.filter((r) => r.groundingConfidenceBand === "high").length,
    mediumBandCount: verified.filter((r) => r.groundingConfidenceBand === "medium").length,
    lowBandCount: verified.filter((r) => r.groundingConfidenceBand === "low").length,
    unsafeBandCount: verified.filter((r) => r.groundingConfidenceBand === "unsafe").length,
  };
}

/**
 * Record answer verification metrics for a run.
 * INV-ANSV8: tenant-isolated via runId scope.
 */
export async function recordAnswerVerificationMetrics(
  runId: string,
  metrics: AnswerVerificationMetricsRecord,
): Promise<void> {
  await db.update(knowledgeAnswerRuns).set({
    groundingConfidenceScore: metrics.groundingConfidenceScore.toFixed(6),
    groundingConfidenceBand: metrics.groundingConfidenceBand,
    citationCoverageRatio: metrics.citationCoverageRatio.toFixed(6),
    supportedClaimCount: metrics.supportedClaimCount,
    partiallySupportedClaimCount: metrics.partiallySupportedClaimCount,
    unsupportedClaimCount: metrics.unsupportedClaimCount,
    unverifiableClaimCount: metrics.unverifiableClaimCount,
    answerSafetyStatus: metrics.answerSafetyStatus ?? null,
    answerPolicyResult: metrics.answerPolicyResult ?? null,
    answerVerificationLatencyMs: metrics.answerVerificationLatencyMs,
  }).where(eq(knowledgeAnswerRuns.id, runId));
}

/**
 * Get verification metrics for a run.
 * INV-ANSV7: no writes.
 */
export async function getAnswerVerificationMetrics(runId: string): Promise<{
  runId: string;
  groundingConfidenceBand: string | null;
  citationCoverageRatio: number | null;
  unsupportedClaimCount: number | null;
  answerPolicyResult: string | null;
  answerVerificationLatencyMs: number | null;
} | null> {
  const rows = await db.select().from(knowledgeAnswerRuns).where(eq(knowledgeAnswerRuns.id, runId)).limit(1);
  const run = rows[0];
  if (!run) return null;
  return {
    runId,
    groundingConfidenceBand: run.groundingConfidenceBand ?? null,
    citationCoverageRatio: run.citationCoverageRatio ? parseFloat(run.citationCoverageRatio) : null,
    unsupportedClaimCount: run.unsupportedClaimCount ?? null,
    answerPolicyResult: run.answerPolicyResult ?? null,
    answerVerificationLatencyMs: run.answerVerificationLatencyMs ?? null,
  };
}

/**
 * Extend answer trace with verification stages.
 * INV-ANSV7: no writes.
 */
export async function getAnswerVerificationTrace(runId: string): Promise<{
  runId: string;
  traceStages: Array<{ stage: string; status: string; detail: string | null }>;
  found: boolean;
  note: string;
}> {
  const rows = await db.select().from(knowledgeAnswerRuns).where(eq(knowledgeAnswerRuns.id, runId)).limit(1);
  const run = rows[0];

  return {
    runId,
    traceStages: [
      { stage: "query", status: "N/A", detail: "Query text not stored on answer run" },
      { stage: "retrieval", status: run ? "ok" : "not_found", detail: run ? `retrieval_run_id=${run.retrievalRunId}` : null },
      { stage: "rerank", status: run ? "ok" : "not_found", detail: run ? `latency=${run.rerankLatencyMs}ms, advanced=${run.advancedRerankUsed}` : null },
      { stage: "safety_review", status: run ? (run.retrievalSafetyStatus ?? "not_recorded") : "not_found", detail: null },
      { stage: "context_assembly", status: run ? "ok" : "not_found", detail: run ? `chunks=${run.contextChunkCount}` : null },
      { stage: "answer_generation", status: run ? "ok" : "not_found", detail: run ? `model=${run.generationModel}, latency=${run.generationLatencyMs}ms` : null },
      { stage: "citation_extraction", status: run ? "ok" : "not_found", detail: null },
      { stage: "answer_verification", status: run?.groundingConfidenceBand ? "ok" : "pending", detail: run ? `band=${run.groundingConfidenceBand}, coverage=${run.citationCoverageRatio}` : null },
      { stage: "final_answer_policy", status: run?.answerPolicyResult ? "ok" : "pending", detail: run?.answerPolicyResult ?? null },
    ],
    found: !!run,
    note: "INV-ANSV7: no writes performed. Extends 5P answer trace with verification stages.",
  };
}

/**
 * Explain verification stage for a run.
 * INV-ANSV7: no writes.
 */
export async function explainVerificationStage(runId: string): Promise<{
  runId: string;
  claimExtractionNote: string;
  citationMatchingNote: string;
  coverageScoringNote: string;
  policyNote: string;
  found: boolean;
}> {
  const rows = await db.select().from(knowledgeAnswerRuns).where(eq(knowledgeAnswerRuns.id, runId)).limit(1);
  const run = rows[0];

  return {
    runId,
    claimExtractionNote: "Deterministic sentence segmentation. Connective phrases → unverifiable. Factual indicators detect numbers/dates.",
    citationMatchingNote: "Keyword overlap (len>4, non-stop-word) between normalized claim text and citation previews + context chunks.",
    coverageScoringNote: "coverage = (supported + 0.5*partial) / verifiable. Confidence = 0.6*coverage + 0.4*avgScore * (1 - unsupportedRatio) * safetyMultiplier.",
    policyNote: run?.answerPolicyResult ? `Policy applied: ${run.answerPolicyResult}` : "Policy not yet applied",
    found: !!run,
  };
}
