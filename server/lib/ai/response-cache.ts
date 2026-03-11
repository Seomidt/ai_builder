/**
 * AI Response Cache — Phase 3I
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Implements safe, tenant-isolated response caching for deterministic AI routes.
 *
 * Design guarantees:
 *   - Cacheability is explicit — only routes with enabled:true in AI_CACHE_POLICIES
 *     are eligible. All other routes skip caching entirely.
 *   - Tenant isolation is mandatory — cache_key includes tenantId in hash material,
 *     and the DB unique index enforces (tenant_id, cache_key) uniqueness.
 *   - Only successful provider responses are stored. Blocked/error/timeout outcomes
 *     never reach storeCachedResponse().
 *   - Expired entries are never returned — expiry is checked in the WHERE clause.
 *   - Cache writes never alter route/provider/model — resolution happens before caching.
 *   - Cache hits do NOT produce ai_usage provider-cost rows. They are observable
 *     via ai_cache_events only.
 *   - Cache key version allows safe invalidation when route config changes materially.
 *
 * Cache key construction:
 *   1. Hash raw content: SHA-256(systemPrompt + "|" + userInput) → contentHash
 *   2. Build fingerprint: "<version>:<tenantId>:<routeKey>:<provider>:<model>:<contentHash>"
 *   3. Hash fingerprint: SHA-256(fingerprint) → final cacheKey stored in DB
 *
 * Phase 3I.
 */

import { createHash } from "crypto";
import { eq, and, gt, sql } from "drizzle-orm";
import { db } from "../../db";
import { aiResponseCache, aiCacheEvents } from "@shared/schema";
import { getRouteCachePolicy, type AiCachePolicy } from "./config";
import type { AiCallResult } from "./types";

// ── Public interface ──────────────────────────────────────────────────────────

export interface CacheContext {
  tenantId: string;
  routeKey: string;
  provider: string;
  model: string;
  systemPrompt: string;
  userInput: string;
  requestId?: string | null;
  feature?: string;
}

type CacheLookupHit = {
  hit: true;
  result: AiCallResult;
  cacheKey: string;
};

type CacheLookupMiss = {
  hit: false;
  cacheKey: string;
  policy: AiCachePolicy;
};

export type CacheLookupResult = CacheLookupHit | CacheLookupMiss;

// ── Core functions ────────────────────────────────────────────────────────────

/**
 * Look up a valid (non-expired) cache entry for the given context.
 *
 * Returns { hit: true, result } if a fresh entry exists.
 * Returns { hit: false } if no entry exists, it's expired, or policy is disabled.
 *
 * Always records a cache_miss or cache_hit event (fire-and-forget).
 * Fail-open on DB errors — treats any failure as a cache miss.
 */
export async function lookupCachedResponse(ctx: CacheContext): Promise<CacheLookupResult> {
  const policy = getRouteCachePolicy(ctx.routeKey);

  if (!policy.enabled) {
    return { hit: false, cacheKey: "", policy };
  }

  const { cacheKey, fingerprint } = buildCacheKey(ctx, policy);

  try {
    const rows = await db
      .select()
      .from(aiResponseCache)
      .where(
        and(
          eq(aiResponseCache.tenantId, ctx.tenantId),
          eq(aiResponseCache.cacheKey, cacheKey),
          gt(aiResponseCache.expiresAt, new Date()),
        ),
      )
      .limit(1);

    if (rows.length === 0) {
      void recordCacheEvent({
        tenantId: ctx.tenantId,
        requestId: ctx.requestId,
        routeKey: ctx.routeKey,
        provider: ctx.provider,
        model: ctx.model,
        eventType: "cache_miss",
        cacheKey,
      });
      return { hit: false, cacheKey, policy };
    }

    const entry = rows[0];

    void updateHitStats(entry.id);

    void recordCacheEvent({
      tenantId: ctx.tenantId,
      requestId: ctx.requestId,
      routeKey: ctx.routeKey,
      provider: ctx.provider,
      model: ctx.model,
      eventType: "cache_hit",
      cacheKey,
    });

    const payload = entry.responsePayload as {
      text: string;
      usage: AiCallResult["usage"];
      model: string;
      feature: string;
    };

    const result: AiCallResult = {
      text: payload.text,
      usage: payload.usage ?? null,
      latencyMs: 0,
      model: payload.model,
      feature: payload.feature,
    };

    console.log(
      `[ai:cache] ✓ cache_hit tenant=${ctx.tenantId} route=${ctx.routeKey} model=${ctx.model} key=${cacheKey.slice(0, 16)}…`,
    );

    return { hit: true, result, cacheKey };

  } catch (err) {
    console.warn("[ai:cache] lookupCachedResponse failed (fail-open):", err);
    return { hit: false, cacheKey, policy };
  }
}

/**
 * Store a successful AI provider response in the cache.
 *
 * Must only be called after a real provider call succeeds.
 * Uses INSERT ... ON CONFLICT DO NOTHING — idempotent under concurrent writes.
 * Fail-open on DB errors — a failed write does not propagate to the caller.
 */
export async function storeCachedResponse(
  ctx: CacheContext,
  result: AiCallResult,
): Promise<void> {
  const policy = getRouteCachePolicy(ctx.routeKey);

  if (!policy.enabled) return;

  if (!result.text || result.text.trim().length === 0) {
    console.warn("[ai:cache] storeCachedResponse: skipping empty response text");
    return;
  }

  const { cacheKey, fingerprint } = buildCacheKey(ctx, policy);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + policy.ttlSeconds * 1_000);

  const responsePayload: Record<string, unknown> = {
    text: result.text,
    usage: result.usage,
    model: result.model,
    feature: result.feature,
  };

  try {
    await db
      .insert(aiResponseCache)
      .values({
        tenantId: ctx.tenantId,
        routeKey: ctx.routeKey,
        provider: ctx.provider,
        model: ctx.model,
        cacheKey,
        requestFingerprint: fingerprint,
        responsePayload,
        responseText: result.text,
        status: "success",
        ttlSeconds: policy.ttlSeconds,
        expiresAt,
        lastHitAt: null,
      })
      .onConflictDoNothing();

    void recordCacheEvent({
      tenantId: ctx.tenantId,
      requestId: ctx.requestId,
      routeKey: ctx.routeKey,
      provider: ctx.provider,
      model: ctx.model,
      eventType: "cache_write",
      cacheKey,
    });

    console.log(
      `[ai:cache] ✎ cache_write tenant=${ctx.tenantId} route=${ctx.routeKey} model=${ctx.model} ttl=${policy.ttlSeconds}s key=${cacheKey.slice(0, 16)}…`,
    );

  } catch (err) {
    console.warn("[ai:cache] storeCachedResponse failed (fail-open):", err);
  }
}

/**
 * Record a cache observability event (fire-and-forget).
 * Errors are swallowed — this must not affect the request path.
 */
export async function recordCacheEvent(params: {
  tenantId: string;
  requestId?: string | null;
  routeKey?: string;
  provider?: string;
  model?: string;
  eventType: "cache_hit" | "cache_miss" | "cache_write" | "cache_skip";
  cacheKey?: string;
  reason?: string;
}): Promise<void> {
  try {
    await db.insert(aiCacheEvents).values({
      tenantId: params.tenantId,
      requestId: params.requestId ?? null,
      routeKey: params.routeKey ?? null,
      provider: params.provider ?? null,
      model: params.model ?? null,
      eventType: params.eventType,
      cacheKey: params.cacheKey ?? null,
      reason: params.reason ?? null,
    });
  } catch (err) {
    console.warn("[ai:cache] recordCacheEvent failed:", err);
  }
}

// ── Cache key construction ────────────────────────────────────────────────────

/**
 * Build a deterministic, tenant-scoped cache key.
 *
 * Steps:
 *   1. Hash raw content (system prompt + user input) → contentHash (SHA-256 hex)
 *   2. Build pre-hash fingerprint string (no raw text, debug-safe)
 *   3. Hash fingerprint → final cacheKey (SHA-256 hex)
 *
 * The fingerprint (step 2) is also stored in the DB for debugging without
 * requiring raw prompt text storage.
 */
function buildCacheKey(
  ctx: CacheContext,
  policy: AiCachePolicy,
): { cacheKey: string; fingerprint: string } {
  const contentHash = sha256(`${ctx.systemPrompt}|${ctx.userInput}`);
  const fingerprint = [
    policy.cacheKeyVersion,
    ctx.tenantId,
    ctx.routeKey,
    ctx.provider,
    ctx.model,
    contentHash,
  ].join(":");
  const cacheKey = sha256(fingerprint);
  return { cacheKey, fingerprint };
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Increment hit_count and update last_hit_at for a cache entry.
 * Fire-and-forget — errors are swallowed.
 */
async function updateHitStats(entryId: string): Promise<void> {
  try {
    await db
      .update(aiResponseCache)
      .set({
        hitCount: sql`${aiResponseCache.hitCount} + 1`,
        lastHitAt: new Date(),
      })
      .where(eq(aiResponseCache.id, entryId));
  } catch (err) {
    console.warn("[ai:cache] updateHitStats failed:", err);
  }
}
