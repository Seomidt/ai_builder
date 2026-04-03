/**
 * Phase 5Z.2 — Answer Timing Policy
 *
 * Deterministic policy layer that decides WHEN to answer based on document
 * processing state. No stale caches, no probabilistic logic — pure decision.
 *
 * Policy decisions:
 *  - "answer_now_complete"  → document fully ready, answer with full confidence
 *  - "answer_now_partial"   → enough chunks ready to give a useful partial answer
 *  - "wait_for_more"        → not enough coverage yet, better to wait briefly
 *  - "not_ready"            → no chunks at all, cannot answer
 *
 * Thresholds (deterministic):
 *  - MIN_COVERAGE_TO_ANSWER:    25%   — minimum before we answer at all
 *  - GOOD_COVERAGE_THRESHOLD:   60%   — above this always answer now
 *  - WAIT_TIMEOUT_MS:        30_000   — after 30s always answer with what we have
 *
 * INV-ATP1: answer_now_partial never returned when coveragePercent === 0.
 * INV-ATP2: answer_now_complete only returned when coveragePercent >= 100 AND !blocked.
 */

// ── Types ──────────────────────────────────────────────────────────────────────

export type AnswerTimingDecision =
  | "answer_now_complete"  // fully ready
  | "answer_now_partial"   // partial but enough to answer
  | "wait_for_more"        // not yet enough — caller may want to delay
  | "not_ready";           // no chunks at all

export interface AnswerTimingPolicyInput {
  coveragePercent:       number;
  segmentsReady:         number;
  segmentsTotal:         number;
  retrievalChunksActive: number;
  timeSinceUploadMs:     number;
  fullCompletionBlocked: boolean;
}

export interface AnswerTimingPolicyResult {
  decision:        AnswerTimingDecision;
  reason:          string;
  coveragePercent: number;
}

// ── Thresholds (exported for transparency and testing) ─────────────────────────

export const MIN_COVERAGE_TO_ANSWER     = 25;   // %  — minimum coverage to answer
export const GOOD_COVERAGE_THRESHOLD    = 60;   // %  — above this: always answer now
export const WAIT_TIMEOUT_MS            = 30_000; // ms — after this, always answer anyway

// ── evaluateAnswerTiming ───────────────────────────────────────────────────────

export function evaluateAnswerTiming(input: AnswerTimingPolicyInput): AnswerTimingPolicyResult {
  const {
    coveragePercent,
    retrievalChunksActive,
    timeSinceUploadMs,
    fullCompletionBlocked,
  } = input;

  // INV-ATP1: no chunks at all → not_ready
  if (retrievalChunksActive === 0) {
    return {
      decision:        "not_ready",
      reason:          "No retrieval chunks available yet",
      coveragePercent: 0,
    };
  }

  // INV-ATP2: fully complete → answer_now_complete
  if (coveragePercent >= 100 && !fullCompletionBlocked) {
    return {
      decision:        "answer_now_complete",
      reason:          "Document fully processed — complete answer available",
      coveragePercent: 100,
    };
  }

  // Blocked permanently with some chunks: always answer with what we have
  if (fullCompletionBlocked) {
    return {
      decision:        "answer_now_partial",
      reason:          `Permanently blocked at ${coveragePercent}% — answering with available chunks`,
      coveragePercent,
    };
  }

  // Timeout: if user has waited long enough, answer with whatever we have
  if (timeSinceUploadMs >= WAIT_TIMEOUT_MS && coveragePercent >= MIN_COVERAGE_TO_ANSWER) {
    return {
      decision:        "answer_now_partial",
      reason:          `Wait timeout (${Math.round(timeSinceUploadMs / 1000)}s elapsed) — answering at ${coveragePercent}%`,
      coveragePercent,
    };
  }

  // Good coverage: answer now without waiting
  if (coveragePercent >= GOOD_COVERAGE_THRESHOLD) {
    return {
      decision:        "answer_now_partial",
      reason:          `Coverage ${coveragePercent}% ≥ threshold ${GOOD_COVERAGE_THRESHOLD}% — answering now`,
      coveragePercent,
    };
  }

  // Enough to answer, but below good threshold and not timed out
  if (coveragePercent >= MIN_COVERAGE_TO_ANSWER) {
    return {
      decision:        "wait_for_more",
      reason:          `Coverage ${coveragePercent}% above minimum but below good threshold — waiting`,
      coveragePercent,
    };
  }

  // Below minimum — not worth answering yet
  return {
    decision:        "not_ready",
    reason:          `Coverage ${coveragePercent}% below minimum ${MIN_COVERAGE_TO_ANSWER}% — not ready`,
    coveragePercent,
  };
}
