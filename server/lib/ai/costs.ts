/**
 * AI Cost Defaults + Cost Estimation Utility
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Two responsibilities:
 *   1. AI_MODEL_PRICING_DEFAULTS — code-level fallback pricing keyed by
 *      provider → model. Used by pricing.ts when no active DB row exists.
 *      Source of truth for default pricing. Never hardcode pricing elsewhere.
 *
 *   2. estimateAiCost() — pure calculation function that converts token
 *      usage × pricing into an estimated USD cost.
 *
 * Pricing sources (as of 2025):
 *   OpenAI  — https://platform.openai.com/docs/pricing
 *   Anthropic — placeholder rates for future integration
 *   Google    — placeholder rates for future integration
 */

// ── Pricing types ──────────────────────────────────────────────────────────────

export interface AiPricing {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
}

export interface AiUsageTokens {
  input_tokens: number;
  output_tokens: number;
  total_tokens?: number | null;
}

// ── Code default pricing ───────────────────────────────────────────────────────

/**
 * Default pricing map keyed by provider → model.
 *
 * Only models that are currently wired in AI_MODEL_ROUTES or are known
 * placeholders are included. If a model is not listed here, estimateAiCost()
 * returns null safely — that is expected behaviour, not an error.
 *
 * Rates are per 1,000,000 tokens in USD.
 */
export const AI_MODEL_PRICING_DEFAULTS: Record<string, Record<string, AiPricing>> = {
  openai: {
    "gpt-4.1":       { inputPerMillionUsd: 2.00,  outputPerMillionUsd: 8.00  },
    "gpt-4.1-mini":  { inputPerMillionUsd: 0.40,  outputPerMillionUsd: 1.60  },
    "gpt-4.1-nano":  { inputPerMillionUsd: 0.10,  outputPerMillionUsd: 0.40  },
  },
  anthropic: {
    // Placeholder — provider not yet wired in registry
    "claude-opus-4-5": { inputPerMillionUsd: 15.00, outputPerMillionUsd: 75.00 },
  },
  google: {
    // Placeholder — provider not yet wired in registry
    "gemini-2.0-flash": { inputPerMillionUsd: 0.10, outputPerMillionUsd: 0.40 },
  },
};

/**
 * Look up the code default pricing for a provider + model pair.
 * Returns null if no entry exists — missing pricing is not an error.
 */
export function getDefaultPricing(provider: string, model: string): AiPricing | null {
  return AI_MODEL_PRICING_DEFAULTS[provider]?.[model] ?? null;
}

// ── Cost estimation ────────────────────────────────────────────────────────────

/**
 * Estimate the USD cost of a single AI call from token usage and pricing.
 *
 * Formula:
 *   inputCost  = (input_tokens  / 1_000_000) × inputPerMillionUsd
 *   outputCost = (output_tokens / 1_000_000) × outputPerMillionUsd
 *   total      = inputCost + outputCost
 *
 * Returns null if usage or pricing is unavailable — never throws.
 * Result is rounded to 8 decimal places to match ai_usage.estimated_cost_usd precision.
 */
export function estimateAiCost(params: {
  usage: AiUsageTokens | null | undefined;
  pricing: AiPricing | null | undefined;
}): number | null {
  const { usage, pricing } = params;
  if (!usage || !pricing) return null;

  try {
    const inputCost  = (usage.input_tokens  / 1_000_000) * pricing.inputPerMillionUsd;
    const outputCost = (usage.output_tokens / 1_000_000) * pricing.outputPerMillionUsd;
    const total = inputCost + outputCost;
    return Math.round(total * 1e8) / 1e8;
  } catch {
    return null;
  }
}
