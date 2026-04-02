/**
 * Phase 5Z.2 — Tests: Readiness Contract Scenarios (pure logic)
 *
 * Integration-style scenarios validating Phase 5Z.2 core contract:
 *  - Partial-ready retrieval before full completion
 *  - Zero-chunk → no partial answer (never partial_ready without chunks)
 *  - Complete document → complete answer metadata
 *  - Multi-doc worst-case eligibility aggregation
 *  - coveragePercent < 100 → answerCompleteness never "complete"
 *  - canRefreshForBetterAnswer reflects remaining processing work
 *
 * All tests are pure (no DB) — uses deriveEligibility() and inline helpers
 * that mirror production aggregate logic.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { deriveEligibility } from "../../server/lib/media/instant-answer-readiness.ts";
import type { AggregationResult } from "../../server/lib/media/segment-aggregator.ts";
import type { InstantAnswerReadiness } from "../../server/lib/media/instant-answer-readiness.ts";

// ── Inline eligibility aggregator (mirrors readiness-enrichment.ts) ───────────

const ELIGIBILITY_RANK: Record<string, number> = {
  not_ready: 0, blocked: 1, partial_ready: 2, fully_ready: 3,
};

function aggregateEligibility(results: InstantAnswerReadiness[]): InstantAnswerReadiness {
  if (!results.length) {
    return {
      eligibility: "not_ready", retrievalChunksActive: 0, coveragePercent: 0,
      fullCompletionBlocked: false, hasDeadLetterSegments: false,
      firstRetrievalReadyAt: null, canRefreshForBetterAnswer: false,
      reason: "No data",
    };
  }
  let worst = results[0]!;
  for (const r of results.slice(1)) {
    if ((ELIGIBILITY_RANK[r.eligibility] ?? 0) < (ELIGIBILITY_RANK[worst.eligibility] ?? 0)) {
      worst = r;
    }
  }
  return {
    ...worst,
    retrievalChunksActive:    results.reduce((s, r) => s + r.retrievalChunksActive, 0),
    coveragePercent:          Math.round(results.reduce((s, r) => s + r.coveragePercent, 0) / results.length),
    fullCompletionBlocked:    results.some((r) => r.fullCompletionBlocked),
    hasDeadLetterSegments:    results.some((r) => r.hasDeadLetterSegments),
    firstRetrievalReadyAt:    results.map((r) => r.firstRetrievalReadyAt).filter((ts): ts is string => ts !== null).sort()[0] ?? null,
    canRefreshForBetterAnswer: results.some((r) => r.canRefreshForBetterAnswer),
  };
}

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

describe("readiness-contract — scenario tests", () => {

  // ── Scenario 1: Partial-ready retrieval before full completion ──────────

  it("SC1: partial-ready retrieval is possible before full completion (partial_ready)", () => {
    const agg = makeAgg({
      documentStatus:        "partially_ready",
      answerCompleteness:    "partial",
      coveragePercent:       40,
      segmentsCompleted:     2,
      segmentsProcessing:    2,
      retrievalChunksActive: 5,
    });
    const result = deriveEligibility(agg);
    assert.equal(result.eligibility, "partial_ready",
      "Should be partial_ready when some chunks exist but doc is not fully processed");
    assert.equal(result.canRefreshForBetterAnswer, true,
      "Should indicate refresh possible when still processing");
    assert.ok(result.retrievalChunksActive > 0, "Must have active chunks");
    assert.ok(result.coveragePercent < 100, "Coverage is not yet 100%");
  });

  it("SC1: first retrieval-producing job provides partial answer path", () => {
    const ts = "2025-06-01T09:00:00.000Z";
    const agg = makeAgg({
      documentStatus:        "partially_ready",
      answerCompleteness:    "partial",
      coveragePercent:       25,
      segmentsProcessing:    3,
      retrievalChunksActive: 2,
      firstRetrievalReadyAt: ts,
    });
    const result = deriveEligibility(agg);
    assert.equal(result.eligibility, "partial_ready");
    assert.equal(result.firstRetrievalReadyAt, ts,
      "firstRetrievalReadyAt must be propagated to caller for timing decisions");
  });

  // ── Scenario 2: Zero-chunk → no partial answer ─────────────────────────

  it("SC2: zero active chunks → eligibility never partial_ready or fully_ready", () => {
    const zeroChunkScenarios: Partial<AggregationResult>[] = [
      { retrievalChunksActive: 0, answerCompleteness: "none",    coveragePercent: 0,   segmentsProcessing: 4 },
      { retrievalChunksActive: 0, answerCompleteness: "partial", coveragePercent: 50,  segmentsProcessing: 2 },
      { retrievalChunksActive: 0, answerCompleteness: "complete",coveragePercent: 100, segmentsCompleted: 4 },
    ];
    for (const override of zeroChunkScenarios) {
      const result = deriveEligibility(makeAgg(override));
      assert.notEqual(result.eligibility, "partial_ready",
        `Zero chunks must not produce partial_ready (scenario: ${JSON.stringify(override)})`);
      assert.notEqual(result.eligibility, "fully_ready",
        `Zero chunks must not produce fully_ready (scenario: ${JSON.stringify(override)})`);
    }
  });

  it("SC2: zero chunks with processing jobs → not_ready with canRefresh=true", () => {
    const result = deriveEligibility(makeAgg({
      retrievalChunksActive: 0,
      segmentsProcessing:    3,
      segmentsQueued:        1,
    }));
    assert.equal(result.eligibility, "not_ready");
    assert.equal(result.canRefreshForBetterAnswer, true);
  });

  it("SC2: zero chunks with blocked state → blocked (not not_ready)", () => {
    const result = deriveEligibility(makeAgg({
      retrievalChunksActive: 0,
      fullCompletionBlocked: true,
      hasDeadLetterSegments: true,
    }));
    assert.equal(result.eligibility, "blocked");
    assert.equal(result.canRefreshForBetterAnswer, false);
  });

  // ── Scenario 3: Complete document → complete answer metadata ───────────

  it("SC3: complete document produces fully_ready with complete metadata", () => {
    const result = deriveEligibility(makeAgg({
      documentStatus:        "completed",
      answerCompleteness:    "complete",
      coveragePercent:       100,
      segmentsCompleted:     8,
      segmentsTotal:         8,
      segmentsProcessing:    0,
      retrievalChunksActive: 20,
      fullCompletionBlocked: false,
    }));
    assert.equal(result.eligibility, "fully_ready");
    assert.equal(result.coveragePercent, 100);
    assert.equal(result.canRefreshForBetterAnswer, false,
      "fully_ready doc should not indicate refresh needed");
    assert.equal(result.fullCompletionBlocked, false);
  });

  it("SC3: fully_ready has correct chunk count propagated", () => {
    const result = deriveEligibility(makeAgg({
      documentStatus:        "completed",
      answerCompleteness:    "complete",
      coveragePercent:       100,
      retrievalChunksActive: 42,
      fullCompletionBlocked: false,
    }));
    assert.equal(result.eligibility, "fully_ready");
    assert.equal(result.retrievalChunksActive, 42);
  });

  // ── Scenario 4: Multi-doc worst-case eligibility aggregation ───────────

  it("SC4: multi-doc aggregation takes worst-case eligibility", () => {
    const docA = deriveEligibility(makeAgg({
      documentStatus: "completed", answerCompleteness: "complete",
      coveragePercent: 100, retrievalChunksActive: 10, fullCompletionBlocked: false,
    }));
    const docB = deriveEligibility(makeAgg({
      documentStatus: "partially_ready", answerCompleteness: "partial",
      coveragePercent: 50, retrievalChunksActive: 5, segmentsProcessing: 2,
    }));

    const aggregate = aggregateEligibility([docA, docB]);
    // docB is worse (partial_ready < fully_ready)
    assert.equal(aggregate.eligibility, "partial_ready",
      "Multi-doc aggregate must use worst-case eligibility");
  });

  it("SC4: multi-doc aggregation sums retrievalChunksActive", () => {
    const results = [
      deriveEligibility(makeAgg({ retrievalChunksActive: 5, answerCompleteness: "partial", coveragePercent: 50, segmentsProcessing: 1 })),
      deriveEligibility(makeAgg({ retrievalChunksActive: 3, answerCompleteness: "partial", coveragePercent: 75, segmentsProcessing: 1 })),
    ];
    const aggregate = aggregateEligibility(results);
    assert.equal(aggregate.retrievalChunksActive, 8, "retrievalChunksActive should be summed");
  });

  it("SC4: multi-doc aggregation not_ready + partial_ready → not_ready", () => {
    const docA = deriveEligibility(makeAgg({ retrievalChunksActive: 0, segmentsProcessing: 4 }));
    const docB = deriveEligibility(makeAgg({
      retrievalChunksActive: 5, answerCompleteness: "partial", coveragePercent: 60, segmentsProcessing: 1,
    }));
    const aggregate = aggregateEligibility([docA, docB]);
    assert.equal(aggregate.eligibility, "not_ready",
      "not_ready should dominate partial_ready in multi-doc scenario");
  });

  it("SC4: multi-doc canRefreshForBetterAnswer is true if ANY doc can refresh", () => {
    const docA = deriveEligibility(makeAgg({
      retrievalChunksActive: 5, answerCompleteness: "partial", coveragePercent: 60,
      segmentsProcessing: 0, segmentsQueued: 0, fullCompletionBlocked: false,
    }));
    const docB = deriveEligibility(makeAgg({
      retrievalChunksActive: 3, answerCompleteness: "partial", coveragePercent: 40,
      segmentsProcessing: 2,
    }));
    const aggregate = aggregateEligibility([docA, docB]);
    assert.equal(aggregate.canRefreshForBetterAnswer, true,
      "canRefreshForBetterAnswer should be true if any doc has pending work");
  });

  // ── Scenario 5: coveragePercent < 100 → never "complete" ──────────────

  it("SC5: coveragePercent < 100 never produces fully_ready regardless of answerCompleteness", () => {
    const coverageValues = [0, 10, 50, 75, 99];
    for (const pct of coverageValues) {
      const result = deriveEligibility(makeAgg({
        answerCompleteness:    "complete",
        coveragePercent:       pct,
        retrievalChunksActive: pct > 0 ? 5 : 0,
        segmentsProcessing:    0,
        fullCompletionBlocked: false,
      }));
      assert.notEqual(result.eligibility, "fully_ready",
        `Coverage ${pct}% must not produce fully_ready`);
    }
  });

  // ── Scenario 6: firstRetrievalReadyAt earliest across multi-doc ────────

  it("SC6: multi-doc aggregation picks earliest firstRetrievalReadyAt", () => {
    const ts1 = "2025-06-01T10:00:00.000Z";
    const ts2 = "2025-06-01T09:00:00.000Z"; // earlier
    const docA = deriveEligibility(makeAgg({
      retrievalChunksActive: 5, answerCompleteness: "partial", coveragePercent: 60,
      segmentsProcessing: 1, firstRetrievalReadyAt: ts1,
    }));
    const docB = deriveEligibility(makeAgg({
      retrievalChunksActive: 3, answerCompleteness: "partial", coveragePercent: 40,
      segmentsProcessing: 2, firstRetrievalReadyAt: ts2,
    }));
    const aggregate = aggregateEligibility([docA, docB]);
    assert.equal(aggregate.firstRetrievalReadyAt, ts2,
      "Aggregate must use the earliest firstRetrievalReadyAt across all docs");
  });

});
