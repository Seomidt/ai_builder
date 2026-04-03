/**
 * answer-cache-distributed.ts — Multi-instance-safe answer cache.
 *
 * PHASE 5Z.6 — Replaces in-memory answer-cache.ts with a distributed backend
 * that works correctly across Railway horizontal instances (if deployed later).
 *
 * Backend: Replit KV (HTTP REST via REPLIT_DB_URL).
 *   - Key:   acache:{sha256(tenantId:queryHash:refinementGenKey:mode).slice(24)}
 *   - Value: JSON{answer, expiresAt}
 *   - TTL:   embedded in stored JSON (checked on read) — Replit KV has no native TTL
 *   - Writes: fire-and-forget (best-effort, cache miss is safe)
 *   - Tenant-safe: tenantId is part of every cache key
 *
 * Graceful fallback: if REPLIT_DB_URL is absent or any KV call throws,
 * the cache silently misses — the LLM call proceeds normally.
 *
 * cache_source field returned on every hit/miss for observability:
 *   "kv"      — Replit KV hit
 *   "miss"    — cache miss (any reason)
 */

import { createHash } from "node:crypto";

// ── Types ─────────────────────────────────────────────────────────────────────

export type AnswerMode = "partial" | "complete";
export type CacheSource = "kv" | "miss";

export interface CachedAnswer {
  text:                  string;
  answerCompleteness:    AnswerMode;
  coveragePercent:       number;
  refinementGeneration:  number;
  createdAt:             string;
}

export interface AnswerCacheKey {
  tenantId:         string;
  queryHash:        string;
  refinementGenKey: string;
  docIds:           string;
  mode:             AnswerMode;
}

export interface CacheGetResult {
  hit:    boolean;
  answer: CachedAnswer | null;
  source: CacheSource;
}

interface StoredEntry {
  answer:    CachedAnswer;
  expiresAt: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const TTL_PARTIAL_MS  = 5  * 60 * 1000;
const TTL_COMPLETE_MS = 30 * 60 * 1000;
const KV_KEY_PREFIX   = "acache:";

// ── Key derivation ────────────────────────────────────────────────────────────

export function buildCacheKey(inputs: AnswerCacheKey): string {
  const canonical = [
    inputs.tenantId,
    inputs.queryHash,
    inputs.refinementGenKey,
    inputs.docIds,
    inputs.mode,
  ].join(":");
  return KV_KEY_PREFIX + createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}

export function hashQuery(query: string): string {
  const normalised = query.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256").update(normalised).digest("hex").slice(0, 16);
}

// ── Replit KV HTTP client ──────────────────────────────────────────────────────

function kvBaseUrl(): string | null {
  return process.env.REPLIT_DB_URL ?? null;
}

async function kvGet(rawKey: string): Promise<string | null> {
  const base = kvBaseUrl();
  if (!base) return null;
  try {
    const res = await fetch(`${base}/${encodeURIComponent(rawKey)}`);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function kvSet(rawKey: string, value: string): Promise<void> {
  const base = kvBaseUrl();
  if (!base) return;
  try {
    const body = new URLSearchParams([[rawKey, value]]);
    await fetch(base, { method: "POST", body });
  } catch {
    // Fire-and-forget: failures are silently swallowed
  }
}

async function kvDelete(rawKey: string): Promise<void> {
  const base = kvBaseUrl();
  if (!base) return;
  try {
    await fetch(`${base}/${encodeURIComponent(rawKey)}`, { method: "DELETE" });
  } catch { }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Retrieve a cached answer.
 * Returns hit=false + source="miss" on any miss or error.
 */
export async function getCachedAnswerDistributed(key: AnswerCacheKey): Promise<CacheGetResult> {
  const cacheKey = buildCacheKey(key);

  const raw = await kvGet(cacheKey);
  if (!raw) return { hit: false, answer: null, source: "miss" };

  try {
    const entry = JSON.parse(decodeURIComponent(raw)) as StoredEntry;

    if (Date.now() > entry.expiresAt) {
      // Evict expired entry asynchronously
      kvDelete(cacheKey).catch(() => {});
      return { hit: false, answer: null, source: "miss" };
    }

    return { hit: true, answer: entry.answer, source: "kv" };
  } catch {
    return { hit: false, answer: null, source: "miss" };
  }
}

/**
 * Store an answer in the distributed cache.
 * Best-effort: failures are logged but not thrown.
 */
export async function setCachedAnswerDistributed(key: AnswerCacheKey, answer: CachedAnswer): Promise<void> {
  const cacheKey = buildCacheKey(key);
  const ttl      = answer.answerCompleteness === "complete" ? TTL_COMPLETE_MS : TTL_PARTIAL_MS;
  const entry: StoredEntry = { answer, expiresAt: Date.now() + ttl };

  try {
    await kvSet(cacheKey, encodeURIComponent(JSON.stringify(entry)));
  } catch { }
}

/**
 * Explicitly invalidate a cache entry.
 */
export async function invalidateCacheEntryDistributed(key: AnswerCacheKey): Promise<void> {
  await kvDelete(buildCacheKey(key));
}
