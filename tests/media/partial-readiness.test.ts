/**
 * Phase 5Z.2 — Tests: Partial Readiness Invariants (pure logic)
 *
 * Tests the INV-PR1 guard and partialWarning/answerCompleteness contract
 * without a live DB, by re-implementing the guard logic inline.
 *
 * INV-PR1: partialWarning is null iff answerCompleteness === "complete".
 * INV-PR2: coveragePercent is always 0–100 (clamped).
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";

// ── Re-implement the pure invariant guard (mirrors partial-readiness.ts) ──────

type AnswerCompleteness = "none" | "partial" | "complete";

interface MockAggregation {
  documentStatus:   string;
  answerCompleteness: AnswerCompleteness;
  coveragePercent:  number;
}

function buildPartialWarning(status: string, coveragePercent: number): string | null {
  switch (status) {
    case "completed":              return null;
    case "partially_ready_with_failures":
      return `Only ${coveragePercent}% of this document has been processed. Some sections could not be processed.`;
    case "partially_ready":
      return `This document is still being processed (${coveragePercent}% ready). Answers may be incomplete.`;
    case "retryable_failed":
      return "Document processing failed and will be retried. Answers are unavailable until it succeeds.";
    case "failed":
      return "Document processing failed. Please re-upload or contact support.";
    case "dead_letter":
      return "Document processing permanently failed after multiple attempts.";
    case "processing":
      return "Document is being processed. Answers will be available soon.";
    case "not_started":
      return "Document processing has not started yet.";
    default:
      return "Document status is unknown.";
  }
}

function enforceInvariants(agg: MockAggregation): {
  answerCompleteness: AnswerCompleteness;
  coveragePercent:    number;
  partialWarning:     string | null;
  inv1Triggered:      boolean;
  inv1FallbackUsed:   boolean;
} {
  // INV-PR2: clamp
  const coveragePercent = Math.max(0, Math.min(100, agg.coveragePercent));

  // INV-PR1 guard (same as production code)
  let answerCompleteness = agg.answerCompleteness;
  let inv1Triggered = false;
  if (answerCompleteness === "complete" && coveragePercent < 100) {
    answerCompleteness = "partial";
    inv1Triggered = true;
  }

  let partialWarning = buildPartialWarning(agg.documentStatus, coveragePercent);
  let inv1FallbackUsed = false;
  if (answerCompleteness !== "complete" && partialWarning === null) {
    partialWarning = `Document coverage is ${coveragePercent}% — answers may be incomplete until processing finishes.`;
    inv1FallbackUsed = true;
  } else if (answerCompleteness === "complete" && partialWarning !== null) {
    partialWarning = null;
  }

  return { answerCompleteness, coveragePercent, partialWarning, inv1Triggered, inv1FallbackUsed };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("partial-readiness — INV-PR1 invariant guard", () => {

  it("INV-PR1: completed with 100% → partialWarning is null", () => {
    const result = enforceInvariants({
      documentStatus:     "completed",
      answerCompleteness: "complete",
      coveragePercent:    100,
    });
    assert.equal(result.answerCompleteness, "complete");
    assert.equal(result.partialWarning, null);
    assert.equal(result.inv1Triggered, false);
  });

  it("INV-PR1: completed but coverage < 100 → answerCompleteness downgraded + fallback warning generated", () => {
    const result = enforceInvariants({
      documentStatus:     "completed",
      answerCompleteness: "complete",
      coveragePercent:    80,
    });
    assert.equal(result.answerCompleteness, "partial");
    assert.notEqual(result.partialWarning, null, "partialWarning must not be null after INV-PR1 downgrade");
    assert.ok(result.partialWarning!.length > 0);
    assert.equal(result.inv1Triggered, true);
    assert.equal(result.inv1FallbackUsed, true);
  });

  it("INV-PR1: partial_ready → partialWarning is always non-null", () => {
    const result = enforceInvariants({
      documentStatus:     "partially_ready",
      answerCompleteness: "partial",
      coveragePercent:    55,
    });
    assert.equal(result.answerCompleteness, "partial");
    assert.notEqual(result.partialWarning, null);
    assert.ok(result.partialWarning!.includes("55%"));
  });

  it("INV-PR1: partially_ready_with_failures → warning includes coverage", () => {
    const result = enforceInvariants({
      documentStatus:     "partially_ready_with_failures",
      answerCompleteness: "partial",
      coveragePercent:    33,
    });
    assert.notEqual(result.partialWarning, null);
    assert.ok(result.partialWarning!.includes("33%"));
  });

  it("INV-PR1: processing → partialWarning is non-null", () => {
    const result = enforceInvariants({
      documentStatus:     "processing",
      answerCompleteness: "none",
      coveragePercent:    0,
    });
    assert.notEqual(result.partialWarning, null);
  });

  it("INV-PR1: dead_letter → partialWarning is non-null", () => {
    const result = enforceInvariants({
      documentStatus:     "dead_letter",
      answerCompleteness: "none",
      coveragePercent:    0,
    });
    assert.notEqual(result.partialWarning, null);
  });

  it("INV-PR1: failed → partialWarning is non-null", () => {
    const result = enforceInvariants({
      documentStatus:     "failed",
      answerCompleteness: "none",
      coveragePercent:    0,
    });
    assert.notEqual(result.partialWarning, null);
  });

  it("INV-PR2: coveragePercent clamped to 0–100 (above 100)", () => {
    const result = enforceInvariants({
      documentStatus:     "partially_ready",
      answerCompleteness: "partial",
      coveragePercent:    150,
    });
    assert.equal(result.coveragePercent, 100);
  });

  it("INV-PR2: coveragePercent clamped to 0–100 (below 0)", () => {
    const result = enforceInvariants({
      documentStatus:     "processing",
      answerCompleteness: "none",
      coveragePercent:    -10,
    });
    assert.equal(result.coveragePercent, 0);
  });

  it("partialWarning is null iff answerCompleteness is complete — property holds for all status values", () => {
    const statuses = [
      "completed", "partially_ready", "partially_ready_with_failures",
      "processing", "retryable_failed", "failed", "dead_letter", "not_started",
    ];
    for (const documentStatus of statuses) {
      const isComplete = documentStatus === "completed";
      const result = enforceInvariants({
        documentStatus,
        answerCompleteness: isComplete ? "complete" : "none",
        coveragePercent:    isComplete ? 100 : 0,
      });
      if (result.answerCompleteness === "complete") {
        assert.equal(result.partialWarning, null, `${documentStatus}: expected null warning when complete`);
      } else {
        assert.notEqual(result.partialWarning, null, `${documentStatus}: expected non-null warning when not complete`);
      }
    }
  });

});
