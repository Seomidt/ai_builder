/**
 * Phase 14 — Agent State Manager
 * Manages run lifecycle: pending → running → completed/failed/aborted/timeout
 * All state transitions stored in ai_agent_runs.
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
}

export type RunStatus = "pending" | "running" | "completed" | "failed" | "aborted" | "timeout";

export interface AgentRunRecord {
  id: string;
  tenantId: string;
  agentVersionId: string;
  workflowId: string | null;
  runStatus: RunStatus;
  startedAt: Date;
  completedAt: Date | null;
}

function rowToRun(r: Record<string, unknown>): AgentRunRecord {
  return {
    id: r["id"] as string,
    tenantId: r["tenant_id"] as string,
    agentVersionId: r["agent_version_id"] as string,
    workflowId: (r["workflow_id"] as string) ?? null,
    runStatus: r["run_status"] as RunStatus,
    startedAt: new Date(r["started_at"] as string),
    completedAt: r["completed_at"] ? new Date(r["completed_at"] as string) : null,
  };
}

// ─── createRun ────────────────────────────────────────────────────────────────
export async function createRun(params: {
  tenantId: string;
  agentVersionId: string;
  workflowId?: string;
  client?: pg.Client;
}): Promise<AgentRunRecord> {
  const { tenantId, agentVersionId, workflowId } = params;
  const useExt = !params.client;
  const client = params.client ?? getClient();
  if (useExt) await client.connect();
  try {
    const r = await client.query(
      `INSERT INTO public.ai_agent_runs (id,tenant_id,agent_version_id,workflow_id,run_status)
       VALUES (gen_random_uuid()::text,$1,$2,$3,'pending') RETURNING *`,
      [tenantId, agentVersionId, workflowId ?? null],
    );
    return rowToRun(r.rows[0]);
  } finally {
    if (useExt) await client.end();
  }
}

// ─── transitionRun ────────────────────────────────────────────────────────────
export async function transitionRun(params: {
  runId: string;
  status: RunStatus;
  client?: pg.Client;
}): Promise<AgentRunRecord> {
  const { runId, status } = params;
  const useExt = !params.client;
  const client = params.client ?? getClient();
  if (useExt) await client.connect();
  try {
    const completedAt = ["completed", "failed", "aborted", "timeout"].includes(status) ? "now()" : "null";
    const r = await client.query(
      `UPDATE public.ai_agent_runs SET run_status=$1, completed_at=${completedAt === "now()" ? "now()" : "null"} WHERE id=$2 RETURNING *`,
      [status, runId],
    );
    if (!r.rows.length) throw new Error(`Run ${runId} not found`);
    return rowToRun(r.rows[0]);
  } finally {
    if (useExt) await client.end();
  }
}

// ─── getRun ───────────────────────────────────────────────────────────────────
export async function getRun(runId: string, tenantId: string): Promise<AgentRunRecord | null> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(`SELECT * FROM public.ai_agent_runs WHERE id=$1 AND tenant_id=$2`, [runId, tenantId]);
    return r.rows.length ? rowToRun(r.rows[0]) : null;
  } finally {
    await client.end();
  }
}

// ─── listRuns ─────────────────────────────────────────────────────────────────
export async function listRuns(params: { tenantId: string; limit?: number }): Promise<AgentRunRecord[]> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT * FROM public.ai_agent_runs WHERE tenant_id=$1 ORDER BY started_at DESC LIMIT $2`,
      [params.tenantId, Math.min(params.limit ?? 50, 200)],
    );
    return r.rows.map(rowToRun);
  } finally {
    await client.end();
  }
}

// ─── isTerminalStatus ─────────────────────────────────────────────────────────
export function isTerminalStatus(status: RunStatus): boolean {
  return ["completed", "failed", "aborted", "timeout"].includes(status);
}
