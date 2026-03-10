/**
 * AI Model Override Loader
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Loads DB-level routing overrides from ai_model_overrides.
 * Overrides are keyed by route_key — NOT by feature.
 *
 * Resolution priority:
 *   1. tenant override  (scope="tenant", scope_id=tenantId)
 *   2. global override  (scope="global", scope_id=NULL)
 *   3. returns null     (caller falls back to code default)
 *
 * Cache strategy (in-process Map, no Redis):
 *   - Fresh hit TTL:    60 seconds
 *   - Not-found TTL:    10 seconds  (keeps newly inserted overrides fast to activate)
 *   - Stale grace:       5 minutes  (served on DB failure if cached value is not null)
 *
 * Failure contract:
 *   - DB errors are logged as warnings only — never thrown to callers
 *   - Invalid provider in override row: log + return null
 *   - Any failure: return null so runner falls back to code default
 */

import { eq, and, isNull } from "drizzle-orm";
import { db } from "../../db";
import { aiModelOverrides } from "../../../shared/schema";
import type { AiModelRoute, AiProviderKey } from "./config";
import { getActiveProviderKeys } from "./providers/registry";

// ── Cache ──────────────────────────────────────────────────────────────────────

interface CacheEntry {
  value: AiModelRoute | null;
  expiresAt: number;
  cachedAt: number;
}

const overrideCache = new Map<string, CacheEntry>();

const TTL_HIT_MS        = 60_000;   // 60 s  — valid override
const TTL_MISS_MS       = 10_000;   // 10 s  — no override found (short: new rows activate quickly)
const STALE_GRACE_MS    = 300_000;  // 5 min — serve stale on DB failure

function buildCacheKey(scope: string, scopeId: string | null, routeKey: string): string {
  return `${scope}:${scopeId ?? "null"}:${routeKey}`;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Load the highest-priority active override for a route key.
 *
 * Returns null if no valid override exists or if any error occurs.
 * Never throws.
 */
export async function loadOverride(
  routeKey: string,
  tenantId?: string | null,
): Promise<AiModelRoute | null> {
  if (tenantId) {
    const tenantResult = await fetchScope(routeKey, "tenant", tenantId);
    if (tenantResult) return tenantResult;
    // null  = no tenant override — fall through to global
    // undefined = DB failure for tenant scope — fall through to global
  }

  const globalResult = await fetchScope(routeKey, "global", null);
  if (globalResult) return globalResult;

  return null;
}

// ── Internal ───────────────────────────────────────────────────────────────────

/**
 * Fetch override for a single scope, with TTL caching.
 *
 * Returns:
 *   AiModelRoute — valid override found
 *   null         — override not found (cached miss)
 *   undefined    — DB failed, no usable stale cache (skip this scope)
 */
async function fetchScope(
  routeKey: string,
  scope: string,
  scopeId: string | null,
): Promise<AiModelRoute | null | undefined> {
  const key = buildCacheKey(scope, scopeId, routeKey);
  const now = Date.now();

  const cached = overrideCache.get(key);
  if (cached && now < cached.expiresAt) {
    return cached.value;
  }

  try {
    const rows = await db
      .select()
      .from(aiModelOverrides)
      .where(
        and(
          eq(aiModelOverrides.scope, scope),
          scopeId !== null
            ? eq(aiModelOverrides.scopeId, scopeId)
            : isNull(aiModelOverrides.scopeId),
          eq(aiModelOverrides.routeKey, routeKey),
          eq(aiModelOverrides.isActive, true),
        ),
      )
      .limit(1);

    const row = rows[0];

    if (!row) {
      overrideCache.set(key, { value: null, expiresAt: now + TTL_MISS_MS, cachedAt: now });
      return null;
    }

    const activeProviders = getActiveProviderKeys();
    if (!activeProviders.includes(row.provider as AiProviderKey)) {
      console.warn(
        `[ai:overrides] provider '${row.provider}' in override row ${row.id} is not active — skipping`,
      );
      overrideCache.set(key, { value: null, expiresAt: now + TTL_MISS_MS, cachedAt: now });
      return null;
    }

    const route: AiModelRoute = {
      provider: row.provider as AiProviderKey,
      model: row.model,
    };
    overrideCache.set(key, { value: route, expiresAt: now + TTL_HIT_MS, cachedAt: now });
    return route;
  } catch (err) {
    console.warn(
      `[ai:overrides] DB lookup failed for key=${key}:`,
      err instanceof Error ? err.message : String(err),
    );

    if (cached && cached.value !== null && now - cached.cachedAt < STALE_GRACE_MS) {
      console.warn(`[ai:overrides] serving stale cache for key=${key}`);
      return cached.value;
    }

    return undefined;
  }
}
