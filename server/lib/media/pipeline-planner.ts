// ============================================================
// PHASE 5Y — Unified Media Processing Platform
// pipeline-planner.ts — Converts pipeline definitions to step records
// ============================================================

import type {
  MediaType,
  PipelineType,
  MediaProcessingStep,
  PipelineStepDef,
} from "./media-types.ts";
import { getPipelineDef } from "./pipeline-registry.ts";

export interface PlannedStep extends Omit<MediaProcessingStep, "id" | "created_at"> {
  // All fields except DB-generated ones
}

/**
 * Creates the concrete step records for a job.
 * Steps are ordered and keyed deterministically.
 */
export function planSteps(params: {
  tenantId: string;
  jobId: string;
  documentId?: string;
  knowledgeAssetId?: string;
  mediaType: MediaType;
  pipelineType: PipelineType;
  inputRef: string;
}): PlannedStep[] {
  const { tenantId, jobId, documentId, knowledgeAssetId, mediaType, pipelineType, inputRef } = params;

  const pipelineDef = getPipelineDef(mediaType, pipelineType);
  if (!pipelineDef) {
    throw new Error(
      `No pipeline definition found for mediaType='${mediaType}' pipelineType='${pipelineType}'`
    );
  }

  return pipelineDef.steps.map((stepDef: PipelineStepDef, index: number) => ({
    tenant_id: tenantId,
    job_id: jobId,
    document_id: documentId,
    knowledge_asset_id: knowledgeAssetId,
    step_key: `${stepDef.stepType}_${index}`,
    step_type: stepDef.stepType,
    step_order: index,
    status: "pending" as const,
    attempt_count: 0,
    started_at: undefined,
    completed_at: undefined,
    failed_at: undefined,
    duration_ms: undefined,
    provider: stepDef.provider,
    model: stepDef.model,
    fallback_depth: 0,
    last_error_code: undefined,
    last_error_message: undefined,
    failure_category: undefined,
    input_ref: index === 0 ? inputRef : undefined, // First step uses original input
    output_ref: undefined,
    output_text: undefined,
    output_char_count: undefined,
    cost_estimate: 0,
    cost_actual: 0,
    metadata_jsonb: {},
  }));
}

/**
 * Derive job status deterministically from step statuses.
 *
 * Rules:
 *   - All steps completed → completed
 *   - Any step failed (non-retryable) → failed
 *   - Any step in retryable_failed → retryable_failed
 *   - Any step running → processing
 *   - All steps pending → pending
 */
export function deriveJobStatus(
  steps: Array<{ status: MediaProcessingStep["status"] }>
): "pending" | "processing" | "retryable_failed" | "completed" | "failed" {
  if (steps.length === 0) return "pending";

  const statuses = steps.map((s) => s.status);

  if (statuses.every((s) => s === "completed" || s === "skipped")) return "completed";
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.some((s) => s === "running")) return "processing";
  if (statuses.some((s) => s === "failed")) return "retryable_failed"; // covered above but explicit
  if (statuses.every((s) => s === "pending")) return "pending";

  return "processing";
}
