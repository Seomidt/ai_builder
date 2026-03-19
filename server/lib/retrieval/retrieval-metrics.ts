/**
 * Phase 11 — Retrieval Metrics Service
 * INV-RET10: Metrics must be recorded for every retrieval query.
 * INV-RET11: Metrics must be tenant-scoped and immutable after creation.
 * Security: safe limits, structured logging.
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

export interface RetrievalMetricsRecord {
  id: string;
  tenantId: string;
  queryId: string;
  latencyMs: number;
  vectorHits: number;
  lexicalHits: number;
  totalResults: number;
  createdAt: Date;
}

function rowToMetrics(r: Record<string, unknown>): RetrievalMetricsRecord {
  return {
    id: r["id"] as string,
    tenantId: r["tenant_id"] as string,
    queryId: r["query_id"] as string,
    latencyMs: r["latency_ms"] as number,
    vectorHits: r["vector_hits"] as number,
    lexicalHits: r["lexical_hits"] as number,
    totalResults: r["total_results"] as number,
    createdAt: new Date(r["created_at"] as string),
  };
}

// ─── recordMetrics ────────────────────────────────────────────────────────────
// INV-RET10: Called after every retrieval run.
// INV-RET11: Upsert-on-queryId for idempotency.

export async function recordMetrics(params: {
  tenantId: string;
  queryId: string;
  latencyMs: number;
  vectorHits: number;
  lexicalHits: number;
  totalResults: number;
  client?: pg.Client;
}): Promise<RetrievalMetricsRecord> {
  const { tenantId, queryId, latencyMs, vectorHits, lexicalHits, totalResults } = params;
  const useExternal = !params.client;
  const client = params.client ?? getClient();
  if (useExternal) await client.connect();

  try {
    const row = await client.query(
      `INSERT INTO public.retrieval_query_metrics (id, tenant_id, query_id, latency_ms, vector_hits, lexical_hits, total_results)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6)
       ON CONFLICT (query_id) DO UPDATE SET
         latency_ms = EXCLUDED.latency_ms,
         vector_hits = EXCLUDED.vector_hits,
         lexical_hits = EXCLUDED.lexical_hits,
         total_results = EXCLUDED.total_results
       RETURNING *`,
      [tenantId, queryId, Math.max(0, latencyMs), vectorHits, lexicalHits, totalResults],
    );
    return rowToMetrics(row.rows[0]);
  } finally {
    if (useExternal) await client.end();
  }
}

// ─── getMetricsByQueryId ──────────────────────────────────────────────────────

export async function getMetricsByQueryId(queryId: string, tenantId: string): Promise<RetrievalMetricsRecord | null> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(`SELECT * FROM public.retrieval_query_metrics WHERE query_id = $1 AND tenant_id = $2`, [queryId, tenantId]);
    return row.rows.length ? rowToMetrics(row.rows[0]) : null;
  } finally {
    await client.end();
  }
}

// ─── slowQueries ──────────────────────────────────────────────────────────────
// Returns queries above latency threshold.

export async function slowQueries(params: { tenantId: string; thresholdMs?: number; limit?: number }): Promise<RetrievalMetricsRecord[]> {
  const { tenantId, thresholdMs = 500, limit = 20 } = params;
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT m.* FROM public.retrieval_query_metrics m
       WHERE m.tenant_id = $1 AND m.latency_ms >= $2
       ORDER BY m.latency_ms DESC LIMIT $3`,
      [tenantId, thresholdMs, Math.min(limit, 100)],
    );
    return row.rows.map(rowToMetrics);
  } finally {
    await client.end();
  }
}

// ─── retrievalHealth ──────────────────────────────────────────────────────────
// Aggregate health summary for a tenant.

export async function retrievalHealth(tenantId: string): Promise<{
  totalQueries: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  avgVectorHits: number;
  avgLexicalHits: number;
  avgTotalResults: number;
  slowQueryCount: number;
}> {
  const client = getClient();
  await client.connect();
  try {
    const [agg, p95] = await Promise.all([
      client.query(
        `SELECT
           COUNT(*) as total,
           ROUND(AVG(latency_ms)) as avg_latency,
           ROUND(AVG(vector_hits)) as avg_vector_hits,
           ROUND(AVG(lexical_hits)) as avg_lexical_hits,
           ROUND(AVG(total_results)) as avg_total_results,
           COUNT(CASE WHEN latency_ms >= 500 THEN 1 END) as slow_count
         FROM public.retrieval_query_metrics WHERE tenant_id = $1`,
        [tenantId],
      ),
      client.query(
        `SELECT PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY latency_ms) as p95
         FROM public.retrieval_query_metrics WHERE tenant_id = $1`,
        [tenantId],
      ),
    ]);

    const r = agg.rows[0];
    return {
      totalQueries: parseInt(r.total, 10),
      avgLatencyMs: parseFloat(r.avg_latency ?? "0"),
      p95LatencyMs: parseFloat(p95.rows[0].p95 ?? "0"),
      avgVectorHits: parseFloat(r.avg_vector_hits ?? "0"),
      avgLexicalHits: parseFloat(r.avg_lexical_hits ?? "0"),
      avgTotalResults: parseFloat(r.avg_total_results ?? "0"),
      slowQueryCount: parseInt(r.slow_count, 10),
    };
  } finally {
    await client.end();
  }
}

// ─── storeFeedback ────────────────────────────────────────────────────────────

export async function storeFeedback(params: {
  tenantId: string;
  queryId: string;
  chunkId: string;
  feedbackType: "relevant" | "irrelevant" | "partial" | "thumbs_up" | "thumbs_down";
}): Promise<{ id: string; queryId: string; chunkId: string; feedbackType: string; createdAt: Date }> {
  const { tenantId, queryId, chunkId, feedbackType } = params;
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `INSERT INTO public.retrieval_feedback (id, query_id, chunk_id, feedback_type, tenant_id)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4) RETURNING *`,
      [queryId, chunkId, feedbackType, tenantId],
    );
    return { id: row.rows[0].id, queryId, chunkId, feedbackType, createdAt: new Date(row.rows[0].created_at) };
  } finally {
    await client.end();
  }
}
