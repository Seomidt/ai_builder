/**
 * Phase 16 — AI Cost Governance: Anomaly Detector
 *
 * Compares recent AI usage against historical baseline.
 * Writes confirmed anomaly events to ai_anomaly_events.
 *
 * Anomaly types:
 *   cost_spike     — cost exceeds baseline by N%
 *   token_spike    — token consumption exceeds baseline by N%
 *   request_spike  — request count exceeds baseline by N%
 *   model_drift    — primary model changes unexpectedly
 *   sudden_stop    — requests drop to zero (after active period)
 */

import { db } from "../../db.ts";
import { sql } from "drizzle-orm";
import type { PeriodType } from "./budget-checker.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AnomalyType =
  | "cost_spike"
  | "token_spike"
  | "request_spike"
  | "model_drift"
  | "sudden_stop";

export type AnomalySeverity = "low" | "medium" | "high" | "critical";

export interface AnomalyDetectionConfig {
  /** % above baseline that triggers low severity */
  lowThresholdPct:      number;
  /** % above baseline that triggers medium severity */
  mediumThresholdPct:   number;
  /** % above baseline that triggers high severity */
  highThresholdPct:     number;
  /** % above baseline that triggers critical severity */
  criticalThresholdPct: number;
  /** How many baseline periods to use for comparison */
  baselinePeriods:      number;
}

export const DEFAULT_ANOMALY_CONFIG: AnomalyDetectionConfig = {
  lowThresholdPct:      25,
  mediumThresholdPct:   75,
  highThresholdPct:     150,
  criticalThresholdPct: 300,
  baselinePeriods:      4,
};

export interface AnomalyCandidate {
  organizationId: string;
  anomalyType:    AnomalyType;
  severity:       AnomalySeverity;
  baselineValue:  number;
  observedValue:  number;
  deviationPct:   number;
  windowMinutes:  number;
  metadata:       Record<string, unknown>;
}

export interface DetectionResult {
  anomalies:      AnomalyCandidate[];
  persisted:      string[];   // IDs of persisted anomaly events
  errors:         string[];
}

// ─── Severity classifier ──────────────────────────────────────────────────────

export function classifyAnomalySeverity(
  deviationPct: number,
  config: AnomalyDetectionConfig = DEFAULT_ANOMALY_CONFIG,
): AnomalySeverity {
  if (deviationPct >= config.criticalThresholdPct) return "critical";
  if (deviationPct >= config.highThresholdPct)     return "high";
  if (deviationPct >= config.mediumThresholdPct)   return "medium";
  return "low";
}

export function deviationPct(baseline: number, observed: number): number {
  if (baseline <= 0) return observed > 0 ? 100 : 0;
  return Math.abs(((observed - baseline) / baseline) * 100);
}

// ─── Baseline computation ─────────────────────────────────────────────────────

interface BaselineMetrics {
  avgCostUsdCents:  number;
  avgTokens:        number;
  avgRequests:      number;
  periodCount:      number;
}

async function computeBaseline(
  organizationId: string,
  periodType:     PeriodType,
  currentStart:   Date,
  baselinePeriods: number,
): Promise<BaselineMetrics> {
  const rows = await db.execute(sql`
    SELECT
      AVG(total_cost_usd_cents) AS avg_cost,
      AVG(total_tokens)         AS avg_tokens,
      AVG(request_count)        AS avg_requests,
      COUNT(*)                  AS period_count
    FROM (
      SELECT total_cost_usd_cents, total_tokens, request_count
      FROM   tenant_ai_usage_snapshots
      WHERE  organization_id = ${organizationId}
        AND  period_type     = ${periodType}
        AND  period_start    < ${currentStart.toISOString()}
      ORDER  BY period_start DESC
      LIMIT  ${baselinePeriods}
    ) recent
  `);

  const r = rows.rows[0] as Record<string, string | number | null> | undefined;
  return {
    avgCostUsdCents: Number(r?.avg_cost     ?? 0),
    avgTokens:       Number(r?.avg_tokens   ?? 0),
    avgRequests:     Number(r?.avg_requests ?? 0),
    periodCount:     Number(r?.period_count ?? 0),
  };
}

// ─── Core detection ───────────────────────────────────────────────────────────

/**
 * Run anomaly detection for a single tenant.
 * Compares current period snapshot against recent baseline.
 */
export async function detectTenantAnomalies(
  organizationId: string,
  periodType:     PeriodType = "monthly",
  config:         AnomalyDetectionConfig = DEFAULT_ANOMALY_CONFIG,
): Promise<AnomalyCandidate[]> {
  if (!organizationId?.trim()) return [];

  // Get the latest snapshot for the current period
  const latestRows = await db.execute(sql`
    SELECT *
    FROM   tenant_ai_usage_snapshots
    WHERE  organization_id = ${organizationId}
      AND  period_type     = ${periodType}
    ORDER  BY snapshot_at DESC
    LIMIT  1
  `);

  if (latestRows.rows.length === 0) return [];

  const latest = latestRows.rows[0] as Record<string, unknown>;
  const currentStart      = new Date(String(latest.period_start));
  const currentCost       = Number(String(latest.total_cost_usd_cents ?? 0));
  const currentTokens     = Number(String(latest.total_tokens ?? 0));
  const currentRequests   = Number(latest.request_count ?? 0);
  const currentModelBreakdown = (latest.model_breakdown as Record<string, { tokens: number; costUsdCents: number; requests: number }>) ?? {};

  const baseline = await computeBaseline(organizationId, periodType, currentStart, config.baselinePeriods);

  // Insufficient baseline — skip
  if (baseline.periodCount < 1) return [];

  const candidates: AnomalyCandidate[] = [];

  // Cost spike
  const costDev = deviationPct(baseline.avgCostUsdCents, currentCost);
  if (costDev >= config.lowThresholdPct && currentCost > baseline.avgCostUsdCents) {
    candidates.push({
      organizationId,
      anomalyType:   "cost_spike",
      severity:      classifyAnomalySeverity(costDev, config),
      baselineValue: baseline.avgCostUsdCents,
      observedValue: currentCost,
      deviationPct:  costDev,
      windowMinutes: periodWindowMinutes(periodType),
      metadata:      { periodType, baselinePeriods: baseline.periodCount },
    });
  }

  // Token spike
  const tokenDev = deviationPct(baseline.avgTokens, currentTokens);
  if (tokenDev >= config.lowThresholdPct && currentTokens > baseline.avgTokens) {
    candidates.push({
      organizationId,
      anomalyType:   "token_spike",
      severity:      classifyAnomalySeverity(tokenDev, config),
      baselineValue: baseline.avgTokens,
      observedValue: currentTokens,
      deviationPct:  tokenDev,
      windowMinutes: periodWindowMinutes(periodType),
      metadata:      { periodType },
    });
  }

  // Request spike
  const reqDev = deviationPct(baseline.avgRequests, currentRequests);
  if (reqDev >= config.lowThresholdPct && currentRequests > baseline.avgRequests) {
    candidates.push({
      organizationId,
      anomalyType:   "request_spike",
      severity:      classifyAnomalySeverity(reqDev, config),
      baselineValue: baseline.avgRequests,
      observedValue: currentRequests,
      deviationPct:  reqDev,
      windowMinutes: periodWindowMinutes(periodType),
      metadata:      { periodType },
    });
  }

  // Sudden stop: had requests in baseline, now zero
  if (baseline.avgRequests > 5 && currentRequests === 0) {
    candidates.push({
      organizationId,
      anomalyType:   "sudden_stop",
      severity:      "high",
      baselineValue: baseline.avgRequests,
      observedValue: 0,
      deviationPct:  100,
      windowMinutes: periodWindowMinutes(periodType),
      metadata:      { periodType },
    });
  }

  // Model drift: primary model changed significantly
  if (Object.keys(currentModelBreakdown).length > 0) {
    const primaryCurrentModel  = topModel(currentModelBreakdown);
    const prevModelRows = await db.execute(sql`
      SELECT model_breakdown
      FROM   tenant_ai_usage_snapshots
      WHERE  organization_id = ${organizationId}
        AND  period_type     = ${periodType}
        AND  period_start    < ${currentStart.toISOString()}
      ORDER  BY period_start DESC
      LIMIT  1
    `);
    if (prevModelRows.rows.length > 0) {
      const prevBreakdown = ((prevModelRows.rows[0] as Record<string, unknown>).model_breakdown as Record<string, { tokens: number }>) ?? {};
      const primaryPrevModel = topModel(prevBreakdown);
      if (primaryCurrentModel && primaryPrevModel && primaryCurrentModel !== primaryPrevModel) {
        candidates.push({
          organizationId,
          anomalyType:   "model_drift",
          severity:      "medium",
          baselineValue: 0,
          observedValue: 0,
          deviationPct:  0,
          windowMinutes: periodWindowMinutes(periodType),
          metadata:      { prevModel: primaryPrevModel, currentModel: primaryCurrentModel, periodType },
        });
      }
    }
  }

  return candidates;
}

/**
 * Persist anomaly candidates to ai_anomaly_events.
 * Returns IDs of inserted records.
 */
export async function persistAnomalies(
  candidates: AnomalyCandidate[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const c of candidates) {
    try {
      const result = await db.execute(sql`
        INSERT INTO ai_anomaly_events
          (organization_id, anomaly_type, window_minutes,
           baseline_value, observed_value, deviation_pct, severity, metadata)
        VALUES
          (${c.organizationId}, ${c.anomalyType}, ${c.windowMinutes},
           ${c.baselineValue.toString()}, ${c.observedValue.toString()},
           ${c.deviationPct.toFixed(2)}, ${c.severity}, ${JSON.stringify(c.metadata)}::jsonb)
        RETURNING id
      `);
      ids.push((result.rows[0] as { id: string }).id);
    } catch {
      // Non-fatal — detection still runs
    }
  }
  return ids;
}

/**
 * Detect and persist anomalies for all tenants with active budgets.
 */
export async function detectAllTenantAnomalies(
  periodType: PeriodType = "monthly",
  config:     AnomalyDetectionConfig = DEFAULT_ANOMALY_CONFIG,
): Promise<DetectionResult> {
  const orgRows = await db.execute(sql`
    SELECT DISTINCT organization_id FROM tenant_ai_budgets WHERE is_active = true
  `);

  const allAnomalies: AnomalyCandidate[] = [];
  const errors: string[]                  = [];

  for (const row of orgRows.rows) {
    const orgId = (row as { organization_id: string }).organization_id;
    try {
      const anomalies = await detectTenantAnomalies(orgId, periodType, config);
      allAnomalies.push(...anomalies);
    } catch (err) {
      errors.push(`${orgId}: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  }

  const persisted = await persistAnomalies(allAnomalies);
  return { anomalies: allAnomalies, persisted, errors };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function periodWindowMinutes(periodType: PeriodType): number {
  switch (periodType) {
    case "daily":   return 1440;
    case "weekly":  return 10080;
    case "monthly": return 43200;
    case "annual":  return 525600;
  }
}

function topModel(breakdown: Record<string, { tokens?: number; costUsdCents?: number }>): string | null {
  let top: string | null = null;
  let max = -1;
  for (const [model, data] of Object.entries(breakdown)) {
    const v = data.tokens ?? data.costUsdCents ?? 0;
    if (v > max) { max = v; top = model; }
  }
  return top;
}
