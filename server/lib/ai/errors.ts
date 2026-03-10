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
