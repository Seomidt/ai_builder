/**
 * Phase 5Z.5 — Tests: Refinement Policy
 *
 * Validates:
 *  - computeRefinementGeneration returns correct integer for each state
 *  - evaluateRefinementPolicy returns correct action for each transition
 *  - No duplicate actions for same generation (idempotency)
 *  - Finalization only happens on status=completed
 *  - not_ready when no usable text exists
 *  - Human-readable labels for all actions
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  computeRefinementGeneration,
  evaluateRefinementPolicy,
  refinementActionLabel,
  type OcrJobRefinementState,
} from "../../server/lib/media/refinement-policy.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

function state(overrides: Partial<OcrJobRefinementState> = {}): OcrJobRefinementState {
  return {
    status:    "running",
    stage:     null,
    charCount: 0,
    pageCount: 0,
    ...overrides,
  };
}

// ── computeRefinementGeneration ────────────────────────────────────────────────

describe("computeRefinementGeneration", () => {
  it("returns 0 when no usable text and not completed", () => {
    assert.equal(computeRefinementGeneration(state({ status: "pending", charCount: 0 })), 0);
  });

  it("returns 1 for partial_ready stage", () => {
    assert.equal(
      computeRefinementGeneration(state({ stage: "partial_ready", charCount: 100 })),
      1,
    );
  });

  it("returns 1 for running state with chars but no stage", () => {
    assert.equal(
      computeRefinementGeneration(state({ status: "running", charCount: 500, stage: null })),
      1,
    );
  });

  it("returns 2 for continuing stage", () => {
    assert.equal(
      computeRefinementGeneration(state({ stage: "continuing", charCount: 2000 })),
      2,
    );
  });

  it("returns 2 for chunking stage", () => {
    assert.equal(
      computeRefinementGeneration(state({ stage: "chunking", charCount: 5000 })),
      2,
    );
  });

  it("returns 3 for completed status", () => {
    assert.equal(
      computeRefinementGeneration(state({ status: "completed", charCount: 10000 })),
      3,
    );
  });
});

// ── evaluateRefinementPolicy ───────────────────────────────────────────────────

describe("evaluateRefinementPolicy", () => {
  it("returns not_ready when no usable text", () => {
    const result = evaluateRefinementPolicy(0, state({ charCount: 0 }));
    assert.equal(result.action, "not_ready");
    assert.equal(result.shouldAutoTrigger, false);
  });

  it("returns start_first_answer when first usable text arrives", () => {
    const result = evaluateRefinementPolicy(0, state({ stage: "partial_ready", charCount: 300 }));
    assert.equal(result.action, "start_first_answer");
    assert.equal(result.shouldAutoTrigger, true);
    assert.equal(result.supersedesPrevious, false);
    assert.equal(result.answerCompleteness, "partial");
    assert.equal(result.refinementGeneration, 1);
  });

  it("returns no_action when generation is unchanged", () => {
    const result = evaluateRefinementPolicy(1, state({ stage: "partial_ready", charCount: 300 }));
    assert.equal(result.action, "no_action");
    assert.equal(result.shouldAutoTrigger, false);
  });

  it("returns refine_answer when generation improves from 1 to 2", () => {
    const result = evaluateRefinementPolicy(1, state({ stage: "continuing", charCount: 2000, pageCount: 3 }));
    assert.equal(result.action, "refine_answer");
    assert.equal(result.shouldAutoTrigger, true);
    assert.equal(result.supersedesPrevious, true);
    assert.equal(result.answerCompleteness, "partial");
    assert.equal(result.refinementGeneration, 2);
  });

  it("returns finalize_answer when job completes", () => {
    const result = evaluateRefinementPolicy(2, state({ status: "completed", charCount: 10000 }));
    assert.equal(result.action, "finalize_answer");
    assert.equal(result.shouldAutoTrigger, true);
    assert.equal(result.supersedesPrevious, true);
    assert.equal(result.answerCompleteness, "complete");
    assert.equal(result.refinementGeneration, 3);
  });

  it("idempotency — no_action when already at completed generation", () => {
    const result = evaluateRefinementPolicy(3, state({ status: "completed", charCount: 10000 }));
    assert.equal(result.action, "no_action");
    assert.equal(result.shouldAutoTrigger, false);
  });

  it("direct 0→3 start: treats as start_first_answer (first answer wins)", () => {
    const result = evaluateRefinementPolicy(0, state({ status: "completed", charCount: 5000 }));
    assert.equal(result.action, "start_first_answer");
    assert.equal(result.answerCompleteness, "complete");
  });
});

// ── refinementActionLabel ──────────────────────────────────────────────────────

describe("refinementActionLabel", () => {
  const actions = [
    "start_first_answer", "refine_answer", "finalize_answer", "no_action", "not_ready",
  ] as const;

  for (const action of actions) {
    it(`returns non-empty label for "${action}"`, () => {
      const label = refinementActionLabel(action);
      assert.ok(label.length > 0, `label for "${action}" should not be empty`);
    });
  }
});
