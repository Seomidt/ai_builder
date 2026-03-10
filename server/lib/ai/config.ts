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
