/**
 * routing-config.ts — AI Gateway routing configuration types and defaults.
 *
 * This file defines the structure for per-tenant, per-route routing configs
 * that the Cloudflare Worker loads from KV or falls back to embedded defaults.
 *
 * Config is intentionally FLAT — no nested logic, no AI calls, no DB access.
 */

// ── Model pricing (USD per 1M input tokens) ───────────────────────────────────
// Source: public provider pricing pages — update as pricing changes.

export const MODEL_PRICING_PER_1M_INPUT: Record<string, number> = {
  "gemini-2.0-flash":          0.10,
  "gemini-2.0-flash-lite":     0.075,
  "gemini-1.5-pro":            1.25,
  "gemini-1.5-flash":          0.075,
  "gpt-4o":                    2.50,
  "gpt-4o-mini":               0.15,
  "gpt-4-turbo":               10.00,
  "claude-3-5-sonnet-20241022": 3.00,
  "claude-3-haiku-20240307":   0.25,
  "mistral-large":             2.00,
  "mistral-small":             0.20,
};

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * A single routing rule: maps a (tenantId, routeKey) pair to provider/model
 * selection, fallback chain, and budget constraints.
 *
 * Stored as JSON in Cloudflare KV under key:  `route:{tenantId}:{routeKey}`
 * and also embedded as defaults in the worker for offline/cold-start safety.
 */
export interface RoutingRule {
  tenantId:     string;
  routeKey:     string;

  provider:     Provider;
  model:        string;

  fallback?: {
    provider: Provider;
    model:    string;
  };

  budget: {
    /**
     * Maximum estimated USD cost for a single request.
     * Computed as: (estimated_input_tokens / 1_000_000) * model_price_per_1M.
     * Estimation: 1 token ≈ 4 bytes of UTF-8 text (conservative).
     * Requests exceeding this limit receive HTTP 402 before touching the backend.
     */
    maxCostPerRequestUsd: number;
  };

  /**
   * Optional: override which HTTP error codes from the backend are treated as
   * retriable provider errors (triggering fallback retry).
   * Defaults: [429, 502, 503, 504].
   */
  retryOnStatusCodes?: number[];
}

export type Provider =
  | "google_gemini"
  | "openai"
  | "anthropic"
  | "mistral"
  | "cohere";

/**
 * KV key format: `route:{tenantId}:{routeKey}`
 * Example:       `route:tenant_acme:chat_document`
 */
export function buildKvKey(tenantId: string, routeKey: string): string {
  return `route:${tenantId}:${routeKey}`;
}

// ── Default routing rules ─────────────────────────────────────────────────────
// Embedded in the worker as fallback when KV lookup misses.
// Override per-tenant via KV without redeploying the worker.

export const DEFAULT_ROUTING_RULES: RoutingRule[] = [
  // ── Chat with document (primary path for BlissOps) ──────────────────────
  {
    tenantId: "*",
    routeKey: "chat_document",
    provider: "google_gemini",
    model:    "gemini-2.0-flash",
    fallback: {
      provider: "openai",
      model:    "gpt-4o-mini",
    },
    budget: {
      maxCostPerRequestUsd: 0.05,
    },
  },

  // ── Simple Q&A / short context ────────────────────────────────────────────
  {
    tenantId: "*",
    routeKey: "chat_simple",
    provider: "google_gemini",
    model:    "gemini-2.0-flash-lite",
    fallback: {
      provider: "google_gemini",
      model:    "gemini-2.0-flash",
    },
    budget: {
      maxCostPerRequestUsd: 0.005,
    },
  },

  // ── Long document analysis (large context) ────────────────────────────────
  {
    tenantId: "*",
    routeKey: "chat_long_document",
    provider: "google_gemini",
    model:    "gemini-1.5-pro",
    fallback: {
      provider: "anthropic",
      model:    "claude-3-haiku-20240307",
    },
    budget: {
      maxCostPerRequestUsd: 0.20,
    },
  },

  // ── Premium tenant: always GPT-4o ─────────────────────────────────────────
  {
    tenantId: "tenant_premium",
    routeKey: "chat_document",
    provider: "openai",
    model:    "gpt-4o",
    fallback: {
      provider: "anthropic",
      model:    "claude-3-5-sonnet-20241022",
    },
    budget: {
      maxCostPerRequestUsd: 0.50,
    },
  },
];

/**
 * Find the best-matching rule for a (tenantId, routeKey) pair.
 * Tenant-specific rules take precedence over wildcard (*) rules.
 */
export function resolveRule(
  rules:    RoutingRule[],
  tenantId: string,
  routeKey: string,
): RoutingRule | null {
  const specific = rules.find(
    r => r.tenantId === tenantId && r.routeKey === routeKey,
  );
  if (specific) return specific;

  const wildcard = rules.find(
    r => r.tenantId === "*" && r.routeKey === routeKey,
  );
  return wildcard ?? null;
}
