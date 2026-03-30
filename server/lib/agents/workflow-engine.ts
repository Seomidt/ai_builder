/**
 * Phase 14 — Workflow Engine
 * Executes ordered workflow steps sequentially.
 * Limits: MAX_WORKFLOW_STEPS=20, MAX_RUN_DURATION_MS=30000.
 * Each step is logged via agent-logger.
 */

import pg from "pg";
import { getWorkflowSteps, validateWorkflow, type WorkflowStepRecord } from "./workflow-validator.ts";
import { logStep } from "./agent-logger.ts";

function getClient(): pg.Client {
  return new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
}

export const MAX_RUN_DURATION_MS = 30_000;

export interface StepResult {
  stepOrder: number;
  stepType: string;
  success: boolean;
  output: Record<string, unknown>;
  latencyMs: number;
  error?: string;
}

export interface WorkflowExecutionResult {
  success: boolean;
  runId: string;
  workflowId: string;
  stepsExecuted: number;
  stepResults: StepResult[];
  totalLatencyMs: number;
  abortedReason?: string;
}

// ─── executeStep ──────────────────────────────────────────────────────────────
async function executeStep(params: {
  step: WorkflowStepRecord;
  input: Record<string, unknown>;
  iterationBudget: number;
  modelId: string | null;
}): Promise<StepResult> {
  const { step, input, iterationBudget, modelId } = params;
  const t0 = Date.now();

  try {
    let output: Record<string, unknown>;

    switch (step.stepType) {
      case "agent": {
        // Deterministic simulation: agent processes input and produces structured output
        output = {
          stepType: "agent",
          agentVersionId: step.agentVersionId,
          modelId,
          iterationsUsed: Math.min(1, iterationBudget),
          result: `Agent step ${step.stepOrder} processed input`,
          inputSummary: Object.keys(input).join(","),
          timestamp: new Date().toISOString(),
        };
        break;
      }
      case "transform": {
        output = {
          stepType: "transform",
          transformed: true,
          inputKeys: Object.keys(input),
          timestamp: new Date().toISOString(),
        };
        break;
      }
      case "condition": {
        output = {
          stepType: "condition",
          conditionMet: true,
          timestamp: new Date().toISOString(),
        };
        break;
      }
      case "output": {
        output = { stepType: "output", payload: input, timestamp: new Date().toISOString() };
        break;
      }
      default:
        output = { stepType: step.stepType, result: "unknown step type" };
    }

    return { stepOrder: step.stepOrder, stepType: step.stepType, success: true, output, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { stepOrder: step.stepOrder, stepType: step.stepType, success: false, output: {}, latencyMs: Date.now() - t0, error: (err as Error).message };
  }
}

// ─── executeWorkflow ──────────────────────────────────────────────────────────
export async function executeWorkflow(params: {
  runId: string;
  workflowId: string;
  tenantId: string;
  initialInput: Record<string, unknown>;
  iterationBudget: number;
  modelId: string | null;
}): Promise<WorkflowExecutionResult> {
  const { runId, workflowId, initialInput, iterationBudget, modelId } = params;
  const startTime = Date.now();

  // Validate before executing
  const validation = await validateWorkflow(workflowId);
  if (!validation.valid) {
    return {
      success: false,
      runId,
      workflowId,
      stepsExecuted: 0,
      stepResults: [],
      totalLatencyMs: Date.now() - startTime,
      abortedReason: `Workflow validation failed: ${validation.errors.join("; ")}`,
    };
  }

  const client = getClient();
  await client.connect();

  try {
    const steps = await getWorkflowSteps(workflowId, client);
    const stepResults: StepResult[] = [];
    let currentInput = { ...initialInput };
    let iterationsRemaining = iterationBudget;

    for (const step of steps) {
      // MAX_RUN_DURATION_MS guard
      if (Date.now() - startTime > MAX_RUN_DURATION_MS) {
        return {
          success: false,
          runId,
          workflowId,
          stepsExecuted: stepResults.length,
          stepResults,
          totalLatencyMs: Date.now() - startTime,
          abortedReason: `Run exceeded MAX_RUN_DURATION_MS (${MAX_RUN_DURATION_MS}ms)`,
        };
      }

      // Iteration budget guard
      if (iterationsRemaining <= 0) {
        return {
          success: false,
          runId,
          workflowId,
          stepsExecuted: stepResults.length,
          stepResults,
          totalLatencyMs: Date.now() - startTime,
          abortedReason: "Iteration budget exhausted",
        };
      }

      const stepResult = await executeStep({ step, input: currentInput, iterationBudget: iterationsRemaining, modelId });
      iterationsRemaining--;

      // Log the step
      await logStep({
        runId,
        stepIndex: step.stepOrder - 1,
        inputPayload: currentInput,
        outputPayload: stepResult.output,
        latencyMs: stepResult.latencyMs,
        client,
      });

      stepResults.push(stepResult);

      if (!stepResult.success) {
        return {
          success: false,
          runId,
          workflowId,
          stepsExecuted: stepResults.length,
          stepResults,
          totalLatencyMs: Date.now() - startTime,
          abortedReason: `Step ${step.stepOrder} failed: ${stepResult.error}`,
        };
      }

      // Pass output as input to next step
      currentInput = { ...currentInput, ...stepResult.output };
    }

    return {
      success: true,
      runId,
      workflowId,
      stepsExecuted: stepResults.length,
      stepResults,
      totalLatencyMs: Date.now() - startTime,
    };
  } finally {
    await client.end();
  }
}
