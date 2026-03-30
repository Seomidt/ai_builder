/**
 * Similarity Control Layer — Storage 1.7 / 1.7A
 *
 * Central control plane for the Similar Cases engine.
 *
 * Responsibilities:
 *   A. shouldRunSimilarity()         — intent-based decision (NOT keyword-primary)
 *   B. resolveMinScore()             — configurable per-channel minScore
 *   C. ISimilarityCache + impl       — cache abstraction (swap-ready for Redis/Upstash)
 *   D. SimilarityRateLimiter         — per-tenant rate protection
 *   E. shouldAllowSimilarityByBudget — budget-aware guard (reuses guards.ts)
 *   F. resolveSimilarityConfidence() — central confidence mapping (single source of truth)
 *   G. logSimilarityEvent()          — structured observability (SOC2-ready)
 *
 * Design principles:
 *   - Language-agnostic: no hardcoded Danish/English strings as primary logic
 *   - Domain-generic: no industry-specific terms (claims, policy, bank, etc.)
 *   - Tenant-safe: cache and rate limits are always tenant-scoped
 *   - Non-blocking: errors in this layer must never disrupt the primary chat flow
 *   - Configurable: thresholds and limits are in one place, easy to extend to DB
 *   - Abstraction-ready: cache layer has interface — Redis/Upstash can plug in cleanly
 */

import type { AiUseCase } from "../ai/types.ts";

// ─── Locale-safe types ────────────────────────────────────────────────────────

/**
 * Why a result matched — locale-safe code for frontend localisation.
 * Frontend maps these to user-visible text in their language.
 */
export type WhyMatchedCode = "vector_match" | "lexical_match" | "hybrid_match";

/**
 * Confidence band for a similar case result.
 * Derived from score + retrieval channel via resolveSimilarityConfidence().
 */
export type SimilarConfidenceCode = "high" | "medium" | "low" | "unknown";

/**
 * Why similarity was (or was not) triggered.
 * Returned in response meta-structure for frontend/debug transparency.
 */
export type SimilarityDecisionReason =
  | "use_case_rule"       // triggered because useCase mandates retrieval
  | "expert_config"       // triggered by expert routingHints.similarityMode
  | "query_shape"         // triggered by query shape (question, sufficient length)
  | "fallback_keyword"    // triggered by weak keyword heuristic (last resort)
  | "not_triggered"       // no conditions met — skip
  | "rate_limited"        // would trigger but rate limit exceeded
  | "cache_hit";          // answered from cache — no retrieval performed

/**
 * What happened with similar-cases for a given chat turn.
 * Included in ChatRunResult for frontend/debug.
 * All values are locale-safe codes — frontend localises to user language.
 */
export type SimilarCasesStatusCode =
  | "success"              // found and returned
  | "no_matches"           // retrieval ran but no results above threshold
  | "not_triggered"        // decision layer said skip
  | "rate_limited"         // skipped due to rate limit
  | "cache_hit"            // served from cache
  | "below_threshold"      // results existed but all filtered by score
  | "skipped_budget_guard" // skipped because tenant AI budget is exhausted/blocked
  | "error_suppressed";    // exception caught, silently suppressed

// ─── Part A: Intent-based similarity decision ─────────────────────────────────

interface ShouldRunParams {
  message:    string;
  useCase?:   AiUseCase | null;
  expertRoutingHints?: Record<string, unknown> | null;
  hasKnowledgeBases?: boolean;
}

interface SimilarityDecision {
  shouldRun:       boolean;
  decisionReason:  SimilarityDecisionReason;
}

/** Use-cases that explicitly benefit from similarity retrieval */
const SIMILARITY_USE_CASES = new Set<AiUseCase>([
  "retrieval_answer",
  "grounded_chat",
]);

const MIN_QUERY_CHARS = 20;
const MAX_QUERY_CHARS = 8_000;

/**
 * Weak keyword fallback list — language-agnostic root patterns.
 * NOT the primary decision mechanism. Only triggers if all structural rules fail.
 * Covers common European languages without maintaining separate brittle keyword lists.
 */
const SIMILARITY_KEYWORD_PATTERNS = [
  /\bsimilar\b/i,       // EN
  /\brelated\b/i,       // EN
  /\blike\s+this\b/i,   // EN
  /\bexample\b/i,       // EN/multilingual
  /\bcase\b/i,          // EN/multilingual root
  /\banal\w+\b/i,       // analogy, analogous (various langs)
  /\bprev\w+\b/i,       // previous, precedent (various langs)
  /\bcompar\w+\b/i,     // compare, comparison (various langs)
  /\bprior\b/i,         // EN
  /\bhistor\w+\b/i,     // historical, history (various langs)
  /\bähnlich\b/i,       // DE: similar
  /\bliknande\b/i,      // SV: similar
  /\blignende\b/i,      // DA: similar
  /\bsamanl\w+\b/i,     // NO: comparison
  /\bvastaa\w+\b/i,     // FI: similar
  /\bsimilaire\b/i,     // FR: similar
  /\bsimilar\w*\b/i,    // ES/PT: similar
];

/**
 * Decide whether similarity search should run for a chat turn.
 *
 * Priority (first match wins):
 *   1. use_case_rule  — explicit useCase mandates retrieval
 *   2. expert_config  — expert routingHints.similarityMode = "always" | "never"
 *   3. query_shape    — question structure + sufficient length (language-agnostic)
 *   4. fallback_keyword — weak cross-language root patterns (last resort)
 *   5. not_triggered  — default: skip
 */
export function shouldRunSimilarity(params: ShouldRunParams): SimilarityDecision {
  const { message, useCase, expertRoutingHints, hasKnowledgeBases } = params;

  if (hasKnowledgeBases === false) {
    return { shouldRun: false, decisionReason: "not_triggered" };
  }

  const msgLen = message.trim().length;
  if (msgLen < MIN_QUERY_CHARS || msgLen > MAX_QUERY_CHARS) {
    return { shouldRun: false, decisionReason: "not_triggered" };
  }

  if (useCase && SIMILARITY_USE_CASES.has(useCase)) {
    return { shouldRun: true, decisionReason: "use_case_rule" };
  }

  const simMode = expertRoutingHints?.["similarityMode"];
  if (simMode === "always") return { shouldRun: true,  decisionReason: "expert_config" };
  if (simMode === "never")  return { shouldRun: false, decisionReason: "not_triggered" };

  const trimmed = message.trim();
  const hasQuestionMark  = trimmed.includes("?");
  const firstWord        = trimmed.split(/\s/)[0] ?? "";
  const startsWithShortWord = firstWord.length <= 5;

  if (hasQuestionMark || (startsWithShortWord && msgLen >= MIN_QUERY_CHARS)) {
    return { shouldRun: true, decisionReason: "query_shape" };
  }

  for (const pattern of SIMILARITY_KEYWORD_PATTERNS) {
    if (pattern.test(message)) {
      return { shouldRun: true, decisionReason: "fallback_keyword" };
    }
  }

  return { shouldRun: false, decisionReason: "not_triggered" };
}

// ─── Part B: Configurable minScore resolver ───────────────────────────────────

export interface SimilarityThresholds {
  vector:  number;
  hybrid:  number;
  lexical: number;
}

const DEFAULT_THRESHOLDS: SimilarityThresholds = {
  vector:  0.35,
  hybrid:  0.30,
  lexical: 0.15,
};

/**
 * Resolve min-score threshold for a retrieval channel.
 *
 * Single source of truth for all threshold decisions.
 * Caller may pass tenant-specific overrides (future: from DB).
 */
export function resolveMinScore(
  channel: "vector" | "lexical" | "hybrid",
  overrides?: Partial<SimilarityThresholds>,
): number {
  const merged: SimilarityThresholds = { ...DEFAULT_THRESHOLDS, ...overrides };
  return merged[channel];
}

// ─── Part F: Central confidence mapping ──────────────────────────────────────

/**
 * resolveSimilarityConfidence — single source of truth for confidence labels.
 *
 * Maps score + retrieval channel → SimilarConfidenceCode.
 * Bands are calibrated per channel because score semantics differ:
 *
 *   vector / hybrid (cosine 0.0–1.0):
 *     high    >= 0.80   — very close match, reliable
 *     medium  >= 0.55   — plausible match, worth showing
 *     low     >= 0.35   — weak match, use with caution (at threshold floor)
 *     unknown  < 0.35   — below threshold, should not normally appear
 *
 *   lexical (pg_trgm + ts_rank composite, rarely exceeds 0.5):
 *     high    >= 0.40   — strong lexical overlap
 *     medium  >= 0.25   — moderate lexical overlap
 *     low     >= 0.15   — minimal overlap (at threshold floor)
 *     unknown  < 0.15   — below threshold, should not normally appear
 *
 * Rules:
 *   - Thresholds must be >= resolveMinScore() for their channel
 *   - Do NOT add ML scoring here — keep deterministic + explainable
 *   - If you change thresholds, document why in this comment
 */
export function resolveSimilarityConfidence(
  score: number,
  channel: "vector" | "lexical" | "hybrid",
): SimilarConfidenceCode {
  if (channel === "lexical") {
    if (score >= 0.40) return "high";
    if (score >= 0.25) return "medium";
    if (score >= 0.15) return "low";
    return "unknown";
  }
  // vector + hybrid
  if (score >= 0.80) return "high";
  if (score >= 0.55) return "medium";
  if (score >= 0.35) return "low";
  return "unknown";
}

/**
 * @deprecated Use resolveSimilarityConfidence() instead.
 * Kept for backward compatibility — delegates to canonical function.
 */
export const deriveConfidenceCode = resolveSimilarityConfidence;

/**
 * Map retrieval channel → locale-safe WhyMatchedCode.
 * Frontend localises these to user-facing language.
 */
export function deriveWhyMatchedCode(
  channel: "vector" | "lexical" | "hybrid",
): WhyMatchedCode {
  if (channel === "lexical") return "lexical_match";
  if (channel === "hybrid")  return "hybrid_match";
  return "vector_match";
}

// ─── Part C: Cache abstraction layer ─────────────────────────────────────────

/**
 * ISimilarityCache<T> — provider-agnostic cache interface.
 *
 * Current implementation: MemorySimilarityCache (in-process, single instance).
 *
 * Future swap path:
 *   To switch to Redis/Upstash/Valkey for multi-instance deployments:
 *   1. Implement ISimilarityCache<T> against your chosen client
 *   2. Replace `similarityCache` export with your new instance
 *   3. No callers need changes — all depend on this interface, not the class
 *
 * Invariants:
 *   - Cache keys MUST always begin with tenantId (enforced by buildKey)
 *   - get() must return null on miss or expired entry
 *   - set() must never throw (fail silently is preferred over disrupting chat)
 */
export interface ISimilarityCache<T> {
  /** Build a deterministic, tenant-safe cache key. */
  buildKey(parts: {
    tenantId:  string;
    expertId?: string;
    query:     string;
    topK:      number;
    kbIds?:    string[];
  }): string;

  /** Return cached value, or null on miss/expiry. */
  get(key: string): T | null | Promise<T | null>;

  /** Store a value. Should not throw. */
  set(key: string, value: T): void | Promise<void>;

  /** Evict all entries for a tenant (e.g. when KB is updated). */
  invalidateTenant(tenantId: string): void | Promise<void>;
}

interface CacheEntry<T> {
  value:     T;
  expiresAt: number;
}

/**
 * MemorySimilarityCache — default ISimilarityCache implementation.
 *
 * In-process, single-instance. Suitable for single-server and Vercel serverless.
 * For multi-instance (Railway/Fly), swap with a Redis-backed ISimilarityCache.
 *
 * Eviction: LRU-style (evicts oldest entry when maxSize is reached).
 * TTL: entries expire after ttlSeconds.
 */
class MemorySimilarityCache<T> implements ISimilarityCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs:   number;
  private readonly maxSize: number;

  constructor(ttlSeconds: number = 300, maxSize: number = 500) {
    this.ttlMs   = ttlSeconds * 1000;
    this.maxSize = maxSize;
  }

  buildKey(parts: {
    tenantId:  string;
    expertId?: string;
    query:     string;
    topK:      number;
    kbIds?:    string[];
  }): string {
    const { tenantId, expertId, query, topK, kbIds } = parts;
    const normalizedQuery = query.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 500);
    const kbPart = kbIds?.sort().join(",") ?? "";
    return `${tenantId}|${expertId ?? ""}|${topK}|${kbPart}|${normalizedQuery}`;
  }

  get(key: string): T | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.store.size >= this.maxSize) {
      const firstKey = this.store.keys().next().value;
      if (firstKey !== undefined) this.store.delete(firstKey);
    }
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  invalidateTenant(tenantId: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(`${tenantId}|`)) this.store.delete(key);
    }
  }

  get size(): number { return this.store.size; }
}

/**
 * Factory — returns the default in-memory cache instance.
 *
 * Swap this factory's return value to change the cache provider globally.
 * For Redis: return new RedisSimilarityCache(redisClient, { ttlSeconds: 300 })
 */
function createDefaultSimilarityCache(): ISimilarityCache<unknown> {
  return new MemorySimilarityCache(300, 500);
}

/** Module-level cache — 5min TTL, 500 entries, tenant-safe keys */
export const similarityCache = createDefaultSimilarityCache() as MemorySimilarityCache<unknown>;

// ─── Part D: Per-tenant rate limiter ─────────────────────────────────────────

interface RateWindow {
  count:       number;
  windowStart: number;
}

class SimilarityRateLimiter {
  private windows = new Map<string, RateWindow>();
  private readonly maxPerMinute: number;
  private readonly windowMs = 60_000;

  constructor(maxPerMinute: number = 30) {
    this.maxPerMinute = maxPerMinute;
  }

  allow(tenantId: string): boolean {
    const now      = Date.now();
    const existing = this.windows.get(tenantId);

    if (!existing || now - existing.windowStart > this.windowMs) {
      this.windows.set(tenantId, { count: 1, windowStart: now });
      return true;
    }
    if (existing.count >= this.maxPerMinute) return false;
    existing.count += 1;
    return true;
  }

  remaining(tenantId: string): number {
    const now      = Date.now();
    const existing = this.windows.get(tenantId);
    if (!existing || now - existing.windowStart > this.windowMs) return this.maxPerMinute;
    return Math.max(0, this.maxPerMinute - existing.count);
  }
}

/** Module-level rate limiter — 30 similarity calls/minute per tenant */
export const similarityRateLimiter = new SimilarityRateLimiter(30);

// ─── Part E: Budget-aware guard ───────────────────────────────────────────────

/**
 * shouldAllowSimilarityByBudget
 *
 * Checks whether the tenant's AI budget allows similarity to run.
 * Reuses the existing guards.ts infrastructure — no duplicated budget math.
 *
 * Decision:
 *   - "blocked"     → skip similarity (return false). Budget exhausted, margin must be protected.
 *   - "budget_mode" → allow (similarity is vector retrieval, not a full AI call — minimal cost).
 *   - "normal"      → allow.
 *   - No limit configured / DB failure → fail-open (allow). Conservative safe default.
 *
 * Never throws — always returns { allowed, reason }.
 */
export async function shouldAllowSimilarityByBudget(
  tenantId: string,
): Promise<{ allowed: boolean; reason: "ok" | "budget_blocked" | "no_limit" | "guard_error" }> {
  try {
    const { loadUsageLimit, getCurrentAiUsageForPeriod, evaluateAiUsageState } =
      await import("../ai/guards");

    const limit = await loadUsageLimit(tenantId);
    if (!limit) {
      return { allowed: true, reason: "no_limit" };
    }

    const currentUsageUsd = await getCurrentAiUsageForPeriod(tenantId);
    const state = evaluateAiUsageState({ currentUsageUsd, limit });

    if (state === "blocked") {
      return { allowed: false, reason: "budget_blocked" };
    }

    return { allowed: true, reason: "ok" };
  } catch (err) {
    console.warn(
      `[similarity:budget-guard] Error checking budget for tenant=${tenantId}: ${
        err instanceof Error ? err.message : String(err)
      } — failing open (allowing similarity)`,
    );
    return { allowed: true, reason: "guard_error" };
  }
}

// ─── Part G: Structured observability logging ─────────────────────────────────

export interface SimilarityEventLog {
  tenantId:            string;
  expertId?:           string;
  mode:                "text" | "asset" | "chunk";
  decisionReason:      SimilarityDecisionReason;
  statusCode:          SimilarCasesStatusCode;
  cacheHit:            boolean;
  budgetGuardSkipped:  boolean;
  pgvectorUsed:        boolean;
  retrievalPath:       string;
  candidateCount:      number;
  returnedCount:       number;
  latencyMs:           number;
  topK:                number;
  rateLimitRemaining:  number;
}

/**
 * Log a structured similarity event.
 *
 * Format: [similarity:event] {JSON}
 *
 * Structured for log aggregators (Datadog, CloudWatch, Loki, Axiom).
 * No PII — query text is never logged (privacy-safe, SOC2-compatible).
 */
export function logSimilarityEvent(event: SimilarityEventLog): void {
  console.log(`[similarity:event] ${JSON.stringify({
    tenant:      event.tenantId,
    expert:      event.expertId ?? null,
    mode:        event.mode,
    decision:    event.decisionReason,
    status:      event.statusCode,
    cache_hit:   event.cacheHit,
    budget_skip: event.budgetGuardSkipped,
    pgv:         event.pgvectorUsed,
    path:        event.retrievalPath,
    candidates:  event.candidateCount,
    returned:    event.returnedCount,
    latency_ms:  event.latencyMs,
    top_k:       event.topK,
    rate_rem:    event.rateLimitRemaining,
    ts:          new Date().toISOString(),
  })}`);
}
