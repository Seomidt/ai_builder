/**
 * Phase 5Z.1 — Partial Readiness & Partial-Truth API Contract
 *
 * Computes and exposes the explicit readiness metadata required for
 * honest UX. Retrieval/chat consumers MUST use this to show warnings
 * when only part of a document has been processed.
 *
 * API contract shape:
 * {
 *   documentStatus:        AggregatedDocumentStatus,
 *   answerCompleteness:    "none" | "partial" | "complete",
 *   segmentsReady:         number,
 *   segmentsTotal:         number,
 *   coveragePercent:       number,   // 0–100
 *   hasFailedSegments:     boolean,
 *   hasDeadLetterSegments: boolean,
 *   fullCompletionBlocked: boolean,
 *   retrievalChunksActive: number,
 *   partialWarning:        string | null,  // human-readable, null when complete
 * }
 *
 * Rules:
 *  - if coveragePercent < 100, answerCompleteness CANNOT be "complete"
 *  - if fullCompletionBlocked, surface that explicitly
 *  - partialWarning is always set when answerCompleteness !== "complete"
 *
 * INV-PR1: partialWarning is null iff answerCompleteness === "complete".
 * INV-PR2: coveragePercent is always 0–100 (clamped).
 * INV-PR3: All data is tenant-scoped — ID params must be caller-validated.
 */

import {
  getDocumentAggregation,
  type AggregatedDocumentStatus,
  type AnswerCompleteness,
  type AggregationResult,
} from "./segment-aggregator.ts";

// ── Public contract type ───────────────────────────────────────────────────────

export interface DocumentReadiness {
  documentStatus:        AggregatedDocumentStatus;
  answerCompleteness:    AnswerCompleteness;
  segmentsReady:         number;
  segmentsTotal:         number;
  coveragePercent:       number;
  hasFailedSegments:     boolean;
  hasDeadLetterSegments: boolean;
  fullCompletionBlocked: boolean;
  retrievalChunksActive: number;
  /** Human-readable warning. null when document is fully complete. */
  partialWarning:        string | null;
  /** Machine-readable detail for support/debug tooling. */
  debug: {
    segmentsCompleted:  number;
    segmentsFailed:     number;
    segmentsProcessing: number;
    segmentsQueued:     number;
    segmentsDeadLetter: number;
    invariantViolations: string[];
  };
}

// ── buildPartialWarning ────────────────────────────────────────────────────────

function buildPartialWarning(
  status: AggregatedDocumentStatus,
  agg:    AggregationResult,
): string | null {
  switch (status) {
    case "completed":
      return null;

    case "partially_ready_with_failures":
      return (
        `Only ${agg.coveragePercent}% of this document has been processed. ` +
        `Some sections could not be processed and will not appear in answers.`
      );

    case "partially_ready":
      return (
        `This document is still being processed (${agg.coveragePercent}% ready). ` +
        `Answers may be incomplete until processing finishes.`
      );

    case "retryable_failed":
      return "Document processing failed and will be retried. Answers are unavailable until it succeeds.";

    case "failed":
      return "Document processing failed. Please re-upload or contact support.";

    case "dead_letter":
      return (
        "Document processing permanently failed after multiple attempts. " +
        "This document cannot be used for answers."
      );

    case "processing":
      return "Document is being processed. Answers will be available soon.";

    case "not_started":
      return "Document processing has not started yet.";

    default:
      return "Document status is unknown.";
  }
}

// ── getDocumentReadiness ───────────────────────────────────────────────────────

export async function getDocumentReadiness(params: {
  tenantId:                string;
  knowledgeDocumentVersionId: string;
}): Promise<DocumentReadiness> {
  const agg = await getDocumentAggregation(params);

  // INV-PR2: clamp coverage
  const coveragePercent = Math.max(0, Math.min(100, agg.coveragePercent));

  // INV-PR1 enforcement: no "complete" if coverage < 100
  let answerCompleteness = agg.answerCompleteness;
  if (answerCompleteness === "complete" && coveragePercent < 100) {
    answerCompleteness = "partial";
    console.warn(
      `[partial-readiness] INV-PR1 guard triggered for version=${params.knowledgeDocumentVersionId}: ` +
      `answerCompleteness was 'complete' but coveragePercent=${coveragePercent}`,
    );
  }

  const partialWarning = buildPartialWarning(agg.documentStatus, agg);

  return {
    documentStatus:        agg.documentStatus,
    answerCompleteness,
    segmentsReady:         agg.segmentsCompleted,
    segmentsTotal:         agg.segmentsTotal,
    coveragePercent,
    hasFailedSegments:     agg.hasFailedSegments,
    hasDeadLetterSegments: agg.hasDeadLetterSegments,
    fullCompletionBlocked: agg.fullCompletionBlocked,
    retrievalChunksActive: agg.retrievalChunksActive,
    partialWarning,
    debug: {
      segmentsCompleted:   agg.segmentsCompleted,
      segmentsFailed:      agg.segmentsFailed,
      segmentsProcessing:  agg.segmentsProcessing,
      segmentsQueued:      agg.segmentsQueued,
      segmentsDeadLetter:  agg.segmentsDeadLetter,
      invariantViolations: agg.invariantViolations,
    },
  };
}

// ── enrichRetrievalResponse ────────────────────────────────────────────────────
// Attaches readiness metadata to any retrieval/chat API response object.
// Callers should merge this into their response shape.

export function buildRetrievalMetadata(readiness: DocumentReadiness): {
  documentStatus:        string;
  answerCompleteness:    string;
  coveragePercent:       number;
  hasFailedSegments:     boolean;
  fullCompletionBlocked: boolean;
  partialWarning:        string | null;
} {
  return {
    documentStatus:        readiness.documentStatus,
    answerCompleteness:    readiness.answerCompleteness,
    coveragePercent:       readiness.coveragePercent,
    hasFailedSegments:     readiness.hasFailedSegments,
    fullCompletionBlocked: readiness.fullCompletionBlocked,
    partialWarning:        readiness.partialWarning,
  };
}
