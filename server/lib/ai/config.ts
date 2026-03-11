/**
 * Central AI Configuration
 *
 * Single source of truth for model identifiers, routing, and runtime limits.
 * Import from here — never hardcode model names, providers, or timeouts elsewhere.
 *
 * Phase 3C additions:
 * - AiProviderKey: supported provider identifiers
 * - AiModelRoute:  { provider, model } pair for a logical model target
 * - AI_MODEL_ROUTES: maps logical keys to concrete provider + model
 *
 * Phase 3H additions:
 * - AiSafetyConfig: per-request safety parameters (token caps, rate limits, concurrency)
 * - AI_SAFETY_DEFAULTS: global defaults — overridden per-tenant via tenant_rate_limits DB table
 *
 * AI_MODELS (legacy string map) is preserved for backward compatibility
 * with model-config.ts and existing agent code that uses string model names.
 */

// ── Provider types ────────────────────────────────────────────────────────────

/** Supported AI provider identifiers */
export type AiProviderKey = "openai" | "anthropic" | "google";

/** A concrete provider + model pair resolved from a logical model key */
export interface AiModelRoute {
  provider: AiProviderKey;
  model: string;
}

// ── Model routes ──────────────────────────────────────────────────────────────

/**
 * Maps logical model keys to concrete provider + model routes.
 *
 * - default   → OpenAI  gpt-4.1-mini    (fast, cost-efficient)
 * - heavy     → OpenAI  gpt-4.1         (complex reasoning steps)
 * - nano      → OpenAI  gpt-4.1-nano    (trivial tasks)
 * - coding    → OpenAI  gpt-4.1         (code generation)
 * - cheap     → Google  gemini-2.0-flash (not yet wired — provider placeholder)
 * - reasoning → Anthropic claude-opus-4-5 (not yet wired — provider placeholder)
 */
export const AI_MODEL_ROUTES = {
  default:   { provider: "openai"    as AiProviderKey, model: "gpt-4.1-mini" },
  heavy:     { provider: "openai"    as AiProviderKey, model: "gpt-4.1" },
  nano:      { provider: "openai"    as AiProviderKey, model: "gpt-4.1-nano" },
  coding:    { provider: "openai"    as AiProviderKey, model: "gpt-4.1" },
  cheap:     { provider: "google"    as AiProviderKey, model: "gemini-2.0-flash" },
  reasoning: { provider: "anthropic" as AiProviderKey, model: "claude-opus-4-5" },
} satisfies Record<string, AiModelRoute>;

export type AiModelKey = keyof typeof AI_MODEL_ROUTES;

// ── Legacy string map (backward compatibility) ────────────────────────────────

/**
 * Legacy model string map.
 * Used by model-config.ts, AGENT_MODEL_REGISTRY, and chatJSON()-based agents.
 * Do not extend — add new entries to AI_MODEL_ROUTES instead.
 */
export const AI_MODELS = {
  /** Fast, cost-efficient model — default for all current agents */
  default: "gpt-4.1-mini",
  /** Heavier model — reserved for complex architecture/review steps */
  heavy: "gpt-4.1",
  /** Cheapest OpenAI option — for trivial reformatting or classification */
  nano: "gpt-4.1-nano",
} as const;

// ── Runtime limits ────────────────────────────────────────────────────────────

/** Hard timeout (ms) for any single provider API call */
export const AI_TIMEOUT_MS = 20_000;

/** Maximum characters of user input to store in ai_usage.input_preview */
export const AI_INPUT_PREVIEW_MAX_CHARS = 500;

// ── Request safety config ─────────────────────────────────────────────────────

/**
 * Request-level safety parameters.
 *
 * maxInputTokens     — estimated input token ceiling before provider call.
 *                      Uses the chars/4 approximation (1 token ≈ 4 English chars).
 *                      Checked before provider call to avoid wasted API spend.
 * maxOutputTokens    — maximum output tokens passed to the provider per call.
 *                      Applied centrally in runner.ts — feature code must not override.
 *                      Budget mode may reduce this further (512 tokens).
 * requestsPerMinute  — maximum AI calls per tenant per rolling 60-second window.
 * requestsPerHour    — maximum AI calls per tenant per rolling 3600-second window.
 * maxConcurrentRequests — maximum simultaneous in-flight AI calls per tenant.
 *                         Enforced in-process only (process-local counter).
 */
export interface AiSafetyConfig {
  maxInputTokens: number;
  maxOutputTokens: number;
  requestsPerMinute: number;
  requestsPerHour: number;
  maxConcurrentRequests: number;
}

/**
 * Global safety defaults — applied when no tenant_rate_limits row is active.
 *
 * These numbers are intentionally conservative for a v1 production system:
 *   - 50k input tokens ≈ ~200KB of text — reasonable for summaries, plans, reviews
 *   - 2048 output tokens — sufficient for most structured responses
 *   - 20 RPM / 200 RPH — prevents accidental frontend loops and abuse
 *   - 5 concurrent — prevents tenant request storms
 *
 * Admins can override per-tenant via the tenant_rate_limits DB table.
 */
export const AI_SAFETY_DEFAULTS: AiSafetyConfig = {
  maxInputTokens:        50_000,
  maxOutputTokens:        2_048,
  requestsPerMinute:         20,
  requestsPerHour:          200,
  maxConcurrentRequests:      5,
};
