/**
 * Phase 16 — AI Cost Governance: Alert Generator
 *
 * Creates ai_usage_alerts rows from budget check results and anomaly candidates.
 * Includes deduplication: does not re-create an open alert of the same type for
 * the same org within the same UTC calendar day.
 */

import { db } from "../../db.ts";
import { sql } from "drizzle-orm";
import type { BudgetCheckResult } from "./budget-checker.ts";
import type { AnomalyCandidate } from "./anomaly-detector.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export type AlertSeverity = "low" | "medium" | "high" | "critical";
export type AlertType     = "budget_warning" | "budget_exceeded" | "anomaly" | "runaway";

export interface AlertRecord {
  id:             string;
  organizationId: string;
  alertType:      AlertType;
  severity:       AlertSeverity;
  status:         "open" | "acknowledged" | "resolved" | "suppressed";
  title:          string;
  message:        string;
}

export interface AlertGenerationResult {
  created:    AlertRecord[];
  suppressed: number;
  errors:     string[];
}

// ─── Deduplication ────────────────────────────────────────────────────────────

async function hasOpenAlertToday(
  organizationId: string,
  alertType:      AlertType,
): Promise<boolean> {
  const rows = await db.execute(sql`
    SELECT id FROM ai_usage_alerts
    WHERE  organization_id = ${organizationId}
      AND  alert_type      = ${alertType}
      AND  status          IN ('open', 'acknowledged')
      AND  created_at     >= NOW() AT TIME ZONE 'UTC' - INTERVAL '24 hours'
    LIMIT  1
  `);
  return rows.rows.length > 0;
}

// ─── Insert helper ────────────────────────────────────────────────────────────

export async function insertAlert(params: {
  organizationId:       string;
  alertType:            AlertType;
  severity:             AlertSeverity;
  title:                string;
  message:              string;
  thresholdPct?:        number;
  currentUsageUsdCents?: bigint;
  budgetUsdCents?:       bigint;
  linkedSnapshotId?:    string;
  linkedAnomalyId?:     string;
  metadata?:            Record<string, unknown>;
}): Promise<AlertRecord> {
  const result = await db.execute(sql`
    INSERT INTO ai_usage_alerts
      (organization_id, alert_type, severity, status, title, message,
       threshold_pct, current_usage_usd_cents, budget_usd_cents,
       linked_snapshot_id, linked_anomaly_id, metadata)
    VALUES
      (${params.organizationId}, ${params.alertType}, ${params.severity}, 'open',
       ${params.title}, ${params.message},
       ${params.thresholdPct ?? null},
       ${params.currentUsageUsdCents?.toString() ?? null},
       ${params.budgetUsdCents?.toString() ?? null},
       ${params.linkedSnapshotId ?? null},
       ${params.linkedAnomalyId ?? null},
       ${JSON.stringify(params.metadata ?? {})}::jsonb)
    RETURNING id, organization_id, alert_type, severity, status, title, message
  `);

  const r = result.rows[0] as Record<string, string>;
  return {
    id:             r.id,
    organizationId: r.organization_id,
    alertType:      r.alert_type as AlertType,
    severity:       r.severity as AlertSeverity,
    status:         r.status as "open",
    title:          r.title,
    message:        r.message,
  };
}

/**
 * Lightweight insert that returns only the new alert ID (for runaway-protection).
 */
export async function insertAlertReturnId(params: {
  organizationId: string;
  alertType:      AlertType;
  severity:       AlertSeverity;
  title:          string;
  message:        string;
  metadata?:      Record<string, unknown>;
}): Promise<string | null> {
  try {
    const alert = await insertAlert(params);
    return alert.id;
  } catch {
    return null;
  }
}

// ─── Budget alert generation ──────────────────────────────────────────────────

/**
 * Generate alerts from budget check results.
 */
export async function generateBudgetAlerts(
  results: BudgetCheckResult[],
): Promise<AlertGenerationResult> {
  const created:    AlertRecord[] = [];
  const errors:     string[]      = [];
  let   suppressed  = 0;

  for (const r of results) {
    try {
      const alertType: AlertType =
        r.status === "exceeded" ? "budget_exceeded" : "budget_warning";

      if (r.status !== "warning" && r.status !== "exceeded") continue;

      const dup = await hasOpenAlertToday(r.organizationId, alertType);
      if (dup) { suppressed++; continue; }

      const pct      = Math.round(r.utilizationPct);
      const severity: AlertSeverity =
        r.status === "exceeded" ? "critical" : pct >= 90 ? "high" : "medium";

      const title =
        r.status === "exceeded"
          ? `AI budget exceeded — ${pct}% of ${r.periodType} budget consumed`
          : `AI budget warning — ${pct}% of ${r.periodType} budget consumed`;

      const usageDollars  = (Number(r.currentUsageUsdCents) / 100).toFixed(2);
      const budgetDollars = (Number(r.budgetUsdCents) / 100).toFixed(2);
      const message =
        `Organization ${r.organizationId} has consumed $${usageDollars} of ` +
        `$${budgetDollars} ${r.periodType} AI budget (${pct}%).`;

      const alert = await insertAlert({
        organizationId:       r.organizationId,
        alertType,
        severity,
        title,
        message,
        thresholdPct:         pct,
        currentUsageUsdCents: r.currentUsageUsdCents,
        budgetUsdCents:       r.budgetUsdCents,
        metadata:             { periodType: r.periodType, periodStart: r.periodStart, periodEnd: r.periodEnd },
      });
      created.push(alert);
    } catch (err) {
      errors.push(`${r.organizationId}: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  }

  return { created, suppressed, errors };
}

// ─── Anomaly alert generation ─────────────────────────────────────────────────

/**
 * Generate alerts from anomaly candidates (already persisted as anomaly events).
 * linkedAnomalyIds maps anomalyCandidate index → persisted ai_anomaly_events.id
 */
export async function generateAnomalyAlerts(
  candidates:      AnomalyCandidate[],
  linkedAnomalyIds: string[],
): Promise<AlertGenerationResult> {
  const created:   AlertRecord[] = [];
  const errors:    string[]      = [];
  let   suppressed = 0;

  for (let i = 0; i < candidates.length; i++) {
    const c       = candidates[i];
    const anomalyId = linkedAnomalyIds[i];

    try {
      const dup = await hasOpenAlertToday(c.organizationId, "anomaly");
      if (dup) { suppressed++; continue; }

      const title   = anomalyTitle(c.anomalyType, c.severity);
      const message = anomalyMessage(c);

      const alert = await insertAlert({
        organizationId:  c.organizationId,
        alertType:       "anomaly",
        severity:        c.severity,
        title,
        message,
        linkedAnomalyId: anomalyId,
        metadata:        {
          anomalyType:   c.anomalyType,
          deviationPct:  c.deviationPct,
          baselineValue: c.baselineValue,
          observedValue: c.observedValue,
          ...c.metadata,
        },
      });
      created.push(alert);
    } catch (err) {
      errors.push(`${c.organizationId}: ${err instanceof Error ? err.message : "Unknown"}`);
    }
  }

  return { created, suppressed, errors };
}

/**
 * Acknowledge an alert (mark as acknowledged).
 */
export async function acknowledgeAlert(alertId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE ai_usage_alerts
    SET    status          = 'acknowledged',
           acknowledged_at = NOW()
    WHERE  id     = ${alertId}
      AND  status = 'open'
    RETURNING id
  `);
  return result.rows.length > 0;
}

/**
 * Resolve an alert.
 */
export async function resolveAlert(alertId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE ai_usage_alerts
    SET    status      = 'resolved',
           resolved_at = NOW()
    WHERE  id     = ${alertId}
      AND  status IN ('open', 'acknowledged')
    RETURNING id
  `);
  return result.rows.length > 0;
}

/**
 * List open alerts for an organization (or all orgs if null).
 */
export async function listOpenAlerts(
  organizationId?: string,
  limit = 50,
): Promise<AlertRecord[]> {
  const safeLimit = Math.min(Math.max(1, limit), 200);

  const rows = organizationId
    ? await db.execute(sql`
        SELECT id, organization_id, alert_type, severity, status, title, message
        FROM   ai_usage_alerts
        WHERE  organization_id = ${organizationId}
          AND  status IN ('open', 'acknowledged')
        ORDER  BY created_at DESC
        LIMIT  ${safeLimit}
      `)
    : await db.execute(sql`
        SELECT id, organization_id, alert_type, severity, status, title, message
        FROM   ai_usage_alerts
        WHERE  status IN ('open', 'acknowledged')
        ORDER  BY created_at DESC
        LIMIT  ${safeLimit}
      `);

  return rows.rows.map((r) => {
    const row = r as Record<string, string>;
    return {
      id:             row.id,
      organizationId: row.organization_id,
      alertType:      row.alert_type as AlertType,
      severity:       row.severity as AlertSeverity,
      status:         row.status as "open" | "acknowledged",
      title:          row.title,
      message:        row.message,
    };
  });
}

// ─── Copy helpers ─────────────────────────────────────────────────────────────

function anomalyTitle(type: string, severity: string): string {
  const sev = severity.charAt(0).toUpperCase() + severity.slice(1);
  switch (type) {
    case "cost_spike":    return `${sev} AI cost spike detected`;
    case "token_spike":   return `${sev} AI token usage spike detected`;
    case "request_spike": return `${sev} AI request volume spike detected`;
    case "model_drift":   return `AI model drift detected`;
    case "sudden_stop":   return `AI usage sudden stop detected`;
    default:              return `${sev} AI anomaly detected`;
  }
}

function anomalyMessage(c: AnomalyCandidate): string {
  const dev = c.deviationPct.toFixed(1);
  switch (c.anomalyType) {
    case "cost_spike":
      return `AI cost for org ${c.organizationId} is ${dev}% above baseline ` +
             `(baseline: $${(c.baselineValue / 100).toFixed(2)}, ` +
             `observed: $${(c.observedValue / 100).toFixed(2)}).`;
    case "token_spike":
      return `Token consumption for org ${c.organizationId} is ${dev}% above baseline ` +
             `(baseline: ${Math.round(c.baselineValue).toLocaleString()}, ` +
             `observed: ${Math.round(c.observedValue).toLocaleString()}).`;
    case "request_spike":
      return `AI request count for org ${c.organizationId} is ${dev}% above baseline.`;
    case "model_drift":
      return `Primary AI model for org ${c.organizationId} changed from ` +
             `"${String(c.metadata.prevModel)}" to "${String(c.metadata.currentModel)}".`;
    case "sudden_stop":
      return `AI usage for org ${c.organizationId} dropped to zero (was averaging ` +
             `${Math.round(c.baselineValue)} requests/period).`;
    default:
      return `Anomaly detected for org ${c.organizationId}: ${dev}% deviation from baseline.`;
  }
}
