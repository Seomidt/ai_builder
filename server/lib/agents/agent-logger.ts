/**
 * Phase 14 — Agent Logger
 * Persists step-level input/output payloads to ai_agent_run_logs.
 * Every step execution is logged before and after. Logs are immutable.
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
}

export interface RunLogRecord {
  id: string;
  runId: string;
  stepIndex: number;
  inputPayload: Record<string, unknown>;
  outputPayload: Record<string, unknown>;
  latencyMs: number | null;
  createdAt: Date;
}

function rowToLog(r: Record<string, unknown>): RunLogRecord {
  return {
    id: r["id"] as string,
    runId: r["run_id"] as string,
    stepIndex: r["step_index"] as number,
    inputPayload: (r["input_payload"] as Record<string, unknown>) ?? {},
    outputPayload: (r["output_payload"] as Record<string, unknown>) ?? {},
    latencyMs: (r["latency_ms"] as number) ?? null,
    createdAt: new Date(r["created_at"] as string),
  };
}

// ─── logStep ──────────────────────────────────────────────────────────────────
export async function logStep(params: {
  runId: string;
  stepIndex: number;
  inputPayload: Record<string, unknown>;
  outputPayload: Record<string, unknown>;
  latencyMs?: number;
  client?: pg.Client;
}): Promise<RunLogRecord> {
  const { runId, stepIndex, inputPayload, outputPayload, latencyMs } = params;
  const useExt = !params.client;
  const client = params.client ?? getClient();
  if (useExt) await client.connect();
  try {
    const r = await client.query(
      `INSERT INTO public.ai_agent_run_logs (id,run_id,step_index,input_payload,output_payload,latency_ms)
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5) RETURNING *`,
      [runId, stepIndex, JSON.stringify(inputPayload), JSON.stringify(outputPayload), latencyMs ?? null],
    );
    return rowToLog(r.rows[0]);
  } finally {
    if (useExt) await client.end();
  }
}

// ─── getRunLogs ───────────────────────────────────────────────────────────────
export async function getRunLogs(runId: string): Promise<RunLogRecord[]> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT * FROM public.ai_agent_run_logs WHERE run_id=$1 ORDER BY step_index ASC`,
      [runId],
    );
    return r.rows.map(rowToLog);
  } finally {
    await client.end();
  }
}

// ─── getRunLogsByTenant ────────────────────────────────────────────────────────
export async function getRunLogsByTenant(params: { tenantId: string; runId: string }): Promise<RunLogRecord[]> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT rl.* FROM public.ai_agent_run_logs rl
       JOIN public.ai_agent_runs ar ON ar.id = rl.run_id
       WHERE rl.run_id=$1 AND ar.tenant_id=$2 ORDER BY rl.step_index ASC`,
      [params.runId, params.tenantId],
    );
    return r.rows.map(rowToLog);
  } finally {
    await client.end();
  }
}
