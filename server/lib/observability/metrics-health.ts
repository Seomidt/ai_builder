/**
 * Phase 15 — Metrics Health & System Health Service
 * Provides aggregated health status across all observability signals.
 * INV-OBS-2: Aggregate-only — no raw tenant data exposed.
 */

import { db } from "../../db";
import { summariseAiLatency } from "./latency-tracker";
import { summariseRetrievalMetrics } from "./retrieval-tracker";
import { summariseAgentMetrics } from "./agent-tracker";
import { listActiveTenantsForPeriod, getCurrentPeriod } from "./tenant-usage-tracker";

// ── System metrics ────────────────────────────────────────────────────────────

export async function getSystemMetricsSummary(windowHours = 24): Promise<{
  totalSystemMetrics: number;
  metricTypes: string[];
  windowHours: number;
  sampleTime: string;
}> {
  const { sql } = await import("drizzle-orm");
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const qr = await db.execute<{ metric_type: string; n: string }>(sql`
    SELECT metric_type, COUNT(*)::int AS n
    FROM obs_system_metrics
    WHERE created_at >= ${windowStart}
    GROUP BY metric_type
    ORDER BY n DESC
  `);

  const total = qr.rows.reduce((s, r) => s + Number(r.n ?? 0), 0);

  return {
    totalSystemMetrics: total,
    metricTypes: qr.rows.map((r) => r.metric_type),
    windowHours,
    sampleTime: new Date().toISOString(),
  };
}

// ── AI health ─────────────────────────────────────────────────────────────────

export async function getAiHealthSummary(windowHours = 24) {
  return summariseAiLatency({ windowHours });
}

// ── Retrieval health ──────────────────────────────────────────────────────────

export async function getRetrievalHealthSummary(windowHours = 24) {
  return summariseRetrievalMetrics({ windowHours });
}

// ── Agent health ──────────────────────────────────────────────────────────────

export async function getAgentHealthSummary(windowHours = 24) {
  return summariseAgentMetrics({ windowHours });
}

// ── Tenant health ─────────────────────────────────────────────────────────────

export async function getTenantHealthSummary() {
  const period = getCurrentPeriod();
  return listActiveTenantsForPeriod(period);
}

// ── Full platform health dashboard ───────────────────────────────────────────

export interface PlatformHealthStatus {
  status: "healthy" | "degraded" | "critical";
  windowHours: number;
  ai: {
    totalRequests: number;
    avgLatencyMs: number;
    p95LatencyMs: number;
    totalCostUsd: number;
  };
  retrieval: {
    totalQueries: number;
    avgLatencyMs: number;
    rerankUsageRate: number;
  };
  agents: {
    totalRuns: number;
    successRate: number;
    avgDurationMs: number;
  };
  tenants: {
    activeTenants: number;
    period: string;
  };
  system: {
    totalMetrics: number;
  };
  generatedAt: string;
}

export async function getPlatformHealthStatus(windowHours = 24): Promise<PlatformHealthStatus> {
  const [ai, retrieval, agents, tenants, system] = await Promise.allSettled([
    summariseAiLatency({ windowHours }),
    summariseRetrievalMetrics({ windowHours }),
    summariseAgentMetrics({ windowHours }),
    listActiveTenantsForPeriod(getCurrentPeriod()),
    getSystemMetricsSummary(windowHours),
  ]);

  const aiData = ai.status === "fulfilled" ? ai.value : { totalRequests: 0, avgLatencyMs: 0, p95LatencyMs: 0, totalCostUsd: 0 };
  const retData = retrieval.status === "fulfilled" ? retrieval.value : { totalQueries: 0, avgLatencyMs: 0, rerankUsageRate: 0 };
  const agData = agents.status === "fulfilled" ? agents.value : { totalRuns: 0, successRate: 0, avgDurationMs: 0 };
  const tenData = tenants.status === "fulfilled" ? tenants.value : { count: 0, period: getCurrentPeriod() };
  const sysData = system.status === "fulfilled" ? system.value : { totalSystemMetrics: 0 };

  // Determine platform health
  let status: "healthy" | "degraded" | "critical" = "healthy";
  if (aiData.avgLatencyMs > 10000) status = "degraded";
  if (aiData.avgLatencyMs > 30000 || (agData.totalRuns > 0 && agData.successRate < 50)) status = "critical";

  return {
    status,
    windowHours,
    ai: {
      totalRequests: aiData.totalRequests,
      avgLatencyMs: aiData.avgLatencyMs,
      p95LatencyMs: aiData.p95LatencyMs,
      totalCostUsd: aiData.totalCostUsd,
    },
    retrieval: {
      totalQueries: retData.totalQueries,
      avgLatencyMs: retData.avgLatencyMs,
      rerankUsageRate: retData.rerankUsageRate,
    },
    agents: {
      totalRuns: agData.totalRuns,
      successRate: agData.successRate,
      avgDurationMs: agData.avgDurationMs,
    },
    tenants: {
      activeTenants: tenData.count,
      period: tenData.period,
    },
    system: {
      totalMetrics: sysData.totalSystemMetrics,
    },
    generatedAt: new Date().toISOString(),
  };
}

// ── Anomaly signals ───────────────────────────────────────────────────────────

export interface AnomalySignal {
  signal: string;
  severity: "low" | "medium" | "high";
  value: number;
  threshold: number;
  description: string;
}

export async function detectObservabilityAnomalies(windowHours = 1): Promise<{
  anomalies: AnomalySignal[];
  checkedAt: string;
}> {
  const ai = await summariseAiLatency({ windowHours }).catch(() => null);
  const agents = await summariseAgentMetrics({ windowHours }).catch(() => null);

  const anomalies: AnomalySignal[] = [];

  if (ai && ai.avgLatencyMs > 5000) {
    anomalies.push({
      signal: "ai_high_latency",
      severity: ai.avgLatencyMs > 15000 ? "high" : "medium",
      value: ai.avgLatencyMs,
      threshold: 5000,
      description: `Average AI latency ${ai.avgLatencyMs}ms exceeds threshold 5000ms`,
    });
  }

  if (agents && agents.totalRuns > 5 && agents.successRate < 80) {
    anomalies.push({
      signal: "agent_low_success_rate",
      severity: agents.successRate < 50 ? "high" : "medium",
      value: agents.successRate,
      threshold: 80,
      description: `Agent success rate ${agents.successRate.toFixed(1)}% below threshold 80%`,
    });
  }

  return { anomalies, checkedAt: new Date().toISOString() };
}
