/**
 * AI Request Safety Summary
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Backend-only summary helper for request safety state per tenant.
 * No UI. No route. Designed so future admin/customer UI can consume
 * this foundation without refactor.
 *
 * Phase 3H
 */

import {
  resolveEffectiveSafetyConfig,
  getCurrentRequestCount,
  getConcurrentRequestCount,
} from "./request-safety";

// ── Summary contract ──────────────────────────────────────────────────────────

export interface AiRequestSafetySummary {
  tenantId: string;
  /** Configured maximum requests per minute (null = tenant has no custom limit, using global default) */
  requestsPerMinuteLimit: number | null;
  /** Configured maximum requests per hour */
  requestsPerHourLimit: number | null;
  /** Configured maximum concurrent in-flight requests */
  maxConcurrentRequests: number | null;
  /** Current request count in the last 60 seconds (from ai_usage) */
  currentMinuteRequestCount: number | null;
  /** Current request count in the last 3600 seconds (from ai_usage) */
  currentHourRequestCount: number | null;
  /** Current in-flight request count for this tenant (process-local) */
  currentConcurrentCount: number;
  /** Whether the tenant has a custom rate limit row (vs using global defaults) */
  hasCustomRateLimit: boolean;
}

// ── Summary builder ───────────────────────────────────────────────────────────

/**
 * Build the request safety summary for a tenant.
 *
 * Reads:
 *   - Active tenant_rate_limits row (if any) for configured limits
 *   - ai_usage recent counts for per-minute and per-hour usage
 *   - Process-local concurrency map for in-flight count
 *
 * Never throws — returns null counts on partial DB failures.
 */
export async function getAiRequestSafetySummary(
  tenantId: string,
): Promise<AiRequestSafetySummary> {
  const [safetyConfig, minuteCount, hourCount] = await Promise.all([
    resolveEffectiveSafetyConfig(tenantId),
    getCurrentRequestCount(tenantId, 60).catch(() => null),
    getCurrentRequestCount(tenantId, 3_600).catch(() => null),
  ]);

  const concurrentCount = getConcurrentRequestCount(tenantId);

  return {
    tenantId,
    requestsPerMinuteLimit: safetyConfig.requestsPerMinute,
    requestsPerHourLimit: safetyConfig.requestsPerHour,
    maxConcurrentRequests: safetyConfig.maxConcurrentRequests,
    currentMinuteRequestCount: minuteCount,
    currentHourRequestCount: hourCount,
    currentConcurrentCount: concurrentCount,
    hasCustomRateLimit: safetyConfig !== null,
  };
}
