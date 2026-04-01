/**
 * Phase 5Z.2 — Instant Answer Readiness
 *
 * Determines whether a knowledge document can already provide answers
 * before its full processing pipeline has completed.
 *
 * Eligibility rules:
 *  - "not_ready"    → no active retrieval chunks exist at all
 *  - "partial_ready"→ ≥1 active chunk exists, document still processing
 *  - "fully_ready"  → all retrieval jobs done, all chunks active, no failures
 *  - "blocked"      → stuck in dead_letter or permanently failed state
 *
 * INV-IAR1: eligibility is never "fully_ready" when coveragePercent < 100.
 * INV-IAR2: eligibility is never "partial_ready" when retrievalChunksActive === 0.
 * INV-IAR3: All data is tenant-scoped — params must be caller-validated.
 */

import { getDocumentAggregation, type AggregationResult } from "./segment-aggregator.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

export type InstantAnswerEligibility =
  | "not_ready"      // no usable chunks at all — must wait
  | "partial_ready"  // some chunks ready — can answer partially
  | "fully_ready"    // all chunks ready — full answer possible
  | "blocked";       // permanently stuck — never will be ready

export interface InstantAnswerReadiness {
  eligibility:           InstantAnswerEligibility;
  retrievalChunksActive: number;
  coveragePercent:       number;
  fullCompletionBlocked: boolean;
  hasDeadLetterSegments: boolean;
  /** ISO timestamp of first chunk becoming active, if known. */
  firstRetrievalReadyAt: string | null;
  /** True when more chunks may become available later. */
  canRefreshForBetterAnswer: boolean;
  /** Human-readable reason (for debug/logging). */
  reason: string;
}

// ── checkInstantAnswerEligibility ─────────────────────────────────────────────

export async function checkInstantAnswerEligibility(params: {
  tenantId:                   string;
  knowledgeDocumentVersionId: string;
}): Promise<InstantAnswerReadiness> {
  const agg = await getDocumentAggregation(params);
  return deriveEligibility(agg);
}

// ── deriveEligibility (pure, exported for testing) ────────────────────────────

export function deriveEligibility(agg: AggregationResult): InstantAnswerReadiness {
  const {
    retrievalChunksActive,
    coveragePercent,
    fullCompletionBlocked,
    hasDeadLetterSegments,
    segmentsProcessing,
    segmentsQueued,
    documentStatus,
    answerCompleteness,
  } = agg;

  // INV-IAR2: must have at least one chunk to be partial_ready or fully_ready
  if (retrievalChunksActive === 0) {
    if (fullCompletionBlocked || hasDeadLetterSegments) {
      return {
        eligibility:            "blocked",
        retrievalChunksActive:  0,
        coveragePercent:        0,
        fullCompletionBlocked,
        hasDeadLetterSegments,
        firstRetrievalReadyAt:  null,
        canRefreshForBetterAnswer: false,
        reason: `No usable chunks — permanently blocked (status=${documentStatus})`,
      };
    }
    return {
      eligibility:            "not_ready",
      retrievalChunksActive:  0,
      coveragePercent:        0,
      fullCompletionBlocked,
      hasDeadLetterSegments,
      firstRetrievalReadyAt:  null,
      canRefreshForBetterAnswer: segmentsProcessing > 0 || segmentsQueued > 0,
      reason: `No retrieval chunks yet — waiting for processing (status=${documentStatus})`,
    };
  }

  // INV-IAR1: fully_ready requires 100% coverage
  if (answerCompleteness === "complete" && coveragePercent >= 100 && !fullCompletionBlocked) {
    return {
      eligibility:            "fully_ready",
      retrievalChunksActive,
      coveragePercent:        100,
      fullCompletionBlocked:  false,
      hasDeadLetterSegments,
      firstRetrievalReadyAt:  null,
      canRefreshForBetterAnswer: false,
      reason:                 "All segments complete — full answer available",
    };
  }

  // Blocked with some chunks: can answer partially but will never improve
  if (fullCompletionBlocked) {
    return {
      eligibility:            "partial_ready",
      retrievalChunksActive,
      coveragePercent,
      fullCompletionBlocked:  true,
      hasDeadLetterSegments,
      firstRetrievalReadyAt:  null,
      canRefreshForBetterAnswer: false,
      reason:
        `${retrievalChunksActive} chunk(s) available but blocked at ${coveragePercent}% ` +
        `(dead_letter=${hasDeadLetterSegments})`,
    };
  }

  // Chunks exist, more work is pending — partial answer now, refresh later
  const stillProcessing = segmentsProcessing > 0 || segmentsQueued > 0;
  return {
    eligibility:            "partial_ready",
    retrievalChunksActive,
    coveragePercent,
    fullCompletionBlocked:  false,
    hasDeadLetterSegments,
    firstRetrievalReadyAt:  null,
    canRefreshForBetterAnswer: stillProcessing,
    reason:
      `${retrievalChunksActive} chunk(s) ready at ${coveragePercent}% coverage ` +
      (stillProcessing ? "— more coming" : "— no further progress expected"),
  };
}
