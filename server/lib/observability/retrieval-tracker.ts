/**
 * Phase 15 — Retrieval Tracker
 * Records per-retrieval-call observability signals.
 * INV-OBS-1: Never throws — fire-and-forget safe.
 * INV-OBS-5: Tenant isolation enforced — no cross-tenant data.
 */

import { db } from "../../db";
import { obsRetrievalMetrics } from "@shared/schema";

export interface RetrievalRecord {
  tenantId?: string | null;
  queryLength?: number | null;
  chunksRetrieved?: number | null;
  rerankUsed?: boolean;
  latencyMs?: number | null;
  resultCount?: number | null;
}

/**
 * Record a retrieval metric. Fire-and-forget: never throws.
 */
export async function recordRetrievalMetric(record: RetrievalRecord): Promise<void> {
  try {
    await db.insert(obsRetrievalMetrics).values({
      tenantId: record.tenantId ?? null,
      queryLength: record.queryLength ?? null,
      chunksRetrieved: record.chunksRetrieved ?? null,
      rerankUsed: record.rerankUsed ?? false,
      latencyMs: record.latencyMs ?? null,
      resultCount: record.resultCount ?? null,
    });
  } catch {
    // INV-OBS-1: Silently swallow
  }
}

/**
 * Summarise retrieval metrics for a time window.
 */
export async function summariseRetrievalMetrics(params: {
  tenantId?: string;
  windowHours?: number;
}): Promise<{
  totalQueries: number;
  avgChunksRetrieved: number;
  avgLatencyMs: number;
  rerankUsageRate: number;
  windowHours: number;
}> {
  const { tenantId, windowHours = 24 } = params;
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000);
  const { sql: drizzleSql } = await import("drizzle-orm");

  const tenantClause = tenantId
    ? drizzleSql` AND tenant_id = ${tenantId}`
    : drizzleSql``;

  const result = await db.execute<{
    total_queries: string;
    avg_chunks: string;
    avg_latency_ms: string;
    rerank_rate: string;
  }>(drizzleSql`
    SELECT
      COUNT(*)::int AS total_queries,
      COALESCE(AVG(chunks_retrieved)::int, 0) AS avg_chunks,
      COALESCE(AVG(latency_ms)::int, 0) AS avg_latency_ms,
      COALESCE(
        (COUNT(*) FILTER (WHERE rerank_used = true) * 100.0 / NULLIF(COUNT(*), 0))::float,
        0
      ) AS rerank_rate
    FROM obs_retrieval_metrics
    WHERE created_at >= ${windowStart} ${tenantClause}
  `);
  const row = result.rows[0];

  return {
    totalQueries: Number(row?.total_queries ?? 0),
    avgChunksRetrieved: Number(row?.avg_chunks ?? 0),
    avgLatencyMs: Number(row?.avg_latency_ms ?? 0),
    rerankUsageRate: Number(row?.rerank_rate ?? 0),
    windowHours,
  };
}
