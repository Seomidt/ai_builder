/**
 * AI Cost Anomaly Detector — Phase 3K
 *
 * SERVER-ONLY: Must never be imported from client/ code.
 *
 * Detects cost, token, and rate anomalies on successful AI usage events.
 * Detection only — no runtime blocking, no auto-remediation.
 *
 * Design principles:
 * - Success-based: only fires on successful ai_usage rows
 * - Tenant-scoped: all detection is tenant-aware
 * - Deterministic thresholds: explicit rules, no ML/probabilistic logic
 * - Cooldown deduplication: same anomaly suppressed within 15-minute window
 * - Fire-and-forget safe: errors must never propagate to AI runtime
 */

import { and, eq, gte, sql } from "drizzle-orm";
import { db } from "../../db";
import { aiAnomalyConfigs, aiAnomalyEvents, aiUsage } from "@shared/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AnomalyDetectionContext {
  tenantId: string;
  requestId?: string | null;
  feature?: string | null;
  routeKey?: string | null;
  provider?: string | null;
  model?: string | null;
  estimatedCostUsd?: number | null;
  totalTokens?: number | null;
  completionTokens?: number | null;
  outputTokensBillable?: number | null;
}

interface ResolvedAnomalyConfig {
  maxCostPerRequestUsd: number;
  maxTotalTokensPerRequest: number;
  maxOutputTokensPerRequest: number;
  maxRequestsPer5m: number;
  maxCostPer5mUsd: number;
  maxRequestsPer1h: number;
  maxCostPer1hUsd: number;
}

// ─── Code Defaults ────────────────────────────────────────────────────────────
// Used when no DB config row exists. Conservative and explicit.

const ANOMALY_CODE_DEFAULTS: ResolvedAnomalyConfig = {
  maxCostPerRequestUsd: 0.10,
  maxTotalTokensPerRequest: 12_000,
  maxOutputTokensPerRequest: 4_000,
  maxRequestsPer5m: 60,
  maxCostPer5mUsd: 3.00,
  maxRequestsPer1h: 500,
  maxCostPer1hUsd: 20.00,
};

// Cooldown window: suppress duplicate anomaly events within this period
const COOLDOWN_MINUTES = 15;

// ─── Config Resolution ────────────────────────────────────────────────────────

/**
 * Load effective anomaly config for a tenant.
 * Resolution order:
 *   1. Active tenant-scoped row for tenantId
 *   2. Active global row
 *   3. ANOMALY_CODE_DEFAULTS (hardcoded fallback)
 *
 * Any DB error falls back to code defaults silently.
 */
export async function loadEffectiveAnomalyConfig(
  tenantId: string,
): Promise<ResolvedAnomalyConfig> {
  try {
    // Try tenant-specific config first
    const tenantRows = await db
      .select()
      .from(aiAnomalyConfigs)
      .where(
        and(
          eq(aiAnomalyConfigs.tenantId, tenantId),
          eq(aiAnomalyConfigs.scope, "tenant"),
          eq(aiAnomalyConfigs.isActive, true),
        ),
      )
      .limit(1);

    if (tenantRows.length > 0) {
      return rowToConfig(tenantRows[0]);
    }

    // Fall back to global config
    const globalRows = await db
      .select()
      .from(aiAnomalyConfigs)
      .where(
        and(
          eq(aiAnomalyConfigs.scope, "global"),
          eq(aiAnomalyConfigs.isActive, true),
        ),
      )
      .limit(1);

    if (globalRows.length > 0) {
      return rowToConfig(globalRows[0]);
    }
  } catch (err) {
    console.error(
      "[anomaly-detector] Failed to load anomaly config — using code defaults:",
      err instanceof Error ? err.message : err,
    );
  }

  return { ...ANOMALY_CODE_DEFAULTS };
}

function rowToConfig(row: typeof aiAnomalyConfigs.$inferSelect): ResolvedAnomalyConfig {
  return {
    maxCostPerRequestUsd: row.maxCostPerRequestUsd != null
      ? Number(row.maxCostPerRequestUsd)
      : ANOMALY_CODE_DEFAULTS.maxCostPerRequestUsd,
    maxTotalTokensPerRequest: row.maxTotalTokensPerRequest
      ?? ANOMALY_CODE_DEFAULTS.maxTotalTokensPerRequest,
    maxOutputTokensPerRequest: row.maxOutputTokensPerRequest
      ?? ANOMALY_CODE_DEFAULTS.maxOutputTokensPerRequest,
    maxRequestsPer5m: row.maxRequestsPer5m
      ?? ANOMALY_CODE_DEFAULTS.maxRequestsPer5m,
    maxCostPer5mUsd: row.maxCostPer5mUsd != null
      ? Number(row.maxCostPer5mUsd)
      : ANOMALY_CODE_DEFAULTS.maxCostPer5mUsd,
    maxRequestsPer1h: row.maxRequestsPer1h
      ?? ANOMALY_CODE_DEFAULTS.maxRequestsPer1h,
    maxCostPer1hUsd: row.maxCostPer1hUsd != null
      ? Number(row.maxCostPer1hUsd)
      : ANOMALY_CODE_DEFAULTS.maxCostPer1hUsd,
  };
}

// ─── Cooldown / Deduplication ─────────────────────────────────────────────────

/**
 * Build a stable cooldown key for a given anomaly signal.
 * Format: "<tenantId>:<eventType>[:<routeKey>][:<model>]"
 */
function buildCooldownKey(
  tenantId: string,
  eventType: string,
  routeKey?: string | null,
  model?: string | null,
): string {
  const parts = [tenantId, eventType];
  if (routeKey) parts.push(routeKey);
  if (model) parts.push(model);
  return parts.join(":");
}

/**
 * Returns true if a recent anomaly event with the same cooldown key exists
 * within the last COOLDOWN_MINUTES minutes.
 */
async function isCoolingDown(cooldownKey: string): Promise<boolean> {
  const windowStart = new Date(Date.now() - COOLDOWN_MINUTES * 60 * 1000);
  try {
    const rows = await db
      .select({ id: aiAnomalyEvents.id })
      .from(aiAnomalyEvents)
      .where(
        and(
          eq(aiAnomalyEvents.cooldownKey, cooldownKey),
          gte(aiAnomalyEvents.createdAt, windowStart),
        ),
      )
      .limit(1);
    return rows.length > 0;
  } catch {
    // On error, allow event through (fail open for observability)
    return false;
  }
}

// ─── Event Writing ────────────────────────────────────────────────────────────

interface AnomalyEventPayload {
  tenantId: string;
  requestId?: string | null;
  feature?: string | null;
  routeKey?: string | null;
  provider?: string | null;
  model?: string | null;
  eventType: string;
  observedValue: number;
  thresholdValue: number;
  periodStart?: Date | null;
  periodEnd?: Date | null;
}

/**
 * Write an anomaly event if not suppressed by cooldown.
 * All DB errors are swallowed — must never block AI runtime.
 */
async function maybeRecordAnomalyEvent(payload: AnomalyEventPayload): Promise<void> {
  const cooldownKey = buildCooldownKey(
    payload.tenantId,
    payload.eventType,
    payload.routeKey,
    payload.model,
  );

  try {
    const inCooldown = await isCoolingDown(cooldownKey);
    if (inCooldown) {
      return;
    }

    await db.insert(aiAnomalyEvents).values({
      tenantId: payload.tenantId,
      requestId: payload.requestId ?? null,
      feature: payload.feature ?? null,
      routeKey: payload.routeKey ?? null,
      provider: payload.provider ?? null,
      model: payload.model ?? null,
      eventType: payload.eventType,
      observedValue: String(payload.observedValue),
      thresholdValue: String(payload.thresholdValue),
      periodStart: payload.periodStart ?? null,
      periodEnd: payload.periodEnd ?? null,
      cooldownKey,
    });

    console.info(
      `[anomaly-detector] Event recorded: ${payload.eventType} | tenant=${payload.tenantId} | observed=${payload.observedValue} | threshold=${payload.thresholdValue}`,
    );
  } catch (err) {
    console.error(
      "[anomaly-detector] Failed to record anomaly event:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ─── Per-Request Anomaly Detection ───────────────────────────────────────────

/**
 * Detect anomalies based on a single request's cost and token counts.
 * Must be called after a confirmed successful ai_usage write.
 */
export async function detectPerRequestAnomalies(
  ctx: AnomalyDetectionContext,
  config: ResolvedAnomalyConfig,
): Promise<void> {
  const cost = ctx.estimatedCostUsd ?? 0;
  const totalTokens = ctx.totalTokens ?? 0;
  // Prefer outputTokensBillable, fall back to completionTokens
  const outputTokens =
    ctx.outputTokensBillable != null
      ? ctx.outputTokensBillable
      : (ctx.completionTokens ?? 0);

  const base: Omit<AnomalyEventPayload, "eventType" | "observedValue" | "thresholdValue"> = {
    tenantId: ctx.tenantId,
    requestId: ctx.requestId,
    feature: ctx.feature,
    routeKey: ctx.routeKey,
    provider: ctx.provider,
    model: ctx.model,
  };

  // 1) cost_per_request_exceeded
  if (cost > 0 && cost > config.maxCostPerRequestUsd) {
    await maybeRecordAnomalyEvent({
      ...base,
      eventType: "cost_per_request_exceeded",
      observedValue: cost,
      thresholdValue: config.maxCostPerRequestUsd,
    });
  }

  // 2) tokens_per_request_exceeded
  if (totalTokens > 0 && totalTokens > config.maxTotalTokensPerRequest) {
    await maybeRecordAnomalyEvent({
      ...base,
      eventType: "tokens_per_request_exceeded",
      observedValue: totalTokens,
      thresholdValue: config.maxTotalTokensPerRequest,
    });
  }

  // 3) output_tokens_per_request_exceeded
  if (outputTokens > 0 && outputTokens > config.maxOutputTokensPerRequest) {
    await maybeRecordAnomalyEvent({
      ...base,
      eventType: "output_tokens_per_request_exceeded",
      observedValue: outputTokens,
      thresholdValue: config.maxOutputTokensPerRequest,
    });
  }
}

// ─── Window-Based Anomaly Detection ──────────────────────────────────────────

interface WindowStats {
  requestCount: number;
  totalCostUsd: number;
}

/**
 * Query ai_usage for success rows within a rolling time window for a tenant.
 */
async function queryWindowStats(
  tenantId: string,
  windowStart: Date,
): Promise<WindowStats> {
  const rows = await db
    .select({
      requestCount: sql<number>`count(*)::int`,
      totalCostUsd: sql<string>`coalesce(sum(estimated_cost_usd::numeric), 0)`,
    })
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.tenantId, tenantId),
        eq(aiUsage.status, "success"),
        gte(aiUsage.createdAt, windowStart),
      ),
    );

  const row = rows[0];
  return {
    requestCount: row?.requestCount ?? 0,
    totalCostUsd: Number(row?.totalCostUsd ?? "0"),
  };
}

/**
 * Detect anomalies based on rolling-window request counts and costs.
 * Windows: 5 minutes and 1 hour.
 */
export async function detectWindowAnomalies(
  ctx: AnomalyDetectionContext,
  config: ResolvedAnomalyConfig,
): Promise<void> {
  const now = new Date();
  const fiveMinAgo = new Date(now.getTime() - 5 * 60 * 1000);
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

  const base: Omit<AnomalyEventPayload, "eventType" | "observedValue" | "thresholdValue"> = {
    tenantId: ctx.tenantId,
    requestId: ctx.requestId,
    feature: ctx.feature,
    routeKey: ctx.routeKey,
    provider: ctx.provider,
    model: ctx.model,
  };

  // ── 5-minute window ─────────────────────────────────────────────────────────
  try {
    const stats5m = await queryWindowStats(ctx.tenantId, fiveMinAgo);

    if (stats5m.requestCount > config.maxRequestsPer5m) {
      await maybeRecordAnomalyEvent({
        ...base,
        eventType: "requests_per_5m_exceeded",
        observedValue: stats5m.requestCount,
        thresholdValue: config.maxRequestsPer5m,
        periodStart: fiveMinAgo,
        periodEnd: now,
      });
    }

    if (stats5m.totalCostUsd > 0 && stats5m.totalCostUsd > config.maxCostPer5mUsd) {
      await maybeRecordAnomalyEvent({
        ...base,
        eventType: "cost_per_5m_exceeded",
        observedValue: stats5m.totalCostUsd,
        thresholdValue: config.maxCostPer5mUsd,
        periodStart: fiveMinAgo,
        periodEnd: now,
      });
    }
  } catch (err) {
    console.error(
      "[anomaly-detector] 5m window query failed:",
      err instanceof Error ? err.message : err,
    );
  }

  // ── 1-hour window ───────────────────────────────────────────────────────────
  try {
    const stats1h = await queryWindowStats(ctx.tenantId, oneHourAgo);

    if (stats1h.requestCount > config.maxRequestsPer1h) {
      await maybeRecordAnomalyEvent({
        ...base,
        eventType: "requests_per_1h_exceeded",
        observedValue: stats1h.requestCount,
        thresholdValue: config.maxRequestsPer1h,
        periodStart: oneHourAgo,
        periodEnd: now,
      });
    }

    if (stats1h.totalCostUsd > 0 && stats1h.totalCostUsd > config.maxCostPer1hUsd) {
      await maybeRecordAnomalyEvent({
        ...base,
        eventType: "cost_per_1h_exceeded",
        observedValue: stats1h.totalCostUsd,
        thresholdValue: config.maxCostPer1hUsd,
        periodStart: oneHourAgo,
        periodEnd: now,
      });
    }
  } catch (err) {
    console.error(
      "[anomaly-detector] 1h window query failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────

/**
 * Run full anomaly detection pipeline for a successful AI usage event.
 *
 * Must be called after the ai_usage row has been written and confirmed.
 * Never throws — all errors are caught internally.
 */
export async function runAnomalyDetection(ctx: AnomalyDetectionContext): Promise<void> {
  if (!ctx.tenantId) return;

  try {
    const config = await loadEffectiveAnomalyConfig(ctx.tenantId);
    await detectPerRequestAnomalies(ctx, config);
    await detectWindowAnomalies(ctx, config);
  } catch (err) {
    // Top-level safety net — must never propagate to AI runtime
    console.error(
      "[anomaly-detector] Unexpected error in anomaly detection pipeline:",
      err instanceof Error ? err.message : err,
    );
  }
}
