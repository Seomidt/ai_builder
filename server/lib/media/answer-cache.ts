/**
 * answer-cache.ts — Chunk-lineage-aware in-memory answer cache.
 *
 * PHASE 5Z.5 — Prevents duplicate LLM work when the same query is asked
 * against identical validated chunk context.
 *
 * Design rules:
 *  - Cache key includes: tenantId + queryHash + refinementGenKey + docIds + mode
 *  - Partial and complete answers are cached SEPARATELY
 *  - Complete answers supersede partial answers for the same full context
 *  - Stale/superseded context misses the cache (key changes with context)
 *  - Bounded: max 200 entries (LRU-style pruning)
 *  - TTL: 5 min for partial, 30 min for complete
 *  - Tenant-safe: tenantId is part of every cache key
 */

import { createHash } from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AnswerMode = "partial" | "complete";

export interface CachedAnswer {
  text:                  string;
  answerCompleteness:    AnswerMode;
  coveragePercent:       number;
  refinementGeneration:  number;
  createdAt:             string;   // ISO timestamp
}

export interface AnswerCacheKey {
  tenantId:             string;
  queryHash:            string;   // sha256(normalised query)
  refinementGenKey:     string;   // from readiness trigger key or OCR stage
  docIds:               string;   // sorted join of document IDs
  mode:                 AnswerMode;
}

interface CacheEntry {
  answer:    CachedAnswer;
  expiresAt: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TTL_PARTIAL_MS  = 5  * 60 * 1000;   // 5 min
const TTL_COMPLETE_MS = 30 * 60 * 1000;   // 30 min
const MAX_ENTRIES     = 200;

// ── Module-level cache (per-process, Railway single-process OK) ───────────────

const _cache = new Map<string, CacheEntry>();

// ── Key derivation ────────────────────────────────────────────────────────────

/**
 * Returns a stable cache lookup key for the given context.
 * Changing any field causes a full cache miss — no stale context leaks.
 */
export function buildCacheKey(inputs: AnswerCacheKey): string {
  const canonical = [
    inputs.tenantId,
    inputs.queryHash,
    inputs.refinementGenKey,
    inputs.docIds,
    inputs.mode,
  ].join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

/**
 * Returns a stable sha256 hash of the normalised query string.
 * Case-folded + whitespace-normalised before hashing.
 */
export function hashQuery(query: string): string {
  const normalised = query.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalised).digest("hex").slice(0, 16);
}

// ── Cache operations ──────────────────────────────────────────────────────────

/** Look up a cached answer. Returns null on miss or expiry. */
export function getCachedAnswer(key: AnswerCacheKey): CachedAnswer | null {
  const cacheKey = buildCacheKey(key);
  const entry    = _cache.get(cacheKey);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    _cache.delete(cacheKey);
    return null;
  }
  return entry.answer;
}

/** Store an answer in the cache. Prunes oldest entries when full. */
export function setCachedAnswer(key: AnswerCacheKey, answer: CachedAnswer): void {
  const cacheKey = buildCacheKey(key);
  const ttl      = answer.answerCompleteness === "complete" ? TTL_COMPLETE_MS : TTL_PARTIAL_MS;

  _cache.set(cacheKey, { answer, expiresAt: Date.now() + ttl });

  // Prune when over capacity (remove oldest expiring entries first)
  if (_cache.size > MAX_ENTRIES) {
    const toDelete = [..._cache.entries()]
      .sort((a, b) => a[1].expiresAt - b[1].expiresAt)
      .slice(0, 50)
      .map(([k]) => k);
    toDelete.forEach(k => _cache.delete(k));
  }
}

/** Explicitly invalidate a cache entry (e.g. when lineage changes). */
export function invalidateCacheEntry(key: AnswerCacheKey): void {
  _cache.delete(buildCacheKey(key));
}

/** Returns current cache size (diagnostic). */
export function getCacheSize(): number {
  return _cache.size;
}

/** Removes all expired entries. Safe to call periodically. */
export function pruneExpiredEntries(): number {
  const now     = Date.now();
  let   removed = 0;
  for (const [k, v] of _cache) {
    if (now > v.expiresAt) { _cache.delete(k); removed++; }
  }
  return removed;
}
