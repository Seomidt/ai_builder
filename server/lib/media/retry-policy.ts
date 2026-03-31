// ============================================================
// PHASE 5Y — Unified Media Processing Platform
// retry-policy.ts — Explicit retry semantics with backoff
// ============================================================

import type { FailureCategory } from "./media-types.ts";
import { isCategoryRetryable } from "./failure-classifier.ts";

export interface RetryDecision {
  shouldRetry: boolean;
  nextRetryAt?: Date;
  deadLetter: boolean;
  reason: string;
}

// Backoff schedule in seconds: attempt 1 → 30s, 2 → 60s, 3 → 120s, 4 → 240s
const BACKOFF_SECONDS = [30, 60, 120, 240, 480];

export function calculateBackoffSeconds(attemptCount: number): number {
  const idx = Math.min(attemptCount - 1, BACKOFF_SECONDS.length - 1);
  return BACKOFF_SECONDS[idx] ?? 480;
}

export function calculateNextRetryAt(attemptCount: number): Date {
  const backoffSec = calculateBackoffSeconds(attemptCount);
  const next = new Date();
  next.setSeconds(next.getSeconds() + backoffSec);
  return next;
}

/**
 * Determine whether a failed job/step should be retried, and when.
 *
 * Rules:
 *   - Non-retryable failure categories → failed immediately (no retry)
 *   - Retryable categories but attempts exhausted → dead_letter
 *   - Retryable categories with remaining attempts → retryable_failed + backoff
 */
export function evaluateRetry(
  failureCategory: FailureCategory,
  attemptCount: number,
  maxAttempts: number
): RetryDecision {
  const retryable = isCategoryRetryable(failureCategory);

  if (!retryable) {
    return {
      shouldRetry: false,
      deadLetter: false,
      reason: `Non-retryable failure category: ${failureCategory}`,
    };
  }

  if (attemptCount >= maxAttempts) {
    return {
      shouldRetry: false,
      deadLetter: true,
      reason: `Max attempts (${maxAttempts}) exhausted after ${attemptCount} tries`,
    };
  }

  const nextRetryAt = calculateNextRetryAt(attemptCount);
  return {
    shouldRetry: true,
    nextRetryAt,
    deadLetter: false,
    reason: `Retryable (${failureCategory}), attempt ${attemptCount}/${maxAttempts}, retry at ${nextRetryAt.toISOString()}`,
  };
}
