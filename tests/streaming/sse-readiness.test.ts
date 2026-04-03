/**
 * Phase 5Z.3 — Tests: SSE Readiness Stream (Integration-style)
 *
 * Tester SSE endpoint-logikken ved at kalde de underliggende hjælpefunktioner
 * og simulere events der ville blive sendt til klienten.
 *
 * Da SSE endpoint kræver en aktiv DB-forbindelse, tester vi:
 *  1. Event-format-validering (at events har korrekte felter)
 *  2. Policy → event-mapping
 *  3. Trigger key → idempotency (ingen duplikate events for same key)
 *  4. UX state machine (at state transitions er gyldige)
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  generateTriggerKey,
  shouldSuppressTrigger,
} from "../../server/lib/media/readiness-trigger-key.ts";
import {
  evaluateImprovementPolicy,
  shouldAutoStartAnswer,
} from "../../server/lib/media/answer-improvement-policy.ts";

// ── Helper: simulate a readiness → policy → event cycle ───────────────────────

function simulateReadinessCycle(params: {
  documentStatus:        string;
  coveragePercent:       number;
  retrievalChunksActive: number;
  firstRetrievalReadyAt: string | null;
  previousTriggerKey:    string | null;
  previousCoveragePercent: number;
}) {
  const triggerResult = generateTriggerKey({
    documentId:            "doc-sse-test",
    documentStatus:        params.documentStatus,
    coveragePercent:       params.coveragePercent,
    firstRetrievalReadyAt: params.firstRetrievalReadyAt,
    retrievalChunksActive: params.retrievalChunksActive,
  });

  const policyResult = evaluateImprovementPolicy({
    documentStatus:          params.documentStatus,
    answerCompleteness:      params.coveragePercent >= 100 ? "complete" : params.retrievalChunksActive > 0 ? "partial" : "none",
    retrievalChunksActive:   params.retrievalChunksActive,
    previousCoveragePercent: params.previousCoveragePercent,
    newCoveragePercent:      params.coveragePercent,
    previousTriggerKey:      params.previousTriggerKey,
    newTriggerKey:           triggerResult.key,
    fullCompletionBlocked:   false,
    hasFailedSegments:       false,
    hasDeadLetterSegments:   false,
  });

  return { triggerResult, policyResult };
}

// ── Event format tests ─────────────────────────────────────────────────────────

describe("SSE event format — partial_ready event", () => {
  it("first partial-ready event has correct structure", () => {
    const { triggerResult, policyResult } = simulateReadinessCycle({
      documentStatus:         "processing",
      coveragePercent:        30,
      retrievalChunksActive:  10,
      firstRetrievalReadyAt:  "2024-01-01T10:00:00.000Z",
      previousTriggerKey:     null,
      previousCoveragePercent: 0,
    });

    // Event that would be sent
    const event = {
      type:           "partial_ready",
      triggerKey:     triggerResult.key,
      coveragePercent: 30,
      chunkCount:     10,
      shouldAutoTrigger: policyResult.shouldAutoTrigger,
      policy:         policyResult.outcome,
    };

    assert.equal(event.type, "partial_ready");
    assert.match(event.triggerKey, /^[0-9a-f]{12}$/);
    assert.equal(event.coveragePercent, 30);
    assert.equal(event.chunkCount, 10);
    assert.equal(event.shouldAutoTrigger, true, "First partial answer should auto-trigger");
    assert.equal(event.policy, "start_first_partial_answer");
  });

  it("completed event has correct structure", () => {
    const { triggerResult, policyResult } = simulateReadinessCycle({
      documentStatus:         "completed",
      coveragePercent:        100,
      retrievalChunksActive:  50,
      firstRetrievalReadyAt:  "2024-01-01T10:00:00.000Z",
      previousTriggerKey:     "old-key-abc",
      previousCoveragePercent: 75,
    });

    const event = {
      type:           "completed",
      triggerKey:     triggerResult.key,
      coveragePercent: 100,
      policy:         policyResult.outcome,
      shouldAutoTrigger: policyResult.shouldAutoTrigger,
    };

    assert.equal(event.type, "completed");
    assert.match(event.triggerKey, /^[0-9a-f]{12}$/);
    assert.equal(event.coveragePercent, 100);
    assert.equal(event.policy, "finalize_complete_answer");
    assert.equal(event.shouldAutoTrigger, true);
  });
});

// ── Idempotency: geen duplicate events voor same triggerKey ───────────────────

describe("SSE event idempotency — no duplicate triggers per key", () => {
  it("two polls with same state → second is suppressed", () => {
    const pollInputs = {
      documentStatus:         "processing",
      coveragePercent:        40,
      retrievalChunksActive:  15,
      firstRetrievalReadyAt:  "2024-01-01T10:00:00.000Z",
      previousTriggerKey:     null,
      previousCoveragePercent: 0,
    };

    // First poll: produces trigger, auto-triggers
    const first = simulateReadinessCycle(pollInputs);
    assert.equal(first.policyResult.shouldAutoTrigger, true, "First poll should auto-trigger");

    // Second poll: same state, client echoes back the key as previousTriggerKey
    const second = simulateReadinessCycle({
      ...pollInputs,
      previousTriggerKey: first.triggerResult.key,
    });

    // Key comparison: same state → same key → suppress
    const suppressed = shouldSuppressTrigger(first.triggerResult.key, second.triggerResult.key);
    assert.equal(suppressed, true, "Same key on second poll must be suppressed");

    // Even if policyResult isn't suppressed at module level, the hook suppresses via key comparison
    assert.equal(second.triggerResult.key, first.triggerResult.key,
      "Same state must yield same key — idempotency guarantee");
  });

  it("reconnect after disconnect → same key → no duplicate trigger", () => {
    const triggerKey = generateTriggerKey({
      documentId:            "doc-reconnect",
      documentStatus:        "processing",
      coveragePercent:       50,
      firstRetrievalReadyAt: "2024-01-01T10:00:00.000Z",
      retrievalChunksActive: 20,
    });

    // After reconnect, same state → same key
    const triggerKeyAfterReconnect = generateTriggerKey({
      documentId:            "doc-reconnect",
      documentStatus:        "processing",
      coveragePercent:       50,
      firstRetrievalReadyAt: "2024-01-01T10:00:00.000Z",
      retrievalChunksActive: 20,
    });

    assert.equal(triggerKey.key, triggerKeyAfterReconnect.key,
      "Same state after reconnect must yield same key");
    assert.equal(shouldSuppressTrigger(triggerKey.key, triggerKeyAfterReconnect.key), true,
      "Reconnect with same key must be suppressed — no double trigger");
  });
});

// ── UX state machine: gyldige state-transitions ───────────────────────────────

describe("SSE → UX state machine transitions", () => {
  it("not_ready → idle (no action)", () => {
    const policy = evaluateImprovementPolicy({
      documentStatus:          "processing",
      answerCompleteness:      "none",
      retrievalChunksActive:   0, // zero chunks
      previousCoveragePercent: 0,
      newCoveragePercent:      0,
      previousTriggerKey:      null,
      newTriggerKey:           "any",
      fullCompletionBlocked:   false,
      hasFailedSegments:       false,
      hasDeadLetterSegments:   false,
    });
    assert.equal(policy.outcome, "not_ready");
    assert.equal(shouldAutoStartAnswer(policy), false, "not_ready must NOT auto-start");
  });

  it("start_first_partial_answer → auto-start (idle → awaiting_answer)", () => {
    const policy = evaluateImprovementPolicy({
      documentStatus:          "processing",
      answerCompleteness:      "partial",
      retrievalChunksActive:   5,
      previousCoveragePercent: 0,
      newCoveragePercent:      25,
      previousTriggerKey:      null,
      newTriggerKey:           "first-key",
      fullCompletionBlocked:   false,
      hasFailedSegments:       false,
      hasDeadLetterSegments:   false,
    });
    assert.equal(policy.outcome, "start_first_partial_answer");
    assert.equal(shouldAutoStartAnswer(policy), true, "start_first_partial_answer must auto-start");
  });

  it("finalize_complete_answer → auto-start + supersedesPrevious (final generation)", () => {
    const policy = evaluateImprovementPolicy({
      documentStatus:          "completed",
      answerCompleteness:      "complete",
      retrievalChunksActive:   100,
      previousCoveragePercent: 75,
      newCoveragePercent:      100,
      previousTriggerKey:      "prev-key",
      newTriggerKey:           "final-key",
      fullCompletionBlocked:   false,
      hasFailedSegments:       false,
      hasDeadLetterSegments:   false,
    });
    assert.equal(policy.outcome, "finalize_complete_answer");
    assert.equal(shouldAutoStartAnswer(policy), true, "finalize must auto-start");
    assert.equal(policy.supersedesPrevious, true, "finalize must supersede previous answer");
  });
});

// ── Tenant isolation: different documents → different trigger keys ─────────────

describe("SSE tenant isolation", () => {
  it("two documents with same state produce different trigger keys", () => {
    const k1 = generateTriggerKey({
      documentId:            "doc-tenant-x-001",
      documentStatus:        "processing",
      coveragePercent:       40,
      firstRetrievalReadyAt: "2024-01-01T10:00:00.000Z",
      retrievalChunksActive: 10,
    });
    const k2 = generateTriggerKey({
      documentId:            "doc-tenant-y-002",
      documentStatus:        "processing",
      coveragePercent:       40,
      firstRetrievalReadyAt: "2024-01-01T10:00:00.000Z",
      retrievalChunksActive: 10,
    });

    assert.notEqual(k1.key, k2.key,
      "Different documents must produce different keys — tenant isolation in SSE stream");
  });
});

// ── Policy coverage: alle 5 outcomes kan produceres ───────────────────────────

describe("evaluateImprovementPolicy() — full outcome coverage", () => {
  const cases: Array<{ label: string; inputs: Parameters<typeof evaluateImprovementPolicy>[0]; expected: string }> = [
    {
      label: "not_ready (0 chunks)",
      expected: "not_ready",
      inputs: {
        documentStatus: "processing", answerCompleteness: "none",
        retrievalChunksActive: 0, previousCoveragePercent: 0, newCoveragePercent: 0,
        previousTriggerKey: null, newTriggerKey: "k1",
        fullCompletionBlocked: false, hasFailedSegments: false, hasDeadLetterSegments: false,
      },
    },
    {
      label: "no_action (same key)",
      expected: "no_action",
      inputs: {
        documentStatus: "processing", answerCompleteness: "partial",
        retrievalChunksActive: 10, previousCoveragePercent: 30, newCoveragePercent: 30,
        previousTriggerKey: "same", newTriggerKey: "same",
        fullCompletionBlocked: false, hasFailedSegments: false, hasDeadLetterSegments: false,
      },
    },
    {
      label: "start_first_partial_answer (first trigger)",
      expected: "start_first_partial_answer",
      inputs: {
        documentStatus: "processing", answerCompleteness: "partial",
        retrievalChunksActive: 8, previousCoveragePercent: 0, newCoveragePercent: 25,
        previousTriggerKey: null, newTriggerKey: "new-k",
        fullCompletionBlocked: false, hasFailedSegments: false, hasDeadLetterSegments: false,
      },
    },
    {
      label: "refresh_partial_answer (coverage improved)",
      expected: "refresh_partial_answer",
      inputs: {
        documentStatus: "processing", answerCompleteness: "partial",
        retrievalChunksActive: 20, previousCoveragePercent: 25, newCoveragePercent: 50,
        previousTriggerKey: "old", newTriggerKey: "new",
        fullCompletionBlocked: false, hasFailedSegments: false, hasDeadLetterSegments: false,
      },
    },
    {
      label: "finalize_complete_answer (completed)",
      expected: "finalize_complete_answer",
      inputs: {
        documentStatus: "completed", answerCompleteness: "complete",
        retrievalChunksActive: 50, previousCoveragePercent: 75, newCoveragePercent: 100,
        previousTriggerKey: "k-prev", newTriggerKey: "k-final",
        fullCompletionBlocked: false, hasFailedSegments: false, hasDeadLetterSegments: false,
      },
    },
  ];

  for (const { label, inputs, expected } of cases) {
    it(`${label} → outcome="${expected}"`, () => {
      const result = evaluateImprovementPolicy(inputs);
      assert.equal(result.outcome, expected, `Expected "${expected}" for case: ${label}`);
    });
  }
});
