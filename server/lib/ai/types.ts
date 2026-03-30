/**
 * AI Runtime Types
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 * Shared types used across runner.ts and any future AI feature callers.
 */

import type { AiModelKey } from "./config.ts";

/**
 * Use-case identifier — determines whether the grounded-data gate applies.
 *
 * Grounded (require documentContext):
 *   document_qa       — answer questions from an uploaded document
 *   retrieval_answer  — answer from retrieval hits
 *   grounded_chat     — chat grounded in internal sources
 *
 * Controlled non-grounded (gate does NOT apply):
 *   validation        — validate a document or content
 *   analysis          — analyse content, suggest improvements
 *   classification    — classify or categorise input
 */
export type AiUseCase =
  | "document_qa"
  | "retrieval_answer"
  | "grounded_chat"
  | "validation"
  | "analysis"
  | "classification";

const GROUNDED_USE_CASES = new Set<AiUseCase>(["document_qa", "retrieval_answer", "grounded_chat"]);

export function isGroundedUseCase(useCase: AiUseCase): boolean {
  return GROUNDED_USE_CASES.has(useCase);
}

/**
 * Context passed by the caller into every AI call.
 * Carries identity and routing metadata — no business logic.
 */
export interface AiCallContext {
  /** Correlation ID — ties AI calls back to HTTP request traces */
  requestId?: string | null;
  /** Feature or agent key that initiated the call (e.g. "planner_agent", "summarize") */
  feature: string;
  /**
   * Use-case identifier — required. Controls whether the grounded-data gate applies.
   * Grounded use cases (document_qa, retrieval_answer, grounded_chat) require documentContext.
   * Controlled use cases (validation, analysis, classification) are never blocked by the gate.
   * Missing useCase → runAiCall throws USE_CASE_REQUIRED.
   */
  useCase: AiUseCase;
  /** Organisation / tenant ID for usage attribution */
  tenantId?: string | null;
  /** User ID for usage attribution */
  userId?: string | null;
  /** Model tier override — defaults to AI_MODELS.default when omitted */
  model?: AiModelKey;
  /**
   * Internal document context — required for grounded use cases.
   * Ignored for controlled non-grounded use cases.
   */
  documentContext?: unknown[];
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
  /** Set when the global hard gate blocked the call before provider contact */
  blocked?: boolean;
  /** Machine-readable block reason */
  reason?: string;
  /** Human-readable fallback answer when blocked */
  answer?: string;
}
