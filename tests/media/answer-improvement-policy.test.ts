/**
 * Phase 5Z.3 — Tests: Answer Improvement Policy
 *
 * Validates that the policy:
 *  - Returns not_ready when zero chunks exist
 *  - Returns no_action when triggerKey unchanged (idempotent)
 *  - Returns start_first_partial_answer for first trigger with chunks
 *  - Returns finalize_complete_answer when document is completed
 *  - Returns refresh_partial_answer when coverage improved and key changed
 *  - Never returns finalize when fullCompletionBlocked=true
 *  - Returns no_action for dead_letter status
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateImprovementPolicy,
  shouldAutoStartAnswer,
  outcomeToUxLabel,
  type PolicyInputs,
} from "../../server/lib/media/answer-improvement-policy.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeInputs(overrides: Partial<PolicyInputs> = {}): PolicyInputs {
  return {
    documentStatus:          "processing",
    answerCompleteness:      "none",
    retrievalChunksActive:   0,
    previousCoveragePercent: 0,
    newCoveragePercent:      0,
    previousTriggerKey:      null,
    newTriggerKey:           "new-key-123",
    fullCompletionBlocked:   false,
    hasFailedSegments:       false,
    hasDeadLetterSegments:   false,
    ...overrides,
  };
}

// ── not_ready: zero chunks ─────────────────────────────────────────────────────

describe("evaluateImprovementPolicy() — not_ready (zero chunks)", () => {
  it("zero chunks → not_ready regardless of status", () => {
    const result = evaluateImprovementPolicy(makeInputs({ retrievalChunksActive: 0 }));
    assert.equal(result.outcome, "not_ready");
    assert.equal(result.shouldAutoTrigger, false);
    assert.equal(result.supersedesPrevious, false);
  });

  it("zero chunks → not_ready even when answerCompleteness=complete", () => {
    const result = evaluateImprovementPolicy(makeInputs({
      retrievalChunksActive: 0,
      answerCompleteness:    "complete",
      documentStatus:        "completed",
    }));
    assert.equal(result.outcome, "not_ready");
    assert.equal(result.shouldAutoTrigger, false);
  });
});

// ── no_action: duplicate trigger key (idempotent) ─────────────────────────────

describe("evaluateImprovementPolicy() — no_action (idempotent)", () => {
  it("same trigger key → no_action (duplicate suppressed)", () => {
    const result = evaluateImprovementPolicy(makeInputs({
      retrievalChunksActive: 10,
      previousTriggerKey:    "same-key-abc",
      newTriggerKey:         "same-key-abc",
    }));
    assert.equal(result.outcome, "no_action");
    assert.equal(result.shouldAutoTrigger, false);
    assert.equal(result.supersedesPrevious, false);
    assert.ok(result.reason.includes("same-key-abc"), "Reason should mention the key");
  });

  it("same key suppression works regardless of coverage/status", () => {
    const result = evaluateImprovementPolicy(makeInputs({
      retrievalChunksActive:   50,
      previousCoveragePercent: 100,
      newCoveragePercent:      100,
      answerCompleteness:      "complete",
      documentStatus:          "completed",
      previousTriggerKey:      "completed-key",
      newTriggerKey:           "completed-key",
    }));
    assert.equal(result.outcome, "no_action");
    assert.equal(result.shouldAutoTrigger, false);
  });
});

// ── start_first_partial_answer ────────────────────────────────────────────────

describe("evaluateImprovementPolicy() — start_first_partial_answer", () => {
  it("first trigger with chunks → start_first_partial_answer", () => {
    const result = evaluateImprovementPolicy(makeInputs({
      retrievalChunksActive: 10,
      newCoveragePercent:    30,
      previousTriggerKey:    null, // no previous answer
    }));
    assert.equal(result.outcome, "start_first_partial_answer");
    assert.equal(result.shouldAutoTrigger, true);
    assert.equal(result.supersedesPrevious, false);
  });

  it("first trigger carries chunk count in reason", () => {
    const result = evaluateImprovementPolicy(makeInputs({
      retrievalChunksActive: 25,
      newCoveragePercent:    40,
      previousTriggerKey:    null,
    }));
    assert.ok(result.reason.includes("40%") || result.reason.includes("25"), "Reason should mention coverage/chunks");
  });
});

// ── finalize_complete_answer ──────────────────────────────────────────────────

describe("evaluateImprovementPolicy() — finalize_complete_answer", () => {
  it("completed + full coverage + no block → finalize_complete_answer", () => {
    const result = evaluateImprovementPolicy(makeInputs({
      documentStatus:        "completed",
      answerCompleteness:    "complete",
      retrievalChunksActive: 100,
      newCoveragePercent:    100,
      fullCompletionBlocked: false,
      previousTriggerKey:    "prev-key-abc",
      newTriggerKey:         "new-key-xyz",
    }));
    assert.equal(result.outcome, "finalize_complete_answer");
    assert.equal(result.shouldAutoTrigger, true);
    assert.equal(result.supersedesPrevious, true);
  });

  it("first complete answer (no previous) → finalize with supersedesPrevious=false", () => {
    const result = evaluateImprovementPolicy(makeInputs({
      documentStatus:        "completed",
      answerCompleteness:    "complete",
      retrievalChunksActive: 100,
      newCoveragePercent:    100,
      fullCompletionBlocked: false,
      previousTriggerKey:    null,
    }));
    assert.equal(result.outcome, "finalize_complete_answer");
    assert.equal(result.supersedesPrevious, false);
  });

  it("fullCompletionBlocked=true prevents finalize_complete_answer", () => {
    const result = evaluateImprovementPolicy(makeInputs({
      documentStatus:        "completed",
      answerCompleteness:    "complete",
      retrievalChunksActive: 100,
      newCoveragePercent:    100,
      fullCompletionBlocked: true, // blocked!
      previousTriggerKey:    "prev-key",
      newTriggerKey:         "new-key",
    }));
    assert.notEqual(result.outcome, "finalize_complete_answer",
      "fullCompletionBlocked must prevent finalize — cannot confirm full coverage");
  });

  it("answerCompleteness=partial prevents finalize_complete_answer", () => {
    const result = evaluateImprovementPolicy(makeInputs({
      documentStatus:        "completed",
      answerCompleteness:    "partial", // NOT complete
      retrievalChunksActive: 80,
      newCoveragePercent:    80,
      fullCompletionBlocked: false,
      previousTriggerKey:    "prev",
      newTriggerKey:         "next",
    }));
    assert.notEqual(result.outcome, "finalize_complete_answer",
      "partial answerCompleteness must not trigger finalize");
  });
});

// ── refresh_partial_answer ────────────────────────────────────────────────────

describe("evaluateImprovementPolicy() — refresh_partial_answer", () => {
  it("coverage improved + previous answer + key changed → refresh", () => {
    const result = evaluateImprovementPolicy(makeInputs({
      retrievalChunksActive:   30,
      previousCoveragePercent: 25,
      newCoveragePercent:      50,
      previousTriggerKey:      "old-key",
      newTriggerKey:           "new-key",
    }));
    assert.equal(result.outcome, "refresh_partial_answer");
    assert.equal(result.shouldAutoTrigger, true);
    assert.equal(result.supersedesPrevious, true);
  });

  it("refresh reason mentions coverage improvement", () => {
    const result = evaluateImprovementPolicy(makeInputs({
      retrievalChunksActive:   20,
      previousCoveragePercent: 30,
      newCoveragePercent:      55,
      previousTriggerKey:      "k1",
      newTriggerKey:           "k2",
    }));
    assert.ok(
      result.reason.includes("30%") || result.reason.includes("55%"),
      "Reason should mention old and new coverage",
    );
  });
});

// ── no_action for dead_letter ─────────────────────────────────────────────────

describe("evaluateImprovementPolicy() — no_action for blocked statuses", () => {
  it("dead_letter + chunks + key changed + no coverage increase → no_action", () => {
    const result = evaluateImprovementPolicy(makeInputs({
      documentStatus:          "dead_letter",
      retrievalChunksActive:   5,
      previousCoveragePercent: 30,
      newCoveragePercent:      30, // same
      previousTriggerKey:      "k1",
      newTriggerKey:           "k2",
    }));
    assert.equal(result.outcome, "no_action",
      "Dead_letter with no coverage change → no_action");
    assert.equal(result.shouldAutoTrigger, false);
  });

  it("partially_ready_with_failures + no coverage change → no_action", () => {
    const result = evaluateImprovementPolicy(makeInputs({
      documentStatus:          "partially_ready_with_failures",
      retrievalChunksActive:   10,
      previousCoveragePercent: 50,
      newCoveragePercent:      50,
      previousTriggerKey:      "k1",
      newTriggerKey:           "k2",
    }));
    assert.equal(result.outcome, "no_action");
    assert.equal(result.shouldAutoTrigger, false);
  });
});

// ── shouldAutoStartAnswer ─────────────────────────────────────────────────────

describe("shouldAutoStartAnswer()", () => {
  it("start_first_partial_answer → should auto start", () => {
    const res = { outcome: "start_first_partial_answer" as const, reason: "", shouldAutoTrigger: true, supersedesPrevious: false };
    assert.equal(shouldAutoStartAnswer(res), true);
  });

  it("not_ready → should not auto start", () => {
    const res = { outcome: "not_ready" as const, reason: "", shouldAutoTrigger: false, supersedesPrevious: false };
    assert.equal(shouldAutoStartAnswer(res), false);
  });

  it("no_action → should not auto start", () => {
    const res = { outcome: "no_action" as const, reason: "", shouldAutoTrigger: false, supersedesPrevious: false };
    assert.equal(shouldAutoStartAnswer(res), false);
  });
});

// ── outcomeToUxLabel ──────────────────────────────────────────────────────────

describe("outcomeToUxLabel()", () => {
  it("all outcomes have a non-empty label", () => {
    const outcomes = [
      "start_first_partial_answer",
      "refresh_partial_answer",
      "finalize_complete_answer",
      "no_action",
      "not_ready",
    ] as const;
    for (const outcome of outcomes) {
      const label = outcomeToUxLabel(outcome);
      assert.ok(label.length > 0, `UX label for '${outcome}' must not be empty`);
    }
  });
});
