/**
 * Phase 23 — Webhook Retry Policy
 * Exponential backoff retry system for failed webhook deliveries.
 */

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;       // Base delay for first retry
  maxDelayMs: number;        // Cap on retry delay
  backoffMultiplier: number; // Multiplier for each retry (default: 2 = exponential)
  jitterMs: number;          // Random jitter to prevent thundering herd
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 5_000,       // 5 seconds
  maxDelayMs: 300_000,      // 5 minutes cap
  backoffMultiplier: 2,
  jitterMs: 1_000,
};

export const AGGRESSIVE_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 10_000,      // 10 seconds
  maxDelayMs: 3_600_000,    // 1 hour cap
  backoffMultiplier: 3,
  jitterMs: 2_000,
};

export const GENTLE_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 2,
  baseDelayMs: 60_000,      // 1 minute
  maxDelayMs: 600_000,      // 10 minutes
  backoffMultiplier: 2,
  jitterMs: 5_000,
};

/**
 * Compute the delay before the next retry attempt.
 * Formula: min(baseDelay * multiplier^(attempt-1) + jitter, maxDelay)
 */
export function computeRetryDelay(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): number {
  const exponential = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, Math.max(0, attempt - 1));
  const jitter = Math.random() * policy.jitterMs;
  return Math.min(Math.floor(exponential + jitter), policy.maxDelayMs);
}

/**
 * Compute the Date when the next retry should happen.
 */
export function computeNextRetryAt(attempt: number, policy: RetryPolicy = DEFAULT_RETRY_POLICY): Date {
  const delayMs = computeRetryDelay(attempt, policy);
  return new Date(Date.now() + delayMs);
}

/**
 * Determine if another retry should be attempted.
 */
export function shouldRetry(attempts: number, maxAttempts: number): boolean {
  return attempts < maxAttempts;
}

/**
 * Build the retry decision for a failed delivery.
 */
export function buildRetryDecision(params: {
  attempts: number;
  maxAttempts: number;
  policy?: RetryPolicy;
  statusCode?: number;
}): {
  shouldRetry: boolean;
  nextRetryAt?: Date;
  delayMs?: number;
  reason: string;
} {
  const policy = params.policy ?? DEFAULT_RETRY_POLICY;

  // Never retry 4xx client errors (except 429 Too Many Requests and 408 Timeout)
  const statusCode = params.statusCode;
  if (statusCode && statusCode >= 400 && statusCode < 500) {
    if (statusCode !== 429 && statusCode !== 408) {
      return {
        shouldRetry: false,
        reason: `Non-retryable HTTP ${statusCode} (client error)`,
      };
    }
  }

  if (!shouldRetry(params.attempts, params.maxAttempts)) {
    return {
      shouldRetry: false,
      reason: `Max attempts (${params.maxAttempts}) reached`,
    };
  }

  const delayMs = computeRetryDelay(params.attempts + 1, policy);
  const nextRetryAt = new Date(Date.now() + delayMs);

  return {
    shouldRetry: true,
    nextRetryAt,
    delayMs,
    reason: `Attempt ${params.attempts + 1} of ${params.maxAttempts}, retry in ${Math.round(delayMs / 1000)}s`,
  };
}

/**
 * Get retry schedule for visualization (what the retry timeline looks like).
 */
export function getRetrySchedule(policy: RetryPolicy = DEFAULT_RETRY_POLICY): Array<{
  attempt: number;
  delayMs: number;
  delayHuman: string;
}> {
  const schedule: Array<{ attempt: number; delayMs: number; delayHuman: string }> = [];
  for (let i = 1; i <= policy.maxAttempts; i++) {
    const base = policy.baseDelayMs * Math.pow(policy.backoffMultiplier, i - 1);
    const capped = Math.min(base, policy.maxDelayMs);
    schedule.push({
      attempt: i,
      delayMs: capped,
      delayHuman: formatDuration(capped),
    });
  }
  return schedule;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/**
 * Get retry stats for a set of deliveries (observability).
 */
export function summarizeRetries(deliveries: Array<{ attempts: number; status: string }>): {
  avgAttempts: number;
  maxAttempts: number;
  retriedCount: number;
  successAfterRetry: number;
} {
  if (deliveries.length === 0) return { avgAttempts: 0, maxAttempts: 0, retriedCount: 0, successAfterRetry: 0 };

  const retriedDeliveries = deliveries.filter((d) => d.attempts > 1);
  const successAfterRetry = retriedDeliveries.filter((d) => d.status === "delivered").length;
  const attempts = deliveries.map((d) => d.attempts);
  const avg = attempts.reduce((a, b) => a + b, 0) / attempts.length;
  const max = Math.max(...attempts);

  return {
    avgAttempts: parseFloat(avg.toFixed(2)),
    maxAttempts: max,
    retriedCount: retriedDeliveries.length,
    successAfterRetry,
  };
}
