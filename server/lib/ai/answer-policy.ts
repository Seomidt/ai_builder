/**
 * answer-policy.ts — Phase 5R
 *
 * Final answer policy engine.
 *
 * Pipeline position:
 *   answer verification → [answer-policy] → final answer delivery
 *
 * Design invariants:
 *   INV-ANSV5  Final answer policy is deterministic
 *   INV-ANSV7  Preview endpoints perform no writes
 *   INV-ANSV9  Existing behavior not broken
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { knowledgeAnswerRuns } from "@shared/schema";
import {
  ALLOW_PARTIAL_ANSWER_FALLBACK,
  ALLOW_INSUFFICIENT_EVIDENCE_FALLBACK,
  MINIMUM_CITATION_COVERAGE_RATIO,
  MAXIMUM_UNSUPPORTED_CLAIM_COUNT,
  MINIMUM_GROUNDING_CONFIDENCE_BAND,
} from "../config/retrieval-config";
import type { GroundingConfidenceBand } from "./answer-verification";
import type { HallucinationRiskLevel } from "./hallucination-guard";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AnswerPolicyOutcome =
  | "full_answer"
  | "grounded_partial_answer"
  | "insufficient_evidence"
  | "safe_refusal";

export interface AnswerPolicyParams {
  groundingConfidenceBand: GroundingConfidenceBand;
  groundingConfidenceScore: number;
  citationCoverageRatio: number;
  unsupportedClaimCount: number;
  totalClaimCount: number;
  hallucinationGuardStatus: HallucinationRiskLevel;
  retrievalConfidenceBand?: string | null;
  retrievalSafetyStatus?: string | null;
  answerRunId?: string | null;
}

export interface AnswerPolicyDecision {
  outcome: AnswerPolicyOutcome;
  reason: string;
  evidenceFactors: Array<{ factor: string; value: string | number; weight: string }>;
  allowPartialFallback: boolean;
  allowInsufficientFallback: boolean;
}

export interface FinalAnswerResult {
  answerRunId: string | null;
  policyDecision: AnswerPolicyDecision;
  appliedOutcome: AnswerPolicyOutcome;
  persistedPolicyResult: boolean;
  note: string;
}

// ── Confidence band ordering ──────────────────────────────────────────────────

const BAND_ORDER: Record<string, number> = {
  high: 3, medium: 2, low: 1, unsafe: 0, unknown: 0,
};

function bandMeetsMinimum(band: string | null | undefined, minimum: string): boolean {
  const bandVal = BAND_ORDER[band ?? "unknown"] ?? 0;
  const minVal = BAND_ORDER[minimum] ?? 0;
  return bandVal >= minVal;
}

// ── Core policy decision ──────────────────────────────────────────────────────

/**
 * Decide the final answer policy deterministically.
 * INV-ANSV5: same inputs always produce the same policy outcome.
 */
export function decideFinalAnswerPolicy(params: AnswerPolicyParams): AnswerPolicyDecision {
  const {
    groundingConfidenceBand,
    groundingConfidenceScore,
    citationCoverageRatio,
    unsupportedClaimCount,
    totalClaimCount,
    hallucinationGuardStatus,
    retrievalSafetyStatus,
  } = params;

  const evidenceFactors: AnswerPolicyDecision["evidenceFactors"] = [
    { factor: "groundingConfidenceBand", value: groundingConfidenceBand, weight: "primary" },
    { factor: "groundingConfidenceScore", value: groundingConfidenceScore.toFixed(3), weight: "primary" },
    { factor: "citationCoverageRatio", value: citationCoverageRatio.toFixed(3), weight: "primary" },
    { factor: "unsupportedClaimCount", value: unsupportedClaimCount, weight: "modifier" },
    { factor: "totalClaimCount", value: totalClaimCount, weight: "context" },
    { factor: "hallucinationGuardStatus", value: hallucinationGuardStatus, weight: "modifier" },
    { factor: "retrievalSafetyStatus", value: retrievalSafetyStatus ?? "not_recorded", weight: "modifier" },
    { factor: "minimumCoverageRatio", value: MINIMUM_CITATION_COVERAGE_RATIO, weight: "config" },
    { factor: "maximumUnsupportedClaims", value: MAXIMUM_UNSUPPORTED_CLAIM_COUNT, weight: "config" },
    { factor: "minimumGroundingConfidenceBand", value: MINIMUM_GROUNDING_CONFIDENCE_BAND, weight: "config" },
  ];

  // Rule 1: safe_refusal — hard stops
  if (retrievalSafetyStatus === "high_risk") {
    return {
      outcome: "safe_refusal",
      reason: "Retrieval context contains high-risk injection signals (INV-ANSV5: deterministic)",
      evidenceFactors,
      allowPartialFallback: false,
      allowInsufficientFallback: false,
    };
  }

  if (groundingConfidenceBand === "unsafe" && hallucinationGuardStatus === "high_risk") {
    return {
      outcome: "safe_refusal",
      reason: "Grounding band is 'unsafe' AND hallucination guard signals 'high_risk' (INV-ANSV5: deterministic)",
      evidenceFactors,
      allowPartialFallback: false,
      allowInsufficientFallback: false,
    };
  }

  if (!bandMeetsMinimum(groundingConfidenceBand, MINIMUM_GROUNDING_CONFIDENCE_BAND)) {
    return {
      outcome: "safe_refusal",
      reason: `Grounding confidence band '${groundingConfidenceBand}' is below minimum '${MINIMUM_GROUNDING_CONFIDENCE_BAND}'`,
      evidenceFactors,
      allowPartialFallback: false,
      allowInsufficientFallback: false,
    };
  }

  // Rule 2: full_answer — strong support
  if (
    groundingConfidenceBand === "high" &&
    citationCoverageRatio >= MINIMUM_CITATION_COVERAGE_RATIO &&
    unsupportedClaimCount === 0 &&
    hallucinationGuardStatus === "no_issue"
  ) {
    return {
      outcome: "full_answer",
      reason: "High grounding confidence, full citation coverage, no unsupported claims (INV-ANSV5: deterministic)",
      evidenceFactors,
      allowPartialFallback: ALLOW_PARTIAL_ANSWER_FALLBACK,
      allowInsufficientFallback: ALLOW_INSUFFICIENT_EVIDENCE_FALLBACK,
    };
  }

  // Rule 3: insufficient_evidence
  if (
    citationCoverageRatio < MINIMUM_CITATION_COVERAGE_RATIO &&
    (groundingConfidenceBand === "low" || groundingConfidenceBand === "unsafe")
  ) {
    return {
      outcome: "insufficient_evidence",
      reason: `Coverage ${(citationCoverageRatio * 100).toFixed(0)}% is below minimum ${(MINIMUM_CITATION_COVERAGE_RATIO * 100).toFixed(0)}% and grounding band is '${groundingConfidenceBand}'`,
      evidenceFactors,
      allowPartialFallback: ALLOW_PARTIAL_ANSWER_FALLBACK,
      allowInsufficientFallback: ALLOW_INSUFFICIENT_EVIDENCE_FALLBACK,
    };
  }

  // Rule 4: grounded_partial_answer — mixed support
  if (ALLOW_PARTIAL_ANSWER_FALLBACK) {
    const reason = unsupportedClaimCount > 0
      ? `${unsupportedClaimCount} unsupported claim(s) detected; answer partially grounded`
      : `Grounding band '${groundingConfidenceBand}' with coverage ${(citationCoverageRatio * 100).toFixed(0)}%`;
    return {
      outcome: "grounded_partial_answer",
      reason: `${reason} (INV-ANSV5: deterministic)`,
      evidenceFactors,
      allowPartialFallback: true,
      allowInsufficientFallback: ALLOW_INSUFFICIENT_EVIDENCE_FALLBACK,
    };
  }

  // Rule 5: insufficient_evidence fallback
  return {
    outcome: "insufficient_evidence",
    reason: "Partial answer fallback disabled; coverage insufficient for full answer",
    evidenceFactors,
    allowPartialFallback: false,
    allowInsufficientFallback: ALLOW_INSUFFICIENT_EVIDENCE_FALLBACK,
  };
}

/**
 * Apply policy decision and optionally persist result.
 * INV-ANSV6: does not mutate answer_text or citations.
 */
export async function applyAnswerPolicy(params: AnswerPolicyParams & {
  persistPolicy?: boolean;
}): Promise<FinalAnswerResult> {
  const { answerRunId = null, persistPolicy = false, ...policyParams } = params;

  const policyDecision = decideFinalAnswerPolicy(policyParams);
  let persistedPolicyResult = false;

  if (persistPolicy && answerRunId) {
    try {
      await db.update(knowledgeAnswerRuns).set({
        answerPolicyResult: policyDecision.outcome,
        answerSafetyStatus: policyDecision.outcome === "safe_refusal" ? "refused" :
          policyDecision.outcome === "insufficient_evidence" ? "insufficient" : "ok",
      }).where(eq(knowledgeAnswerRuns.id, answerRunId));
      persistedPolicyResult = true;
    } catch {
      persistedPolicyResult = false;
    }
  }

  return {
    answerRunId,
    policyDecision,
    appliedOutcome: policyDecision.outcome,
    persistedPolicyResult,
    note: "INV-ANSV5: deterministic. INV-ANSV6: answer_text and citations not mutated. INV-ANSV7: no hidden writes.",
  };
}

/**
 * Explain answer policy decision from DB.
 * INV-ANSV7: no writes.
 */
export async function explainAnswerPolicy(runId: string): Promise<{
  runId: string;
  policyOutcome: string | null;
  safetyStatus: string | null;
  groundingBand: string | null;
  coverageRatio: number | null;
  unsupportedClaims: number | null;
  policyRules: Array<{ priority: number; ruleName: string; description: string }>;
  found: boolean;
  note: string;
}> {
  const rows = await db.select().from(knowledgeAnswerRuns).where(eq(knowledgeAnswerRuns.id, runId)).limit(1);
  const run = rows[0];

  return {
    runId,
    policyOutcome: run?.answerPolicyResult ?? null,
    safetyStatus: run?.answerSafetyStatus ?? null,
    groundingBand: run?.groundingConfidenceBand ?? null,
    coverageRatio: run?.citationCoverageRatio ? parseFloat(run.citationCoverageRatio) : null,
    unsupportedClaims: run?.unsupportedClaimCount ?? null,
    policyRules: [
      { priority: 1, ruleName: "safe_refusal_high_risk_safety", description: "retrieval_safety_status=high_risk → safe_refusal" },
      { priority: 2, ruleName: "safe_refusal_unsafe_grounding", description: "band=unsafe AND hallucination=high_risk → safe_refusal" },
      { priority: 3, ruleName: "safe_refusal_below_minimum_band", description: `band below ${MINIMUM_GROUNDING_CONFIDENCE_BAND} → safe_refusal` },
      { priority: 4, ruleName: "full_answer_strong_support", description: "band=high AND coverage≥threshold AND unsupported=0 AND guard=no_issue → full_answer" },
      { priority: 5, ruleName: "insufficient_evidence_low_coverage", description: `coverage<${MINIMUM_CITATION_COVERAGE_RATIO} AND band=low/unsafe → insufficient_evidence` },
      { priority: 6, ruleName: "grounded_partial_answer", description: "mixed support + partial_answer_fallback enabled → grounded_partial_answer" },
      { priority: 7, ruleName: "insufficient_evidence_fallback", description: "all else + partial_answer_fallback disabled → insufficient_evidence" },
    ],
    found: !!run,
    note: "INV-ANSV5: deterministic. INV-ANSV7: no writes performed.",
  };
}

/**
 * Preview answer policy for given params — no writes (INV-ANSV7).
 */
export function previewAnswerPolicy(params: Omit<AnswerPolicyParams, "answerRunId">): {
  decision: AnswerPolicyDecision;
  note: string;
} {
  const decision = decideFinalAnswerPolicy({ ...params, answerRunId: null });
  return {
    decision,
    note: "INV-ANSV7: no writes performed. INV-ANSV5: deterministic preview.",
  };
}
