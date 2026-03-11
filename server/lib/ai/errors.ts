/**
 * AI Error Hierarchy
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Typed error classes so callers can handle provider failures
 * without parsing error message strings.
 *
 * All errors carry feature, model and latencyMs so diagnostics
 * are possible even when the error is caught far from the call site.
 *
 * Phase 3H additions:
 * - AiTokenCapError     — input exceeded maxInputTokens before provider call
 * - AiRateLimitError    — tenant exceeded requestsPerMinute or requestsPerHour
 * - AiConcurrencyError  — tenant has too many simultaneous in-flight requests
 */

export interface AiErrorMeta {
  feature: string;
  model: string;
  latencyMs: number;
}

/** Base class for all AI runtime errors */
export class AiError extends Error {
  readonly feature: string;
  readonly model: string;
  readonly latencyMs: number;

  constructor(message: string, meta: AiErrorMeta) {
    super(message);
    this.name = "AiError";
    this.feature = meta.feature;
    this.model = meta.model;
    this.latencyMs = meta.latencyMs;
  }
}

/** OPENAI_API_KEY is missing or empty */
export class AiUnavailableError extends AiError {
  constructor(meta: AiErrorMeta) {
    super("AI service is unavailable: OPENAI_API_KEY is not configured", meta);
    this.name = "AiUnavailableError";
  }
}

/** The provider call was aborted due to the AI_TIMEOUT_MS limit */
export class AiTimeoutError extends AiError {
  constructor(meta: AiErrorMeta) {
    super(`AI call timed out after ${meta.latencyMs}ms (feature: ${meta.feature})`, meta);
    this.name = "AiTimeoutError";
  }
}

/** OpenAI returned HTTP 429 — rate limit or quota exceeded */
export class AiQuotaError extends AiError {
  constructor(meta: AiErrorMeta) {
    super("AI quota exceeded: OpenAI returned 429", meta);
    this.name = "AiQuotaError";
  }
}

/** Any other provider or runtime failure */
export class AiServiceError extends AiError {
  constructor(message: string, meta: AiErrorMeta) {
    super(message, meta);
    this.name = "AiServiceError";
  }
}

/**
 * Tenant has exhausted their included AI usage budget.
 *
 * Thrown by runner.ts when guards.ts evaluates the tenant's usage state
 * as "blocked" (current period usage ≥ hard_limit_percent of budget).
 *
 * No provider call is made after this error is thrown.
 * Future pay-as-you-go can be wired by handling this error at the feature layer.
 */
export class AiBudgetExceededError extends AiError {
  constructor(meta: AiErrorMeta) {
    super(
      "AI budget exceeded: included AI usage for this period has been exhausted",
      meta,
    );
    this.name = "AiBudgetExceededError";
  }
}

/**
 * Input text exceeded maxInputTokens before the provider call was attempted.
 *
 * Thrown by request-safety.ts token cap check.
 * No provider call is made — the check is purely pre-flight.
 * The estimated token count and configured limit are included in the message
 * so callers can surface useful feedback without parsing strings.
 */
export class AiTokenCapError extends AiError {
  readonly estimatedTokens: number;
  readonly tokenLimit: number;

  constructor(meta: AiErrorMeta & { estimatedTokens: number; tokenLimit: number }) {
    super(
      `Input too large: estimated ${meta.estimatedTokens} tokens exceeds limit of ${meta.tokenLimit}`,
      meta,
    );
    this.name = "AiTokenCapError";
    this.estimatedTokens = meta.estimatedTokens;
    this.tokenLimit = meta.tokenLimit;
  }
}

/**
 * Tenant has exceeded their configured request rate limit.
 *
 * Thrown by request-safety.ts rate limit check.
 * No provider call is made.
 * Includes which limit was breached (per-minute or per-hour) and the counts.
 */
export class AiRateLimitError extends AiError {
  readonly limitType: "per_minute" | "per_hour";
  readonly currentCount: number;
  readonly limit: number;

  constructor(meta: AiErrorMeta & {
    limitType: "per_minute" | "per_hour";
    currentCount: number;
    limit: number;
  }) {
    super(
      `Rate limit exceeded: ${meta.currentCount} requests in window, limit is ${meta.limit} (${meta.limitType})`,
      meta,
    );
    this.name = "AiRateLimitError";
    this.limitType = meta.limitType;
    this.currentCount = meta.currentCount;
    this.limit = meta.limit;
  }
}

/**
 * Tenant has too many simultaneous in-flight AI requests.
 *
 * Thrown by request-safety.ts concurrency guard.
 * No provider call is made — slot was never acquired.
 * The concurrency guard is process-local in Phase 3H.
 */
export class AiConcurrencyError extends AiError {
  readonly currentConcurrent: number;
  readonly concurrencyLimit: number;

  constructor(meta: AiErrorMeta & {
    currentConcurrent: number;
    concurrencyLimit: number;
  }) {
    super(
      `Concurrency limit exceeded: ${meta.currentConcurrent} requests in flight, limit is ${meta.concurrencyLimit}`,
      meta,
    );
    this.name = "AiConcurrencyError";
    this.currentConcurrent = meta.currentConcurrent;
    this.concurrencyLimit = meta.concurrencyLimit;
  }
}
