/**
 * refinement-policy-fine.test.ts
 *
 * Tests for PHASE 5Z.6 fine-grained refinement key and trigger logic.
 * Validates: hash stability, bucket rounding, trigger conditions, and
 * backwards-compatible legacy integer computation.
 */

import { test, describe } from "vitest";
import assert              from "node:assert/strict";

import {
  computeFineGrainedRefinementKey,
  shouldTriggerRefinement,
  evaluateRefinementPolicy,
  computeRefinementGeneration,
  type OcrJobRefinementState,
} from "../../server/lib/media/refinement-policy.ts";

// ── computeFineGrainedRefinementKey ────────────────────────────────────────────

describe("computeFineGrainedRefinementKey", () => {
  test("same inputs → same key (deterministic)", () => {
    const k1 = computeFineGrainedRefinementKey(["c1","c2"], 1000, 45, "partial");
    const k2 = computeFineGrainedRefinementKey(["c1","c2"], 1000, 45, "partial");
    assert.equal(k1, k2);
  });

  test("sorted chunkIds → same key regardless of input order", () => {
    const k1 = computeFineGrainedRefinementKey(["c2","c1"], 1000, 45, "partial");
    const k2 = computeFineGrainedRefinementKey(["c1","c2"], 1000, 45, "partial");
    assert.equal(k1, k2);
  });

  test("coverage 45% and 49% → same bucket key (rounds to 40)", () => {
    const k1 = computeFineGrainedRefinementKey(["c1"], 1000, 45, "partial");
    const k2 = computeFineGrainedRefinementKey(["c1"], 1000, 49, "partial");
    assert.equal(k1, k2, "45 and 49 both floor to 40%");
  });

  test("coverage 40% and 50% → different bucket key", () => {
    const k1 = computeFineGrainedRefinementKey(["c1"], 1000, 40, "partial");
    const k2 = computeFineGrainedRefinementKey(["c1"], 1000, 50, "partial");
    assert.notEqual(k1, k2);
  });

  test("different charCount → different key", () => {
    const k1 = computeFineGrainedRefinementKey(["c1"], 1000, 50, "partial");
    const k2 = computeFineGrainedRefinementKey(["c1"], 2000, 50, "partial");
    assert.notEqual(k1, k2);
  });

  test("different status → different key", () => {
    const k1 = computeFineGrainedRefinementKey(["c1"], 1000, 50, "partial");
    const k2 = computeFineGrainedRefinementKey(["c1"], 1000, 50, "completed");
    assert.notEqual(k1, k2);
  });

  test("different chunkIds → different key", () => {
    const k1 = computeFineGrainedRefinementKey(["c1","c2"], 1000, 50, "partial");
    const k2 = computeFineGrainedRefinementKey(["c1","c3"], 1000, 50, "partial");
    assert.notEqual(k1, k2);
  });

  test("empty chunkIds → valid 16-char hex key", () => {
    const k = computeFineGrainedRefinementKey([], 0, 0, "partial");
    assert.equal(k.length, 16);
    assert.match(k, /^[0-9a-f]+$/);
  });

  test("coverage clamped at 100 max", () => {
    const k1 = computeFineGrainedRefinementKey(["c1"], 1000, 100, "completed");
    const k2 = computeFineGrainedRefinementKey(["c1"], 1000, 150, "completed");
    assert.equal(k1, k2, "both clamp to 100");
  });

  test("coverage clamped at 0 min", () => {
    const k1 = computeFineGrainedRefinementKey(["c1"], 1000, 0,  "partial");
    const k2 = computeFineGrainedRefinementKey(["c1"], 1000, -5, "partial");
    assert.equal(k1, k2, "negative coverage clamps to 0");
  });
});

// ── shouldTriggerRefinement ────────────────────────────────────────────────────

describe("shouldTriggerRefinement", () => {
  test("no previous key → always trigger", () => {
    const r = shouldTriggerRefinement({
      prevKey: null,             prevCharCount: 0, prevCoveragePercent: 0,
      currentKey: "abc123",     currentCharCount: 1000, currentCoveragePercent: 40,
      currentStatus: "partial",
    });
    assert.equal(r.trigger, true);
    assert.equal(r.reason, "no_previous_answer");
  });

  test("same key → no trigger", () => {
    const r = shouldTriggerRefinement({
      prevKey: "abc",            prevCharCount: 1000, prevCoveragePercent: 40,
      currentKey: "abc",        currentCharCount: 1100, currentCoveragePercent: 44,
      currentStatus: "partial",
    });
    assert.equal(r.trigger, false);
    assert.equal(r.reason, "no_context_change");
  });

  test("delta_chars >= 500 → trigger", () => {
    const r = shouldTriggerRefinement({
      prevKey: "key1",           prevCharCount: 1000, prevCoveragePercent: 30,
      currentKey: "key2",       currentCharCount: 1600, currentCoveragePercent: 35,
      currentStatus: "partial",
    });
    assert.equal(r.trigger, true);
    assert.ok(r.reason.includes("delta_chars"));
  });

  test("delta_chars < 500 but key changed → no trigger (trivial change)", () => {
    const r = shouldTriggerRefinement({
      prevKey: "key1",           prevCharCount: 1000, prevCoveragePercent: 30,
      currentKey: "key2",       currentCharCount: 1200, currentCoveragePercent: 35,
      currentStatus: "partial",
    });
    assert.equal(r.trigger, false);
    assert.equal(r.reason, "trivial_change_below_threshold");
  });

  test("coverage delta >= 10% → trigger", () => {
    const r = shouldTriggerRefinement({
      prevKey: "key1",           prevCharCount: 1000, prevCoveragePercent: 30,
      currentKey: "key2",       currentCharCount: 1200, currentCoveragePercent: 42,
      currentStatus: "partial",
    });
    assert.equal(r.trigger, true);
    assert.ok(r.reason.includes("coverage_up"));
  });

  test("coverage delta < 10% → no trigger if chars below threshold too", () => {
    const r = shouldTriggerRefinement({
      prevKey: "key1",           prevCharCount: 1000, prevCoveragePercent: 30,
      currentKey: "key2",       currentCharCount: 1100, currentCoveragePercent: 37,
      currentStatus: "partial",
    });
    assert.equal(r.trigger, false);
  });

  test("status=completed → always trigger", () => {
    const r = shouldTriggerRefinement({
      prevKey: "key1",           prevCharCount: 1000, prevCoveragePercent: 80,
      currentKey: "key2",       currentCharCount: 1050, currentCoveragePercent: 84,
      currentStatus: "completed",
    });
    assert.equal(r.trigger, true);
    assert.ok(r.reason.includes("status_completed"));
  });

  test("multiple reasons accumulated", () => {
    const r = shouldTriggerRefinement({
      prevKey: "key1",           prevCharCount: 500,  prevCoveragePercent: 10,
      currentKey: "key2",       currentCharCount: 2000, currentCoveragePercent: 80,
      currentStatus: "completed",
    });
    assert.equal(r.trigger, true);
    assert.ok(r.reason.includes("delta_chars"));
    assert.ok(r.reason.includes("coverage_up"));
    assert.ok(r.reason.includes("status_completed"));
  });
});

// ── evaluateRefinementPolicy (fine-grained) ───────────────────────────────────

describe("evaluateRefinementPolicy — fine-grained", () => {
  const baseState: OcrJobRefinementState = {
    status: "running", stage: "partial_ready",
    charCount: 1200, pageCount: 1,
    chunkIds: ["c1", "c2"], coveragePercent: 45,
  };

  test("no previous → start_first_answer", () => {
    const res = evaluateRefinementPolicy(null, 0, 0, 0, baseState);
    assert.equal(res.action, "start_first_answer");
    assert.equal(res.shouldAutoTrigger, true);
    assert.equal(res.supersedesPrevious, false);
  });

  test("completed status → finalize_answer", () => {
    const state: OcrJobRefinementState = { ...baseState, status: "completed" };
    const prevKey = computeFineGrainedRefinementKey(["c1","c2"], 800, 30, "partial");
    const res = evaluateRefinementPolicy(prevKey, 1, 800, 30, state);
    assert.equal(res.action, "finalize_answer");
    assert.equal(res.answerCompleteness, "complete");
    assert.equal(res.refinementGeneration, 3);
  });

  test("no_action when context trivially changed", () => {
    const currentKey = computeFineGrainedRefinementKey(baseState.chunkIds!, baseState.charCount, baseState.coveragePercent!, baseState.status);
    const prevCharCount = baseState.charCount - 100;
    const prevKey = computeFineGrainedRefinementKey(baseState.chunkIds!, prevCharCount, baseState.coveragePercent! - 3, "partial");
    const res = evaluateRefinementPolicy(prevKey, 1, prevCharCount, (baseState.coveragePercent ?? 0) - 3, baseState);
    assert.equal(res.action, "no_action");
    assert.equal(res.shouldAutoTrigger, false);
  });

  test("not_ready when charCount=0", () => {
    const state: OcrJobRefinementState = { ...baseState, charCount: 0, stage: null };
    const res = evaluateRefinementPolicy(null, 0, 0, 0, state);
    assert.equal(res.action, "not_ready");
  });

  test("refinementGenKey returned on every result", () => {
    const res = evaluateRefinementPolicy(null, 0, 0, 0, baseState);
    assert.ok(res.refinementGenKey);
    assert.equal(res.refinementGenKey.length, 16);
  });

  test("triggerReason populated", () => {
    const res = evaluateRefinementPolicy(null, 0, 0, 0, baseState);
    assert.ok(res.triggerReason.length > 0);
  });
});

// ── computeRefinementGeneration (backwards compat) ───────────────────────────

describe("computeRefinementGeneration — legacy integers", () => {
  test("completed → 3", () => {
    assert.equal(computeRefinementGeneration({ status: "completed", stage: "done", charCount: 5000, pageCount: 5 }), 3);
  });
  test("partial_ready stage → 1", () => {
    assert.equal(computeRefinementGeneration({ status: "running", stage: "partial_ready", charCount: 200, pageCount: 1 }), 1);
  });
  test("continuing with chars → 2", () => {
    assert.equal(computeRefinementGeneration({ status: "running", stage: "continuing", charCount: 2000, pageCount: 3 }), 2);
  });
  test("no chars → 0", () => {
    assert.equal(computeRefinementGeneration({ status: "running", stage: null, charCount: 0, pageCount: 0 }), 0);
  });
});
