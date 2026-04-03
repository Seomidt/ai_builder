/**
 * Phase 5Z.3 — Answer Improvement Policy
 *
 * Deterministic policy that decides whether (and how) a new readiness
 * generation should affect the current answer state.
 *
 * This is a PURE function — no DB access, no side effects.
 *
 * Design rules (Phase 5Z.3 spec):
 *  - Conservative: only start/refresh answers when there is a material improvement
 *  - Never suggest an answer for zero validated chunks
 *  - Never suggest "finalize" unless backend says answerCompleteness === "complete"
 *  - Never suggest refresh unless the trigger key genuinely changed
 *  - Duplicate triggers for same key → no_action (idempotency)
 *  - fullCompletionBlocked → never finalize_complete_answer
 *
 * Outcomes:
 *  - start_first_partial_answer  — first time retrieval-ready chunks exist
 *  - refresh_partial_answer      — better coverage available; supersedes previous
 *  - finalize_complete_answer    — full coverage reached, no more improvements expected
 *  - no_action                   — state changed but not enough to warrant new answer
 *  - not_ready                   — no valid chunks exist, cannot answer
 */

import type { AnswerCompleteness, AggregatedDocumentStatus } from "./segment-aggregator.ts";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PolicyOutcome =
  | "start_first_partial_answer"
  | "refresh_partial_answer"
  | "finalize_complete_answer"
  | "no_action"
  | "not_ready";

export interface PolicyInputs {
  /** Current document processing status. */
  documentStatus:        AggregatedDocumentStatus;
  /** Current answer completeness from aggregation. */
  answerCompleteness:    AnswerCompleteness;
  /** Active retrieval-ready chunks right now. */
  retrievalChunksActive: number;
  /** Coverage from previous readiness generation (0 if no previous). */
  previousCoveragePercent: number;
  /** Coverage from new readiness generation. */
  newCoveragePercent:    number;
  /** Trigger key of the previous answer generation (null if no previous answer). */
  previousTriggerKey:    string | null;
  /** Trigger key of the new readiness generation. */
  newTriggerKey:         string;
  /** True if full completion is permanently blocked (dead-letter segments). */
  fullCompletionBlocked: boolean;
  /** True if any segments have failed (retryable). */
  hasFailedSegments:     boolean;
  /** True if any segments are in dead-letter state. */
  hasDeadLetterSegments: boolean;
}

export interface PolicyResult {
  outcome:        PolicyOutcome;
  reason:         string;
  /** True if the client should immediately start a new answer generation. */
  shouldAutoTrigger: boolean;
  /** True if a new answer will supersede a previous one. */
  supersedesPrevious: boolean;
}

// ── Policy ────────────────────────────────────────────────────────────────────

/**
 * Evaluates the answer improvement policy for the given readiness transition.
 * Returns a deterministic outcome and action recommendation.
 */
export function evaluateImprovementPolicy(inputs: PolicyInputs): PolicyResult {
  const {
    documentStatus,
    answerCompleteness,
    retrievalChunksActive,
    previousCoveragePercent,
    newCoveragePercent,
    previousTriggerKey,
    newTriggerKey,
    fullCompletionBlocked,
  } = inputs;

  // ── Guard: no chunks → not_ready ──────────────────────────────────────────
  if (retrievalChunksActive === 0) {
    return {
      outcome:            "not_ready",
      reason:             "No validated retrieval-ready chunks exist — cannot start answer",
      shouldAutoTrigger:  false,
      supersedesPrevious: false,
    };
  }

  // ── Guard: same trigger key as previous answer → idempotent no_action ────
  if (previousTriggerKey !== null && previousTriggerKey === newTriggerKey) {
    return {
      outcome:            "no_action",
      reason:             `Trigger key unchanged (${newTriggerKey}) — duplicate trigger suppressed`,
      shouldAutoTrigger:  false,
      supersedesPrevious: false,
    };
  }

  // ── Path: full completion available ───────────────────────────────────────
  if (
    answerCompleteness === "complete" &&
    documentStatus === "completed" &&
    !fullCompletionBlocked
  ) {
    if (previousTriggerKey === null) {
      // No previous answer — start complete answer directly
      return {
        outcome:            "finalize_complete_answer",
        reason:             "Document fully completed — starting complete answer",
        shouldAutoTrigger:  true,
        supersedesPrevious: false,
      };
    }
    return {
      outcome:            "finalize_complete_answer",
      reason:             `Full coverage reached (${newCoveragePercent}%) — superseding previous partial answer`,
      shouldAutoTrigger:  true,
      supersedesPrevious: true,
    };
  }

  // ── Path: first partial answer ────────────────────────────────────────────
  if (previousTriggerKey === null) {
    // No previous answer exists — this is the first trigger
    return {
      outcome:            "start_first_partial_answer",
      reason:             `First retrieval-ready chunks available (${newCoveragePercent}% coverage, ${retrievalChunksActive} chunks)`,
      shouldAutoTrigger:  true,
      supersedesPrevious: false,
    };
  }

  // ── Path: improved partial answer ─────────────────────────────────────────
  // Coverage must have meaningfully increased (crossed a bucket boundary,
  // which is guaranteed by the trigger key changing via coverageBucket()).
  if (newCoveragePercent > previousCoveragePercent) {
    return {
      outcome:            "refresh_partial_answer",
      reason:             `Coverage improved from ${previousCoveragePercent}% to ${newCoveragePercent}% — refreshing partial answer`,
      shouldAutoTrigger:  true,
      supersedesPrevious: true,
    };
  }

  // ── Path: status changed but coverage not better ──────────────────────────
  // e.g. processing → partially_ready_with_failures but same coverage bucket
  if (documentStatus === "partially_ready_with_failures" || documentStatus === "dead_letter") {
    return {
      outcome:            "no_action",
      reason:             `Status changed to ${documentStatus} but coverage not improved — no refresh warranted`,
      shouldAutoTrigger:  false,
      supersedesPrevious: false,
    };
  }

  // ── Default: trigger key changed but no clear reason to refresh ──────────
  return {
    outcome:            "no_action",
    reason:             `Trigger key changed (${previousTriggerKey} → ${newTriggerKey}) but no material coverage improvement detected`,
    shouldAutoTrigger:  false,
    supersedesPrevious: false,
  };
}

// ── Convenience helpers ────────────────────────────────────────────────────────

/** Returns true if the policy outcome should auto-trigger a new chat answer. */
export function shouldAutoStartAnswer(result: PolicyResult): boolean {
  return result.shouldAutoTrigger;
}

/** Maps a policy outcome to a human-readable UX label. */
export function outcomeToUxLabel(outcome: PolicyOutcome): string {
  switch (outcome) {
    case "start_first_partial_answer":  return "Starting partial answer from available content…";
    case "refresh_partial_answer":      return "Improving answer with more content…";
    case "finalize_complete_answer":    return "Finalizing complete answer…";
    case "no_action":                   return "Waiting for more content…";
    case "not_ready":                   return "Not ready to answer yet";
  }
}
