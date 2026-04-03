/**
 * tests/lib/calculate-ai-price.test.ts
 *
 * Unit tests for calculateAiPrice() — pure function, no DB, no mocks needed.
 *
 * Coverage:
 *  1. cost_plus_multiplier — correct provider cost + customer price + margin
 *  2. fixed_markup         — flat USD addition to provider cost
 *  3. per_1k_tokens        — token-rate price, provider cost independent
 *  4. minimumChargeUsd     — floor applied in all modes
 *  5. margin always equals customerPrice − providerCost
 *  6. zero-token edge cases
 *  7. unknown pricingMode  — safe fallback to 1× pass-through
 *  8. missing optional fields — null/undefined handled safely
 *  9. tenant isolation (pricing is per-input, not stateful)
 * 10. 8-decimal-place precision
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { calculateAiPrice } from "../../server/lib/ai/pricing/calculate-ai-price.ts";

// ── Shared fixture ────────────────────────────────────────────────────────────

/** 1 200 input tokens + 400 output tokens with gpt-4.1-mini pricing */
const BASE = {
  inputTokens:         1_200,
  outputTokens:          400,
  inputPricePer1mUsd:    0.40,  // $0.40 / 1M → $0.00048 for 1200 tokens
  outputPricePer1mUsd:   1.60,  // $1.60 / 1M → $0.00064 for 400 tokens
  // providerCostUsd = 0.00048 + 0.00064 = 0.00112
} as const;

const PROVIDER_COST = (1_200 / 1_000_000) * 0.40 + (400 / 1_000_000) * 1.60; // 0.00112

// ─────────────────────────────────────────────────────────────────────────────
// 1. cost_plus_multiplier
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateAiPrice — cost_plus_multiplier", () => {
  it("1× multiplier: customer price = provider cost, margin = 0", () => {
    const r = calculateAiPrice({ ...BASE, pricingMode: "cost_plus_multiplier", multiplier: 1 });
    assert.ok(Math.abs(r.providerCostUsd  - PROVIDER_COST) < 1e-9, "providerCostUsd incorrect");
    assert.ok(Math.abs(r.customerPriceUsd - PROVIDER_COST) < 1e-9, "customerPriceUsd must equal cost at 1×");
    assert.ok(Math.abs(r.marginUsd)       < 1e-9,                  "margin must be 0 at 1×");
  });

  it("1.4× multiplier: customer price = cost × 1.4", () => {
    const r = calculateAiPrice({ ...BASE, pricingMode: "cost_plus_multiplier", multiplier: 1.4 });
    const expected = PROVIDER_COST * 1.4;
    assert.ok(Math.abs(r.customerPriceUsd - expected) < 1e-9);
    assert.ok(Math.abs(r.marginUsd - (expected - PROVIDER_COST)) < 1e-9);
  });

  it("2× multiplier: 100% markup", () => {
    const r = calculateAiPrice({ ...BASE, pricingMode: "cost_plus_multiplier", multiplier: 2 });
    assert.ok(Math.abs(r.customerPriceUsd - PROVIDER_COST * 2) < 1e-9);
    assert.ok(Math.abs(r.marginUsd        - PROVIDER_COST)     < 1e-9, "margin = providerCost at 2×");
  });

  it("multiplier=null defaults to 1 (no markup)", () => {
    const r = calculateAiPrice({ ...BASE, pricingMode: "cost_plus_multiplier", multiplier: null });
    assert.ok(Math.abs(r.customerPriceUsd - PROVIDER_COST) < 1e-9);
  });

  it("multiplier absent defaults to 1", () => {
    const r = calculateAiPrice({ ...BASE, pricingMode: "cost_plus_multiplier" });
    assert.ok(Math.abs(r.customerPriceUsd - PROVIDER_COST) < 1e-9);
  });

  it("negative multiplier is clamped to 0 (customer price = 0, but floor applies)", () => {
    const r = calculateAiPrice({ ...BASE, pricingMode: "cost_plus_multiplier", multiplier: -1 });
    assert.equal(r.customerPriceUsd, 0, "negative multiplier yields 0");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. fixed_markup
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateAiPrice — fixed_markup", () => {
  it("adds fixed amount to provider cost", () => {
    const markup = 0.005;
    const r = calculateAiPrice({ ...BASE, pricingMode: "fixed_markup", fixedMarkupUsd: markup });
    const expected = PROVIDER_COST + markup;
    assert.ok(Math.abs(r.providerCostUsd  - PROVIDER_COST) < 1e-9);
    assert.ok(Math.abs(r.customerPriceUsd - expected)       < 1e-9, "customer = cost + markup");
    assert.ok(Math.abs(r.marginUsd        - markup)         < 1e-9, "margin = fixedMarkupUsd");
  });

  it("zero fixedMarkupUsd: customer price = provider cost", () => {
    const r = calculateAiPrice({ ...BASE, pricingMode: "fixed_markup", fixedMarkupUsd: 0 });
    assert.ok(Math.abs(r.customerPriceUsd - PROVIDER_COST) < 1e-9);
    assert.ok(Math.abs(r.marginUsd) < 1e-9);
  });

  it("fixedMarkupUsd=null defaults to 0", () => {
    const r = calculateAiPrice({ ...BASE, pricingMode: "fixed_markup", fixedMarkupUsd: null });
    assert.ok(Math.abs(r.customerPriceUsd - PROVIDER_COST) < 1e-9);
  });

  it("large markup: margin = markup", () => {
    const markup = 1.0; // $1 flat charge
    const r = calculateAiPrice({ ...BASE, pricingMode: "fixed_markup", fixedMarkupUsd: markup });
    assert.ok(Math.abs(r.marginUsd - markup) < 1e-9);
    assert.ok(r.customerPriceUsd > PROVIDER_COST, "customer price must exceed provider cost");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. per_1k_tokens
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateAiPrice — per_1k_tokens", () => {
  it("customer price derived from token rates, not provider model cost", () => {
    // Different input/output rates
    const inputRate  = 0.002;  // $0.002 / 1k input tokens
    const outputRate = 0.006;  // $0.006 / 1k output tokens

    const r = calculateAiPrice({
      ...BASE,
      pricingMode:               "per_1k_tokens",
      pricePer1kInputTokensUsd:  inputRate,
      pricePer1kOutputTokensUsd: outputRate,
    });

    const expectedCustomer = (1_200 / 1_000) * inputRate + (400 / 1_000) * outputRate;
    assert.ok(Math.abs(r.providerCostUsd  - PROVIDER_COST)   < 1e-9, "provider cost still computed from model rates");
    assert.ok(Math.abs(r.customerPriceUsd - expectedCustomer) < 1e-9, "customer price from per_1k rates");
    assert.ok(Math.abs(r.marginUsd - (expectedCustomer - PROVIDER_COST)) < 1e-9);
  });

  it("zero rates: customer price = 0, margin = −providerCost", () => {
    const r = calculateAiPrice({
      ...BASE,
      pricingMode:               "per_1k_tokens",
      pricePer1kInputTokensUsd:  0,
      pricePer1kOutputTokensUsd: 0,
    });
    assert.equal(r.customerPriceUsd, 0, "zero rates → zero customer price");
    assert.ok(r.marginUsd < 0, "negative margin when price < cost");
  });

  it("null rates default to 0", () => {
    const r = calculateAiPrice({
      ...BASE,
      pricingMode:               "per_1k_tokens",
      pricePer1kInputTokensUsd:  null,
      pricePer1kOutputTokensUsd: null,
    });
    assert.equal(r.customerPriceUsd, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. minimumChargeUsd floor — applied in all modes
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateAiPrice — minimumChargeUsd floor", () => {
  it("cost_plus_multiplier: floor lifts customer price when cost < minimum", () => {
    // Very few tokens → tiny cost; floor of $0.01
    const r = calculateAiPrice({
      inputTokens: 10, outputTokens: 5,
      inputPricePer1mUsd: 0.40, outputPricePer1mUsd: 1.60,
      pricingMode:      "cost_plus_multiplier",
      multiplier:        1,
      minimumChargeUsd:  0.01,
    });
    assert.ok(r.providerCostUsd < 0.01,  "tiny cost must be below floor");
    assert.equal(r.customerPriceUsd, 0.01, "customer price must equal floor");
    assert.ok(r.marginUsd > 0, "margin = floor - tiny_cost > 0");
  });

  it("floor does not reduce price when cost already exceeds it", () => {
    const r = calculateAiPrice({
      inputTokens: 100_000, outputTokens: 50_000,
      inputPricePer1mUsd: 2.00, outputPricePer1mUsd: 8.00,
      pricingMode:      "cost_plus_multiplier",
      multiplier:        1.3,
      minimumChargeUsd:  0.001,
    });
    assert.ok(r.customerPriceUsd > 0.001, "price exceeds floor — floor must be irrelevant");
    const expected = ((100_000/1e6)*2 + (50_000/1e6)*8) * 1.3;
    assert.ok(Math.abs(r.customerPriceUsd - expected) < 1e-6);
  });

  it("fixed_markup: floor applied when markup < floor", () => {
    const r = calculateAiPrice({
      inputTokens: 1, outputTokens: 1,
      inputPricePer1mUsd: 0.10, outputPricePer1mUsd: 0.40,
      pricingMode:     "fixed_markup",
      fixedMarkupUsd:   0,
      minimumChargeUsd: 0.005,
    });
    assert.equal(r.customerPriceUsd, 0.005);
  });

  it("minimumChargeUsd=0: no floor effect", () => {
    const r = calculateAiPrice({
      ...BASE, pricingMode: "cost_plus_multiplier", multiplier: 1, minimumChargeUsd: 0,
    });
    assert.ok(Math.abs(r.customerPriceUsd - PROVIDER_COST) < 1e-9);
  });

  it("minimumChargeUsd=null: treated as 0", () => {
    const r = calculateAiPrice({
      ...BASE, pricingMode: "cost_plus_multiplier", multiplier: 1, minimumChargeUsd: null,
    });
    assert.ok(Math.abs(r.customerPriceUsd - PROVIDER_COST) < 1e-9);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. margin = customerPrice − providerCost (all modes)
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateAiPrice — margin invariant", () => {
  const modes: Array<Parameters<typeof calculateAiPrice>[0]> = [
    { ...BASE, pricingMode: "cost_plus_multiplier", multiplier: 1.5 },
    { ...BASE, pricingMode: "fixed_markup",         fixedMarkupUsd: 0.002 },
    { ...BASE, pricingMode: "per_1k_tokens",
      pricePer1kInputTokensUsd: 0.003, pricePer1kOutputTokensUsd: 0.009 },
  ];

  for (const input of modes) {
    it(`margin = customerPrice − providerCost for mode=${input.pricingMode}`, () => {
      const r = calculateAiPrice(input);
      const diff = r.customerPriceUsd - r.providerCostUsd;
      assert.ok(
        Math.abs(r.marginUsd - diff) < 1e-9,
        `marginUsd=${r.marginUsd} but customerPrice−providerCost=${diff}`,
      );
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. Zero-token edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateAiPrice — zero-token edge cases", () => {
  it("0 input + 0 output tokens: providerCost = 0, margin determined by floor", () => {
    const r = calculateAiPrice({
      inputTokens: 0, outputTokens: 0,
      inputPricePer1mUsd: 2.00, outputPricePer1mUsd: 8.00,
      pricingMode: "cost_plus_multiplier", multiplier: 1.5,
    });
    assert.equal(r.providerCostUsd,  0, "no tokens → zero provider cost");
    assert.equal(r.customerPriceUsd, 0, "no floor → zero customer price");
    assert.equal(r.marginUsd,        0, "zero margin on zero cost with 1.5×");
  });

  it("0 tokens with minimum charge: customer price = minimum", () => {
    const r = calculateAiPrice({
      inputTokens: 0, outputTokens: 0,
      inputPricePer1mUsd: 2.00, outputPricePer1mUsd: 8.00,
      pricingMode: "cost_plus_multiplier", multiplier: 1.5,
      minimumChargeUsd: 0.01,
    });
    assert.equal(r.providerCostUsd,  0);
    assert.equal(r.customerPriceUsd, 0.01, "floor applies even on zero tokens");
    assert.equal(r.marginUsd,        0.01, "margin = floor at zero cost");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. Unknown pricingMode — safe fallback
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateAiPrice — unknown pricingMode fallback", () => {
  it("unrecognised mode falls back to 1× pass-through (no markup)", () => {
    const r = calculateAiPrice({
      ...BASE,
      // Force cast to bypass TypeScript enum constraint
      pricingMode: "unknown_mode" as "cost_plus_multiplier",
    });
    assert.ok(Math.abs(r.providerCostUsd  - PROVIDER_COST) < 1e-9);
    assert.ok(Math.abs(r.customerPriceUsd - PROVIDER_COST) < 1e-9, "unknown mode → 1× pass-through");
    assert.ok(Math.abs(r.marginUsd) < 1e-9, "zero margin on pass-through");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 8. 8-decimal-place precision
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateAiPrice — precision", () => {
  it("results are rounded to 8 decimal places", () => {
    const r = calculateAiPrice({
      inputTokens: 1, outputTokens: 1,
      inputPricePer1mUsd: 0.40, outputPricePer1mUsd: 1.60,
      pricingMode: "cost_plus_multiplier", multiplier: 1.3,
    });
    // Check that no more than 8 decimal places are present
    const decimalPlaces = (n: number) => {
      const s = n.toFixed(10);
      return s.replace(/0+$/, "").split(".")[1]?.length ?? 0;
    };
    assert.ok(decimalPlaces(r.providerCostUsd)  <= 8, "providerCostUsd must have ≤ 8 dp");
    assert.ok(decimalPlaces(r.customerPriceUsd) <= 8, "customerPriceUsd must have ≤ 8 dp");
    assert.ok(decimalPlaces(r.marginUsd)        <= 8, "marginUsd must have ≤ 8 dp");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. Tenant isolation — pure function, not stateful
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateAiPrice — tenant isolation (stateless)", () => {
  it("two calls with different multipliers produce independent results", () => {
    const tenantA = calculateAiPrice({ ...BASE, pricingMode: "cost_plus_multiplier", multiplier: 1.2 });
    const tenantB = calculateAiPrice({ ...BASE, pricingMode: "cost_plus_multiplier", multiplier: 2.0 });

    assert.notEqual(tenantA.customerPriceUsd, tenantB.customerPriceUsd,
      "different multipliers must produce different prices");
    assert.ok(Math.abs(tenantA.providerCostUsd - tenantB.providerCostUsd) < 1e-9,
      "provider cost is the same for same token counts and model rates");
  });

  it("calling twice with same inputs produces same result (pure / no side effects)", () => {
    const r1 = calculateAiPrice({ ...BASE, pricingMode: "cost_plus_multiplier", multiplier: 1.5 });
    const r2 = calculateAiPrice({ ...BASE, pricingMode: "cost_plus_multiplier", multiplier: 1.5 });
    assert.equal(r1.providerCostUsd,  r2.providerCostUsd);
    assert.equal(r1.customerPriceUsd, r2.customerPriceUsd);
    assert.equal(r1.marginUsd,        r2.marginUsd);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 10. Realistic production scenarios
// ─────────────────────────────────────────────────────────────────────────────

describe("calculateAiPrice — realistic scenarios", () => {
  it("GPT-4.1-mini, 8 000 input + 1 200 output, 1.3× multiplier", () => {
    const r = calculateAiPrice({
      inputTokens: 8_000, outputTokens: 1_200,
      inputPricePer1mUsd: 0.40, outputPricePer1mUsd: 1.60,
      pricingMode: "cost_plus_multiplier", multiplier: 1.3,
    });
    const cost = (8_000/1e6)*0.40 + (1_200/1e6)*1.60; // 0.0032 + 0.00192 = 0.00512
    assert.ok(Math.abs(r.providerCostUsd - cost) < 1e-9);
    assert.ok(Math.abs(r.customerPriceUsd - cost * 1.3) < 1e-6);
    assert.ok(r.marginUsd > 0, "positive margin expected");
  });

  it("per_1k_tokens: $0.001 input, $0.003 output, 5 000 + 1 000 tokens", () => {
    const r = calculateAiPrice({
      inputTokens: 5_000, outputTokens: 1_000,
      inputPricePer1mUsd: 0.40, outputPricePer1mUsd: 1.60,
      pricingMode:               "per_1k_tokens",
      pricePer1kInputTokensUsd:  0.001,
      pricePer1kOutputTokensUsd: 0.003,
    });
    const expectedCustomer = (5_000/1_000)*0.001 + (1_000/1_000)*0.003; // 0.005 + 0.003 = 0.008
    assert.ok(Math.abs(r.customerPriceUsd - expectedCustomer) < 1e-9);
  });
});
