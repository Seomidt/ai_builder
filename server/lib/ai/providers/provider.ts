/**
 * AI Provider Interface
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Defines the generic contract that every provider adapter must implement.
 * Features and runner.ts interact with providers only through this interface —
 * never through provider-specific code directly.
 */

export interface AiProviderGenerateInput {
  /** Concrete model identifier to pass to the provider (e.g. "gpt-4.1-mini") */
  model: string;
  /** System-level instructions for the model */
  systemPrompt: string;
  /** User-facing input / task description */
  userInput: string;
  /** Optional timeout override in milliseconds */
  timeoutMs?: number;
  /**
   * Optional maximum number of output tokens.
   * Set by runner.ts in budget_mode to reduce verbosity.
   * If omitted, the provider uses its own default (no hard cap).
   */
  maxOutputTokens?: number;
}

export interface AiProviderGenerateResult {
  /** Generated text from the model */
  text: string;
  /**
   * Token usage reported by the provider — null if unavailable.
   *
   * input_tokens / output_tokens / total_tokens — normalized usage values
   * cached_input_tokens — prompt tokens served from cache (OpenAI: input_token_details.cached_tokens)
   * reasoning_tokens    — reasoning tokens (OpenAI o-series: output_token_details.reasoning_tokens)
   *
   * Providers that do not support cached or reasoning tokens return 0 for those fields.
   */
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cached_input_tokens: number;
    reasoning_tokens: number;
  } | null;
  /** Raw provider response — for debugging only, never exposed to clients */
  raw: unknown;
}

export interface AiProvider {
  /** Unique provider identifier — must match AiProviderKey in config.ts */
  readonly key: string;
  /** Generate text using this provider */
  generateText(input: AiProviderGenerateInput): Promise<AiProviderGenerateResult>;
}
