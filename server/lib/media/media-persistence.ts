// ============================================================
// PHASE 5Y — Unified Media Processing Platform
// media-persistence.ts — All DB reads/writes for media jobs and steps
// ============================================================

import { createClient } from "@supabase/supabase-js";
import type {
  MediaProcessingJob,
  MediaProcessingStep,
  MediaEventLog,
  MediaJobStatus,
  StepStatus,
  FailureCategory,
} from "./media-types.ts";
import type { PlannedStep } from "./pipeline-planner.ts";

const supabaseUrl = process.env.SUPABASE_URL ?? "";
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? "";

function getDb() {
  return createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });
}

// ── Job operations ────────────────────────────────────────────────────────────

export async function createJob(
  job: Omit<MediaProcessingJob, "id" | "created_at" | "updated_at">
): Promise<MediaProcessingJob> {
  const db = getDb();
  const { data, error } = await db
    .from("media_processing_jobs")
    .insert(job)
    .select()
    .single();
  if (error) throw new Error(`createJob failed: ${error.message}`);
  return data as MediaProcessingJob;
}

export async function createSteps(steps: PlannedStep[]): Promise<MediaProcessingStep[]> {
  const db = getDb();
  const { data, error } = await db
    .from("media_processing_steps")
    .insert(steps)
    .select();
  if (error) throw new Error(`createSteps failed: ${error.message}`);
  return data as MediaProcessingStep[];
}

export async function claimNextJob(workerId: string): Promise<MediaProcessingJob | null> {
  const db = getDb();
  const now = new Date().toISOString();

  // Atomic claim using FOR UPDATE SKIP LOCKED via RPC
  const { data, error } = await db.rpc("claim_media_job", {
    p_worker_id: workerId,
    p_now: now,
  });

  if (error) throw new Error(`claimNextJob failed: ${error.message}`);
  return (data as MediaProcessingJob[])?.at(0) ?? null;
}

export async function updateJobStatus(
  jobId: string,
  status: MediaJobStatus,
  fields?: Partial<MediaProcessingJob>
): Promise<void> {
  const db = getDb();
  const { error } = await db
    .from("media_processing_jobs")
    .update({ status, updated_at: new Date().toISOString(), ...fields })
    .eq("id", jobId);
  if (error) throw new Error(`updateJobStatus failed: ${error.message}`);
}

export async function heartbeatJob(jobId: string): Promise<void> {
  const db = getDb();
  const { error } = await db
    .from("media_processing_jobs")
    .update({ heartbeat_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) throw new Error(`heartbeatJob failed: ${error.message}`);
}

export async function getJobById(jobId: string): Promise<MediaProcessingJob | null> {
  const db = getDb();
  const { data, error } = await db
    .from("media_processing_jobs")
    .select("*")
    .eq("id", jobId)
    .single();
  if (error) return null;
  return data as MediaProcessingJob;
}

export async function getJobSteps(jobId: string): Promise<MediaProcessingStep[]> {
  const db = getDb();
  const { data, error } = await db
    .from("media_processing_steps")
    .select("*")
    .eq("job_id", jobId)
    .order("step_order", { ascending: true });
  if (error) throw new Error(`getJobSteps failed: ${error.message}`);
  return data as MediaProcessingStep[];
}

// ── Step operations ───────────────────────────────────────────────────────────

export async function updateStep(
  stepId: string,
  fields: Partial<MediaProcessingStep>
): Promise<void> {
  const db = getDb();
  const { error } = await db
    .from("media_processing_steps")
    .update(fields)
    .eq("id", stepId);
  if (error) throw new Error(`updateStep failed: ${error.message}`);
}

export async function markStepRunning(stepId: string): Promise<void> {
  await updateStep(stepId, {
    status: "running",
    started_at: new Date().toISOString(),
  });
}

export async function markStepCompleted(
  stepId: string,
  outputText: string,
  durationMs: number,
  costActual?: number
): Promise<void> {
  await updateStep(stepId, {
    status: "completed",
    completed_at: new Date().toISOString(),
    output_text: outputText,
    output_char_count: outputText.length,
    duration_ms: durationMs,
    cost_actual: costActual ?? 0,
  });
}

export async function markStepFailed(
  stepId: string,
  errorCode: string,
  errorMessage: string,
  failureCategory: FailureCategory,
  durationMs: number
): Promise<void> {
  await updateStep(stepId, {
    status: "failed",
    failed_at: new Date().toISOString(),
    last_error_code: errorCode,
    last_error_message: errorMessage.slice(0, 1000),
    failure_category: failureCategory,
    duration_ms: durationMs,
  });
}

// ── Event log ─────────────────────────────────────────────────────────────────

export async function logEvent(
  event: Omit<MediaEventLog, "id" | "created_at">
): Promise<void> {
  const db = getDb();
  const { error } = await db.from("media_event_log").insert(event);
  if (error) {
    // Non-fatal — log to console but don't throw
    console.error("[media-persistence] logEvent failed:", error.message);
  }
}

// ── Reaper ────────────────────────────────────────────────────────────────────

/**
 * Find jobs that are stuck in 'processing' with a stale heartbeat.
 * Returns jobs where heartbeat_at is older than the given cutoff.
 */
export async function findStuckJobs(
  heartbeatCutoffMs: number
): Promise<MediaProcessingJob[]> {
  const db = getDb();
  const cutoff = new Date(Date.now() - heartbeatCutoffMs).toISOString();

  const { data, error } = await db
    .from("media_processing_jobs")
    .select("*")
    .eq("status", "processing")
    .lt("heartbeat_at", cutoff);

  if (error) throw new Error(`findStuckJobs failed: ${error.message}`);
  return (data ?? []) as MediaProcessingJob[];
}

export async function resetStuckJob(
  jobId: string,
  reason: string
): Promise<void> {
  const db = getDb();
  const { error } = await db
    .from("media_processing_jobs")
    .update({
      status: "pending",
      worker_id: null,
      heartbeat_at: null,
      last_error_message: `Reset by reaper: ${reason}`,
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("status", "processing"); // Only reset if still processing (avoid races)

  if (error) throw new Error(`resetStuckJob failed: ${error.message}`);
}

// ── Legacy OCR bridge ─────────────────────────────────────────────────────────
// Allows the old chat_ocr_tasks status endpoint to still work during migration

export async function getOcrTaskStatus(taskId: string): Promise<{
  status: string;
  stage?: string;
  error?: string;
  result?: string;
} | null> {
  const db = getDb();

  // Try new media_processing_jobs first
  const { data: job } = await db
    .from("media_processing_jobs")
    .select("status, last_error_message")
    .eq("id", taskId)
    .single();

  if (job) {
    return {
      status: job.status,
      error: job.last_error_message,
    };
  }

  // Fall back to legacy chat_ocr_tasks
  const { data: legacyTask } = await db
    .from("chat_ocr_tasks")
    .select("status, stage, last_error, ocr_text")
    .eq("id", taskId)
    .single();

  if (legacyTask) {
    return {
      status: legacyTask.status,
      stage: legacyTask.stage,
      error: legacyTask.last_error,
      result: legacyTask.ocr_text,
    };
  }

  return null;
}
