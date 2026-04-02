/**
 * Phase 5Z.5 — Tests: Live Answer Refinement Engine
 *
 * Validates:
 *  - New session starts in no_answer state
 *  - First usable text triggers first_partial_answer transition
 *  - More context triggers refined_partial_answer
 *  - Final completion triggers finalized_complete_answer
 *  - Duplicate generation does NOT re-trigger (idempotency)
 *  - Refinement count increments correctly
 *  - Session metrics are populated (firstAnswerAt, finalAnswerAt)
 *  - No duplicate refinement runs for same generation
 *  - getSessionCount and snapshotSession work
 *  - Multi-session isolation (different sessionKeys)
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  getOrCreateSession,
  evaluateRefinementTransition,
  clearSession,
  getSessionCount,
  snapshotSession,
  type RefinementSession,
} from "../../server/lib/media/live-answer-refinement.ts";
import type { OcrJobRefinementState } from "../../server/lib/media/refinement-policy.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

let _sessionSeq = 0;
function freshKey(): string {
  return `tenant-test:task-${++_sessionSeq}:user-1`;
}

function jobState(overrides: Partial<OcrJobRefinementState> = {}): OcrJobRefinementState {
  return { status: "running", stage: null, charCount: 0, pageCount: 0, ...overrides };
}

function runSession(key: string, states: OcrJobRefinementState[]) {
  const session     = getOrCreateSession(key);
  const transitions = states.map(s => evaluateRefinementTransition(session, s));
  return { session, transitions };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("getOrCreateSession", () => {
  it("creates a new session with no_answer state", () => {
    const key = freshKey();
    const s   = getOrCreateSession(key);
    assert.equal(s.lifecycleState, "no_answer");
    assert.equal(s.lastGeneration, 0);
    assert.equal(s.refinementCount, 0);
    assert.equal(s.firstAnswerAt, null);
    assert.equal(s.finalAnswerAt, null);
  });

  it("returns same session on subsequent calls", () => {
    const key = freshKey();
    const s1  = getOrCreateSession(key);
    const s2  = getOrCreateSession(key);
    assert.strictEqual(s1, s2, "must return the same session object");
  });
});

describe("evaluateRefinementTransition — no text", () => {
  it("returns not_ready when no text available", () => {
    const key = freshKey();
    const s   = getOrCreateSession(key);
    const t   = evaluateRefinementTransition(s, jobState({ charCount: 0 }));
    assert.equal(t.policy.action, "not_ready");
    assert.equal(t.shouldGenerateAnswer, false);
    assert.equal(s.lifecycleState, "no_answer");
    assert.equal(s.refinementCount, 0);
  });
});

describe("evaluateRefinementTransition — first partial answer", () => {
  it("transitions to first_partial_answer on first usable text", () => {
    const key = freshKey();
    const s   = getOrCreateSession(key);
    const t   = evaluateRefinementTransition(s, jobState({ stage: "partial_ready", charCount: 300 }));
    assert.equal(t.policy.action, "start_first_answer");
    assert.equal(t.shouldGenerateAnswer, true);
    assert.equal(s.lifecycleState, "first_partial_answer");
    assert.equal(s.refinementCount, 1);
    assert.ok(s.firstAnswerAt !== null, "firstAnswerAt should be set");
    assert.equal(t.supersedesGeneration, null);
    assert.equal(t.metrics.refinementCount, 1);
  });
});

describe("evaluateRefinementTransition — idempotency", () => {
  it("same generation does NOT re-trigger (no duplicate runs)", () => {
    const key = freshKey();
    const s   = getOrCreateSession(key);

    // First trigger
    evaluateRefinementTransition(s, jobState({ stage: "partial_ready", charCount: 300 }));
    const countAfterFirst = s.refinementCount;

    // Same state again — must be no_action
    const t2 = evaluateRefinementTransition(s, jobState({ stage: "partial_ready", charCount: 300 }));
    assert.equal(t2.policy.action, "no_action");
    assert.equal(t2.shouldGenerateAnswer, false);
    assert.equal(s.refinementCount, countAfterFirst, "refinementCount must not increase on no_action");
  });
});

describe("evaluateRefinementTransition — refinement sequence", () => {
  it("first_partial → refined_partial → finalized: full lifecycle", () => {
    const key = freshKey();
    const s   = getOrCreateSession(key);

    // Step 1: first partial
    const t1 = evaluateRefinementTransition(s, jobState({ stage: "partial_ready", charCount: 300 }));
    assert.equal(t1.policy.action, "start_first_answer");
    assert.equal(s.lifecycleState, "first_partial_answer");

    // Step 2: more pages → refined
    const t2 = evaluateRefinementTransition(s, jobState({ stage: "continuing", charCount: 2000, pageCount: 3 }));
    assert.equal(t2.policy.action, "refine_answer");
    assert.equal(s.lifecycleState, "refined_partial_answer");
    assert.equal(t2.supersedesGeneration, 1, "should supersede generation 1");
    assert.equal(s.refinementCount, 2);

    // Step 3: completed → finalized
    const t3 = evaluateRefinementTransition(s, jobState({ status: "completed", charCount: 10000, pageCount: 8 }));
    assert.equal(t3.policy.action, "finalize_answer");
    assert.equal(s.lifecycleState, "finalized_complete_answer");
    assert.equal(t3.supersedesGeneration, 2, "should supersede generation 2");
    assert.ok(s.finalAnswerAt !== null, "finalAnswerAt should be set after finalization");
    assert.equal(s.refinementCount, 3);
  });
});

describe("clearSession", () => {
  it("removes session from store", () => {
    const key = freshKey();
    getOrCreateSession(key);
    clearSession(key);
    const snapshot = snapshotSession(key);
    assert.equal(snapshot, null, "session should be gone after clear");
  });
});

describe("Multi-tenant isolation", () => {
  it("two different session keys operate independently", () => {
    const key1 = freshKey();
    const key2 = freshKey();

    const s1 = getOrCreateSession(key1);
    const s2 = getOrCreateSession(key2);

    evaluateRefinementTransition(s1, jobState({ stage: "partial_ready", charCount: 500 }));

    assert.equal(s1.lifecycleState, "first_partial_answer");
    assert.equal(s2.lifecycleState, "no_answer", "s2 must not be affected by s1 transition");
  });
});

describe("getSessionCount / snapshotSession", () => {
  it("getSessionCount returns positive integer after session creation", () => {
    getOrCreateSession(freshKey());
    assert.ok(getSessionCount() > 0);
  });

  it("snapshotSession returns session data for existing key", () => {
    const key = freshKey();
    getOrCreateSession(key);
    const snapshot = snapshotSession(key);
    assert.ok(snapshot !== null, "should return non-null for existing key");
    assert.equal(snapshot!.sessionKey, key);
  });

  it("snapshotSession returns null for unknown key", () => {
    assert.equal(snapshotSession("non-existent-key-xyz"), null);
  });
});
