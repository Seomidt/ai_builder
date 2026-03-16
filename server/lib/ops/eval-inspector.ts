/**
 * Phase 27 — AI Evaluation Inspector
 * Operational view into AI governance policies, retention evaluations,
 * and anomaly-based regression signals.
 *
 * Covers: policy runs, regression signals, failure patterns.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PolicyEvaluationRun {
  policyId:    string;
  policyKey:   string;
  policyType:  string;
  active:      boolean;
  ruleCount:   number;
  lastEvalAt:  string | null;
  violations:  number;
}

export interface RegressionSignal {
  source:       string;
  tenantId:     string | null;
  eventType:    string;
  occurrences:  number;
  firstSeenAt:  string;
  lastSeenAt:   string;
  severity:     "low" | "medium" | "high";
}

export interface FailurePattern {
  category:    string;
  pattern:     string;
  count:       number;
  affectedTenants: number;
  firstSeenAt: string;
  lastSeenAt:  string;
}

export interface RetentionEvaluationSummary {
  policyKey:     string;
  tableName:     string;
  retentionDays: number;
  cutoffDate:    string;
  archiveEnabled: boolean;
  deleteEnabled:  boolean;
}

export interface EvalHealthSummary {
  activePolicies:          number;
  totalRules:              number;
  anomalyEventsLast24h:    number;
  moderationEventsLast24h: number;
  openAlerts:              number;
  regressionSignals:       number;
  deletionJobsBlocked:     number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeNum(v: unknown): number { const n = Number(v); return isNaN(n) ? 0 : n; }

function classifySeverity(count: number): "low" | "medium" | "high" {
  if (count >= 10) return "high";
  if (count >= 3)  return "medium";
  return "low";
}

// ── Policy Evaluation Runs ────────────────────────────────────────────────────

export async function getPolicyEvaluationRuns(activeOnly = true): Promise<PolicyEvaluationRun[]> {
  const whereActive = activeOnly ? "WHERE p.enabled = TRUE" : "";

  const r = await db.execute(sql.raw(`
    SELECT
      p.id                       AS policy_id,
      p.policy_key,
      'ai_governance'            AS policy_type,
      p.enabled                  AS active,
      0                          AS rule_count,
      p.updated_at               AS last_eval_at,
      0                          AS violations
    FROM ai_policies p
    ${whereActive}
    ORDER BY p.created_at DESC
    LIMIT 100
  `));

  // Also include retention policy evaluations
  const retentionRows = await db.execute(sql.raw(`
    SELECT
      rp.id                        AS policy_id,
      rp.policy_key,
      'retention'                  AS policy_type,
      rp.active,
      COUNT(DISTINCT rr.id)        AS rule_count,
      MAX(rp.updated_at)           AS last_eval_at,
      0                            AS violations
    FROM data_retention_policies rp
    LEFT JOIN data_retention_rules rr ON rr.policy_id = rp.id
    ${activeOnly ? "WHERE rp.active = TRUE" : ""}
    GROUP BY rp.id, rp.policy_key, rp.active
    ORDER BY rp.created_at DESC
    LIMIT 50
  `));

  const aiRows = (r.rows as any[]).map(row => ({
    policyId:   row.policy_id,
    policyKey:  row.policy_key,
    policyType: row.policy_type ?? "ai_governance",
    active:     row.active,
    ruleCount:  safeNum(row.rule_count),
    lastEvalAt: row.last_eval_at ? new Date(row.last_eval_at).toISOString() : null,
    violations: safeNum(row.violations),
  }));

  const retRows = (retentionRows.rows as any[]).map(row => ({
    policyId:   row.policy_id,
    policyKey:  row.policy_key,
    policyType: "retention",
    active:     row.active,
    ruleCount:  safeNum(row.rule_count),
    lastEvalAt: row.last_eval_at ? new Date(row.last_eval_at).toISOString() : null,
    violations: safeNum(row.violations),
  }));

  return [...aiRows, ...retRows];
}

// ── Regression Signals ────────────────────────────────────────────────────────

export async function getRegressionSignals(
  windowHours = 24,
  tenantId?: string,
): Promise<RegressionSignal[]> {
  const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const tFilter = tenantId ? `AND tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";

  const [anomalyRes, govRes] = await Promise.all([
    // AI anomaly events (phase 16 gov_anomaly_events)
    db.execute(sql.raw(`
      SELECT
        'ai_anomaly'          AS source,
        tenant_id,
        event_type,
        COUNT(*)              AS occurrences,
        MIN(created_at)       AS first_seen,
        MAX(created_at)       AS last_seen
      FROM gov_anomaly_events
      WHERE created_at >= '${cutoff}' ${tFilter}
      GROUP BY tenant_id, event_type
      ORDER BY occurrences DESC
      LIMIT 50
    `)),
    // AI platform anomaly events (phase pre-16)
    db.execute(sql.raw(`
      SELECT
        'platform_anomaly'   AS source,
        tenant_id,
        event_type,
        COUNT(*)             AS occurrences,
        MIN(created_at)      AS first_seen,
        MAX(created_at)      AS last_seen
      FROM ai_anomaly_events
      WHERE created_at >= '${cutoff}' ${tFilter}
      GROUP BY tenant_id, event_type
      ORDER BY occurrences DESC
      LIMIT 50
    `)),
  ]);

  const toSignal = (row: any, source: string): RegressionSignal => ({
    source,
    tenantId:    row.tenant_id ?? null,
    eventType:   row.event_type,
    occurrences: safeNum(row.occurrences),
    firstSeenAt: new Date(row.first_seen).toISOString(),
    lastSeenAt:  new Date(row.last_seen).toISOString(),
    severity:    classifySeverity(safeNum(row.occurrences)),
  });

  return [
    ...(anomalyRes.rows as any[]).map(r => toSignal(r, "ai_anomaly")),
    ...(govRes.rows     as any[]).map(r => toSignal(r, "platform_anomaly")),
  ].sort((a, b) => b.occurrences - a.occurrences);
}

// ── Failure Patterns ──────────────────────────────────────────────────────────

export async function getFailurePatterns(windowHours = 168): Promise<FailurePattern[]> {
  const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString();

  const [jobFailures, webhookFailures, deletionBlocks] = await Promise.all([
    db.execute(sql.raw(`
      SELECT
        'job_failure'        AS category,
        COALESCE(LEFT(failure_reason, 80), 'unknown') AS pattern,
        COUNT(*)             AS cnt,
        COUNT(DISTINCT tenant_id) AS tenants,
        MIN(created_at)      AS first_seen,
        MAX(created_at)      AS last_seen
      FROM knowledge_processing_jobs
      WHERE status = 'failed' AND created_at >= '${cutoff}'
      GROUP BY LEFT(failure_reason, 80)
      ORDER BY cnt DESC
      LIMIT 20
    `)),
    db.execute(sql.raw(`
      SELECT
        'webhook_failure'    AS category,
        COALESCE(LEFT(last_error, 80), 'unknown') AS pattern,
        COUNT(*)             AS cnt,
        COUNT(DISTINCT tenant_id) AS tenants,
        MIN(created_at)      AS first_seen,
        MAX(created_at)      AS last_seen
      FROM webhook_deliveries
      WHERE status = 'failed' AND created_at >= '${cutoff}'
      GROUP BY LEFT(last_error, 80)
      ORDER BY cnt DESC
      LIMIT 20
    `)),
    db.execute(sql.raw(`
      SELECT
        'deletion_blocked'           AS category,
        'legal_hold_active'          AS pattern,
        COUNT(*)                     AS cnt,
        COUNT(DISTINCT tenant_id)    AS tenants,
        MIN(created_at)              AS first_seen,
        MAX(created_at)              AS last_seen
      FROM data_deletion_jobs
      WHERE blocked_by_hold = TRUE AND created_at >= '${cutoff}'
      GROUP BY 1, 2
    `)),
  ]);

  const toPattern = (row: any): FailurePattern => ({
    category:        row.category,
    pattern:         row.pattern,
    count:           safeNum(row.cnt),
    affectedTenants: safeNum(row.tenants),
    firstSeenAt:     new Date(row.first_seen).toISOString(),
    lastSeenAt:      new Date(row.last_seen).toISOString(),
  });

  return [
    ...(jobFailures.rows     as any[]).map(toPattern),
    ...(webhookFailures.rows as any[]).map(toPattern),
    ...(deletionBlocks.rows  as any[]).map(toPattern),
  ].sort((a, b) => b.count - a.count);
}

// ── Retention Evaluations ─────────────────────────────────────────────────────

export async function getRetentionEvaluations(): Promise<RetentionEvaluationSummary[]> {
  const r = await db.execute(sql.raw(`
    SELECT
      rp.policy_key,
      rr.table_name,
      rr.retention_days,
      rr.archive_enabled,
      rr.delete_enabled,
      (NOW() - INTERVAL '1 day' * rr.retention_days)::timestamptz AS cutoff_date
    FROM data_retention_rules rr
    JOIN data_retention_policies rp ON rp.id = rr.policy_id
    WHERE rp.active = TRUE AND rr.active = TRUE
    ORDER BY rr.retention_days ASC
  `));

  return (r.rows as any[]).map(row => ({
    policyKey:      row.policy_key,
    tableName:      row.table_name,
    retentionDays:  safeNum(row.retention_days),
    cutoffDate:     new Date(row.cutoff_date).toISOString(),
    archiveEnabled: row.archive_enabled,
    deleteEnabled:  row.delete_enabled,
  }));
}

// ── Eval Health Summary ───────────────────────────────────────────────────────

export async function getEvalHealthSummary(): Promise<EvalHealthSummary> {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();

  const r = await db.execute(sql.raw(`
    SELECT
      (SELECT COUNT(*) FROM ai_policies WHERE enabled=TRUE)                            AS ai_policies,
      (SELECT COUNT(*) FROM data_retention_policies WHERE active=TRUE)                 AS ret_policies,
      (SELECT COUNT(*) FROM data_retention_rules WHERE active=TRUE)                    AS ret_rules,
      (SELECT COUNT(*) FROM ai_anomaly_events WHERE created_at>='${yesterday}')        AS anomaly_24h,
      (SELECT COUNT(*) FROM moderation_events  WHERE created_at>='${yesterday}')       AS moderation_24h,
      (SELECT COUNT(*) FROM ai_usage_alerts)                                           AS open_alerts,
      (SELECT COUNT(*) FROM data_deletion_jobs WHERE blocked_by_hold=TRUE AND status='pending') AS del_blocked
  `));

  const row = (r.rows[0] as any) ?? {};
  const totalPolicies = safeNum(row.ai_policies) + safeNum(row.ret_policies);
  const totalRules    = safeNum(row.ret_rules);

  // Regression signals = distinct anomaly event types in last 24h
  const sigRes = await db.execute(sql.raw(`
    SELECT COUNT(DISTINCT event_type) AS cnt
    FROM gov_anomaly_events WHERE created_at>='${yesterday}'
  `));

  return {
    activePolicies:          totalPolicies,
    totalRules,
    anomalyEventsLast24h:    safeNum(row.anomaly_24h),
    moderationEventsLast24h: safeNum(row.moderation_24h),
    openAlerts:              safeNum(row.open_alerts),
    regressionSignals:       safeNum((sigRes.rows[0] as any)?.cnt ?? 0),
    deletionJobsBlocked:     safeNum(row.del_blocked),
  };
}
