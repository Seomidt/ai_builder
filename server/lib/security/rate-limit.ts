/**
 * Phase 25 — Enhanced Rate Limiting Library
 * In-memory rate limiting with tenant-level, IP-level, and endpoint-level tracking.
 * Augments Phase 13.2 express-rate-limit middleware with programmatic inspection.
 */

// ── Rate limit policies ────────────────────────────────────────────────────────

export interface RateLimitPolicy {
  name: string;
  maxRequests: number;
  windowMs: number;
  type: "tenant" | "ip" | "admin" | "webhook" | "ai" | "global";
}

export const RATE_LIMIT_POLICIES: Record<string, RateLimitPolicy> = {
  global:          { name: "Global API",        maxRequests: 1000, windowMs: 15 * 60_000, type: "global" },
  tenant_api:      { name: "Tenant API",         maxRequests: 500,  windowMs: 60_000,      type: "tenant" },
  tenant_ai:       { name: "Tenant AI",          maxRequests: 60,   windowMs: 60_000,      type: "ai" },
  admin_endpoints: { name: "Admin Endpoints",    maxRequests: 200,  windowMs: 60_000,      type: "admin" },
  webhook_inbound: { name: "Webhook Inbound",    maxRequests: 100,  windowMs: 60_000,      type: "webhook" },
  auth_attempts:   { name: "Auth Attempts",      maxRequests: 10,   windowMs: 60_000,      type: "ip" },
  evaluation_api:  { name: "Evaluation API",     maxRequests: 30,   windowMs: 60_000,      type: "tenant" },
  stripe_webhook:  { name: "Stripe Webhook",     maxRequests: 200,  windowMs: 60_000,      type: "webhook" },
};

// ── In-memory rate limit tracking ─────────────────────────────────────────────

interface RateLimitEntry {
  count: number;
  windowStart: number;
  lastSeen: number;
}

const rateLimitStore = new Map<string, RateLimitEntry>();

function cleanupExpiredEntries(windowMs: number): void {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore) {
    if (now - entry.windowStart > windowMs * 2) {
      rateLimitStore.delete(key);
    }
  }
}

// ── Rate limit check ───────────────────────────────────────────────────────────

export interface RateLimitCheck {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterMs: number;
  headers: Record<string, string>;
}

/**
 * Check and record a rate-limited request.
 * Returns whether the request is allowed plus rate limit state.
 */
export function checkRateLimit(key: string, policy: RateLimitPolicy): RateLimitCheck {
  const now = Date.now();
  const { maxRequests, windowMs } = policy;

  // Cleanup old entries occasionally
  if (Math.random() < 0.01) cleanupExpiredEntries(windowMs);

  let entry = rateLimitStore.get(key);
  if (!entry || now - entry.windowStart >= windowMs) {
    // New window
    entry = { count: 0, windowStart: now, lastSeen: now };
  }
  entry.count++;
  entry.lastSeen = now;
  rateLimitStore.set(key, entry);

  const remaining = Math.max(0, maxRequests - entry.count);
  const resetAt = new Date(entry.windowStart + windowMs);
  const allowed = entry.count <= maxRequests;
  const retryAfterMs = allowed ? 0 : resetAt.getTime() - now;

  return {
    allowed,
    limit: maxRequests,
    remaining,
    resetAt,
    retryAfterMs,
    headers: {
      "X-RateLimit-Limit":     String(maxRequests),
      "X-RateLimit-Remaining": String(remaining),
      "X-RateLimit-Reset":     String(Math.ceil(resetAt.getTime() / 1000)),
      ...(allowed ? {} : { "Retry-After": String(Math.ceil(retryAfterMs / 1000)) }),
    },
  };
}

/**
 * Check rate limit without recording (read-only peek).
 */
export function peekRateLimit(key: string, policy: RateLimitPolicy): {
  count: number;
  remaining: number;
  windowStart: number;
} {
  const entry = rateLimitStore.get(key);
  if (!entry) return { count: 0, remaining: policy.maxRequests, windowStart: Date.now() };
  const now = Date.now();
  if (now - entry.windowStart >= policy.windowMs) {
    return { count: 0, remaining: policy.maxRequests, windowStart: now };
  }
  return {
    count: entry.count,
    remaining: Math.max(0, policy.maxRequests - entry.count),
    windowStart: entry.windowStart,
  };
}

// ── Tenant-level rate limiting ─────────────────────────────────────────────────

export function buildTenantKey(tenantId: string, policyName: string): string {
  return `tenant:${tenantId}:${policyName}`;
}

export function buildIpKey(ip: string, policyName: string): string {
  return `ip:${ip}:${policyName}`;
}

export function buildAdminKey(userId: string): string {
  return `admin:${userId}`;
}

export function checkTenantRateLimit(tenantId: string, policyName: keyof typeof RATE_LIMIT_POLICIES = "tenant_api"): RateLimitCheck {
  const policy = RATE_LIMIT_POLICIES[policyName];
  if (!policy) throw new Error(`Unknown rate limit policy: ${policyName}`);
  return checkRateLimit(buildTenantKey(tenantId, policyName), policy);
}

export function checkIpRateLimit(ip: string, policyName: keyof typeof RATE_LIMIT_POLICIES = "global"): RateLimitCheck {
  const policy = RATE_LIMIT_POLICIES[policyName];
  if (!policy) throw new Error(`Unknown rate limit policy: ${policyName}`);
  return checkRateLimit(buildIpKey(ip, policyName), policy);
}

// ── Circuit breaker ────────────────────────────────────────────────────────────

export interface CircuitBreakerState {
  id: string;
  status: "closed" | "open" | "half-open";
  failureCount: number;
  successCount: number;
  lastFailureAt?: Date;
  openedAt?: Date;
  nextAttemptAt?: Date;
}

const circuitBreakers = new Map<string, CircuitBreakerState>();

export function getCircuitBreaker(id: string): CircuitBreakerState {
  return circuitBreakers.get(id) ?? {
    id,
    status: "closed",
    failureCount: 0,
    successCount: 0,
  };
}

export function recordCircuitFailure(id: string, threshold: number = 5, cooldownMs: number = 60_000): CircuitBreakerState {
  const state = getCircuitBreaker(id);
  state.failureCount++;
  state.lastFailureAt = new Date();
  if (state.failureCount >= threshold) {
    state.status = "open";
    state.openedAt = new Date();
    state.nextAttemptAt = new Date(Date.now() + cooldownMs);
  }
  circuitBreakers.set(id, state);
  return state;
}

export function recordCircuitSuccess(id: string): CircuitBreakerState {
  const state = getCircuitBreaker(id);
  state.successCount++;
  if (state.status === "half-open") {
    state.status = "closed";
    state.failureCount = 0;
  }
  circuitBreakers.set(id, state);
  return state;
}

export function checkCircuitBreaker(id: string): { open: boolean; state: CircuitBreakerState } {
  const state = getCircuitBreaker(id);
  const now = Date.now();
  if (state.status === "open" && state.nextAttemptAt && now >= state.nextAttemptAt.getTime()) {
    state.status = "half-open";
    circuitBreakers.set(id, state);
  }
  return { open: state.status === "open", state };
}

export function resetCircuitBreaker(id: string): CircuitBreakerState {
  const state: CircuitBreakerState = { id, status: "closed", failureCount: 0, successCount: 0 };
  circuitBreakers.set(id, state);
  return state;
}

// ── Rate limit stats ───────────────────────────────────────────────────────────

export function getRateLimitStats(): {
  activeKeys: number;
  policies: Array<{ name: string; type: string; maxRequests: number; windowMs: number }>;
  circuitBreakers: Array<CircuitBreakerState>;
} {
  return {
    activeKeys: rateLimitStore.size,
    policies: Object.values(RATE_LIMIT_POLICIES).map(p => ({
      name: p.name,
      type: p.type,
      maxRequests: p.maxRequests,
      windowMs: p.windowMs,
    })),
    circuitBreakers: Array.from(circuitBreakers.values()),
  };
}

/**
 * Reset the in-memory store (for testing).
 */
export function resetRateLimitStore(): void {
  rateLimitStore.clear();
}

export function resetAllCircuitBreakers(): void {
  circuitBreakers.clear();
}
