/**
 * Phase 14 — Agent Runner
 * Top-level execution pipeline for a single agent run.
 * Pipeline: loadAgentVersion → validatePromptApproval → executeWorkflow → storeResults
 * Limits: MAX_ITERATIONS=10, MAX_WORKFLOW_STEPS=20, MAX_RUN_DURATION_MS=30000.
 */

import pg from "pg";
import { getAgentVersion, getAgentById } from "./agent-engine.ts";
import { createRun, transitionRun } from "./agent-state.ts";
import { executeWorkflow } from "./workflow-engine.ts";

function getClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
}

export const MAX_ITERATIONS = 10;
export const MAX_RUN_DURATION_MS = 30_000;

export interface AgentRunResult {
  success: boolean;
  runId: string;
  tenantId: string;
  agentVersionId: string;
  workflowId: string | null;
  runStatus: string;
  stepsExecuted: number;
  totalLatencyMs: number;
  iterationsUsed: number;
  error?: string;
  abortedReason?: string;
}

// ─── runAgent ────────────────────────────────────────────────────────────────
export async function runAgent(params: {
  tenantId: string;
  agentVersionId: string;
  workflowId?: string;
  initialInput?: Record<string, unknown>;
  skipApprovalCheck?: boolean;
}): Promise<AgentRunResult> {
  const { tenantId, agentVersionId, workflowId, initialInput = {}, skipApprovalCheck = false } = params;
  const startTime = Date.now();

  // ── Step 1: Load agent version ──────────────────────────────────────────────
  const agentVersion = await getAgentVersion(agentVersionId);
  if (!agentVersion) {
    return errorRun(agentVersionId, tenantId, workflowId ?? null, "Agent version not found", startTime);
  }

  // ── Step 2: Validate tenant owns this agent ─────────────────────────────────
  const client = getClient();
  await client.connect();
  let runId: string | null = null;

  try {
    const agent = await getAgentById(agentVersion.agentId, tenantId, client);
    if (!agent) {
      return errorRun(agentVersionId, tenantId, workflowId ?? null, "Agent does not belong to tenant (isolation violation)", startTime);
    }

    // ── Step 3: Validate prompt approval (INV-PG6) ────────────────────────────
    if (!skipApprovalCheck && agentVersion.promptVersionId) {
      const approvalR = await client.query(
        `SELECT approval_status FROM public.prompt_approvals WHERE prompt_version_id=$1`,
        [agentVersion.promptVersionId],
      );
      if (!approvalR.rows.length || approvalR.rows[0].approval_status !== "approved") {
        return errorRun(agentVersionId, tenantId, workflowId ?? null, `Prompt version '${agentVersion.promptVersionId}' is not approved — cannot execute agent`, startTime);
      }
    }

    // ── Step 4: Create run record ─────────────────────────────────────────────
    const run = await createRun({ tenantId, agentVersionId, workflowId, client });
    runId = run.id;

    // ── Step 5: Transition to running ─────────────────────────────────────────
    await transitionRun({ runId, status: "running", client });

    // ── Step 6: Enforce max_iterations ────────────────────────────────────────
    const iterationBudget = Math.min(agentVersion.maxIterations, MAX_ITERATIONS);

    // ── Step 7: Execute workflow (if provided) ────────────────────────────────
    let stepsExecuted = 0;
    let abortedReason: string | undefined;
    let workflowSuccess = true;

    if (workflowId) {
      const wfResult = await executeWorkflow({
        runId,
        workflowId,
        tenantId,
        initialInput,
        iterationBudget,
        modelId: agentVersion.modelId,
      });
      stepsExecuted = wfResult.stepsExecuted;
      workflowSuccess = wfResult.success;
      abortedReason = wfResult.abortedReason;
    }

    // ── Step 8: Finalize run status ────────────────────────────────────────────
    const finalStatus = workflowSuccess ? "completed" : (abortedReason?.includes("timeout") || abortedReason?.includes("duration") ? "timeout" : "failed");
    await transitionRun({ runId, status: finalStatus as any, client });

    const totalLatencyMs = Date.now() - startTime;

    return {
      success: workflowSuccess,
      runId,
      tenantId,
      agentVersionId,
      workflowId: workflowId ?? null,
      runStatus: finalStatus,
      stepsExecuted,
      totalLatencyMs,
      iterationsUsed: Math.min(stepsExecuted, iterationBudget),
      error: workflowSuccess ? undefined : abortedReason,
      abortedReason,
    };
  } catch (err) {
    if (runId) {
      await transitionRun({ runId, status: "failed", client }).catch(() => {});
    }
    return errorRun(agentVersionId, tenantId, workflowId ?? null, (err as Error).message, startTime);
  } finally {
    await client.end();
  }
}

function errorRun(agentVersionId: string, tenantId: string, workflowId: string | null, error: string, startTime: number): AgentRunResult {
  return {
    success: false,
    runId: `error-${Date.now()}`,
    tenantId,
    agentVersionId,
    workflowId,
    runStatus: "failed",
    stepsExecuted: 0,
    totalLatencyMs: Date.now() - startTime,
    iterationsUsed: 0,
    error,
  };
}
