/**
 * AI Pricing Loader
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Resolves the pricing for a provider + model pair, in this priority:
 *   1. Active row in ai_model_pricing DB table  → source = "db_override", version = row.id
 *   2. Code default from AI_MODEL_PRICING_DEFAULTS in costs.ts → source = "code_default", version = null
 *   3. No pricing found                         → pricing = null, source = null, version = null
 *
 * Cache strategy (in-process Map, no Redis):
 *   - Fresh hit TTL:   60 seconds
 *   - Not-found TTL:   10 seconds (keeps new DB rows fast to activate)
 *   - Stale grace:      5 minutes  (served on DB failure if previous value exists)
 *
 * Failure contract:
 *   - DB errors are logged as warnings — never thrown to callers
 *   - Invalid DB rows are skipped — fallback to code defaults
 *   - Missing pricing returns null — AI calls are never blocked by pricing errors
 *
 * Final hardening: returns PricingResult with source + version for cost basis logging.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import { aiModelPricing } from "../../../shared/schema";
import { getDefaultPricing, type AiPricing } from "./costs";

// ── Result type ─────────────────────────────────────────────────────────────────

/**
 * Resolved pricing result for a provider + model pair.
 *
 * pricing — the rate data, null if no pricing known
 * source  — "db_override" if from the DB, "code_default" if from code defaults, null if not found
 * version — DB row id for "db_override", null for "code_default" or not found
 *           Allows cost rows to reference the exact pricing configuration used.
 */
export interface PricingResult {
  pricing: AiPricing | null;
  source: "db_override" | "code_default" | null;
  version: string | null;
}

// ── Cache ──────────────────────────────────────────────────────────────────────

interface CacheEntry {
  value: PricingResult;
  expiresAt: number;
  cachedAt: number;
}

const pricingCache = new Map<string, CacheEntry>();

const TTL_HIT_MS     = 60_000;  // 60 s  — valid pricing row or code default
const TTL_MISS_MS    = 10_000;  // 10 s  — no pricing known (new rows activate quickly)
const STALE_GRACE_MS = 300_000; // 5 min — serve stale on DB failure

function buildCacheKey(provider: string, model: string): string {
  return `${provider}:${model}`;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Load pricing for a provider + model pair.
 *
 * Priority: DB active row → code default → null.
 * Never throws. Cache is in-process only.
 *
 * Returns a PricingResult with pricing data, source identifier, and version.
 * Callers must persist source + version to ai_usage for cost basis auditability.
 */
export async function loadPricing(
  provider: string,
  model: string,
): Promise<PricingResult> {
  const key = buildCacheKey(provider, model);
  const now = Date.now();

  const cached = pricingCache.get(key);
  if (cached && now < cached.expiresAt) {
    return cached.value;
  }

  try {
    const rows = await db
      .select()
      .from(aiModelPricing)
      .where(
        and(
          eq(aiModelPricing.provider, provider),
          eq(aiModelPricing.model, model),
          eq(aiModelPricing.isActive, true),
        ),
      )
      .limit(1);

    const row = rows[0];

    if (row) {
      const result: PricingResult = {
        pricing: {
          inputPerMillionUsd:  Number(row.inputPerMillionUsd),
          outputPerMillionUsd: Number(row.outputPerMillionUsd),
        },
        source: "db_override",
        version: row.id,
      };
      pricingCache.set(key, { value: result, expiresAt: now + TTL_HIT_MS, cachedAt: now });
      return result;
    }

    // No active DB row — fall back to code default
    const defaultPricing = getDefaultPricing(provider, model);
    const result: PricingResult = defaultPricing
      ? { pricing: defaultPricing, source: "code_default", version: null }
      : { pricing: null, source: null, version: null };

    const ttl = defaultPricing ? TTL_HIT_MS : TTL_MISS_MS;
    pricingCache.set(key, { value: result, expiresAt: now + ttl, cachedAt: now });
    return result;
  } catch (err) {
    console.warn(
      `[ai:pricing] DB lookup failed for ${key}:`,
      err instanceof Error ? err.message : String(err),
    );

    // Stale grace: serve last-known non-null pricing if within grace window
    if (cached && cached.value.pricing !== null && now - cached.cachedAt < STALE_GRACE_MS) {
      console.warn(`[ai:pricing] serving stale cache for ${key}`);
      return cached.value;
    }

    // Final fallback: code default (may also be null — that is safe)
    const defaultPricing = getDefaultPricing(provider, model);
    return defaultPricing
      ? { pricing: defaultPricing, source: "code_default", version: null }
      : { pricing: null, source: null, version: null };
  }
}
