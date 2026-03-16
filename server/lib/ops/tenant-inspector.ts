/**
 * Phase 27 — Tenant Inspector
 * Returns comprehensive operational profile for a tenant.
 *
 * Data sources: subscriptions, budgets, rate limits, jobs,
 *               webhooks, security flags, retention holds.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface TenantSecurityFlags {
  hasActiveHold: boolean;
  openSecurityEvents: number;
  recentModerationSpikes: number;
  recentAnomalyEvents: number;
  rateLimitHits: number;
}

export interface TenantBillingSnapshot {
  subscriptionStatus: string | null;
  planCode: string | null;
  planName: string | null;
  monthlyBudgetUsd: number | null;
  currentMonthSpendUsd: number;
  aiAlertsCount: number;
}

export interface TenantOpsProfile {
  tenantId: string;
  inspectedAt: string;
  subscription: TenantBillingSnapshot;
  aiUsage: {
    currentMonthRequests: number;
    currentMonthTokensIn: number;
    currentMonthTokensOut: number;
    currentMonthCostUsd: number;
    avgLatencyMs: number | null;
  };
  jobs: {
    active: number;
    failed: number;
    completed: number;
    totalLast24h: number;
  };
  webhooks: {
    endpointCount: number;
    activeEndpoints: number;
    deliveriesLast24h: number;
    failedDeliveriesLast24h: number;
  };
  security: TenantSecurityFlags;
  governance: {
    activeLegalHolds: number;
    pendingDeletionJobs: number;
    retentionPoliciesActive: number;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeNum(val: unknown): number {
  const n = Number(val);
  return isNaN(n) ? 0 : n;
}

// ── Core inspector ────────────────────────────────────────────────────────────

export async function inspectTenant(tenantId: string): Promise<TenantOpsProfile> {
  const now = new Date();
  const monthStart = new Date(now.getUTCFullYear(), now.getUTCMonth(), 1).toISOString();
  const yesterday = new Date(now.getTime() - 86_400_000).toISOString();

  const [
    subRow,
    aiRow,
    jobRow,
    wh24Row,
    secRow,
    govRow,
    budgetRow,
    alertRow,
  ] = await Promise.all([
    // Subscription + plan
    db.execute(sql.raw(`
      SELECT ts.status, sp.plan_code, sp.plan_name
      FROM tenant_subscriptions ts
      LEFT JOIN subscription_plans sp ON sp.id = ts.subscription_plan_id
      WHERE ts.tenant_id = '${tenantId}'
        AND ts.status IN ('active','trialing')
      ORDER BY ts.created_at DESC LIMIT 1
    `)),
    // AI usage this month
    db.execute(sql.raw(`
      SELECT
        COUNT(*)                               AS requests,
        COALESCE(SUM(tokens_in),0)             AS tokens_in,
        COALESCE(SUM(tokens_out),0)            AS tokens_out,
        COALESCE(SUM(cost_usd::numeric),0)     AS cost_usd,
        AVG(latency_ms)                        AS avg_latency_ms
      FROM obs_ai_latency_metrics
      WHERE tenant_id = '${tenantId}'
        AND created_at >= '${monthStart}'
    `)),
    // Job stats
    db.execute(sql.raw(`
      SELECT
        COUNT(*) FILTER (WHERE status IN ('queued','running'))  AS active,
        COUNT(*) FILTER (WHERE status = 'failed')               AS failed,
        COUNT(*) FILTER (WHERE status = 'completed')            AS completed,
        COUNT(*) FILTER (WHERE created_at >= '${yesterday}')    AS last_24h
      FROM knowledge_processing_jobs
      WHERE tenant_id = '${tenantId}'
    `)),
    // Webhook stats
    db.execute(sql.raw(`
      SELECT
        COUNT(*) FILTER (WHERE e.active)                                         AS active_endpoints,
        COUNT(*)                                                                 AS total_endpoints,
        COUNT(d.id) FILTER (WHERE d.created_at >= '${yesterday}')               AS deliveries_24h,
        COUNT(d.id) FILTER (WHERE d.created_at >= '${yesterday}' AND d.status = 'failed') AS failed_24h
      FROM webhook_endpoints e
      LEFT JOIN webhook_deliveries d ON d.endpoint_id = e.id
      WHERE e.tenant_id = '${tenantId}'
    `)),
    // Security flags
    db.execute(sql.raw(`
      SELECT
        (SELECT COUNT(*) FROM legal_holds      WHERE tenant_id='${tenantId}' AND active=TRUE)            AS active_holds,
        (SELECT COUNT(*) FROM security_events  WHERE tenant_id='${tenantId}' AND created_at>='${yesterday}') AS sec_events,
        (SELECT COUNT(*) FROM moderation_events WHERE tenant_id='${tenantId}' AND created_at>='${yesterday}') AS mod_events,
        (SELECT COUNT(*) FROM ai_anomaly_events WHERE tenant_id='${tenantId}' AND created_at>='${yesterday}') AS anomaly_events
    `)),
    // Governance
    db.execute(sql.raw(`
      SELECT
        (SELECT COUNT(*) FROM legal_holds WHERE tenant_id='${tenantId}' AND active=TRUE)               AS holds,
        (SELECT COUNT(*) FROM data_deletion_jobs WHERE tenant_id='${tenantId}' AND status='pending')   AS del_jobs,
        (SELECT COUNT(*) FROM data_retention_policies WHERE active=TRUE)                               AS ret_policies
    `)),
    // Budget
    db.execute(sql.raw(`
      SELECT monthly_budget_usd FROM tenant_ai_budgets WHERE tenant_id='${tenantId}' LIMIT 1
    `)),
    // AI usage alerts
    db.execute(sql.raw(`
      SELECT COUNT(*) AS cnt FROM ai_usage_alerts WHERE tenant_id='${tenantId}'
    `)),
  ]);

  const sub  = (subRow.rows[0]  as any) ?? {};
  const ai   = (aiRow.rows[0]   as any) ?? {};
  const jobs = (jobRow.rows[0]  as any) ?? {};
  const wh   = (wh24Row.rows[0] as any) ?? {};
  const sec  = (secRow.rows[0]  as any) ?? {};
  const gov  = (govRow.rows[0]  as any) ?? {};
  const bud  = (budgetRow.rows[0] as any) ?? {};
  const alert = (alertRow.rows[0] as any) ?? {};

  return {
    tenantId,
    inspectedAt: now.toISOString(),
    subscription: {
      subscriptionStatus: sub.status ?? null,
      planCode:   sub.plan_code  ?? null,
      planName:   sub.plan_name  ?? null,
      monthlyBudgetUsd:        bud.monthly_budget_usd ? Number(bud.monthly_budget_usd) : null,
      currentMonthSpendUsd:    safeNum(ai.cost_usd),
      aiAlertsCount:           safeNum(alert.cnt),
    },
    aiUsage: {
      currentMonthRequests:  safeNum(ai.requests),
      currentMonthTokensIn:  safeNum(ai.tokens_in),
      currentMonthTokensOut: safeNum(ai.tokens_out),
      currentMonthCostUsd:   safeNum(ai.cost_usd),
      avgLatencyMs:          ai.avg_latency_ms != null ? safeNum(ai.avg_latency_ms) : null,
    },
    jobs: {
      active:      safeNum(jobs.active),
      failed:      safeNum(jobs.failed),
      completed:   safeNum(jobs.completed),
      totalLast24h: safeNum(jobs.last_24h),
    },
    webhooks: {
      endpointCount:          safeNum(wh.total_endpoints),
      activeEndpoints:        safeNum(wh.active_endpoints),
      deliveriesLast24h:      safeNum(wh.deliveries_24h),
      failedDeliveriesLast24h: safeNum(wh.failed_24h),
    },
    security: {
      hasActiveHold:           safeNum(sec.active_holds) > 0,
      openSecurityEvents:      safeNum(sec.sec_events),
      recentModerationSpikes:  safeNum(sec.mod_events),
      recentAnomalyEvents:     safeNum(sec.anomaly_events),
      rateLimitHits:           0, // enriched via security inspector
    },
    governance: {
      activeLegalHolds:       safeNum(gov.holds),
      pendingDeletionJobs:    safeNum(gov.del_jobs),
      retentionPoliciesActive: safeNum(gov.ret_policies),
    },
  };
}

// ── Tenant list overview ──────────────────────────────────────────────────────

export interface TenantListEntry {
  tenantId: string;
  subscriptionStatus: string | null;
  planCode: string | null;
  activeJobs: number;
  failedJobsLast24h: number;
  activeHolds: number;
  aiAlertsOpen: number;
}

export async function listTenantOverviews(limit = 50): Promise<TenantListEntry[]> {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();

  const res = await db.execute(sql.raw(`
    SELECT
      ts.tenant_id,
      ts.status                                                                   AS sub_status,
      sp.plan_code,
      COUNT(DISTINCT kpj.id) FILTER (WHERE kpj.status IN ('queued','running'))   AS active_jobs,
      COUNT(DISTINCT kpj.id) FILTER (WHERE kpj.status='failed' AND kpj.created_at>='${yesterday}') AS failed_jobs,
      COUNT(DISTINCT lh.id)  FILTER (WHERE lh.active=TRUE)                        AS active_holds,
      COUNT(DISTINCT aua.id)                                                     AS open_alerts
    FROM tenant_subscriptions ts
    LEFT JOIN subscription_plans sp ON sp.id = ts.subscription_plan_id
    LEFT JOIN knowledge_processing_jobs kpj ON kpj.tenant_id = ts.tenant_id
    LEFT JOIN legal_holds lh ON lh.tenant_id = ts.tenant_id
    LEFT JOIN ai_usage_alerts aua ON aua.tenant_id = ts.tenant_id
    WHERE ts.status IN ('active','trialing')
    GROUP BY ts.tenant_id, ts.status, sp.plan_code
    ORDER BY active_holds DESC, failed_jobs DESC
    LIMIT ${limit}
  `));

  return (res.rows as any[]).map(r => ({
    tenantId:            r.tenant_id,
    subscriptionStatus:  r.sub_status ?? null,
    planCode:            r.plan_code  ?? null,
    activeJobs:          safeNum(r.active_jobs),
    failedJobsLast24h:   safeNum(r.failed_jobs),
    activeHolds:         safeNum(r.active_holds),
    aiAlertsOpen:        safeNum(r.open_alerts),
  }));
}

// ── Tenant search ─────────────────────────────────────────────────────────────

export async function searchTenants(query: string, limit = 20): Promise<string[]> {
  const escaped = query.replace(/'/g, "''");
  const res = await db.execute(sql.raw(`
    SELECT DISTINCT tenant_id FROM tenant_subscriptions
    WHERE tenant_id ILIKE '%${escaped}%'
    ORDER BY tenant_id LIMIT ${limit}
  `));
  return (res.rows as any[]).map(r => r.tenant_id);
}
