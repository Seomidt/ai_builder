/**
 * hallucination-guard.ts — Phase 5R
 *
 * Evidence-based hallucination guard heuristics.
 *
 * Design invariants:
 *   INV-ANSV4  Guard is evidence-based and explainable
 *   INV-ANSV7  Preview endpoints perform no writes
 *   INV-ANSV9  Existing retrieval/citation behavior intact
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { knowledgeAnswerRuns } from "@shared/schema";
import {
  HALLUCINATION_GUARD_ENABLED,
  STRONG_CERTAINTY_PENALTY_ENABLED,
  MAXIMUM_UNSUPPORTED_CLAIM_COUNT,
  MINIMUM_CITATION_COVERAGE_RATIO,
} from "../config/retrieval-config";
import type { ExtractedClaim, CitationInput, GroundingConfidenceBand } from "./answer-verification";

// ── Types ─────────────────────────────────────────────────────────────────────

export type HallucinationRiskLevel = "no_issue" | "caution" | "high_risk";

export interface HallucinationSignal {
  signalType: string;
  description: string;
  severity: "low" | "medium" | "high";
  evidence: string;
}

export interface UnsupportedClaimReport {
  claimIndex: number;
  claimText: string;
  claimType: string;
  reason: string;
}

export interface CitationGapReport {
  citationId: string;
  chunkId: string;
  claimsReferencing: number;
  weakMatchScore: number;
  note: string;
}

export interface HallucinationGuardSummary {
  riskLevel: HallucinationRiskLevel;
  signals: HallucinationSignal[];
  unsupportedClaims: UnsupportedClaimReport[];
  citationGaps: CitationGapReport[];
  certaintyClaims: string[];
  guardEnabled: boolean;
  note: string;
}

export interface HallucinationGuardParams {
  answerText: string;
  claims: ExtractedClaim[];
  citations: CitationInput[];
  groundingConfidenceBand: GroundingConfidenceBand;
  citationCoverageRatio: number;
  retrievalSafetyStatus?: string | null;
}

// ── Strong certainty phrase detection ────────────────────────────────────────

const STRONG_CERTAINTY_PATTERNS = [
  /\bdefinitely\b/i, /\bcertainly\b/i, /\bguaranteed\b/i, /\bproven\b/i,
  /\bconfirmed\b/i, /\bexactly\b/i, /\bprecisely\b/i, /\balways\b/i,
  /\bnever fails\b/i, /\bcategorically\b/i, /\babsolutely\b/i, /\bwithout doubt\b/i,
  /\bwithout question\b/i, /\bundeniably\b/i,
];

export function detectCertaintyLanguage(answerText: string): string[] {
  if (!STRONG_CERTAINTY_PENALTY_ENABLED) return [];
  const found: string[] = [];
  for (const pattern of STRONG_CERTAINTY_PATTERNS) {
    const match = answerText.match(pattern);
    if (match) found.push(match[0].toLowerCase());
  }
  return [...new Set(found)];
}

// ── Heuristic detection functions ─────────────────────────────────────────────

/**
 * Detect unsupported factual claims.
 * INV-ANSV4: evidence-based — only flags claims with status "unsupported" from verification.
 */
export function detectUnsupportedAnswerClaims(params: {
  claims: ExtractedClaim[];
  groundingConfidenceBand: GroundingConfidenceBand;
  citationCoverageRatio: number;
}): UnsupportedClaimReport[] {
  if (!HALLUCINATION_GUARD_ENABLED) return [];
  const { claims } = params;

  return claims
    .filter((c) => c.supportStatus === "unsupported" && c.claimType !== "connective")
    .map((c) => ({
      claimIndex: c.claimIndex,
      claimText: c.claimText,
      claimType: c.claimType,
      reason: c.claimType === "factual"
        ? "Factual claim (contains numbers/dates) not matched to any citation"
        : "General claim not found in any citation preview or context",
    }));
}

/**
 * Detect citation gaps — citations that are weakly matched or unreferenced.
 * INV-ANSV4: evidence-based.
 */
export function detectCitationGaps(params: {
  claims: ExtractedClaim[];
  citations: CitationInput[];
}): CitationGapReport[] {
  if (!HALLUCINATION_GUARD_ENABLED) return [];
  const { claims, citations } = params;

  const gaps: CitationGapReport[] = [];

  for (const citation of citations) {
    const referencingClaims = claims.filter((c) => c.citationIds.includes(citation.citationId));
    const avgMatchScore = referencingClaims.length > 0
      ? referencingClaims.reduce((s, c) => s + c.matchScore, 0) / referencingClaims.length
      : 0;

    // Gap: citation is referenced but match score is very low (< 0.2)
    if (referencingClaims.length > 0 && avgMatchScore < 0.2) {
      gaps.push({
        citationId: citation.citationId,
        chunkId: citation.chunkId,
        claimsReferencing: referencingClaims.length,
        weakMatchScore: avgMatchScore,
        note: "Citation referenced by claims but keyword overlap is very weak — citation may not actually support the claim",
      });
    }
  }

  return gaps;
}

/**
 * Build a complete hallucination guard summary.
 * INV-ANSV4: evidence-based — each signal has a description and evidence string.
 * INV-ANSV7: no writes.
 */
export function buildHallucinationGuardSummary(params: HallucinationGuardParams): HallucinationGuardSummary {
  if (!HALLUCINATION_GUARD_ENABLED) {
    return {
      riskLevel: "no_issue",
      signals: [],
      unsupportedClaims: [],
      citationGaps: [],
      certaintyClaims: [],
      guardEnabled: false,
      note: "Hallucination guard disabled via config. INV-ANSV7: no writes.",
    };
  }

  const { answerText, claims, citations, groundingConfidenceBand, citationCoverageRatio, retrievalSafetyStatus } = params;

  const signals: HallucinationSignal[] = [];

  // Heuristic 1: unsupported factual claims
  const unsupportedClaims = detectUnsupportedAnswerClaims({ claims, groundingConfidenceBand, citationCoverageRatio });
  if (unsupportedClaims.length > 0) {
    signals.push({
      signalType: "unsupported_claims",
      description: `${unsupportedClaims.length} claim(s) have no citation match`,
      severity: unsupportedClaims.length > MAXIMUM_UNSUPPORTED_CLAIM_COUNT ? "high" : "medium",
      evidence: unsupportedClaims.map((c) => `[${c.claimIndex}] "${c.claimText.slice(0, 60)}"`).join("; "),
    });
  }

  // Heuristic 2: citation gaps
  const citationGaps = detectCitationGaps({ claims, citations });
  if (citationGaps.length > 0) {
    signals.push({
      signalType: "citation_gaps",
      description: `${citationGaps.length} citation(s) have very weak keyword overlap`,
      severity: "medium",
      evidence: citationGaps.map((g) => `citation=${g.citationId}, score=${g.weakMatchScore.toFixed(2)}`).join("; "),
    });
  }

  // Heuristic 3: coverage too low relative to answer length
  const answerWordCount = answerText.split(/\s+/).length;
  if (citationCoverageRatio < MINIMUM_CITATION_COVERAGE_RATIO && answerWordCount > 30) {
    signals.push({
      signalType: "low_coverage_for_length",
      description: `Answer has ${answerWordCount} words but citation coverage is only ${(citationCoverageRatio * 100).toFixed(0)}%`,
      severity: citationCoverageRatio < 0.2 ? "high" : "medium",
      evidence: `coverage_ratio=${citationCoverageRatio.toFixed(3)}, word_count=${answerWordCount}, threshold=${MINIMUM_CITATION_COVERAGE_RATIO}`,
    });
  }

  // Heuristic 4: strong certainty language with weak evidence
  const certaintyClaims = detectCertaintyLanguage(answerText);
  if (certaintyClaims.length > 0 && groundingConfidenceBand !== "high") {
    signals.push({
      signalType: "certainty_without_strong_support",
      description: `Answer uses strong certainty language (${certaintyClaims.join(", ")}) but grounding band is '${groundingConfidenceBand}'`,
      severity: groundingConfidenceBand === "unsafe" ? "high" : "medium",
      evidence: `certainty_phrases=[${certaintyClaims.join(", ")}], grounding_band=${groundingConfidenceBand}`,
    });
  }

  // Heuristic 5: safety status high_risk = automatic high_risk guard signal
  if (retrievalSafetyStatus === "high_risk") {
    signals.push({
      signalType: "retrieval_safety_high_risk",
      description: "Retrieval context contains high-risk injection signals (from 5Q safety review)",
      severity: "high",
      evidence: `retrieval_safety_status=high_risk`,
    });
  }

  // Heuristic 6: unsafe grounding band
  if (groundingConfidenceBand === "unsafe") {
    signals.push({
      signalType: "unsafe_grounding_band",
      description: "Grounding confidence band is 'unsafe' — answer confidence is too low for safe delivery",
      severity: "high",
      evidence: `grounding_confidence_band=unsafe`,
    });
  }

  // Determine overall risk level
  const highSignals = signals.filter((s) => s.severity === "high");
  const medSignals = signals.filter((s) => s.severity === "medium");

  let riskLevel: HallucinationRiskLevel;
  if (highSignals.length > 0) {
    riskLevel = "high_risk";
  } else if (medSignals.length > 0 || signals.length > 0) {
    riskLevel = "caution";
  } else {
    riskLevel = "no_issue";
  }

  return {
    riskLevel,
    signals,
    unsupportedClaims,
    citationGaps,
    certaintyClaims,
    guardEnabled: true,
    note: "INV-ANSV4: evidence-based signals only. INV-ANSV7: no writes performed.",
  };
}

/**
 * Explain hallucination guard from DB.
 * INV-ANSV7: no writes.
 */
export async function explainHallucinationGuard(runId: string): Promise<{
  runId: string;
  guardEnabled: boolean;
  heuristics: Array<{ name: string; description: string }>;
  runData: {
    groundingConfidenceBand: string | null;
    unsupportedClaimCount: number | null;
    answerSafetyStatus: string | null;
  } | null;
  found: boolean;
  note: string;
}> {
  const rows = await db.select().from(knowledgeAnswerRuns).where(eq(knowledgeAnswerRuns.id, runId)).limit(1);
  const run = rows[0];

  return {
    runId,
    guardEnabled: HALLUCINATION_GUARD_ENABLED,
    heuristics: [
      { name: "unsupported_claims", description: "Claims with no citation keyword match flagged as unsupported" },
      { name: "citation_gaps", description: "Citations with avgMatchScore < 0.2 across referencing claims" },
      { name: "low_coverage_for_length", description: `Coverage < ${MINIMUM_CITATION_COVERAGE_RATIO} for answers > 30 words` },
      { name: "certainty_without_support", description: `Strong certainty phrases detected with non-'high' grounding band` },
      { name: "retrieval_safety_high_risk", description: "Retrieval safety status = high_risk propagates to guard" },
      { name: "unsafe_grounding_band", description: "Grounding band = unsafe triggers high_risk guard" },
    ],
    runData: run ? {
      groundingConfidenceBand: run.groundingConfidenceBand ?? null,
      unsupportedClaimCount: run.unsupportedClaimCount ?? null,
      answerSafetyStatus: run.answerSafetyStatus ?? null,
    } : null,
    found: !!run,
    note: "INV-ANSV4: evidence-based. INV-ANSV7: no writes performed.",
  };
}
