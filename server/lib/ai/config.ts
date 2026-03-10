/**
 * Central AI Configuration
 *
 * Single source of truth for model identifiers and runtime limits.
 * Import from here — never hardcode model names or timeouts elsewhere.
 *
 * To change the default model for all agents: update `default` here.
 * To add a model tier for specific features: add a new key below.
 */

export const AI_MODELS = {
  /** Fast, cost-efficient model — default for all current agents */
  default: "gpt-4.1-mini",
  /** Heavier model — reserved for complex architecture/review steps */
  heavy: "gpt-4.1",
  /** Cheapest option — for trivial reformatting or classification steps */
  nano: "gpt-4.1-nano",
} as const;

export type AiModelKey = keyof typeof AI_MODELS;

/** Hard timeout (ms) for any single OpenAI API call */
export const AI_TIMEOUT_MS = 20_000;

/** Maximum characters of user input to store in ai_usage.input_preview */
export const AI_INPUT_PREVIEW_MAX_CHARS = 500;
