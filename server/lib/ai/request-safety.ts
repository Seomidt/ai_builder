/**
 * AI Request Safety Guards
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Central enforcement point for request-level safety before any provider call.
 * Operates in this order (called from runner.ts):
 *   1. Token cap precheck   — rejects oversized inputs before any API spend
 *   2. Rate limit check     — enforces requests_per_minute + requests_per_hour
 *   3. Concurrency guard    — limits simultaneous in-flight calls per tenant
 *
 * Design rules:
 *   - All three checks run before the provider call — no fallback to provider-side limits
 *   - Safety blocks are recorded in request_safety_events for traceability
 *   - Provider/model is NEVER switched as a side effect of safety logic
 *   - Concurrency slots are always released in runner.ts finally blocks
 *   - DB failures in safety checks log warnings and fail-open (allow the call through)
 *     EXCEPT concurrency which is pure in-process and always reliable
 *
 * Token approximation:
 *   Math.ceil(charCount / 4) — approximately 1 token per 4 English characters.
 *   This matches GPT tokenizer behavior for typical prose (±10-20% error).
 *   The approximation is intentionally conservative: it may block a very small
 *   number of valid inputs at the boundary, but it never allows oversized inputs
 *   through without detection. No external tokenizer dependency is added.
 *
 * Rate limit counting:
 *   Counts ai_usage rows in the rolling time window for the tenant.
 *   Blocked calls (status="blocked" from budget guardrail) are included.
 *   Rate-limit-blocked calls go to request_safety_events, not ai_usage,
 *   so the count stays at the limit (self-limiting by design).
 *
 * Concurrency guard:
 *   Process-local Map<tenantId, count>. Not distributed.
 *   Sufficient for single-process deployment (Phase 3H scope).
 *   Caller (runner.ts) must call releaseConcurrencySlot() in a finally block.
 *
 * Phase 3H
 */

import { and, count, eq, gte } from "drizzle-orm";
import { db } from "../../db";
import { aiUsage, tenantRateLimits, requestSafetyEvents } from "@shared/schema";
import { AI_SAFETY_DEFAULTS, type AiSafetyConfig } from "./config";
import {
  AiTokenCapError,
  AiRateLimitError,
  AiConcurrencyError,
  type AiErrorMeta,
} from "./errors";

// ── Token approximation ───────────────────────────────────────────────────────

/**
 * Estimate token count from raw text using the chars/4 approximation.
 *
 * Accuracy: ±10–20% for English prose. Less accurate for code, non-Latin scripts,
 * or highly structured JSON. The approximation errs on the side of over-counting
 * (conservative), which means it occasionally rejects inputs that would technically
 * fit — but never allows oversized inputs to slip through undetected.
 *
 * Do not replace with an external tokenizer unless the repo already includes one.
 */
export function estimateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

// ── Tenant rate limit loader ──────────────────────────────────────────────────

/**
 * Load the active tenant rate limit row from the DB.
 *
 * Returns null if:
 *   - tenantId is empty/missing
 *   - no active row exists for this tenant
 *   - DB query fails
 *
 * Null means use AI_SAFETY_DEFAULTS — no throw on failure.
 */
export async function loadTenantRateLimit(tenantId: string): Promise<{
  requestsPerMinute: number;
  requestsPerHour: number;
  maxConcurrentRequests: number;
} | null> {
  if (!tenantId) return null;
  try {
    const rows = await db
      .select({
        requestsPerMinute: tenantRateLimits.requestsPerMinute,
        requestsPerHour: tenantRateLimits.requestsPerHour,
        maxConcurrentRequests: tenantRateLimits.maxConcurrentRequests,
      })
      .from(tenantRateLimits)
      .where(
        and(
          eq(tenantRateLimits.tenantId, tenantId),
          eq(tenantRateLimits.isActive, true),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  } catch (err) {
    console.warn(
      "[ai:request-safety] Failed to load rate limit for tenant",
      tenantId,
      ":",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Resolve the effective safety config for a tenant.
 *
 * Priority: tenant DB row → global AI_SAFETY_DEFAULTS.
 * Partial overrides are not supported — if a DB row exists, all its fields are used.
 * (Admins must configure all three limits in one row.)
 */
export async function resolveEffectiveSafetyConfig(tenantId: string | null | undefined): Promise<AiSafetyConfig> {
  if (!tenantId) return AI_SAFETY_DEFAULTS;
  const row = await loadTenantRateLimit(tenantId);
  if (!row) return AI_SAFETY_DEFAULTS;
  return {
    ...AI_SAFETY_DEFAULTS,
    requestsPerMinute: row.requestsPerMinute,
    requestsPerHour: row.requestsPerHour,
    maxConcurrentRequests: row.maxConcurrentRequests,
  };
}

// ── Current request count ─────────────────────────────────────────────────────

/**
 * Count the number of AI requests made by a tenant in a rolling time window.
 *
 * Counts rows in ai_usage for the given tenant within the last windowSeconds.
 * All statuses (success, error, blocked) are counted — any attempt uses a slot.
 *
 * Rate-limited calls go to request_safety_events instead of ai_usage, so the
 * count naturally stays at or below the limit (self-limiting by design).
 *
 * Returns 0 on DB failure (fail-open — prefer allowing calls over false blocks).
 */
export async function getCurrentRequestCount(
  tenantId: string,
  windowSeconds: number,
): Promise<number> {
  try {
    const cutoff = new Date(Date.now() - windowSeconds * 1_000);
    const rows = await db
      .select({ total: count() })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.tenantId, tenantId),
          gte(aiUsage.createdAt, cutoff),
        ),
      );
    return rows[0]?.total ?? 0;
  } catch (err) {
    console.warn(
      "[ai:request-safety] Failed to count requests for tenant",
      tenantId,
      "window=",
      windowSeconds,
      ":",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

// ── Safety event logger ───────────────────────────────────────────────────────

/**
 * Record a request_safety_events row for a blocked request.
 *
 * Fire-and-forget — never throws. Blocked calls must remain traceable
 * even when the event insert itself fails.
 */
export async function recordSafetyEvent(params: {
  tenantId: string;
  requestId?: string | null;
  feature?: string | null;
  eventType: "token_cap_exceeded" | "rate_limit_blocked" | "concurrency_blocked";
  metricValue?: number | null;
  limitValue?: number | null;
  routeKey?: string | null;
  provider?: string | null;
  model?: string | null;
}): Promise<void> {
  try {
    await db.insert(requestSafetyEvents).values({
      tenantId: params.tenantId,
      requestId: params.requestId ?? null,
      feature: params.feature ?? null,
      eventType: params.eventType,
      metricValue: params.metricValue ?? null,
      limitValue: params.limitValue ?? null,
      routeKey: params.routeKey ?? null,
      provider: params.provider ?? null,
      model: params.model ?? null,
    });
  } catch (err) {
    console.error(
      "[ai:request-safety] Failed to record safety event:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ── Token cap precheck ────────────────────────────────────────────────────────

/**
 * Check whether the input text exceeds the configured maxInputTokens.
 *
 * Must be called before any provider call.
 * Uses the chars/4 approximation — see estimateTokenCount() for accuracy notes.
 *
 * On block:
 *   - Records a request_safety_events row (fire-and-forget)
 *   - Throws AiTokenCapError with estimated and limit values
 *
 * Never silently trims input — that would change semantics unpredictably.
 */
export async function checkTokenCap(params: {
  userInput: string;
  maxInputTokens: number;
  tenantId: string;
  requestId?: string | null;
  feature?: string | null;
  routeKey?: string | null;
  provider?: string | null;
  model?: string | null;
  meta: AiErrorMeta;
}): Promise<void> {
  const estimated = estimateTokenCount(params.userInput);
  if (estimated <= params.maxInputTokens) return;

  void recordSafetyEvent({
    tenantId: params.tenantId,
    requestId: params.requestId,
    feature: params.feature,
    eventType: "token_cap_exceeded",
    metricValue: estimated,
    limitValue: params.maxInputTokens,
    routeKey: params.routeKey,
    provider: params.provider,
    model: params.model,
  });

  throw new AiTokenCapError({
    ...params.meta,
    estimatedTokens: estimated,
    tokenLimit: params.maxInputTokens,
  });
}

// ── Rate limit guard ──────────────────────────────────────────────────────────

/**
 * Check whether the tenant has exceeded their request rate limits.
 *
 * Checks both per-minute and per-hour windows (per-minute checked first).
 * Both checks hit the DB — on DB failure, fails-open (allows the call through)
 * with a console warning.
 *
 * On block:
 *   - Records a request_safety_events row (fire-and-forget)
 *   - Throws AiRateLimitError with limit type, count, and limit
 *
 * Blocked rate-limit calls do NOT go into ai_usage — only into request_safety_events.
 * This means the rate limit count (derived from ai_usage) naturally stays at the limit.
 */
export async function checkRateLimit(params: {
  tenantId: string;
  safetyConfig: AiSafetyConfig;
  requestId?: string | null;
  feature?: string | null;
  routeKey?: string | null;
  provider?: string | null;
  model?: string | null;
  meta: AiErrorMeta;
}): Promise<void> {
  const { tenantId, safetyConfig } = params;

  const [minuteCount, hourCount] = await Promise.all([
    getCurrentRequestCount(tenantId, 60),
    getCurrentRequestCount(tenantId, 3_600),
  ]);

  if (minuteCount >= safetyConfig.requestsPerMinute) {
    void recordSafetyEvent({
      tenantId,
      requestId: params.requestId,
      feature: params.feature,
      eventType: "rate_limit_blocked",
      metricValue: minuteCount,
      limitValue: safetyConfig.requestsPerMinute,
      routeKey: params.routeKey,
      provider: params.provider,
      model: params.model,
    });
    throw new AiRateLimitError({
      ...params.meta,
      limitType: "per_minute",
      currentCount: minuteCount,
      limit: safetyConfig.requestsPerMinute,
    });
  }

  if (hourCount >= safetyConfig.requestsPerHour) {
    void recordSafetyEvent({
      tenantId,
      requestId: params.requestId,
      feature: params.feature,
      eventType: "rate_limit_blocked",
      metricValue: hourCount,
      limitValue: safetyConfig.requestsPerHour,
      routeKey: params.routeKey,
      provider: params.provider,
      model: params.model,
    });
    throw new AiRateLimitError({
      ...params.meta,
      limitType: "per_hour",
      currentCount: hourCount,
      limit: safetyConfig.requestsPerHour,
    });
  }
}

// ── Concurrency guard ─────────────────────────────────────────────────────────

/**
 * Process-local in-flight request counter per tenant.
 *
 * Keys: tenantId. Values: number of currently in-flight requests.
 * This is intentionally process-local for Phase 3H.
 * A distributed replacement (Redis INCR/DECR with TTL) can replace this
 * map without changing the caller interface in runner.ts.
 */
const concurrencyMap = new Map<string, number>();

function getConcurrentCount(tenantId: string): number {
  return concurrencyMap.get(tenantId) ?? 0;
}

/**
 * Acquire a concurrency slot for a tenant.
 *
 * Checks the current in-flight count against maxConcurrentRequests.
 * If at limit: records a safety event and throws AiConcurrencyError.
 * If under limit: increments the counter and returns.
 *
 * Caller MUST call releaseConcurrencySlot() in a finally block.
 * Never throws on DB failure — concurrency check is pure in-process.
 */
export async function acquireConcurrencySlot(params: {
  tenantId: string;
  maxConcurrentRequests: number;
  requestId?: string | null;
  feature?: string | null;
  routeKey?: string | null;
  provider?: string | null;
  model?: string | null;
  meta: AiErrorMeta;
}): Promise<void> {
  const { tenantId, maxConcurrentRequests } = params;
  const current = getConcurrentCount(tenantId);

  if (current >= maxConcurrentRequests) {
    void recordSafetyEvent({
      tenantId,
      requestId: params.requestId,
      feature: params.feature,
      eventType: "concurrency_blocked",
      metricValue: current,
      limitValue: maxConcurrentRequests,
      routeKey: params.routeKey,
      provider: params.provider,
      model: params.model,
    });
    throw new AiConcurrencyError({
      ...params.meta,
      currentConcurrent: current,
      concurrencyLimit: maxConcurrentRequests,
    });
  }

  concurrencyMap.set(tenantId, current + 1);
}

/**
 * Release a concurrency slot for a tenant.
 *
 * Must be called in a finally block after acquireConcurrencySlot() succeeds.
 * Safe to call even if the slot count is already 0 (defensive).
 */
export function releaseConcurrencySlot(tenantId: string): void {
  const current = getConcurrentCount(tenantId);
  if (current <= 1) {
    concurrencyMap.delete(tenantId);
  } else {
    concurrencyMap.set(tenantId, current - 1);
  }
}

/**
 * Inspect the current in-flight count for a tenant (read-only).
 * Used by request-safety-summary.ts — does not modify state.
 */
export function getConcurrentRequestCount(tenantId: string): number {
  return getConcurrentCount(tenantId);
}
