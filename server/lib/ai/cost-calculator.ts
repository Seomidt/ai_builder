/**
 * Cost Calculator — Phase X+1
 *
 * Thin public API for AI cost calculation.
 * Delegates to estimateAiCost() in costs.ts which is the canonical implementation.
 *
 * Design: single source of truth in costs.ts, this module provides the
 * named interface required by the spec without duplicating logic.
 */

import { estimateAiCost, type AiUsageTokens } from "./costs.ts";
import { loadPricing } from "./pricing.ts";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CostCalculationInput {
  provider:     string;
  model:        string;
  inputTokens:  number;
  outputTokens: number;
}

export interface CostCalculationResult {
  costUsd:        number;
  pricingSource:  string | null;
  pricingVersion: string | null;
}

// ── calculateCost ─────────────────────────────────────────────────────────────
// Deterministic: same inputs always produce same output.
// No hardcoded pricing — always resolved via loadPricing().

export async function calculateCost(
  input: CostCalculationInput,
): Promise<CostCalculationResult> {
  const { provider, model, inputTokens, outputTokens } = input;

  const { pricing, source, version } = await loadPricing(provider, model);

  const usage: AiUsageTokens = {
    input_tokens:  Math.max(0, inputTokens),
    output_tokens: Math.max(0, outputTokens),
    total_tokens:  Math.max(0, inputTokens + outputTokens),
  };

  const costUsd = estimateAiCost({ usage, pricing }) ?? 0;

  return {
    costUsd:        Math.max(0, costUsd),
    pricingSource:  source,
    pricingVersion: version,
  };
}
