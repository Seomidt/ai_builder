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
 * Each error carries:
 *   httpStatus         — correct HTTP status code for this outcome
 *   errorCode          — stable machine-readable code for API clients
 *   retryAfterSeconds  — hint for Retry-After header (undefined = no retry hint)
 *
 * Phase 3H.1: HTTP status codes and stable error payloads added.
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
  readonly httpStatus: number;
  readonly errorCode: string;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    message: string,
    meta: AiErrorMeta,
    httpStatus: number,
    errorCode: string,
    retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "AiError";
    this.feature = meta.feature;
    this.model = meta.model;
    this.latencyMs = meta.latencyMs;
    this.httpStatus = httpStatus;
    this.errorCode = errorCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** OPENAI_API_KEY is missing or empty */
export class AiUnavailableError extends AiError {
  constructor(meta: AiErrorMeta) {
    super(
      "AI service is unavailable: OPENAI_API_KEY is not configured",
      meta,
      503,
      "ai_unavailable",
    );
    this.name = "AiUnavailableError";
  }
}

/** The provider call was aborted due to the AI_TIMEOUT_MS limit */
export class AiTimeoutError extends AiError {
  constructor(meta: AiErrorMeta) {
    super(
      `AI call timed out after ${meta.latencyMs}ms (feature: ${meta.feature})`,
      meta,
      504,
      "ai_timeout",
    );
    this.name = "AiTimeoutError";
  }
}

/** OpenAI returned HTTP 429 — rate limit or quota exceeded at provider level */
export class AiQuotaError extends AiError {
  constructor(meta: AiErrorMeta) {
    super(
      "AI quota exceeded: OpenAI returned 429",
      meta,
      429,
      "ai_quota_exceeded",
      60,
    );
    this.name = "AiQuotaError";
  }
}

/** Any other provider or runtime failure */
export class AiServiceError extends AiError {
  constructor(message: string, meta: AiErrorMeta) {
    super(message, meta, 502, "ai_service_error");
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
 * HTTP 402 — explicit budget exhaustion signal.
 */
export class AiBudgetExceededError extends AiError {
  constructor(meta: AiErrorMeta) {
    super(
      "AI budget exceeded: included AI usage for this period has been exhausted",
      meta,
      402,
      "ai_budget_exceeded",
    );
    this.name = "AiBudgetExceededError";
  }
}

/**
 * Input text exceeded maxInputTokens before the provider call was attempted.
 *
 * Thrown by request-safety.ts token cap check.
 * No provider call is made — the check is purely pre-flight.
 * HTTP 413 — Payload Too Large.
 */
export class AiTokenCapError extends AiError {
  readonly estimatedTokens: number;
  readonly tokenLimit: number;

  constructor(meta: AiErrorMeta & { estimatedTokens: number; tokenLimit: number }) {
    super(
      `Input too large: estimated ${meta.estimatedTokens} tokens exceeds limit of ${meta.tokenLimit}`,
      meta,
      413,
      "token_cap_exceeded",
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
 * HTTP 429 — Too Many Requests. Retry-After: 60 seconds (per-minute window).
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
      429,
      "rate_limit_exceeded",
      meta.limitType === "per_minute" ? 60 : 3600,
    );
    this.name = "AiRateLimitError";
    this.limitType = meta.limitType;
    this.currentCount = meta.currentCount;
    this.limit = meta.limit;
  }
}

/**
 * A duplicate request arrived while the original is still in progress.
 *
 * Thrown by idempotency.ts when a second call with the same
 * tenant_id + request_id arrives before the first completes.
 * No provider call is made — the original is still executing.
 * HTTP 409 — Conflict. Retry-After: 5 seconds.
 */
export class AiDuplicateInflightError extends AiError {
  readonly requestId: string;

  constructor(meta: AiErrorMeta & { requestId: string }) {
    super(
      `Duplicate request: request_id="${meta.requestId}" is already in progress for this tenant`,
      meta,
      409,
      "duplicate_inflight",
      5,
    );
    this.name = "AiDuplicateInflightError";
    this.requestId = meta.requestId;
  }
}

/**
 * Tenant has too many simultaneous in-flight AI requests.
 *
 * Thrown by request-safety.ts concurrency guard.
 * No provider call is made — slot was never acquired.
 * HTTP 429 — Too Many Requests. Retry-After: 5 seconds.
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
      429,
      "concurrency_limit_exceeded",
      5,
    );
    this.name = "AiConcurrencyError";
    this.currentConcurrent = meta.currentConcurrent;
    this.concurrencyLimit = meta.concurrencyLimit;
  }
}

/**
 * A single logical request has exceeded its per-request AI call budget.
 *
 * Thrown by step-budget.ts when a request identified by request_id
 * attempts more AI provider calls than the configured limit (default: 5).
 *
 * No provider call is made — the budget was exhausted before the attempt.
 * HTTP 429 — Too Many Requests. Framed as request execution limit.
 * Retry-After: not applicable (same request_id will always be blocked).
 */
export class AiStepBudgetExceededError extends AiError {
  readonly requestId: string;
  readonly totalAiCalls: number;
  readonly maxAiCalls: number;

  constructor(meta: AiErrorMeta & {
    requestId: string;
    totalAiCalls: number;
    maxAiCalls: number;
  }) {
    super(
      `Step budget exceeded: request_id="${meta.requestId}" has already executed ${meta.totalAiCalls} AI calls (limit: ${meta.maxAiCalls})`,
      meta,
      429,
      "step_budget_exceeded",
    );
    this.name = "AiStepBudgetExceededError";
    this.requestId = meta.requestId;
    this.totalAiCalls = meta.totalAiCalls;
    this.maxAiCalls = meta.maxAiCalls;
  }
}
