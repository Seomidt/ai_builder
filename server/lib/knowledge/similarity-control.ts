/**
 * Similarity Control Layer — Storage 1.7
 *
 * Central control plane for the Similar Cases engine.
 *
 * Responsibilities:
 *   A. shouldRunSimilarity()   — intent-based decision (NOT keyword-primary)
 *   B. resolveSimilarityThresholds() — configurable per-channel minScore
 *   C. SimilarityCache        — in-memory tenant-safe cache with TTL
 *   D. SimilarityRateLimiter  — per-tenant rate protection
 *   E. logSimilarityEvent()   — structured observability (SOC2-ready)
 *
 * Design principles:
 *   - Language-agnostic: no hardcoded Danish/English strings as primary logic
 *   - Domain-generic: no industry-specific terms (claims, policy, bank, etc.)
 *   - Tenant-safe: cache and rate limits are always tenant-scoped
 *   - Non-blocking: errors in this layer must never disrupt the primary chat flow
 *   - Configurable: thresholds and limits are in one place, easy to extend to DB
 */

import type { AiUseCase } from "../ai/types";

// ─── Part C: Locale-safe types (exported for use in kb-similar + chat-runner) ─

/**
 * Why a result matched — locale-safe code for frontend localisation.
 * Frontend maps these to user-visible text in their language.
 */
export type WhyMatchedCode = "vector_match" | "lexical_match" | "hybrid_match";

/**
 * Confidence band for a similar case result.
 * Derived from score + retrieval channel.
 */
export type SimilarConfidenceCode = "high" | "medium" | "low" | "unknown";

/**
 * Why similarity was (or was not) triggered.
 * Returned in the response meta-structure for frontend/debug transparency.
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
 */
export type SimilarCasesStatusCode =
  | "success"             // found and returned
  | "no_matches"          // retrieval ran but no results above threshold
  | "not_triggered"       // decision layer said skip
  | "rate_limited"        // skipped due to rate limit
  | "cache_hit"           // served from cache
  | "below_threshold"     // results existed but all filtered by score
  | "error_suppressed";   // exception caught, silently suppressed

// ─── Part A: Intent-based similarity decision ─────────────────────────────────

/**
 * Rules for when similarity search should run.
 *
 * Priority order (evaluated in sequence, first match wins):
 *   1. use_case_rule  — explicit route/use-case mandates retrieval
 *   2. expert_config  — expert routingHints contains similarityMode
 *   3. query_shape    — question structure + length signals retrieval intent
 *   4. fallback_keyword — weak keyword heuristic (secondary, last resort)
 *   5. not_triggered  — default: skip
 *
 * This must work without language-specific hardcoding.
 */

interface ShouldRunParams {
  message:    string;
  useCase?:   AiUseCase | null;
  expertRoutingHints?: Record<string, unknown> | null;
  hasKnowledgeBases?: boolean;  // skip if expert has no KBs at all
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

/**
 * Question-shape heuristics (language-agnostic):
 * - ends with "?"
 * - starts with interrogative char-patterns (wh*, how*, what*, etc. — language-agnostic check: any word < 5 chars at start)
 * - message is longer than MIN_QUERY_CHARS (real question, not a trivial command)
 */
const MIN_QUERY_CHARS = 20;
const MAX_QUERY_CHARS = 8_000; // beyond this length, skip (document upload mode)

/**
 * Weak keyword fallback list — language-agnostic approach using common roots.
 * NOT the primary decision mechanism. Only used if all other rules fail.
 * These are broad enough to catch multiple European languages without brittle exact-match lists.
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

export function shouldRunSimilarity(params: ShouldRunParams): SimilarityDecision {
  const { message, useCase, expertRoutingHints, hasKnowledgeBases } = params;

  // Never run if expert has no knowledge bases
  if (hasKnowledgeBases === false) {
    return { shouldRun: false, decisionReason: "not_triggered" };
  }

  const msgLen = message.trim().length;

  // Never run on very short or very long inputs
  if (msgLen < MIN_QUERY_CHARS || msgLen > MAX_QUERY_CHARS) {
    return { shouldRun: false, decisionReason: "not_triggered" };
  }

  // ── Rule 1: Use-case mandates retrieval ─────────────────────────────────
  if (useCase && SIMILARITY_USE_CASES.has(useCase)) {
    return { shouldRun: true, decisionReason: "use_case_rule" };
  }

  // ── Rule 2: Expert routing hint enables similarity ─────────────────────
  const simMode = expertRoutingHints?.["similarityMode"];
  if (simMode === "always") {
    return { shouldRun: true, decisionReason: "expert_config" };
  }
  if (simMode === "never") {
    return { shouldRun: false, decisionReason: "not_triggered" };
  }

  // ── Rule 3: Query shape (language-agnostic) ─────────────────────────────
  // A real question is: >= MIN_QUERY_CHARS, contains "?" or starts with
  // a short word (common interrogative pattern across European languages).
  const trimmed = message.trim();
  const hasQuestionMark = trimmed.includes("?");
  const firstWord = trimmed.split(/\s/)[0] ?? "";
  const startsWithShortWord = firstWord.length <= 5; // wh*, how*, was*, kan*, er*, etc.

  if (hasQuestionMark || (startsWithShortWord && msgLen >= MIN_QUERY_CHARS)) {
    return { shouldRun: true, decisionReason: "query_shape" };
  }

  // ── Rule 4: Weak keyword fallback ──────────────────────────────────────
  // This is the last resort. Language-agnostic root patterns.
  for (const pattern of SIMILARITY_KEYWORD_PATTERNS) {
    if (pattern.test(message)) {
      return { shouldRun: true, decisionReason: "fallback_keyword" };
    }
  }

  return { shouldRun: false, decisionReason: "not_triggered" };
}

// ─── Part B: Configurable minScore resolver ───────────────────────────────────

/**
 * Min-score thresholds by retrieval channel.
 *
 * Semantics differ per channel:
 *   vector  — cosine similarity 0.0–1.0. High threshold = precision-first.
 *   hybrid  — mixed cosine + lexical. Slightly lower OK.
 *   lexical — pg_trgm + ts_rank composite. Much lower ceiling naturally.
 *
 * These are the code-level defaults. Future: override per-tenant from DB.
 */
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
 * Override priority:
 *   1. Caller-supplied override (for future tenant DB config)
 *   2. Code-level defaults above
 *
 * @param channel - retrieval channel
 * @param overrides - optional tenant-specific threshold overrides
 */
export function resolveMinScore(
  channel: "vector" | "lexical" | "hybrid",
  overrides?: Partial<SimilarityThresholds>,
): number {
  const merged: SimilarityThresholds = { ...DEFAULT_THRESHOLDS, ...overrides };
  return merged[channel];
}

/**
 * Derive confidence code from score + retrieval channel.
 * Bands are calibrated per channel since scores have different ceilings.
 *
 * vector:   high >= 0.80, medium >= 0.55, low >= 0.35
 * lexical:  high >= 0.40, medium >= 0.25, low >= 0.15
 */
export function deriveConfidenceCode(
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
 * Map retrieval channel → locale-safe code for frontend.
 */
export function deriveWhyMatchedCode(
  channel: "vector" | "lexical" | "hybrid",
): WhyMatchedCode {
  if (channel === "lexical") return "lexical_match";
  if (channel === "hybrid") return "hybrid_match";
  return "vector_match";
}

// ─── Part C: In-memory tenant-safe cache ─────────────────────────────────────

interface CacheEntry<T> {
  value:     T;
  expiresAt: number;
}

class SimilarityCache<T> {
  private store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlSeconds: number = 300, maxSize: number = 500) {
    this.ttlMs   = ttlSeconds * 1000;
    this.maxSize = maxSize;
  }

  /** Build a tenant-safe cache key. tenantId is always the first component. */
  buildKey(parts: {
    tenantId:  string;
    expertId?: string;
    query:     string;
    topK:      number;
    kbIds?:    string[];
  }): string {
    const { tenantId, expertId, query, topK, kbIds } = parts;
    // Normalize query: lowercase + collapse whitespace (language-neutral)
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
    // Evict oldest if at capacity
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

/** Module-level cache instance — shared across all requests */
export const similarityCache = new SimilarityCache(300, 500); // 5min TTL, max 500 entries

// ─── Part D: Per-tenant rate limiter ─────────────────────────────────────────

interface RateWindow {
  count:       number;
  windowStart: number;
}

/**
 * Simple sliding-window rate limiter.
 * Tenant-safe — each tenantId gets its own counter.
 * In-process only (not distributed). Good enough for single-instance deployments.
 */
class SimilarityRateLimiter {
  private windows = new Map<string, RateWindow>();

  private readonly maxPerMinute: number;
  private readonly windowMs: number = 60_000;

  constructor(maxPerMinute: number = 30) {
    this.maxPerMinute = maxPerMinute;
  }

  /**
   * Returns true if the tenant is within the rate limit.
   * Increments the counter if allowed.
   */
  allow(tenantId: string): boolean {
    const now = Date.now();
    const existing = this.windows.get(tenantId);

    if (!existing || now - existing.windowStart > this.windowMs) {
      // Start new window
      this.windows.set(tenantId, { count: 1, windowStart: now });
      return true;
    }

    if (existing.count >= this.maxPerMinute) {
      return false;
    }

    existing.count += 1;
    return true;
  }

  /** Get remaining quota for a tenant (for debug/logging). */
  remaining(tenantId: string): number {
    const now = Date.now();
    const existing = this.windows.get(tenantId);
    if (!existing || now - existing.windowStart > this.windowMs) return this.maxPerMinute;
    return Math.max(0, this.maxPerMinute - existing.count);
  }
}

/** Module-level rate limiter — 30 similarity calls/minute per tenant */
export const similarityRateLimiter = new SimilarityRateLimiter(30);

// ─── Part E: Structured observability logging ─────────────────────────────────

export interface SimilarityEventLog {
  tenantId:         string;
  expertId?:        string;
  mode:             "text" | "asset" | "chunk";
  decisionReason:   SimilarityDecisionReason;
  statusCode:       SimilarCasesStatusCode;
  cacheHit:         boolean;
  pgvectorUsed:     boolean;
  retrievalPath:    string;
  candidateCount:   number;
  returnedCount:    number;
  latencyMs:        number;
  topK:             number;
  rateLimitRemaining: number;
}

/**
 * Log a structured similarity event.
 *
 * Format: [similarity:event] {JSON}
 *
 * Structured so log aggregators (Datadog, CloudWatch, Loki) can parse fields.
 * No PII — query text is NOT logged (privacy-safe, SOC2-compatible).
 */
export function logSimilarityEvent(event: SimilarityEventLog): void {
  console.log(`[similarity:event] ${JSON.stringify({
    tenant:      event.tenantId,
    expert:      event.expertId ?? null,
    mode:        event.mode,
    decision:    event.decisionReason,
    status:      event.statusCode,
    cache_hit:   event.cacheHit,
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
