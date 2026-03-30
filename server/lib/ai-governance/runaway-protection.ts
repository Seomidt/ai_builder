/**
 * Phase 16 — AI Cost Governance: Runaway Protection
 *
 * Detects and flags runaway AI usage — rapid cost/token accumulation within a
 * short window — and generates "runaway" alerts. Does NOT hard-kill AI runs
 * (orchestration layer handles enforcement), but marks affected runs and
 * notifies ops via alert-generator.
 *
 * Runaway triggers (all within the configured window):
 *   1. cost_rate:    cost-per-minute exceeds threshold
 *   2. token_rate:   tokens-per-minute exceeds threshold
 *   3. error_rate:   failed / total requests > error_rate_pct
 *   4. budget_burn:  projected end-of-period cost exceeds hard limit
 */

import { db } from "../../db.ts";
import { sql } from "drizzle-orm";
import { insertAlertReturnId } from "./alert-generator.ts";

// ─── Config ───────────────────────────────────────────────────────────────────

export interface RunawayProtectionConfig {
  /** Rolling window in minutes for rate calculations */
  windowMinutes:         number;
  /** Max USD cents per minute before triggering (default: $1.00/min = 100 cents) */
  maxCostCentsPerMinute: number;
  /** Max tokens per minute before triggering */
  maxTokensPerMinute:    number;
  /** Error rate threshold % (0–100) */
  maxErrorRatePct:       number;
  /** If projected cost > budget × this factor, trigger (default: 2 = 200%) */
  budgetBurnFactor:      number;
}

export const DEFAULT_RUNAWAY_CONFIG: RunawayProtectionConfig = {
  windowMinutes:         15,
  maxCostCentsPerMinute: 100,
  maxTokensPerMinute:    100_000,
  maxErrorRatePct:       50,
  budgetBurnFactor:      2,
};

// ─── Types ────────────────────────────────────────────────────────────────────

export type RunawayTrigger =
  | "cost_rate"
  | "token_rate"
  | "error_rate"
  | "budget_burn";

export interface RunawayEvent {
  organizationId:  string;
  trigger:         RunawayTrigger;
  observedValue:   number;
  thresholdValue:  number;
  windowMinutes:   number;
  severity:        "high" | "critical";
  metadata:        Record<string, unknown>;
}

export interface RunawayCheckResult {
  organizationId: string;
  triggered:      boolean;
  events:         RunawayEvent[];
  alertIds:       string[];
  errors:         string[];
}

// ─── Rate computation ─────────────────────────────────────────────────────────

interface WindowMetrics {
  totalCostUsdCents: number;
  totalTokens:       number;
  totalRequests:     number;
  failedRequests:    number;
  windowMinutes:     number;
}

async function getWindowMetrics(
  organizationId: string,
  windowMinutes:  number,
): Promise<WindowMetrics> {
  const zero: WindowMetrics = {
    totalCostUsdCents: 0,
    totalTokens:       0,
    totalRequests:     0,
    failedRequests:    0,
    windowMinutes,
  };

  try {
    const rows = await db.execute(sql`
      SELECT
        COALESCE(SUM(cost_usd_micros / 10), 0)               AS cost_cents,
        COALESCE(SUM(input_tokens + output_tokens), 0)        AS tokens,
        COUNT(*)                                              AS requests
      FROM ai_billing_usage
      WHERE organization_id = ${organizationId}
        AND billed_at      >= NOW() - (${windowMinutes} || ' minutes')::interval
    `);
    const r = rows.rows[0] as Record<string, string | number | null> | undefined;
    if (r) {
      zero.totalCostUsdCents = Number(r.cost_cents ?? 0);
      zero.totalTokens       = Number(r.tokens     ?? 0);
      zero.totalRequests     = Number(r.requests   ?? 0);
    }
  } catch {
    // Graceful degradation
  }

  try {
    const failRows = await db.execute(sql`
      SELECT COUNT(*) AS cnt
      FROM ai_runs
      WHERE organization_id = ${organizationId}
        AND status          = 'failed'
        AND created_at     >= NOW() - (${windowMinutes} || ' minutes')::interval
    `);
    const fr = failRows.rows[0] as { cnt: string | number } | undefined;
    if (fr) zero.failedRequests = Number(fr.cnt);
  } catch {
    // Graceful degradation
  }

  return zero;
}

// ─── Core check ───────────────────────────────────────────────────────────────

export async function checkRunawayProtection(
  organizationId: string,
  config: RunawayProtectionConfig = DEFAULT_RUNAWAY_CONFIG,
): Promise<RunawayCheckResult> {
  const result: RunawayCheckResult = {
    organizationId,
    triggered: false,
    events:    [],
    alertIds:  [],
    errors:    [],
  };

  if (!organizationId?.trim()) {
    result.errors.push("organizationId is required");
    return result;
  }

  let metrics: WindowMetrics;
  try {
    metrics = await getWindowMetrics(organizationId, config.windowMinutes);
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : "Failed to get metrics");
    return result;
  }

  const costPerMinute  = metrics.totalCostUsdCents / config.windowMinutes;
  const tokensPerMinute = metrics.totalTokens      / config.windowMinutes;
  const errorRatePct   = metrics.totalRequests > 0
    ? (metrics.failedRequests / metrics.totalRequests) * 100
    : 0;

  // Trigger: cost rate
  if (costPerMinute > config.maxCostCentsPerMinute) {
    result.events.push({
      organizationId,
      trigger:        "cost_rate",
      observedValue:  costPerMinute,
      thresholdValue: config.maxCostCentsPerMinute,
      windowMinutes:  config.windowMinutes,
      severity:       costPerMinute > config.maxCostCentsPerMinute * 3 ? "critical" : "high",
      metadata:       { totalCostUsdCents: metrics.totalCostUsdCents, windowMinutes: config.windowMinutes },
    });
  }

  // Trigger: token rate
  if (tokensPerMinute > config.maxTokensPerMinute) {
    result.events.push({
      organizationId,
      trigger:        "token_rate",
      observedValue:  tokensPerMinute,
      thresholdValue: config.maxTokensPerMinute,
      windowMinutes:  config.windowMinutes,
      severity:       tokensPerMinute > config.maxTokensPerMinute * 3 ? "critical" : "high",
      metadata:       { totalTokens: metrics.totalTokens, windowMinutes: config.windowMinutes },
    });
  }

  // Trigger: error rate
  if (metrics.totalRequests >= 5 && errorRatePct > config.maxErrorRatePct) {
    result.events.push({
      organizationId,
      trigger:        "error_rate",
      observedValue:  errorRatePct,
      thresholdValue: config.maxErrorRatePct,
      windowMinutes:  config.windowMinutes,
      severity:       errorRatePct > 80 ? "critical" : "high",
      metadata:       { failedRequests: metrics.failedRequests, totalRequests: metrics.totalRequests },
    });
  }

  // Trigger: budget burn rate (project to end of period)
  try {
    const budgetRow = await db.execute(sql`
      SELECT budget_usd_cents, hard_limit_pct
      FROM   tenant_ai_budgets
      WHERE  organization_id = ${organizationId}
        AND  period_type     = 'monthly'
        AND  is_active       = true
      LIMIT  1
    `);
    if (budgetRow.rows.length > 0) {
      const b              = budgetRow.rows[0] as { budget_usd_cents: string; hard_limit_pct: number };
      const budgetCents    = Number(b.budget_usd_cents);
      const hardLimitCents = budgetCents * (Number(b.hard_limit_pct) / 100);

      // Use current monthly usage from snapshots as running total
      const usageRow = await db.execute(sql`
        SELECT COALESCE(SUM(total_cost_usd_cents), 0) AS used
        FROM   tenant_ai_usage_snapshots
        WHERE  organization_id = ${organizationId}
          AND  period_type     = 'monthly'
          AND  period_start   >= date_trunc('month', NOW())
      `);
      const usedCents = Number((usageRow.rows[0] as { used: string }).used ?? 0);

      // Project: current burn rate over remaining minutes in month
      const now              = new Date();
      const endOfMonth       = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      const remainingMinutes = (endOfMonth.getTime() - now.getTime()) / 60_000;
      const projectedTotal   = usedCents + costPerMinute * remainingMinutes;

      if (projectedTotal > hardLimitCents * config.budgetBurnFactor) {
        result.events.push({
          organizationId,
          trigger:        "budget_burn",
          observedValue:  projectedTotal,
          thresholdValue: hardLimitCents,
          windowMinutes:  config.windowMinutes,
          severity:       "critical",
          metadata:       { projectedTotalUsdCents: projectedTotal, budgetUsdCents: budgetCents, usedCents },
        });
      }
    }
  } catch {
    // Non-fatal
  }

  if (result.events.length > 0) {
    result.triggered = true;

    // Persist as runaway alerts (dedup: max 1 per trigger per org per 15 min)
    for (const ev of result.events) {
      try {
        const alertId = await insertAlertReturnId({
          organizationId:  ev.organizationId,
          alertType:       "runaway",
          severity:        ev.severity,
          title:           runawayTitle(ev.trigger),
          message:         runawayMessage(ev),
          metadata:        ev.metadata,
        });
        if (alertId) result.alertIds.push(alertId);
      } catch (err) {
        result.errors.push(err instanceof Error ? err.message : "Alert insert failed");
      }
    }
  }

  return result;
}

/**
 * Run runaway protection for all tenants with active budgets.
 */
export async function checkAllRunawayProtection(
  config: RunawayProtectionConfig = DEFAULT_RUNAWAY_CONFIG,
): Promise<RunawayCheckResult[]> {
  const orgRows = await db.execute(sql`
    SELECT DISTINCT organization_id FROM tenant_ai_budgets WHERE is_active = true
  `);

  const results: RunawayCheckResult[] = [];
  for (const row of orgRows.rows) {
    const orgId = (row as { organization_id: string }).organization_id;
    results.push(await checkRunawayProtection(orgId, config));
  }
  return results;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function runawayTitle(trigger: RunawayTrigger): string {
  switch (trigger) {
    case "cost_rate":    return "Runaway AI cost rate detected";
    case "token_rate":   return "Runaway AI token rate detected";
    case "error_rate":   return "Runaway AI error rate detected";
    case "budget_burn":  return "AI budget burn rate — projected overspend";
  }
}

function runawayMessage(ev: RunawayEvent): string {
  const obs  = ev.observedValue.toFixed(2);
  const thr  = ev.thresholdValue.toFixed(2);
  switch (ev.trigger) {
    case "cost_rate":
      return `Org ${ev.organizationId} is burning $${(ev.observedValue / 100).toFixed(2)}/min ` +
             `(threshold: $${(ev.thresholdValue / 100).toFixed(2)}/min) over ${ev.windowMinutes}m window.`;
    case "token_rate":
      return `Org ${ev.organizationId} consuming ${Math.round(ev.observedValue).toLocaleString()} tokens/min ` +
             `(threshold: ${Math.round(ev.thresholdValue).toLocaleString()}) over ${ev.windowMinutes}m window.`;
    case "error_rate":
      return `Org ${ev.organizationId} error rate is ${obs}% (threshold: ${thr}%) ` +
             `over last ${ev.windowMinutes} minutes.`;
    case "budget_burn":
      return `Org ${ev.organizationId} projected to exceed budget by ${obs}% ` +
             `if current burn rate continues.`;
  }
}
