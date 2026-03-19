/**
 * Phase 30 — Global Platform Rate Limiter
 * Protects the platform from API abuse and traffic spikes.
 * INV-SAFE3: Rate limiting must be deterministic.
 * Extends Phase 25 rate limiting with per-scope enforcement.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type RateLimitScope = "ip" | "tenant" | "endpoint" | "apikey";

export type EndpointCategory =
  | "ai"
  | "webhook"
  | "auth"
  | "admin"
  | "general";

export interface RateLimitConfig {
  maxRequests: number;
  windowMs:    number;
  scope:       RateLimitScope;
  category:    EndpointCategory;
}

export interface RateLimitDecision {
  allowed:        boolean;
  scope:          RateLimitScope;
  key:            string;
  category:       EndpointCategory;
  requestCount:   number;
  limit:          number;
  windowMs:       number;
  remainingMs:    number;
  resetAt:        string;
  reason:         string;
  violationLogged: boolean;
}

export interface RateLimitSummary {
  totalKeys:     number;
  violationCount: number;
  topViolators:  { key: string; count: number }[];
  checkedAt:     string;
}

// ── Endpoint category matching ────────────────────────────────────────────────

export const ENDPOINT_CONFIGS: Record<EndpointCategory, RateLimitConfig> = {
  ai:      { maxRequests: 60,   windowMs: 60_000,      scope: "tenant",   category: "ai"      },
  webhook: { maxRequests: 120,  windowMs: 60_000,      scope: "ip",       category: "webhook" },
  auth:    { maxRequests: 30,   windowMs: 60_000,      scope: "ip",       category: "auth"    },
  admin:   { maxRequests: 10,   windowMs: 60_000,      scope: "ip",       category: "admin"   },
  general: { maxRequests: 300,  windowMs: 60_000,      scope: "ip",       category: "general" },
};

export function resolveEndpointCategory(path: string): EndpointCategory {
  if (path.startsWith("/api/ai/"))                      return "ai";
  if (path.startsWith("/api/webhooks/"))                return "webhook";
  if (path.startsWith("/api/auth/"))                    return "auth";
  if (path.startsWith("/api/admin/"))                   return "admin";
  return "general";
}

// ── In-memory rate limit store ────────────────────────────────────────────────

interface BucketEntry {
  count:       number;
  windowStart: number;
}

const _buckets    = new Map<string, BucketEntry>();
const _violations: { key: string; category: EndpointCategory; count: number; ts: string }[] = [];

function bucketKey(scope: RateLimitScope, identifier: string, category: EndpointCategory): string {
  return `${scope}:${category}:${identifier}`;
}

function getOrCreateBucket(key: string, windowMs: number): BucketEntry {
  const now = Date.now();
  const existing = _buckets.get(key);

  if (!existing || now - existing.windowStart >= windowMs) {
    const fresh = { count: 0, windowStart: now };
    _buckets.set(key, fresh);
    return fresh;
  }
  return existing;
}

// Clean expired buckets periodically
let _lastCleanup = Date.now();
function maybeClean(): void {
  const now = Date.now();
  if (now - _lastCleanup < 30_000) return;
  _lastCleanup = now;
  for (const [key, bucket] of _buckets) {
    if (now - bucket.windowStart > 120_000) _buckets.delete(key);
  }
}

// ── Core functions ────────────────────────────────────────────────────────────

export function recordRequest(
  scope:      RateLimitScope,
  identifier: string,
  path:       string,
): void {
  maybeClean();
  const category = resolveEndpointCategory(path);
  const config   = ENDPOINT_CONFIGS[category];
  const key      = bucketKey(scope, identifier, category);
  const bucket   = getOrCreateBucket(key, config.windowMs);
  bucket.count++;
}

export function checkRateLimit(
  scope:      RateLimitScope,
  identifier: string,
  path:       string,
  config?:    Partial<RateLimitConfig>,
): RateLimitDecision {
  maybeClean();
  const category    = resolveEndpointCategory(path);
  const baseConfig  = { ...ENDPOINT_CONFIGS[category], ...config };
  const key         = bucketKey(scope, identifier, category);
  const bucket      = getOrCreateBucket(key, baseConfig.windowMs);

  const now         = Date.now();
  const elapsed     = now - bucket.windowStart;
  const remainingMs = Math.max(0, baseConfig.windowMs - elapsed);
  const resetAt     = new Date(bucket.windowStart + baseConfig.windowMs).toISOString();
  const allowed     = bucket.count < baseConfig.maxRequests;
  const reason      = allowed
    ? `Request allowed (${bucket.count}/${baseConfig.maxRequests})`
    : `Rate limit exceeded (${bucket.count}/${baseConfig.maxRequests}) for ${category}`;

  let violationLogged = false;
  if (!allowed) {
    violationLogged = true;
    _violations.push({ key, category, count: bucket.count, ts: new Date().toISOString() });
    if (_violations.length > 1000) _violations.shift();
    console.warn(`[rate-limit] BLOCKED ${scope}:${identifier} on ${path} — ${reason}`);
  }

  return {
    allowed, scope, key, category,
    requestCount: bucket.count,
    limit:        baseConfig.maxRequests,
    windowMs:     baseConfig.windowMs,
    remainingMs, resetAt, reason, violationLogged,
  };
}

export function checkAndRecord(
  scope:      RateLimitScope,
  identifier: string,
  path:       string,
): RateLimitDecision {
  const decision = checkRateLimit(scope, identifier, path);
  if (decision.allowed) {
    recordRequest(scope, identifier, path);
  }
  return decision;
}

export function resetRateLimit(
  scope:      RateLimitScope,
  identifier: string,
  category:   EndpointCategory,
): void {
  const key = bucketKey(scope, identifier, category);
  _buckets.delete(key);
}

// ── Multi-scope check (per IP + per tenant + per endpoint) ────────────────────

export interface MultiScopeDecision {
  allowed:   boolean;
  decisions: RateLimitDecision[];
  blocker?:  RateLimitDecision;
}

export function checkMultiScope(opts: {
  ip?:       string;
  tenantId?: string;
  apiKey?:   string;
  path:      string;
}): MultiScopeDecision {
  const decisions: RateLimitDecision[] = [];

  if (opts.ip)       decisions.push(checkRateLimit("ip",       opts.ip,       opts.path));
  if (opts.tenantId) decisions.push(checkRateLimit("tenant",   opts.tenantId, opts.path));
  if (opts.apiKey)   decisions.push(checkRateLimit("apikey",   opts.apiKey,   opts.path));
  decisions.push(checkRateLimit("endpoint", opts.path, opts.path));

  const blocker = decisions.find(d => !d.allowed);
  return { allowed: !blocker, decisions, blocker };
}

// ── Explain ───────────────────────────────────────────────────────────────────

export function explainRateLimitDecision(decision: RateLimitDecision): string {
  if (decision.allowed) {
    return `[${decision.category.toUpperCase()}] ${decision.key}: ${decision.requestCount}/${decision.limit} requests in window. Allowed.`;
  }
  return [
    `[${decision.category.toUpperCase()}] RATE LIMIT EXCEEDED for ${decision.key}.`,
    `Requests: ${decision.requestCount}/${decision.limit}.`,
    `Resets at: ${decision.resetAt}.`,
  ].join(" ");
}

export function summarizeRateLimitState(): RateLimitSummary {
  const now          = Date.now();
  const activeKeys   = [..._buckets.entries()].filter(([, b]) => now - b.windowStart < 120_000);
  const recentViolations = _violations.filter(v => now - Date.parse(v.ts) < 60_000);

  // Top violators by key count
  const counts: Record<string, number> = {};
  for (const v of _violations) {
    counts[v.key] = (counts[v.key] ?? 0) + v.count;
  }
  const topViolators = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([key, count]) => ({ key, count }));

  return {
    totalKeys:     activeKeys.length,
    violationCount: recentViolations.length,
    topViolators,
    checkedAt:     new Date().toISOString(),
  };
}

// ── Access to violation log ───────────────────────────────────────────────────

export function getRecentViolations(limit = 50): typeof _violations {
  return [..._violations].slice(-limit).reverse();
}

export function getBucketState(
  scope:      RateLimitScope,
  identifier: string,
  category:   EndpointCategory,
): BucketEntry | undefined {
  const key = bucketKey(scope, identifier, category);
  return _buckets.get(key);
}

// ── Spec aliases (Phase 30 final spec names) ──────────────────────────────────

/**
 * getRateLimitState — returns current state for a specific scope+identifier+path.
 * Alias-wrapper around checkRateLimit that does NOT record a request.
 */
export function getRateLimitState(
  scope:      RateLimitScope,
  identifier: string,
  path:       string,
): RateLimitDecision {
  return checkRateLimit(scope, identifier, path);
}

/**
 * summarizeRateLimiter — platform-wide summary.
 * Alias for summarizeRateLimitState().
 */
export function summarizeRateLimiter(): RateLimitSummary {
  return summarizeRateLimitState();
}
