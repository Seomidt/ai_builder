/**
 * Phase 5Z.2 — Tests: Instant Answer Readiness (pure logic)
 *
 * Tests the eligibility derivation logic without a live DB,
 * using synthetic AggregationResult inputs.
 *
 * INV-IAR1: eligibility is never "fully_ready" when coveragePercent < 100.
 * INV-IAR2: eligibility is never "partial_ready" when retrievalChunksActive === 0.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deriveEligibility } from "../../server/lib/media/instant-answer-readiness.ts";
import type { AggregationResult } from "../../server/lib/media/segment-aggregator.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeAgg(overrides: Partial<AggregationResult> = {}): AggregationResult {
  return {
    documentStatus:        "processing",
    answerCompleteness:    "none",
    segmentsTotal:         4,
    segmentsCompleted:     0,
    segmentsFailed:        0,
    segmentsProcessing:    4,
    segmentsQueued:        0,
    segmentsDeadLetter:    0,
    coveragePercent:       0,
    hasFailedSegments:     false,
    hasDeadLetterSegments: false,
    fullCompletionBlocked: false,
    retrievalChunksActive: 0,
    firstRetrievalReadyAt: null,
    invariantViolations:   [],
    jobDetails:            [],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("instant-answer-readiness — deriveEligibility", () => {

  // ── not_ready cases ───────────────────────────────────────────────────────

  it("not_ready when no chunks and still processing", () => {
    const agg = makeAgg({ retrievalChunksActive: 0, fullCompletionBlocked: false, segmentsProcessing: 4 });
    const result = deriveEligibility(agg);
    assert.equal(result.eligibility, "not_ready");
    assert.equal(result.canRefreshForBetterAnswer, true);
  });

  it("not_ready when no chunks and coverage is 0", () => {
    const agg = makeAgg({ retrievalChunksActive: 0, coveragePercent: 0, segmentsQueued: 4, segmentsProcessing: 0 });
    const result = deriveEligibility(agg);
    assert.equal(result.eligibility, "not_ready");
    assert.equal(result.retrievalChunksActive, 0);
  });

  it("not_ready when no chunks and no pending segments", () => {
    const agg = makeAgg({
      retrievalChunksActive: 0,
      segmentsProcessing:    0,
      segmentsQueued:        0,
      coveragePercent:       0,
    });
    const result = deriveEligibility(agg);
    assert.equal(result.eligibility, "not_ready");
    assert.equal(result.canRefreshForBetterAnswer, false);
  });

  // ── blocked cases ─────────────────────────────────────────────────────────

  it("blocked when no chunks and dead_letter segments exist", () => {
    const agg = makeAgg({
      retrievalChunksActive: 0,
      hasDeadLetterSegments: true,
      fullCompletionBlocked: true,
      segmentsDeadLetter:    2,
      segmentsProcessing:    0,
    });
    const result = deriveEligibility(agg);
    assert.equal(result.eligibility, "blocked");
    assert.equal(result.canRefreshForBetterAnswer, false);
  });

  it("blocked when no chunks and fullCompletionBlocked", () => {
    const agg = makeAgg({
      retrievalChunksActive: 0,
      fullCompletionBlocked: true,
    });
    const result = deriveEligibility(agg);
    assert.equal(result.eligibility, "blocked");
  });

  // ── fully_ready cases ─────────────────────────────────────────────────────

  it("fully_ready when complete with all chunks active", () => {
    const agg = makeAgg({
      documentStatus:        "completed",
      answerCompleteness:    "complete",
      coveragePercent:       100,
      segmentsCompleted:     4,
      segmentsProcessing:    0,
      retrievalChunksActive: 10,
      fullCompletionBlocked: false,
    });
    const result = deriveEligibility(agg);
    assert.equal(result.eligibility, "fully_ready");
    assert.equal(result.coveragePercent, 100);
    assert.equal(result.canRefreshForBetterAnswer, false);
  });

  // INV-IAR1: must not be fully_ready at < 100%
  it("INV-IAR1: partial_ready (not fully_ready) when coveragePercent < 100", () => {
    const agg = makeAgg({
      answerCompleteness:    "partial",
      coveragePercent:       80,
      retrievalChunksActive: 8,
      segmentsProcessing:    1,
      fullCompletionBlocked: false,
    });
    const result = deriveEligibility(agg);
    assert.notEqual(result.eligibility, "fully_ready");
    assert.equal(result.eligibility, "partial_ready");
  });

  // ── partial_ready cases ───────────────────────────────────────────────────

  it("partial_ready when some chunks exist and still processing", () => {
    const agg = makeAgg({
      documentStatus:        "partially_ready",
      answerCompleteness:    "partial",
      coveragePercent:       50,
      segmentsCompleted:     2,
      segmentsProcessing:    2,
      retrievalChunksActive: 5,
      fullCompletionBlocked: false,
    });
    const result = deriveEligibility(agg);
    assert.equal(result.eligibility, "partial_ready");
    assert.equal(result.retrievalChunksActive, 5);
    assert.equal(result.canRefreshForBetterAnswer, true);
  });

  it("partial_ready with canRefresh=false when blocked with chunks", () => {
    const agg = makeAgg({
      documentStatus:        "partially_ready_with_failures",
      answerCompleteness:    "partial",
      coveragePercent:       40,
      retrievalChunksActive: 3,
      fullCompletionBlocked: true,
      hasDeadLetterSegments: true,
    });
    const result = deriveEligibility(agg);
    assert.equal(result.eligibility, "partial_ready");
    assert.equal(result.canRefreshForBetterAnswer, false);
    assert.equal(result.fullCompletionBlocked, true);
  });

  it("partial_ready with canRefresh=false when no pending work but < 100%", () => {
    const agg = makeAgg({
      answerCompleteness:    "partial",
      coveragePercent:       75,
      retrievalChunksActive: 6,
      segmentsProcessing:    0,
      segmentsQueued:        0,
      fullCompletionBlocked: false,
    });
    const result = deriveEligibility(agg);
    assert.equal(result.eligibility, "partial_ready");
    assert.equal(result.canRefreshForBetterAnswer, false);
  });

  // INV-IAR2: must not be partial_ready when no chunks
  it("INV-IAR2: not partial_ready when retrievalChunksActive === 0", () => {
    const agg = makeAgg({
      answerCompleteness:    "partial",
      coveragePercent:       60,
      retrievalChunksActive: 0,
    });
    const result = deriveEligibility(agg);
    assert.notEqual(result.eligibility, "partial_ready");
  });

  // ── firstRetrievalReadyAt propagation ─────────────────────────────────────

  it("firstRetrievalReadyAt is null when no chunks (not_ready)", () => {
    const agg = makeAgg({ retrievalChunksActive: 0, firstRetrievalReadyAt: "2025-01-01T00:00:00.000Z" });
    const result = deriveEligibility(agg);
    assert.equal(result.firstRetrievalReadyAt, null, "no chunks → firstRetrievalReadyAt must be null");
  });

  it("firstRetrievalReadyAt is propagated when fully_ready", () => {
    const ts = "2025-06-01T10:30:00.000Z";
    const agg = makeAgg({
      documentStatus:        "completed",
      answerCompleteness:    "complete",
      coveragePercent:       100,
      retrievalChunksActive: 5,
      fullCompletionBlocked: false,
      firstRetrievalReadyAt: ts,
    });
    const result = deriveEligibility(agg);
    assert.equal(result.eligibility, "fully_ready");
    assert.equal(result.firstRetrievalReadyAt, ts);
  });

  it("firstRetrievalReadyAt is propagated when partial_ready", () => {
    const ts = "2025-06-01T09:00:00.000Z";
    const agg = makeAgg({
      documentStatus:        "partially_ready",
      answerCompleteness:    "partial",
      coveragePercent:       50,
      retrievalChunksActive: 4,
      segmentsProcessing:    2,
      firstRetrievalReadyAt: ts,
    });
    const result = deriveEligibility(agg);
    assert.equal(result.eligibility, "partial_ready");
    assert.equal(result.firstRetrievalReadyAt, ts);
  });

  it("firstRetrievalReadyAt is propagated when blocked with chunks", () => {
    const ts = "2025-06-01T08:00:00.000Z";
    const agg = makeAgg({
      documentStatus:        "partially_ready_with_failures",
      answerCompleteness:    "partial",
      coveragePercent:       30,
      retrievalChunksActive: 2,
      fullCompletionBlocked: true,
      hasDeadLetterSegments: true,
      firstRetrievalReadyAt: ts,
    });
    const result = deriveEligibility(agg);
    assert.equal(result.eligibility, "partial_ready");
    assert.equal(result.firstRetrievalReadyAt, ts);
  });

  it("firstRetrievalReadyAt null does not break deriveEligibility for any branch", () => {
    const branches = [
      makeAgg({ retrievalChunksActive: 0, segmentsProcessing: 1 }),
      makeAgg({ retrievalChunksActive: 0, fullCompletionBlocked: true }),
      makeAgg({ retrievalChunksActive: 3, answerCompleteness: "partial", coveragePercent: 50, segmentsProcessing: 2 }),
      makeAgg({ retrievalChunksActive: 3, answerCompleteness: "partial", coveragePercent: 50, fullCompletionBlocked: true }),
      makeAgg({ retrievalChunksActive: 5, answerCompleteness: "complete", coveragePercent: 100 }),
    ];
    for (const agg of branches) {
      const result = deriveEligibility(agg);
      assert.ok(typeof result.eligibility === "string", "eligibility must be defined");
    }
  });

  // ── retrieval completeness contract ───────────────────────────────────────

  it("coveragePercent is always propagated in result", () => {
    const agg = makeAgg({
      documentStatus:        "partially_ready",
      answerCompleteness:    "partial",
      coveragePercent:       73,
      retrievalChunksActive: 7,
      segmentsProcessing:    1,
    });
    const result = deriveEligibility(agg);
    assert.equal(result.coveragePercent, 73);
  });

  it("reason string is always non-empty for all eligibility states", () => {
    const cases: Partial<AggregationResult>[] = [
      { retrievalChunksActive: 0, segmentsProcessing: 1 },
      { retrievalChunksActive: 0, fullCompletionBlocked: true },
      { retrievalChunksActive: 5, answerCompleteness: "complete", coveragePercent: 100 },
      { retrievalChunksActive: 3, answerCompleteness: "partial", coveragePercent: 60, segmentsProcessing: 1 },
      { retrievalChunksActive: 3, answerCompleteness: "partial", coveragePercent: 60, fullCompletionBlocked: true, hasDeadLetterSegments: true },
    ];
    for (const c of cases) {
      const result = deriveEligibility(makeAgg(c));
      assert.ok(result.reason.length > 0, `reason must not be empty for eligibility=${result.eligibility}`);
    }
  });

  // ── invariantViolations handling ──────────────────────────────────────────

  it("INV violations with zero chunks → not_ready with fullCompletionBlocked=true", () => {
    const agg = makeAgg({
      retrievalChunksActive: 0,
      invariantViolations:   ["INV-AGG2 VIOLATION: status=completed but retrievalChunksActive=0"],
    });
    const result = deriveEligibility(agg);
    assert.notEqual(result.eligibility, "fully_ready",
      "Invariant violation must prevent fully_ready eligibility");
    assert.notEqual(result.eligibility, "partial_ready",
      "Zero chunks + invariant violation must not be partial_ready");
    assert.equal(result.fullCompletionBlocked, true,
      "fullCompletionBlocked must be true when invariant violations present");
    assert.equal(result.canRefreshForBetterAnswer, false);
  });

  it("INV violations with chunks → partial_ready with blocked=true (safe partial)", () => {
    const agg = makeAgg({
      retrievalChunksActive: 5,
      answerCompleteness:    "complete",
      coveragePercent:       100,
      invariantViolations:   ["INV-AGG1 VIOLATION: status=completed but hasFailedSegments=true"],
    });
    const result = deriveEligibility(agg);
    // With violations + chunks: serve partial (not complete) with blocked=true
    assert.equal(result.eligibility, "partial_ready",
      "Invariant violation with chunks should serve partial (not complete) to avoid incorrect 'fully_ready'");
    assert.equal(result.fullCompletionBlocked, true,
      "fullCompletionBlocked must be true when invariant violations present with chunks");
    assert.equal(result.canRefreshForBetterAnswer, false);
  });

  it("INV violations reason string always mentions the violation", () => {
    const violation = "INV-AGG2 VIOLATION: test violation";
    const agg = makeAgg({ invariantViolations: [violation] });
    const result = deriveEligibility(agg);
    assert.ok(result.reason.includes("Invariant violation"),
      "Reason should mention invariant violation");
  });

  it("empty invariantViolations → normal eligibility path (no downgrade)", () => {
    const agg = makeAgg({
      documentStatus:        "completed",
      answerCompleteness:    "complete",
      coveragePercent:       100,
      retrievalChunksActive: 5,
      invariantViolations:   [],
    });
    const result = deriveEligibility(agg);
    assert.equal(result.eligibility, "fully_ready",
      "Empty invariant violations must not downgrade eligibility");
  });

});
