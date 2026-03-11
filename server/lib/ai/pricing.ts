/**
 * AI Pricing Loader
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Resolves the pricing for a provider + model pair, in this priority:
 *   1. Active row in ai_model_pricing DB table
 *   2. Code default from AI_MODEL_PRICING_DEFAULTS in costs.ts
 *   3. null — pricing unknown (AI call still proceeds, cost logged as null)
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
 */

import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import { aiModelPricing } from "../../../shared/schema";
import { getDefaultPricing, type AiPricing } from "./costs";

// ── Cache ──────────────────────────────────────────────────────────────────────

interface CacheEntry {
  value: AiPricing | null;
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
 */
export async function loadPricing(
  provider: string,
  model: string,
): Promise<AiPricing | null> {
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
      const pricing: AiPricing = {
        inputPerMillionUsd:  Number(row.inputPerMillionUsd),
        outputPerMillionUsd: Number(row.outputPerMillionUsd),
      };
      pricingCache.set(key, { value: pricing, expiresAt: now + TTL_HIT_MS, cachedAt: now });
      return pricing;
    }

    // No active DB row — fall back to code default
    const defaultPricing = getDefaultPricing(provider, model);
    const ttl = defaultPricing ? TTL_HIT_MS : TTL_MISS_MS;
    pricingCache.set(key, { value: defaultPricing, expiresAt: now + ttl, cachedAt: now });
    return defaultPricing;
  } catch (err) {
    console.warn(
      `[ai:pricing] DB lookup failed for ${key}:`,
      err instanceof Error ? err.message : String(err),
    );

    // Stale grace: serve last-known non-null value if within grace window
    if (cached && cached.value !== null && now - cached.cachedAt < STALE_GRACE_MS) {
      console.warn(`[ai:pricing] serving stale cache for ${key}`);
      return cached.value;
    }

    // Final fallback: code default (may also be null — that is safe)
    return getDefaultPricing(provider, model);
  }
}
