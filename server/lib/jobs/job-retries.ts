/**
 * Phase 19 — Job Retry Policy
 * Exponential backoff computation and retry decision logic.
 *
 * INV-JOB7: Retry delays are bounded and deterministic.
 * INV-JOB3: Retry exhaustion is recorded, not swallowed.
 */

const DEFAULT_BACKOFF_MS = 1000;
const DEFAULT_MULTIPLIER = 2.0;
const DEFAULT_MAX_BACKOFF_MS = 30_000;
const ABSOLUTE_MAX_BACKOFF_MS = 300_000; // 5 minutes ceiling

export interface RetryPolicy {
  backoffMs?: number;
  multiplier?: number;
  maxBackoffMs?: number;
  jitterMs?: number;
}

/**
 * Compute the backoff delay for a given attempt number.
 * Uses exponential backoff with optional jitter.
 *
 * INV-JOB7: Result is always bounded within [0, ABSOLUTE_MAX_BACKOFF_MS].
 */
export function computeBackoffMs(
  attemptNumber: number,
  policy: RetryPolicy = {},
): number {
  if (attemptNumber <= 1) return 0; // No delay before first retry
  const backoffMs = Math.max(0, policy.backoffMs ?? DEFAULT_BACKOFF_MS);
  const multiplier = Math.max(1, policy.multiplier ?? DEFAULT_MULTIPLIER);
  const maxBackoff = Math.min(
    Math.abs(policy.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS),
    ABSOLUTE_MAX_BACKOFF_MS,
  );
  const jitter = Math.max(0, policy.jitterMs ?? 0);

  const exponential = backoffMs * Math.pow(multiplier, attemptNumber - 2);
  const clamped = Math.min(exponential, maxBackoff);
  const jitterAmount = jitter > 0 ? Math.random() * jitter : 0;

  return Math.floor(Math.min(clamped + jitterAmount, ABSOLUTE_MAX_BACKOFF_MS));
}

/**
 * Decide whether a failed attempt should be retried.
 */
export function shouldRetry(
  attemptNumber: number,
  maxAttempts: number,
  error?: string,
): boolean {
  if (attemptNumber >= maxAttempts) return false;
  // Non-retryable errors (terminal failures)
  const nonRetryable = ["NOT_AUTHORIZED", "INVALID_PAYLOAD", "JOB_TYPE_NOT_FOUND"];
  if (error && nonRetryable.some((e) => error.includes(e))) return false;
  return true;
}

/**
 * Build a canonical retry policy from user-supplied config.
 * Validates and clamps all values.
 */
export function buildRetryPolicy(input: RetryPolicy = {}): RetryPolicy {
  return {
    backoffMs: Math.max(100, Math.min(input.backoffMs ?? DEFAULT_BACKOFF_MS, 60_000)),
    multiplier: Math.max(1, Math.min(input.multiplier ?? DEFAULT_MULTIPLIER, 10)),
    maxBackoffMs: Math.max(1000, Math.min(input.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS, ABSOLUTE_MAX_BACKOFF_MS)),
    jitterMs: Math.max(0, Math.min(input.jitterMs ?? 0, 5_000)),
  };
}

/**
 * Explain the retry schedule for a given policy and max attempts.
 */
export function explainRetrySchedule(
  maxAttempts: number,
  policy: RetryPolicy = {},
): Array<{ attempt: number; delayMs: number; cumulativeMs: number }> {
  const normalized = buildRetryPolicy(policy);
  const schedule = [];
  let cumulative = 0;
  for (let a = 1; a <= maxAttempts; a++) {
    const delay = computeBackoffMs(a, normalized);
    cumulative += delay;
    schedule.push({ attempt: a, delayMs: delay, cumulativeMs: cumulative });
  }
  return schedule;
}

/**
 * Summarize retry health: how many attempts at each retry count.
 */
export function summarizeRetryHealth(
  attempts: Array<{ attemptNumber: number; status: string }>,
): {
  totalAttempts: number;
  successOnFirst: number;
  retriedOnce: number;
  retriedMultiple: number;
  exhausted: number;
} {
  const byRun = new Map<number, number[]>();
  for (const a of attempts) {
    const key = a.attemptNumber;
    if (!byRun.has(key)) byRun.set(key, []);
    byRun.get(key)!.push(1);
  }
  const maxAttempt = Math.max(...Array.from(byRun.keys()), 0);
  return {
    totalAttempts: attempts.length,
    successOnFirst: attempts.filter((a) => a.attemptNumber === 1 && a.status === "success").length,
    retriedOnce: attempts.filter((a) => a.attemptNumber === 2).length,
    retriedMultiple: attempts.filter((a) => a.attemptNumber > 2).length,
    exhausted: 0, // Computed externally from job status=failed
  };
}
