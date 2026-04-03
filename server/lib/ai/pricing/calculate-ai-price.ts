/**
 * calculate-ai-price.ts — AI Customer Price Calculator
 *
 * SERVER-ONLY. Pure calculation function — no DB calls, no side effects.
 *
 * Converts provider cost (from token counts × model pricing) into the
 * customer-facing price using the tenant's active pricing configuration.
 *
 * Supported pricing modes (matches ai_customer_pricing_configs.pricing_mode):
 *
 *   "cost_plus_multiplier"
 *     customer_price = provider_cost × multiplier
 *     Example: multiplier=1.3 → 30% markup on provider cost
 *
 *   "fixed_markup"
 *     customer_price = provider_cost + fixed_markup_usd
 *     Example: fixed_markup_usd=0.005 → add 0.5¢ flat per call
 *
 *   "per_1k_tokens"
 *     customer_price = (input_tokens/1000 × price_per_1k_input)
 *                    + (output_tokens/1000 × price_per_1k_output)
 *     Provider cost is irrelevant for this mode — price is derived from tokens only.
 *
 * In all modes:
 *   - customer_price is floored at minimum_charge_usd (default: 0)
 *   - margin = customer_price − provider_cost (may be 0 or negative if minimum < cost)
 *
 * Usage:
 *   const result = calculateAiPrice({
 *     inputTokens: 1200,
 *     outputTokens: 400,
 *     inputPricePer1mUsd: 0.40,   // from ai_model_pricing
 *     outputPricePer1mUsd: 1.60,  // from ai_model_pricing
 *     pricingMode: "cost_plus_multiplier",
 *     multiplier: 1.4,
 *     minimumChargeUsd: 0,
 *   });
 *   // → { providerCostUsd, customerPriceUsd, marginUsd }
 */

// ── Input ──────────────────────────────────────────────────────────────────────

export interface CalculateAiPriceInput {
  inputTokens:          number;
  outputTokens:         number;
  /** Provider model cost per 1,000,000 input tokens (USD) */
  inputPricePer1mUsd:   number;
  /** Provider model cost per 1,000,000 output tokens (USD) */
  outputPricePer1mUsd:  number;

  /** Pricing mode from ai_customer_pricing_configs.pricing_mode */
  pricingMode: "cost_plus_multiplier" | "fixed_markup" | "per_1k_tokens";

  /** Used by cost_plus_multiplier — customer_price = provider_cost × multiplier */
  multiplier?: number | null;
  /** Used by fixed_markup — customer_price = provider_cost + fixed_markup_usd */
  fixedMarkupUsd?: number | null;
  /** Used by per_1k_tokens — price per 1,000 input tokens (USD) */
  pricePer1kInputTokensUsd?: number | null;
  /** Used by per_1k_tokens — price per 1,000 output tokens (USD) */
  pricePer1kOutputTokensUsd?: number | null;
  /** Floor: customer_price is always >= this value (default: 0) */
  minimumChargeUsd?: number | null;
}

// ── Output ─────────────────────────────────────────────────────────────────────

export interface CalculateAiPriceResult {
  /** Raw provider cost = tokens × model rate */
  providerCostUsd: number;
  /** Final customer-facing price after applying pricing mode + floor */
  customerPriceUsd: number;
  /** margin = customerPriceUsd − providerCostUsd (may be 0) */
  marginUsd: number;
}

// ── Implementation ─────────────────────────────────────────────────────────────

const SCALE = 1e8; // 8 decimal places — matches ai_billing_usage column precision

function round8(n: number): number {
  return Math.round(n * SCALE) / SCALE;
}

/**
 * Calculate provider cost and customer price from token counts and pricing config.
 *
 * Pure function — never throws. All unknown modes fall back to 1× cost_plus_multiplier.
 */
export function calculateAiPrice(input: CalculateAiPriceInput): CalculateAiPriceResult {
  const {
    inputTokens,
    outputTokens,
    inputPricePer1mUsd,
    outputPricePer1mUsd,
    pricingMode,
    multiplier,
    fixedMarkupUsd,
    pricePer1kInputTokensUsd,
    pricePer1kOutputTokensUsd,
    minimumChargeUsd,
  } = input;

  const minCharge = Math.max(0, Number(minimumChargeUsd ?? 0));

  // ── Provider cost (always token-based) ──────────────────────────────────────
  const providerCostUsd = round8(
    (inputTokens  / 1_000_000) * inputPricePer1mUsd +
    (outputTokens / 1_000_000) * outputPricePer1mUsd,
  );

  // ── Customer price by mode ───────────────────────────────────────────────────
  let rawCustomerPrice: number;

  if (pricingMode === "cost_plus_multiplier") {
    rawCustomerPrice = providerCostUsd * Math.max(0, Number(multiplier ?? 1));

  } else if (pricingMode === "fixed_markup") {
    rawCustomerPrice = providerCostUsd + Math.max(0, Number(fixedMarkupUsd ?? 0));

  } else if (pricingMode === "per_1k_tokens") {
    rawCustomerPrice =
      (inputTokens  / 1_000) * Number(pricePer1kInputTokensUsd  ?? 0) +
      (outputTokens / 1_000) * Number(pricePer1kOutputTokensUsd ?? 0);

  } else {
    // Unknown mode — fall back to 1:1 cost pass-through (no markup)
    rawCustomerPrice = providerCostUsd;
  }

  const customerPriceUsd = round8(Math.max(minCharge, rawCustomerPrice));
  const marginUsd        = round8(customerPriceUsd - providerCostUsd);

  return { providerCostUsd, customerPriceUsd, marginUsd };
}

/**
 * Load the active pricing config for a tenant from ai_customer_pricing_configs.
 *
 * Resolution order:
 *   1. Tenant-specific active row (scope='tenant', tenant_id=tenantId)
 *   2. Global active row (scope='global')
 *   3. Null → caller must apply code default (1× cost pass-through)
 *
 * Returns the raw DB row so callers can log pricingSource + pricingVersion.
 */
export async function loadCustomerPricingConfig(
  tenantId: string,
): Promise<{
  config: {
    id: string;
    pricingMode: "cost_plus_multiplier" | "fixed_markup" | "per_1k_tokens";
    multiplier: number | null;
    fixedMarkupUsd: number | null;
    pricePer1kInputTokensUsd: number | null;
    pricePer1kOutputTokensUsd: number | null;
    minimumChargeUsd: number | null;
  };
  source: "tenant_config" | "global_config";
} | null> {
  // Dynamic import to keep this file tree-shakeable and avoid circular deps at load time
  const { db } = await import("../../db.ts");
  const { aiCustomerPricingConfigs } = await import("@shared/schema");
  const { eq, and, isNull } = await import("drizzle-orm");

  try {
    // 1. Tenant-specific
    const tenantRows = await db
      .select()
      .from(aiCustomerPricingConfigs)
      .where(
        and(
          eq(aiCustomerPricingConfigs.tenantId, tenantId),
          eq(aiCustomerPricingConfigs.scope, "tenant"),
          eq(aiCustomerPricingConfigs.isActive, true),
        ),
      )
      .limit(1);

    if (tenantRows[0]) {
      const r = tenantRows[0];
      return {
        config: {
          id: r.id,
          pricingMode: r.pricingMode as "cost_plus_multiplier" | "fixed_markup" | "per_1k_tokens",
          multiplier: r.multiplier !== null ? Number(r.multiplier) : null,
          fixedMarkupUsd: r.fixedMarkupUsd !== null ? Number(r.fixedMarkupUsd) : null,
          pricePer1kInputTokensUsd: r.pricePer1kInputTokensUsd !== null ? Number(r.pricePer1kInputTokensUsd) : null,
          pricePer1kOutputTokensUsd: r.pricePer1kOutputTokensUsd !== null ? Number(r.pricePer1kOutputTokensUsd) : null,
          minimumChargeUsd: r.minimumChargeUsd !== null ? Number(r.minimumChargeUsd) : null,
        },
        source: "tenant_config",
      };
    }

    // 2. Global fallback
    const globalRows = await db
      .select()
      .from(aiCustomerPricingConfigs)
      .where(
        and(
          eq(aiCustomerPricingConfigs.scope, "global"),
          eq(aiCustomerPricingConfigs.isActive, true),
          isNull(aiCustomerPricingConfigs.tenantId),
        ),
      )
      .limit(1);

    if (globalRows[0]) {
      const r = globalRows[0];
      return {
        config: {
          id: r.id,
          pricingMode: r.pricingMode as "cost_plus_multiplier" | "fixed_markup" | "per_1k_tokens",
          multiplier: r.multiplier !== null ? Number(r.multiplier) : null,
          fixedMarkupUsd: r.fixedMarkupUsd !== null ? Number(r.fixedMarkupUsd) : null,
          pricePer1kInputTokensUsd: r.pricePer1kInputTokensUsd !== null ? Number(r.pricePer1kInputTokensUsd) : null,
          pricePer1kOutputTokensUsd: r.pricePer1kOutputTokensUsd !== null ? Number(r.pricePer1kOutputTokensUsd) : null,
          minimumChargeUsd: r.minimumChargeUsd !== null ? Number(r.minimumChargeUsd) : null,
        },
        source: "global_config",
      };
    }

    return null;
  } catch (err) {
    console.warn("[calculate-ai-price] loadCustomerPricingConfig error:", (err as Error).message);
    return null;
  }
}
