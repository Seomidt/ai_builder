/**
 * Phase 14 — Workflow Validator
 * Validates workflow structure before execution.
 * Limits: max 20 steps, no gaps in step_order, all agent_version_ids valid.
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
}

export const MAX_WORKFLOW_STEPS = 20;

export interface WorkflowRecord {
  id: string;
  tenantId: string;
  workflowName: string;
  createdAt: Date;
}

export interface WorkflowStepRecord {
  id: string;
  workflowId: string;
  stepOrder: number;
  stepType: string;
  agentVersionId: string | null;
  createdAt: Date;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  stepCount: number;
}

function rowToWorkflow(r: Record<string, unknown>): WorkflowRecord {
  return {
    id: r["id"] as string,
    tenantId: r["tenant_id"] as string,
    workflowName: r["workflow_name"] as string,
    createdAt: new Date(r["created_at"] as string),
  };
}

function rowToStep(r: Record<string, unknown>): WorkflowStepRecord {
  return {
    id: r["id"] as string,
    workflowId: r["workflow_id"] as string,
    stepOrder: r["step_order"] as number,
    stepType: r["step_type"] as string,
    agentVersionId: (r["agent_version_id"] as string) ?? null,
    createdAt: new Date(r["created_at"] as string),
  };
}

// ─── createWorkflow ───────────────────────────────────────────────────────────
export async function createWorkflow(params: { tenantId: string; workflowName: string }): Promise<WorkflowRecord> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `INSERT INTO public.ai_workflows (id,tenant_id,workflow_name)
       VALUES (gen_random_uuid()::text,$1,$2) RETURNING *`,
      [params.tenantId, params.workflowName],
    );
    return rowToWorkflow(r.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── addWorkflowStep ──────────────────────────────────────────────────────────
export async function addWorkflowStep(params: {
  workflowId: string;
  stepOrder: number;
  stepType?: string;
  agentVersionId?: string;
}): Promise<WorkflowStepRecord> {
  const { workflowId, stepOrder, stepType = "agent", agentVersionId } = params;
  if (stepOrder < 1 || stepOrder > MAX_WORKFLOW_STEPS) {
    throw new Error(`stepOrder must be 1–${MAX_WORKFLOW_STEPS} (got ${stepOrder})`);
  }
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(
      `INSERT INTO public.ai_workflow_steps (id,workflow_id,step_order,step_type,agent_version_id)
       VALUES (gen_random_uuid()::text,$1,$2,$3,$4) RETURNING *`,
      [workflowId, stepOrder, stepType, agentVersionId ?? null],
    );
    return rowToStep(r.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── getWorkflowSteps ─────────────────────────────────────────────────────────
export async function getWorkflowSteps(workflowId: string, client?: pg.Client): Promise<WorkflowStepRecord[]> {
  const useExt = !client;
  const c = client ?? getClient();
  if (useExt) await c.connect();
  try {
    const r = await c.query(
      `SELECT * FROM public.ai_workflow_steps WHERE workflow_id=$1 ORDER BY step_order ASC`,
      [workflowId],
    );
    return r.rows.map(rowToStep);
  } finally {
    if (useExt) await c.end();
  }
}

// ─── listWorkflows ────────────────────────────────────────────────────────────
export async function listWorkflows(tenantId: string): Promise<WorkflowRecord[]> {
  const client = getClient();
  await client.connect();
  try {
    const r = await client.query(`SELECT * FROM public.ai_workflows WHERE tenant_id=$1 ORDER BY created_at DESC`, [tenantId]);
    return r.rows.map(rowToWorkflow);
  } finally {
    await client.end();
  }
}

// ─── validateWorkflow ─────────────────────────────────────────────────────────
export async function validateWorkflow(workflowId: string): Promise<ValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  const client = getClient();
  await client.connect();
  try {
    const steps = await getWorkflowSteps(workflowId, client);

    if (steps.length === 0) {
      errors.push("Workflow has no steps.");
      return { valid: false, errors, warnings, stepCount: 0 };
    }

    if (steps.length > MAX_WORKFLOW_STEPS) {
      errors.push(`Workflow exceeds max steps (${steps.length} > ${MAX_WORKFLOW_STEPS}).`);
    }

    // Validate step_order is sequential 1..N without gaps
    const orders = steps.map((s) => s.stepOrder).sort((a, b) => a - b);
    for (let i = 0; i < orders.length; i++) {
      if (orders[i] !== i + 1) {
        errors.push(`Gap in step_order: expected ${i + 1}, found ${orders[i]}.`);
        break;
      }
    }

    // Validate agent steps have an agent_version_id
    for (const step of steps) {
      if (step.stepType === "agent" && !step.agentVersionId) {
        errors.push(`Step ${step.stepOrder} is type 'agent' but has no agent_version_id.`);
      }
    }

    if (steps.length > 10) {
      warnings.push(`Workflow has ${steps.length} steps — execution may be slow.`);
    }

    return { valid: errors.length === 0, errors, warnings, stepCount: steps.length };
  } finally {
    await client.end();
  }
}
