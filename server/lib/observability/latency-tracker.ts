/**
 * Phase 15 — AI Latency Tracker
 * Records per-LLM-call latency, token, and cost telemetry.
 * INV-OBS-1: Never throws — always fire-and-forget safe.
 * INV-OBS-6: Writes never block AI execution.
 */

import { db } from "../../db";
import { obsAiLatencyMetrics } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";

export interface AiLatencyRecord {
  tenantId?: string | null;
  model: string;
  provider: string;
  latencyMs: number;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costUsd?: number | null;
  requestId?: string | null;
}

/**
 * Record an AI latency metric. Fire-and-forget: never throws.
 * Callers must call this without await or with void to stay non-blocking.
 */
export async function recordAiLatencyMetric(record: AiLatencyRecord): Promise<void> {
  try {
    await db.insert(obsAiLatencyMetrics).values({
      tenantId: record.tenantId ?? null,
      model: record.model,
      provider: record.provider,
      latencyMs: record.latencyMs,
      tokensIn: record.tokensIn ?? null,
      tokensOut: record.tokensOut ?? null,
      costUsd: record.costUsd != null ? String(record.costUsd) : null,
      requestId: record.requestId ?? null,
    });
  } catch {
    // INV-OBS-1: Silently swallow — metrics must never break primary workflows
  }
}

/**
 * Summarise AI latency metrics for a time window.
 * INV-OBS-2: No raw tenant data exposed — aggregate only.
 */
export async function summariseAiLatency(params: {
  tenantId?: string;
  provider?: string;
  model?: string;
  windowHours?: number;
}): Promise<{
  totalRequests: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCostUsd: number;
  windowHours: number;
}> {
  const { tenantId, provider, model, windowHours = 24 } = params;
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const tenantCond = tenantId ? drizzleSql` AND tenant_id = ${tenantId}` : drizzleSql``;
  const providerCond = provider ? drizzleSql` AND provider = ${provider}` : drizzleSql``;
  const modelCond = model ? drizzleSql` AND model = ${model}` : drizzleSql``;

  const result = await db.execute<{
    total_requests: string;
    avg_latency_ms: string;
    p95_latency_ms: string;
    total_tokens_in: string;
    total_tokens_out: string;
    total_cost_usd: string;
  }>(drizzleSql`
    SELECT
      COUNT(*)::int AS total_requests,
      COALESCE(AVG(latency_ms)::int, 0) AS avg_latency_ms,
      COALESCE(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms)::int, 0) AS p95_latency_ms,
      COALESCE(SUM(tokens_in), 0)::int AS total_tokens_in,
      COALESCE(SUM(tokens_out), 0)::int AS total_tokens_out,
      COALESCE(SUM(cost_usd::numeric), 0)::float AS total_cost_usd
    FROM obs_ai_latency_metrics
    WHERE created_at >= ${windowStart}
    ${tenantCond}
    ${providerCond}
    ${modelCond}
  `);
  const row = result.rows[0];

  return {
    totalRequests: Number(row?.total_requests ?? 0),
    avgLatencyMs: Number(row?.avg_latency_ms ?? 0),
    p95LatencyMs: Number(row?.p95_latency_ms ?? 0),
    totalTokensIn: Number(row?.total_tokens_in ?? 0),
    totalTokensOut: Number(row?.total_tokens_out ?? 0),
    totalCostUsd: Number(row?.total_cost_usd ?? 0),
    windowHours,
  };
}
