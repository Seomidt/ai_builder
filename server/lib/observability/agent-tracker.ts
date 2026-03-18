/**
 * Phase 15 — Agent Runtime Tracker
 * Records per-run agent execution telemetry.
 * INV-OBS-1: Never throws — fire-and-forget safe.
 * INV-OBS-5: Tenant isolation enforced.
 */

import { db } from "../../db";
import { obsAgentRuntimeMetrics } from "@shared/schema";

export type AgentRunStatus = "success" | "failure" | "timeout" | "cancelled";

export interface AgentRunRecord {
  tenantId?: string | null;
  agentId?: string | null;
  runId?: string | null;
  steps?: number | null;
  iterations?: number | null;
  durationMs?: number | null;
  status?: AgentRunStatus | string | null;
}

/**
 * Record an agent run metric. Fire-and-forget: never throws.
 */
export async function recordAgentRunMetric(record: AgentRunRecord): Promise<void> {
  try {
    await db.insert(obsAgentRuntimeMetrics).values({
      tenantId: record.tenantId ?? null,
      agentId: record.agentId ?? null,
      runId: record.runId ?? null,
      steps: record.steps ?? null,
      iterations: record.iterations ?? null,
      durationMs: record.durationMs ?? null,
      status: record.status ?? null,
    });
  } catch {
    // INV-OBS-1: Silently swallow
  }
}

/**
 * Summarise agent runtime metrics for a time window.
 */
export async function summariseAgentMetrics(params: {
  tenantId?: string;
  windowHours?: number;
}): Promise<{
  totalRuns: number;
  successRuns: number;
  failureRuns: number;
  avgSteps: number;
  avgDurationMs: number;
  successRate: number;
  windowHours: number;
}> {
  const { tenantId, windowHours = 24 } = params;
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const { sql: drizzleSql } = await import("drizzle-orm");

  const tenantClause = tenantId
    ? drizzleSql` AND tenant_id = ${tenantId}`
    : drizzleSql``;

  const result = await db.execute<{
    total_runs: string;
    success_runs: string;
    failure_runs: string;
    avg_steps: string;
    avg_duration_ms: string;
  }>(drizzleSql`
    SELECT
      COUNT(*)::int AS total_runs,
      COUNT(*) FILTER (WHERE status = 'success')::int AS success_runs,
      COUNT(*) FILTER (WHERE status = 'failure')::int AS failure_runs,
      COALESCE(AVG(steps)::int, 0) AS avg_steps,
      COALESCE(AVG(duration_ms)::int, 0) AS avg_duration_ms
    FROM obs_agent_runtime_metrics
    WHERE created_at >= ${windowStart} ${tenantClause}
  `);
  const row = result.rows[0];

  const total = Number(row?.total_runs ?? 0);
  const success = Number(row?.success_runs ?? 0);

  return {
    totalRuns: total,
    successRuns: success,
    failureRuns: Number(row?.failure_runs ?? 0),
    avgSteps: Number(row?.avg_steps ?? 0),
    avgDurationMs: Number(row?.avg_duration_ms ?? 0),
    successRate: total > 0 ? (success / total) * 100 : 0,
    windowHours,
  };
}
