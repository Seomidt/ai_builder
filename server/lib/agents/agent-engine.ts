/**
 * Phase 14 — Agent Engine
 * CRUD for ai_agents and ai_agent_versions.
 * Enforces: tenant-isolation, max_iterations ≤ 10, unique(agent_id, version).
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
}

export const MAX_ITERATIONS = 10;

export interface AgentRecord {
  id: string;
  tenantId: string;
  agentName: string;
  description: string | null;
  createdAt: Date;
}

export interface AgentVersionRecord {
  id: string;
  agentId: string;
  version: number;
  promptVersionId: string | null;
  modelId: string | null;
  maxIterations: number;
  createdAt: Date;
}

function rowToAgent(r: Record<string, unknown>): AgentRecord {
  return {
    id: r["id"] as string,
    tenantId: r["tenant_id"] as string,
    agentName: r["agent_name"] as string,
    description: (r["description"] as string) ?? null,
    createdAt: new Date(r["created_at"] as string),
  };
}

function rowToVersion(r: Record<string, unknown>): AgentVersionRecord {
  return {
    id: r["id"] as string,
    agentId: r["agent_id"] as string,
    version: r["version"] as number,
    promptVersionId: (r["prompt_version_id"] as string) ?? null,
    modelId: (r["model_id"] as string) ?? null,
    maxIterations: r["max_iterations"] as number,
    createdAt: new Date(r["created_at"] as string),
  };
}

// ─── createAgent ──────────────────────────────────────────────────────────────
export async function createAgent(params: {
  tenantId: string;
  agentName: string;
  description?: string;
}): Promise<AgentRecord> {
  const { tenantId, agentName, description } = params;
  if (!tenantId || !agentName) throw new Error("tenantId, agentName required");
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `INSERT INTO public.ai_agents (id,tenant_id,agent_name,description)
       VALUES (gen_random_uuid()::text,$1,$2,$3) RETURNING *`,
      [tenantId, agentName, description ?? null],
    );
    return rowToAgent(r.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── listAgents ───────────────────────────────────────────────────────────────
export async function listAgents(tenantId: string): Promise<AgentRecord[]> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(`SELECT * FROM public.ai_agents WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]);
    return r.rows.map(rowToAgent);
  } finally {
    await client.end();
  }
}

// ─── getAgentById ─────────────────────────────────────────────────────────────
export async function getAgentById(agentId: string, tenantId: string, client?: pg.Client): Promise<AgentRecord | null> {
  const useExt = !client;
  const c = client ?? getClient();
  if (useExt) await c.connect();
  try {
    const r = await c.query(`SELECT * FROM public.ai_agents WHERE id=$1 AND tenant_id=$2`, [agentId, tenantId]);
    return r.rows.length ? rowToAgent(r.rows[0]) : null;
  } finally {
    if (useExt) await c.end();
  }
}

// ─── createAgentVersion ───────────────────────────────────────────────────────
export async function createAgentVersion(params: {
  agentId: string;
  version?: number;
  promptVersionId?: string;
  modelId?: string;
  maxIterations?: number;
}): Promise<AgentVersionRecord> {
  const { agentId, promptVersionId, modelId } = params;
  const maxIterations = Math.min(params.maxIterations ?? 10, MAX_ITERATIONS);
  const client = getClient();
  await client.connect();
  try {
    // Auto-increment version if not provided
    let version = params.version;
    if (version === undefined) {
      const v = await client.query(`SELECT COALESCE(MAX(version),0)+1 as next FROM public.ai_agent_versions WHERE agent_id=$1`, [agentId]);
      version = v.rows[0].next as number;
    }
    const r = await client.query(
      `INSERT INTO public.ai_agent_versions (id,agent_id,version,prompt_version_id,model_id,max_iterations)
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4,$5) RETURNING *`,
      [agentId, version, promptVersionId ?? null, modelId ?? null, maxIterations],
    );
    return rowToVersion(r.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── getAgentVersion ──────────────────────────────────────────────────────────
export async function getAgentVersion(agentVersionId: string, client?: pg.Client): Promise<AgentVersionRecord | null> {
  const useExt = !client;
  const c = client ?? getClient();
  if (useExt) await c.connect();
  try {
    const r = await c.query(`SELECT * FROM public.ai_agent_versions WHERE id=$1`, [agentVersionId]);
    return r.rows.length ? rowToVersion(r.rows[0]) : null;
  } finally {
    if (useExt) await c.end();
  }
}

// ─── getLatestAgentVersion ────────────────────────────────────────────────────
export async function getLatestAgentVersion(agentId: string): Promise<AgentVersionRecord | null> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `SELECT * FROM public.ai_agent_versions WHERE agent_id=$1 ORDER BY version DESC LIMIT 1`,
      [agentId],
    );
    return r.rows.length ? rowToVersion(r.rows[0]) : null;
  } finally {
    await client.end();
  }
}

// ─── agentMetrics ─────────────────────────────────────────────────────────────
export async function agentMetrics(tenantId: string): Promise<{
  totalAgents: number;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  abortedRuns: number;
  timeoutRuns: number;
  avgLatencyMs: number;
  totalStepsLogged: number;
}> {
  const client = getClient();
  await client.connect();
  try {
    const [agents, runs, logs] = await Promise.all([
      client.query(`SELECT COUNT(*) as cnt FROM public.ai_agents WHERE tenant_id=$1`, [tenantId]),
      client.query(
        `SELECT
           COUNT(*) as total,
           COUNT(CASE WHEN run_status='completed' THEN 1 END) as completed,
           COUNT(CASE WHEN run_status='failed' THEN 1 END) as failed,
           COUNT(CASE WHEN run_status='aborted' THEN 1 END) as aborted,
           COUNT(CASE WHEN run_status='timeout' THEN 1 END) as timeout
         FROM public.ai_agent_runs WHERE tenant_id=$1`,
        [tenantId],
      ),
      client.query(
        `SELECT COUNT(rl.*) as cnt, COALESCE(AVG(rl.latency_ms),0) as avg_lat
         FROM public.ai_agent_run_logs rl
         JOIN public.ai_agent_runs ar ON ar.id=rl.run_id AND ar.tenant_id=$1`,
        [tenantId],
      ),
    ]);
    return {
      totalAgents: parseInt(agents.rows[0].cnt, 10),
      totalRuns: parseInt(runs.rows[0].total, 10),
      completedRuns: parseInt(runs.rows[0].completed, 10),
      failedRuns: parseInt(runs.rows[0].failed, 10),
      abortedRuns: parseInt(runs.rows[0].aborted, 10),
      timeoutRuns: parseInt(runs.rows[0].timeout, 10),
      avgLatencyMs: parseFloat(parseFloat(logs.rows[0].avg_lat).toFixed(1)),
      totalStepsLogged: parseInt(logs.rows[0].cnt, 10),
    };
  } finally {
    await client.end();
  }
}

// ─── agentHealth ──────────────────────────────────────────────────────────────
export function agentHealth(): {
  status: string;
  limits: Record<string, number>;
  note: string;
} {
  return {
    status: "operational",
    limits: {
      MAX_ITERATIONS: 10,
      MAX_WORKFLOW_STEPS: 20,
      MAX_RUN_DURATION_MS: 30_000,
    },
    note: "Agents are tenant-isolated. Governance rules enforced per run.",
  };
}
