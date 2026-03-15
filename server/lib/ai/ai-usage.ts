/**
 * Phase 12 — AI Usage Tracking
 * Records token usage, cost estimation, latency per request.
 * INV-AI6: Every AI request must have usage recorded.
 * INV-AI8: Cost estimation must be non-negative.
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
}

export interface UsageRecord {
  id: string;
  tenantId: string;
  requestId: string;
  modelId: string;
  tokenPrompt: number;
  tokenCompletion: number;
  estimatedCost: number;
  createdAt: Date;
}

function rowToUsage(r: Record<string, unknown>): UsageRecord {
  return {
    id: r["id"] as string,
    tenantId: r["tenant_id"] as string,
    requestId: r["request_id"] as string,
    modelId: r["model_id"] as string,
    tokenPrompt: r["token_prompt"] as number,
    tokenCompletion: r["token_completion"] as number,
    estimatedCost: parseFloat((r["estimated_cost"] as string) ?? "0"),
    createdAt: new Date(r["created_at"] as string),
  };
}

// ─── estimateCost ────────────────────────────────────────────────────────────
// INV-AI8: Returns non-negative cost.
export function estimateCost(params: { tokenPrompt: number; tokenCompletion: number; costPromptPer1k: number; costCompletionPer1k: number }): number {
  const { tokenPrompt, tokenCompletion, costPromptPer1k, costCompletionPer1k } = params;
  const cost = (Math.max(0, tokenPrompt) / 1000) * costPromptPer1k + (Math.max(0, tokenCompletion) / 1000) * costCompletionPer1k;
  return Math.max(0, parseFloat(cost.toFixed(8)));
}

// ─── recordUsage ─────────────────────────────────────────────────────────────
// INV-AI6: Called after every AI request.
export async function recordUsage(params: {
  tenantId: string;
  requestId: string;
  modelId: string;
  tokenPrompt: number;
  tokenCompletion: number;
  costPromptPer1k?: number;
  costCompletionPer1k?: number;
  client?: pg.Client;
}): Promise<UsageRecord> {
  const { tenantId, requestId, modelId, tokenPrompt, tokenCompletion, costPromptPer1k = 0, costCompletionPer1k = 0 } = params;
  const estimatedCost = estimateCost({ tokenPrompt, tokenCompletion, costPromptPer1k, costCompletionPer1k });

  const useExt = !params.client;
  const client = params.client ?? getClient();
  if (useExt) await client.connect();

  try {
    const r = await client.query(
      `INSERT INTO public.ai_usage_metrics (id,tenant_id,request_id,model_id,token_prompt,token_completion,estimated_cost)
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5,$6)
       ON CONFLICT (request_id) DO UPDATE SET
         token_prompt=EXCLUDED.token_prompt, token_completion=EXCLUDED.token_completion,
         estimated_cost=EXCLUDED.estimated_cost
       RETURNING *`,
      [tenantId, requestId, modelId, Math.max(0, tokenPrompt), Math.max(0, tokenCompletion), estimatedCost],
    );
    return rowToUsage(r.rows[0]);
  } finally {
    if (useExt) await client.end();
  }
}

// ─── storeResponse ───────────────────────────────────────────────────────────
export async function storeResponse(params: {
  requestId: string;
  responseText: string;
  tokenPrompt: number;
  tokenCompletion: number;
  latencyMs: number;
  client?: pg.Client;
}): Promise<{ id: string; requestId: string; latencyMs: number }> {
  const { requestId, responseText, tokenPrompt, tokenCompletion, latencyMs } = params;
  const useExt = !params.client;
  const client = params.client ?? getClient();
  if (useExt) await client.connect();

  try {
    const r = await client.query(
      `INSERT INTO public.ai_responses (id,request_id,response_text,token_prompt,token_completion,latency_ms)
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5)
       ON CONFLICT (request_id) DO UPDATE SET
         response_text=EXCLUDED.response_text, token_prompt=EXCLUDED.token_prompt,
         token_completion=EXCLUDED.token_completion, latency_ms=EXCLUDED.latency_ms
       RETURNING id, request_id, latency_ms`,
      [requestId, responseText, Math.max(0, tokenPrompt), Math.max(0, tokenCompletion), Math.max(0, latencyMs)],
    );
    return { id: r.rows[0].id, requestId, latencyMs };
  } finally {
    if (useExt) await client.end();
  }
}

// ─── getUsageByRequest ───────────────────────────────────────────────────────
export async function getUsageByRequest(requestId: string, tenantId: string): Promise<UsageRecord | null> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(`SELECT * FROM public.ai_usage_metrics WHERE request_id=$1 AND tenant_id=$2`, [requestId, tenantId]);
    return r.rows.length ? rowToUsage(r.rows[0]) : null;
  } finally {
    await client.end();
  }
}

// ─── tenantUsageSummary ──────────────────────────────────────────────────────
export async function tenantUsageSummary(tenantId: string): Promise<{
  totalRequests: number;
  totalTokenPrompt: number;
  totalTokenCompletion: number;
  totalEstimatedCost: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  byModel: Array<{ modelId: string; requests: number; tokens: number; cost: number }>;
}> {
  const client = getClient();
  await client.connect();
  try {
    const [agg, byModel, latency] = await Promise.all([
      client.query(
        `SELECT COUNT(*) as total, SUM(token_prompt) as tp, SUM(token_completion) as tc, SUM(estimated_cost) as cost
         FROM public.ai_usage_metrics WHERE tenant_id=$1`,
        [tenantId],
      ),
      client.query(
        `SELECT model_id, COUNT(*) as cnt, SUM(token_prompt+token_completion) as tokens, SUM(estimated_cost) as cost
         FROM public.ai_usage_metrics WHERE tenant_id=$1 GROUP BY model_id ORDER BY cnt DESC`,
        [tenantId],
      ),
      client.query(
        `SELECT ROUND(AVG(r.latency_ms)) as avg_ms,
                PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY r.latency_ms) as p95_ms
         FROM public.ai_responses r
         JOIN public.ai_requests req ON req.id = r.request_id
         WHERE req.tenant_id=$1`,
        [tenantId],
      ),
    ]);

    const a = agg.rows[0];
    return {
      totalRequests: parseInt(a.total, 10),
      totalTokenPrompt: parseInt(a.tp ?? "0", 10),
      totalTokenCompletion: parseInt(a.tc ?? "0", 10),
      totalEstimatedCost: parseFloat(a.cost ?? "0"),
      avgLatencyMs: parseFloat(latency.rows[0]?.avg_ms ?? "0"),
      p95LatencyMs: parseFloat(latency.rows[0]?.p95_ms ?? "0"),
      byModel: byModel.rows.map((r) => ({ modelId: r.model_id, requests: parseInt(r.cnt, 10), tokens: parseInt(r.tokens ?? "0", 10), cost: parseFloat(r.cost ?? "0") })),
    };
  } finally {
    await client.end();
  }
}

// ─── aiHealth ────────────────────────────────────────────────────────────────
export async function aiHealth(tenantId: string): Promise<{
  totalRequests: number;
  totalResponses: number;
  avgLatencyMs: number;
  totalCostUsd: number;
  slowRequestCount: number;
  note: string;
}> {
  const client = getClient();
  await client.connect();
  try {
    const [reqs, resp] = await Promise.all([
      client.query(`SELECT COUNT(*) as cnt FROM public.ai_requests WHERE tenant_id=$1`, [tenantId]),
      client.query(
        `SELECT COUNT(*) as cnt, ROUND(AVG(r.latency_ms)) as avg_ms,
                COUNT(CASE WHEN r.latency_ms>2000 THEN 1 END) as slow
         FROM public.ai_responses r
         JOIN public.ai_requests req ON req.id=r.request_id WHERE req.tenant_id=$1`,
        [tenantId],
      ),
    ]);
    const cost = await client.query(`SELECT SUM(estimated_cost) as c FROM public.ai_usage_metrics WHERE tenant_id=$1`, [tenantId]);

    return {
      totalRequests: parseInt(reqs.rows[0].cnt, 10),
      totalResponses: parseInt(resp.rows[0].cnt, 10),
      avgLatencyMs: parseFloat(resp.rows[0].avg_ms ?? "0"),
      totalCostUsd: parseFloat(cost.rows[0].c ?? "0"),
      slowRequestCount: parseInt(resp.rows[0].slow, 10),
      note: "Phase 12 AI health summary — all metrics tenant-scoped.",
    };
  } finally {
    await client.end();
  }
}
