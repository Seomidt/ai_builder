/**
 * Phase 5Z.2 — Tests: Answer Timing Policy (pure logic)
 *
 * Tests the deterministic answer timing policy without any I/O.
 *
 * INV-ATP1: answer_now_partial never returned when retrievalChunksActive === 0.
 * INV-ATP2: answer_now_complete only returned when coveragePercent >= 100 AND !blocked.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  evaluateAnswerTiming,
  MIN_COVERAGE_TO_ANSWER,
  GOOD_COVERAGE_THRESHOLD,
  WAIT_TIMEOUT_MS,
  type AnswerTimingPolicyInput,
} from "../../server/lib/media/answer-timing-policy.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInput(overrides: Partial<AnswerTimingPolicyInput> = {}): AnswerTimingPolicyInput {
  return {
    coveragePercent:       0,
    segmentsReady:         0,
    segmentsTotal:         4,
    retrievalChunksActive: 0,
    timeSinceUploadMs:     0,
    fullCompletionBlocked: false,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("answer-timing-policy — evaluateAnswerTiming", () => {

  // ── not_ready cases ───────────────────────────────────────────────────────

  it("not_ready when no chunks exist", () => {
    const result = evaluateAnswerTiming(makeInput({ retrievalChunksActive: 0, coveragePercent: 50 }));
    assert.equal(result.decision, "not_ready");
  });

  it("not_ready when below minimum coverage threshold", () => {
    const result = evaluateAnswerTiming(makeInput({
      retrievalChunksActive: 3,
      coveragePercent:       MIN_COVERAGE_TO_ANSWER - 1,
      timeSinceUploadMs:     0,
    }));
    assert.equal(result.decision, "not_ready");
  });

  // INV-ATP1: never answer_now_partial with 0 chunks
  it("INV-ATP1: not answer_now_partial when retrievalChunksActive === 0", () => {
    const result = evaluateAnswerTiming(makeInput({
      retrievalChunksActive: 0,
      coveragePercent:       80,
    }));
    assert.notEqual(result.decision, "answer_now_partial");
  });

  // ── answer_now_complete cases ─────────────────────────────────────────────

  it("answer_now_complete when fully ready", () => {
    const result = evaluateAnswerTiming(makeInput({
      coveragePercent:       100,
      retrievalChunksActive: 10,
      fullCompletionBlocked: false,
      segmentsReady:         4,
    }));
    assert.equal(result.decision, "answer_now_complete");
    assert.equal(result.coveragePercent, 100);
  });

  // INV-ATP2: never answer_now_complete if blocked
  it("INV-ATP2: not answer_now_complete when fullCompletionBlocked even at 100%", () => {
    const result = evaluateAnswerTiming(makeInput({
      coveragePercent:       100,
      retrievalChunksActive: 5,
      fullCompletionBlocked: true,
    }));
    assert.notEqual(result.decision, "answer_now_complete");
    // Should fall through to answer_now_partial (blocked)
    assert.equal(result.decision, "answer_now_partial");
  });

  // ── answer_now_partial cases ──────────────────────────────────────────────

  it("answer_now_partial when coverage meets good threshold", () => {
    const result = evaluateAnswerTiming(makeInput({
      coveragePercent:       GOOD_COVERAGE_THRESHOLD,
      retrievalChunksActive: 6,
      fullCompletionBlocked: false,
      timeSinceUploadMs:     0,
    }));
    assert.equal(result.decision, "answer_now_partial");
  });

  it("answer_now_partial when permanently blocked with chunks", () => {
    const result = evaluateAnswerTiming(makeInput({
      coveragePercent:       40,
      retrievalChunksActive: 4,
      fullCompletionBlocked: true,
    }));
    assert.equal(result.decision, "answer_now_partial");
  });

  it("answer_now_partial when wait timeout exceeded", () => {
    const result = evaluateAnswerTiming(makeInput({
      coveragePercent:       MIN_COVERAGE_TO_ANSWER,
      retrievalChunksActive: 2,
      fullCompletionBlocked: false,
      timeSinceUploadMs:     WAIT_TIMEOUT_MS + 1000,
    }));
    assert.equal(result.decision, "answer_now_partial");
  });

  it("answer_now_partial when above good threshold", () => {
    const result = evaluateAnswerTiming(makeInput({
      coveragePercent:       75,
      retrievalChunksActive: 7,
      fullCompletionBlocked: false,
      timeSinceUploadMs:     0,
    }));
    assert.equal(result.decision, "answer_now_partial");
  });

  // ── wait_for_more cases ───────────────────────────────────────────────────

  it("wait_for_more when at minimum coverage but below good threshold and no timeout", () => {
    const result = evaluateAnswerTiming(makeInput({
      coveragePercent:       MIN_COVERAGE_TO_ANSWER,
      retrievalChunksActive: 2,
      fullCompletionBlocked: false,
      timeSinceUploadMs:     0,
    }));
    assert.equal(result.decision, "wait_for_more");
  });

  it("wait_for_more when between min and good threshold", () => {
    const mid = Math.floor((MIN_COVERAGE_TO_ANSWER + GOOD_COVERAGE_THRESHOLD) / 2);
    const result = evaluateAnswerTiming(makeInput({
      coveragePercent:       mid,
      retrievalChunksActive: 3,
      fullCompletionBlocked: false,
      timeSinceUploadMs:     1000,
    }));
    assert.equal(result.decision, "wait_for_more");
  });

  // ── result fields ─────────────────────────────────────────────────────────

  it("result includes coveragePercent and reason fields", () => {
    const result = evaluateAnswerTiming(makeInput({
      coveragePercent:       100,
      retrievalChunksActive: 5,
    }));
    assert.ok(typeof result.decision   === "string");
    assert.ok(typeof result.reason     === "string");
    assert.ok(typeof result.coveragePercent === "number");
  });

  it("reason string is always non-empty", () => {
    const cases: AnswerTimingPolicyInput[] = [
      makeInput({ retrievalChunksActive: 0 }),
      makeInput({ retrievalChunksActive: 5, coveragePercent: 100 }),
      makeInput({ retrievalChunksActive: 5, coveragePercent: 50, fullCompletionBlocked: true }),
      makeInput({ retrievalChunksActive: 5, coveragePercent: MIN_COVERAGE_TO_ANSWER }),
    ];
    for (const input of cases) {
      const r = evaluateAnswerTiming(input);
      assert.ok(r.reason.length > 0, `Expected non-empty reason for input: ${JSON.stringify(input)}`);
    }
  });

});
