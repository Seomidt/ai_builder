/**
 * AI Runtime Types
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 * Shared types used across runner.ts and any future AI feature callers.
 */

import type { AiModelKey } from "./config";

/**
 * Context passed by the caller into every AI call.
 * Carries identity and routing metadata — no business logic.
 */
export interface AiCallContext {
  /** Correlation ID — ties AI calls back to HTTP request traces */
  requestId?: string | null;
  /** Feature or agent key that initiated the call (e.g. "planner_agent", "summarize") */
  feature: string;
  /** Organisation / tenant ID for usage attribution */
  tenantId?: string | null;
  /** User ID for usage attribution */
  userId?: string | null;
  /** Model tier override — defaults to AI_MODELS.default when omitted */
  model?: AiModelKey;
}

/**
 * Normalised result returned by runAiCall() on success.
 */
export interface AiCallResult {
  /** Generated text from the model */
  text: string;
  /** Token usage reported by the provider — null if unavailable */
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  } | null;
  /** Wall-clock time for the provider round-trip in milliseconds */
  latencyMs: number;
  /** Resolved model identifier that was actually used */
  model: string;
  /** Echo of context.feature — for tracing without re-reading context */
  feature: string;
}
