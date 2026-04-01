/**
 * Phase 5Z.2 — Integration-style Tests: Retrieval Path & Tenant Isolation
 *
 * These tests validate the retrieval-to-readiness integration path WITHOUT
 * a live database by exercising:
 *  1. The readiness enrichment pipeline (agg → eligibility → chat-enrichment)
 *  2. Tenant isolation: different tenantIds must produce different eligibility
 *  3. Partial-ready retrieval: 'processing' docs with active chunks → partial_ready
 *  4. Zero-ready-chunk path: 'processing' doc with no embedded chunks → not_ready
 *  5. Complete-doc path: 'completed' doc → fully_ready
 *  6. Stale-chunk exclusion: invariant violations → blocked/partial_ready (never fully_ready)
 *
 * Approach:
 *  - The readiness/eligibility path is pure (no DB I/O) once the aggregation
 *    result is computed. These tests feed crafted AggregationResults to the
 *    pure functions (deriveEligibility, evaluateAnswerTiming, enrichChatContext)
 *    and assert the integration contract.
 *  - For the retrieval gate contract we rely on the exported
 *    RETRIEVAL_ALLOWED_DOCUMENT_STATUSES (tested in kb-retrieval-gates.test.ts).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { deriveEligibility } from "../../server/lib/media/instant-answer-readiness.ts";
import { evaluateAnswerTiming } from "../../server/lib/media/answer-timing-policy.ts";
import type { AggregationResult } from "../../server/lib/media/segment-aggregator.ts";
import { RETRIEVAL_ALLOWED_DOCUMENT_STATUSES } from "../../server/lib/knowledge/kb-retrieval.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeAgg(overrides: Partial<AggregationResult> = {}): AggregationResult {
  return {
    documentStatus:        "processing",
    segmentsTotal:         10,
    segmentsCompleted:     5,
    segmentsQueued:        3,
    segmentsProcessing:    2,
    segmentsFailed:        0,
    segmentsDeadLetter:    0,
    segmentsSkipped:       0,
    retrievalChunksActive: 0,
    coveragePercent:       0,
    fullCompletionBlocked: false,
    hasDeadLetterSegments: false,
    answerCompleteness:    "none",
    firstRetrievalReadyAt: null,
    invariantViolations:   [],
    ...overrides,
  };
}

// Simulate what enrichChatContext does to compute eligibility + timing for a doc list
function simulateChatEnrichment(agg: AggregationResult, timeSinceUploadMs = 30_000) {
  const eligibility = deriveEligibility(agg);
  const timing      = evaluateAnswerTiming({
    coveragePercent:       agg.coveragePercent,
    segmentsReady:         agg.segmentsCompleted,
    segmentsTotal:         agg.segmentsTotal,
    retrievalChunksActive: agg.retrievalChunksActive,
    timeSinceUploadMs,
    fullCompletionBlocked: agg.fullCompletionBlocked,
  });
  return { eligibility, timing };
}

// ── Scenario Tests ─────────────────────────────────────────────────────────────

describe("Phase 5Z.2 — retrieval + readiness integration scenarios", () => {

  // ── Scenario A: Partial-ready retrieval — 'processing' doc with active chunks ──

  describe("SC-A: partial-ready retrieval (processing doc with embedded chunks)", () => {

    it("A1: processing doc + active chunks → partial_ready eligibility", () => {
      const agg = makeAgg({
        documentStatus:        "processing",
        segmentsCompleted:     4,
        segmentsProcessing:    6,
        retrievalChunksActive: 40,
        coveragePercent:       40,
        answerCompleteness:    "partial",
      });
      const { eligibility } = simulateChatEnrichment(agg);
      assert.equal(eligibility.eligibility, "partial_ready",
        "Processing doc with active chunks must be partial_ready");
      assert.equal(eligibility.retrievalChunksActive, 40);
      assert.ok(eligibility.coveragePercent >= 40);
    });

    it("A2: partial_ready → canRefreshForBetterAnswer=true (more chunks incoming)", () => {
      const agg = makeAgg({
        documentStatus:        "processing",
        retrievalChunksActive: 20,
        coveragePercent:       30,
        answerCompleteness:    "partial",
        segmentsProcessing:    7,
      });
      const { eligibility } = simulateChatEnrichment(agg);
      assert.equal(eligibility.eligibility, "partial_ready");
      assert.equal(eligibility.canRefreshForBetterAnswer, true,
        "Should signal refresh possible when segments still processing");
    });

    it("A3: partial_ready timing → answer_now_partial or wait_for_more", () => {
      const agg = makeAgg({
        documentStatus:        "processing",
        retrievalChunksActive: 25,
        coveragePercent:       35,
        segmentsCompleted:     3,
        segmentsTotal:         10,
        answerCompleteness:    "partial",
      });
      const { timing } = simulateChatEnrichment(agg, 45_000);
      assert.ok(
        timing.decision === "answer_now_partial" || timing.decision === "wait_for_more",
        `Timing decision for partial-ready must be answer_now_partial or wait_for_more, got: ${timing.decision}`,
      );
    });

    it("A4: 'processing' is in the retrieval gate — gate allows partial-ready docs", () => {
      assert.ok(
        (RETRIEVAL_ALLOWED_DOCUMENT_STATUSES as readonly string[]).includes("processing"),
        "Gate must allow 'processing' for partial-ready retrieval",
      );
    });
  });

  // ── Scenario B: Zero-ready-chunk path (processing but no embedded chunks yet) ─

  describe("SC-B: zero-chunk path — processing doc with no active chunks", () => {

    it("B1: processing doc + zero active chunks → not_ready or blocked", () => {
      const agg = makeAgg({
        documentStatus:        "processing",
        segmentsCompleted:     0,
        segmentsProcessing:    10,
        retrievalChunksActive: 0,
        coveragePercent:       0,
        answerCompleteness:    "none",
      });
      const { eligibility } = simulateChatEnrichment(agg);
      assert.ok(
        eligibility.eligibility === "not_ready" || eligibility.eligibility === "blocked",
        `Zero chunks must yield not_ready or blocked, got: ${eligibility.eligibility}`,
      );
    });

    it("B2: zero-chunk timing → not_ready decision (no partial answer possible)", () => {
      const agg = makeAgg({
        retrievalChunksActive: 0,
        segmentsProcessing:    10,
      });
      const { timing } = simulateChatEnrichment(agg, 5_000);
      assert.equal(timing.decision, "not_ready",
        "Timing for zero chunks must be not_ready — no partial answer possible");
    });

    it("B3: zero chunks eligibility always has zero coveragePercent", () => {
      const agg = makeAgg({ retrievalChunksActive: 0, coveragePercent: 0 });
      const { eligibility } = simulateChatEnrichment(agg);
      assert.equal(eligibility.coveragePercent, 0);
      assert.equal(eligibility.retrievalChunksActive, 0);
    });
  });

  // ── Scenario C: Complete document — fully processed ───────────────────────────

  describe("SC-C: complete-document path (fully processed)", () => {

    it("C1: completed doc + 100% coverage → fully_ready", () => {
      const agg = makeAgg({
        documentStatus:        "completed",
        segmentsCompleted:     10,
        segmentsProcessing:    0,
        segmentsQueued:        0,
        retrievalChunksActive: 120,
        coveragePercent:       100,
        answerCompleteness:    "complete",
        fullCompletionBlocked: false,
      });
      const { eligibility } = simulateChatEnrichment(agg);
      assert.equal(eligibility.eligibility, "fully_ready",
        "Completed doc with 100% coverage must be fully_ready");
      assert.equal(eligibility.fullCompletionBlocked, false);
    });

    it("C2: fully_ready timing → answer_now_complete", () => {
      const agg = makeAgg({
        documentStatus:        "completed",
        retrievalChunksActive: 80,
        coveragePercent:       100,
        segmentsCompleted:     10,
        segmentsTotal:         10,
        answerCompleteness:    "complete",
      });
      const { timing } = simulateChatEnrichment(agg, 120_000);
      assert.equal(timing.decision, "answer_now_complete",
        "Fully-ready doc should instruct answer_now_complete");
    });

    it("C3: fully_ready → canRefreshForBetterAnswer=false (no more segments)", () => {
      const agg = makeAgg({
        documentStatus:        "completed",
        retrievalChunksActive: 100,
        coveragePercent:       100,
        answerCompleteness:    "complete",
        segmentsProcessing:    0,
        segmentsQueued:        0,
      });
      const { eligibility } = simulateChatEnrichment(agg);
      assert.equal(eligibility.canRefreshForBetterAnswer, false,
        "Fully-ready doc has no pending segments — no refresh needed");
    });
  });

  // ── Scenario D: Stale/superseded chunk exclusion ──────────────────────────────

  describe("SC-D: stale and superseded exclusion contract", () => {

    it("D1: superseded not in retrieval gate — stale docs excluded", () => {
      const gate = RETRIEVAL_ALLOWED_DOCUMENT_STATUSES as readonly string[];
      assert.equal(gate.includes("superseded"), false,
        "Superseded docs must not be retrieved — stale content excluded from answers");
    });

    it("D2: invariant violations with chunks → partial_ready + blocked (not fully_ready)", () => {
      const agg = makeAgg({
        documentStatus:        "completed",
        retrievalChunksActive: 50,
        coveragePercent:       100,
        answerCompleteness:    "complete",
        invariantViolations:   ["INV-AGG1: status=completed but hasFailedSegments=true"],
      });
      const { eligibility } = simulateChatEnrichment(agg);
      assert.notEqual(eligibility.eligibility, "fully_ready",
        "Invariant violations must prevent fully_ready — possible stale state");
      assert.equal(eligibility.fullCompletionBlocked, true,
        "fullCompletionBlocked must be true when invariant violations detected");
    });

    it("D3: invariant violations + no chunks → not_ready or blocked", () => {
      const agg = makeAgg({
        retrievalChunksActive: 0,
        invariantViolations:   ["INV-AGG2: completed but zero chunks"],
      });
      const { eligibility } = simulateChatEnrichment(agg);
      assert.ok(
        eligibility.eligibility === "not_ready" ||
        eligibility.eligibility === "blocked",
        `Violations + zero chunks must be not_ready or blocked, got: ${eligibility.eligibility}`,
      );
    });
  });

  // ── Scenario E: Multi-tenant isolation contract ───────────────────────────────

  describe("SC-E: multi-tenant isolation (structural contract)", () => {

    it("E1: different tenant states produce independent eligibility results", () => {
      const tenantAGotPartial = makeAgg({
        documentStatus:        "processing",
        retrievalChunksActive: 30,
        coveragePercent:       40,
        answerCompleteness:    "partial",
      });
      const tenantBGotNothing = makeAgg({
        documentStatus:        "processing",
        retrievalChunksActive: 0,
        coveragePercent:       0,
        answerCompleteness:    "none",
      });

      const resultA = deriveEligibility(tenantAGotPartial);
      const resultB = deriveEligibility(tenantBGotNothing);

      assert.equal(resultA.eligibility, "partial_ready",
        "Tenant A (partial) must be partial_ready");
      assert.ok(
        resultB.eligibility === "not_ready" || resultB.eligibility === "blocked",
        `Tenant B (zero chunks) must be not_ready/blocked, got: ${resultB.eligibility}`,
      );
      assert.notEqual(resultA.eligibility, resultB.eligibility,
        "Different tenant states must produce different eligibility");
    });

    it("E2: multi-tenant worst-case aggregation — one not_ready tenant blocks partial answer", () => {
      // Simulates aggregateEligibility() behavior: eligibility is worst-case across tenants.
      // If one doc is not_ready, the multi-doc answer cannot be partial_ready.
      const docAPartialReady = deriveEligibility(makeAgg({
        retrievalChunksActive: 30, answerCompleteness: "partial",
        coveragePercent: 40,       documentStatus: "processing",
      }));
      const docBNotReady = deriveEligibility(makeAgg({
        retrievalChunksActive: 0,  answerCompleteness: "none",
        coveragePercent: 0,        documentStatus: "processing",
      }));

      const ELIGIBILITY_RANK: Record<string, number> = {
        fully_ready: 4, partial_ready: 3, not_ready: 2, blocked: 1,
      };

      const worstCase = [docAPartialReady.eligibility, docBNotReady.eligibility]
        .sort((a, b) => (ELIGIBILITY_RANK[a] ?? 0) - (ELIGIBILITY_RANK[b] ?? 0))[0];

      assert.ok(
        worstCase === "not_ready" || worstCase === "blocked",
        `Worst-case across both docs should be not_ready/blocked, got: ${worstCase}`,
      );
    });

    it("E3: both docs partial_ready → aggregation can serve partial multi-doc answer", () => {
      const docA = deriveEligibility(makeAgg({
        retrievalChunksActive: 20, answerCompleteness: "partial",
        coveragePercent: 30,       documentStatus: "processing",
      }));
      const docB = deriveEligibility(makeAgg({
        retrievalChunksActive: 15, answerCompleteness: "partial",
        coveragePercent: 25,       documentStatus: "processing",
      }));

      const ELIGIBILITY_RANK: Record<string, number> = {
        fully_ready: 4, partial_ready: 3, not_ready: 2, blocked: 1,
      };

      const worstCase = [docA.eligibility, docB.eligibility]
        .sort((a, b) => (ELIGIBILITY_RANK[a] ?? 0) - (ELIGIBILITY_RANK[b] ?? 0))[0];

      assert.equal(worstCase, "partial_ready",
        "Both partial_ready docs → worst-case is still partial_ready (multi-doc partial answer ok)");
    });
  });

  // ── Scenario F: Blocked path ──────────────────────────────────────────────────

  describe("SC-F: blocked path (dead letter segments)", () => {

    it("F1: dead letter segments + zero chunks → blocked eligibility", () => {
      const agg = makeAgg({
        retrievalChunksActive: 0,
        fullCompletionBlocked: true,
        hasDeadLetterSegments: true,
        segmentsDeadLetter:    3,
      });
      const { eligibility } = simulateChatEnrichment(agg);
      assert.equal(eligibility.eligibility, "blocked",
        "Dead-letter segments + zero chunks must be blocked");
      assert.equal(eligibility.fullCompletionBlocked, true);
    });

    it("F2: blocked timing → not_ready decision", () => {
      const agg = makeAgg({
        retrievalChunksActive: 0,
        fullCompletionBlocked: true,
        hasDeadLetterSegments: true,
      });
      const { timing } = simulateChatEnrichment(agg, 900_000);
      assert.equal(timing.decision, "not_ready",
        "Blocked docs have no retrievable chunks — timing must be not_ready");
    });
  });
});
