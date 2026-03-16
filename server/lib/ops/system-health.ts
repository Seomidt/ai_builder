/**
 * Phase 27 — System Health Summary
 * Aggregates health signals across: AI, queue, webhooks, security, billing.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────────────

export type HealthStatus = "healthy" | "degraded" | "critical" | "unknown";

export interface SubsystemHealth {
  status:  HealthStatus;
  score:   number; // 0–100
  metrics: Record<string, number | string | null>;
  issues:  string[];
}

export interface SystemHealthReport {
  generatedAt: string;
  overallStatus: HealthStatus;
  overallScore: number; // 0–100
  subsystems: {
    ai:       SubsystemHealth;
    queue:    SubsystemHealth;
    webhooks: SubsystemHealth;
    security: SubsystemHealth;
    billing:  SubsystemHealth;
    governance: SubsystemHealth;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeNum(v: unknown): number { const n = Number(v); return isNaN(n) ? 0 : n; }

function scoreToStatus(score: number): HealthStatus {
  if (score >= 80) return "healthy";
  if (score >= 50) return "degraded";
  if (score >= 0)  return "critical";
  return "unknown";
}

// ── AI Health ─────────────────────────────────────────────────────────────────

async function getAiHealth(): Promise<SubsystemHealth> {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const issues: string[] = [];

  const r = await db.execute(sql.raw(`
    SELECT
      COUNT(*)                                              AS total_calls,
      AVG(latency_ms)                                       AS avg_latency,
      COUNT(*) FILTER (WHERE latency_ms > 5000)             AS slow_calls,
      COUNT(*) FILTER (WHERE cost_usd::numeric > 0.5)       AS expensive_calls,
      (SELECT COUNT(*) FROM ai_usage_alerts)                                AS open_alerts,
      (SELECT COUNT(*) FROM gov_anomaly_events WHERE created_at>='${yesterday}') AS anomalies_24h
    FROM obs_ai_latency_metrics
    WHERE created_at >= '${yesterday}'
  `));

  const row = (r.rows[0] as any) ?? {};
  const total      = safeNum(row.total_calls);
  const avgLatency = safeNum(row.avg_latency);
  const slowCalls  = safeNum(row.slow_calls);
  const openAlerts = safeNum(row.open_alerts);
  const anomalies  = safeNum(row.anomalies_24h);

  let score = 100;
  if (openAlerts > 0)  { score -= 15; issues.push(`${openAlerts} open AI usage alerts`); }
  if (anomalies  > 5)  { score -= 20; issues.push(`${anomalies} AI anomalies in last 24h`); }
  if (total > 0 && slowCalls / total > 0.1) { score -= 15; issues.push(`${Math.round(slowCalls/total*100)}% slow AI calls (>5s)`); }
  if (avgLatency > 3000) { score -= 10; issues.push(`High avg AI latency: ${Math.round(avgLatency)}ms`); }

  return {
    status:  scoreToStatus(score),
    score:   Math.max(0, score),
    metrics: {
      totalCallsLast24h: total,
      avgLatencyMs:      total > 0 ? Math.round(avgLatency) : null,
      slowCallCount:     slowCalls,
      openAlerts,
      anomaliesLast24h:  anomalies,
    },
    issues,
  };
}

// ── Queue Health ──────────────────────────────────────────────────────────────

async function getQueueHealth(): Promise<SubsystemHealth> {
  const issues: string[] = [];

  const r = await db.execute(sql.raw(`
    SELECT
      COUNT(*) FILTER (WHERE status='queued')              AS queued,
      COUNT(*) FILTER (WHERE status='running')             AS running,
      COUNT(*) FILTER (WHERE status='failed')              AS failed,
      COUNT(*) FILTER (WHERE status='running'
        AND COALESCE(heartbeat_at, started_at, created_at)
            < NOW() - INTERVAL '30 minutes')               AS stale,
      COUNT(*) FILTER (WHERE status='failed'
        AND attempt_count >= max_attempts)                 AS exhausted
    FROM knowledge_processing_jobs
  `));

  const row = (r.rows[0] as any) ?? {};
  const queued    = safeNum(row.queued);
  const running   = safeNum(row.running);
  const failed    = safeNum(row.failed);
  const stale     = safeNum(row.stale);
  const exhausted = safeNum(row.exhausted);

  let score = 100;
  if (stale     > 5)  { score -= 25; issues.push(`${stale} stale running jobs (no heartbeat >30min)`); }
  if (queued    > 100){ score -= 15; issues.push(`Queue backlog: ${queued} jobs waiting`); }
  if (exhausted > 10) { score -= 20; issues.push(`${exhausted} retry-exhausted jobs`); }
  if (failed    > 50) { score -= 10; issues.push(`${failed} failed jobs total`); }

  return {
    status:  scoreToStatus(score),
    score:   Math.max(0, score),
    metrics: { queued, running, failed, stale, exhausted },
    issues,
  };
}

// ── Webhook Health ────────────────────────────────────────────────────────────

async function getWebhookHealth(): Promise<SubsystemHealth> {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const issues: string[] = [];

  const r = await db.execute(sql.raw(`
    SELECT
      COUNT(*) FILTER (WHERE status='delivered' AND created_at>='${yesterday}') AS delivered_24h,
      COUNT(*) FILTER (WHERE status='failed'    AND created_at>='${yesterday}') AS failed_24h,
      COUNT(*) FILTER (WHERE status='retrying')                                 AS retrying_now,
      COUNT(*) FILTER (WHERE status='failed' AND attempts>=max_attempts)        AS exhausted
    FROM webhook_deliveries
  `));

  const row      = (r.rows[0] as any) ?? {};
  const d24h     = safeNum(row.delivered_24h);
  const f24h     = safeNum(row.failed_24h);
  const retrying = safeNum(row.retrying_now);
  const exhausted= safeNum(row.exhausted);
  const total24h = d24h + f24h;
  const successRate = total24h > 0 ? d24h / total24h : 1;

  let score = 100;
  if (successRate < 0.95) { score -= 20; issues.push(`Low webhook success rate: ${Math.round(successRate*100)}%`); }
  if (successRate < 0.80) { score -= 20; issues.push("Webhook delivery critically low"); }
  if (exhausted  > 5)     { score -= 15; issues.push(`${exhausted} permanently failed deliveries`); }
  if (retrying   > 20)    { score -= 10; issues.push(`${retrying} deliveries in retry loop`); }

  return {
    status:  scoreToStatus(score),
    score:   Math.max(0, score),
    metrics: {
      deliveredLast24h: d24h,
      failedLast24h:    f24h,
      successRateLast24h: Math.round(successRate * 100) / 100,
      retryingNow:      retrying,
      exhausted,
    },
    issues,
  };
}

// ── Security Health ───────────────────────────────────────────────────────────

async function getSecurityHealth(): Promise<SubsystemHealth> {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const issues: string[] = [];

  const r = await db.execute(sql.raw(`
    SELECT
      COUNT(*)                                            AS total_events,
      COUNT(*) FILTER (WHERE event_type ILIKE '%critical%') AS critical_events,
      COUNT(*) FILTER (WHERE event_type ILIKE '%high%')     AS high_events,
      (SELECT COUNT(*) FROM moderation_events WHERE created_at>='${yesterday}') AS mod_events,
      (SELECT COUNT(*) FROM legal_holds WHERE active=TRUE) AS active_holds
    FROM security_events
    WHERE created_at >= '${yesterday}'
  `));

  const row     = (r.rows[0] as any) ?? {};
  const critical= safeNum(row.critical_events);
  const high    = safeNum(row.high_events);
  const total   = safeNum(row.total_events);
  const mod     = safeNum(row.mod_events);
  const holds   = safeNum(row.active_holds);

  let score = 100;
  if (critical > 0)   { score -= 30; issues.push(`${critical} critical security events in 24h`); }
  if (high     > 5)   { score -= 15; issues.push(`${high} high-severity security events in 24h`); }
  if (mod      > 100) { score -= 15; issues.push(`${mod} moderation events in 24h — spike detected`); }
  if (holds    > 0)   { score -= 5;  issues.push(`${holds} active legal holds`); }

  return {
    status:  scoreToStatus(score),
    score:   Math.max(0, score),
    metrics: { totalEventsLast24h: total, criticalEvents: critical, highEvents: high, moderationEvents: mod, activeLegalHolds: holds },
    issues,
  };
}

// ── Billing Health ────────────────────────────────────────────────────────────

async function getBillingHealth(): Promise<SubsystemHealth> {
  const issues: string[] = [];

  const r = await db.execute(sql.raw(`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('active','trialing'))  AS active_subs,
      COUNT(*) FILTER (WHERE status = 'past_due')              AS past_due,
      COUNT(*) FILTER (WHERE status = 'cancelled')             AS cancelled,
      (SELECT COUNT(*) FROM tenant_ai_budgets WHERE monthly_budget_usd IS NOT NULL) AS budgets_configured
    FROM tenant_subscriptions
  `));

  const row      = (r.rows[0] as any) ?? {};
  const active   = safeNum(row.active_subs);
  const pastDue  = safeNum(row.past_due);
  const budgets  = safeNum(row.budgets_configured);

  let score = 100;
  if (pastDue > 0)              { score -= 20; issues.push(`${pastDue} past-due subscriptions`); }
  if (active > 0 && budgets === 0) { score -= 10; issues.push("No AI budgets configured"); }

  return {
    status:  scoreToStatus(score),
    score:   Math.max(0, score),
    metrics: { activeSubscriptions: active, pastDue, budgetsConfigured: budgets },
    issues,
  };
}

// ── Governance Health ─────────────────────────────────────────────────────────

async function getGovernanceHealth(): Promise<SubsystemHealth> {
  const issues: string[] = [];

  const r = await db.execute(sql.raw(`
    SELECT
      (SELECT COUNT(*) FROM data_retention_policies WHERE active=TRUE) AS ret_policies,
      (SELECT COUNT(*) FROM data_retention_rules WHERE active=TRUE)    AS ret_rules,
      (SELECT COUNT(*) FROM legal_holds WHERE active=TRUE)             AS active_holds,
      (SELECT COUNT(*) FROM data_deletion_jobs WHERE status='pending') AS pending_del_jobs,
      (SELECT COUNT(*) FROM data_deletion_jobs WHERE blocked_by_hold=TRUE AND status='pending') AS blocked_jobs
  `));

  const row      = (r.rows[0] as any) ?? {};
  const holds    = safeNum(row.active_holds);
  const blocked  = safeNum(row.blocked_jobs);
  const policies = safeNum(row.ret_policies);
  const pending  = safeNum(row.pending_del_jobs);

  let score = 100;
  if (holds   > 3)  { score -= 15; issues.push(`${holds} active legal holds`); }
  if (blocked > 5)  { score -= 10; issues.push(`${blocked} deletion jobs blocked by holds`); }
  if (policies < 5) { score -= 10; issues.push("Fewer than 5 retention policies active"); }
  if (pending > 20) { score -= 10; issues.push(`${pending} pending deletion jobs`); }

  return {
    status:  scoreToStatus(score),
    score:   Math.max(0, score),
    metrics: {
      retentionPolicies: policies,
      retentionRules:    safeNum(row.ret_rules),
      activeLegalHolds:  holds,
      pendingDeletionJobs: pending,
      blockedByHold:     blocked,
    },
    issues,
  };
}

// ── Full System Health ────────────────────────────────────────────────────────

export async function getSystemHealthReport(): Promise<SystemHealthReport> {
  const [ai, queue, webhooks, security, billing, governance] = await Promise.all([
    getAiHealth(),
    getQueueHealth(),
    getWebhookHealth(),
    getSecurityHealth(),
    getBillingHealth(),
    getGovernanceHealth(),
  ]);

  const scores      = [ai.score, queue.score, webhooks.score, security.score, billing.score, governance.score];
  const overallScore= Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  const overallStatus = scoreToStatus(overallScore);

  return {
    generatedAt:   new Date().toISOString(),
    overallStatus,
    overallScore,
    subsystems: { ai, queue, webhooks, security, billing, governance },
  };
}

// ── Named sub-getters for individual route use ────────────────────────────────

export { getAiHealth, getQueueHealth, getWebhookHealth, getSecurityHealth, getBillingHealth, getGovernanceHealth };
