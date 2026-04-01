// ============================================================
// PHASE 5Y — Unified Media Processing Platform
// media-worker.ts — Core step executor
// ============================================================

import type {
  MediaProcessingJob,
  MediaProcessingStep,
  MediaType,
  PipelineType,
  StepType,
} from "./media-types.ts";
import { getProvider } from "./providers/gemini-provider.ts";
import { getFallbackChain, getNextFallback } from "./fallback-policy.ts";
import { evaluateRetry } from "./retry-policy.ts";
import { classifyFailure } from "./failure-classifier.ts";
import { deriveJobStatus } from "./pipeline-planner.ts";
import { validateOutput, validateProviderResponse } from "./output-validator.ts";
import {
  getJobSteps,
  markStepRunning,
  markStepCompleted,
  markStepFailed,
  updateJobStatus,
  updateStep,
  heartbeatJob,
  logEvent,
} from "./media-persistence.ts";

const HEARTBEAT_INTERVAL_MS = 15_000; // 15 seconds

// ── R2 download helper ────────────────────────────────────────────────────────

async function downloadFromR2(r2Key: string): Promise<{ buffer: Buffer; mimeType: string; filename: string }> {
  const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL ?? process.env.CLOUDFLARE_R2_PUBLIC_URL ?? "";
  const url = `${R2_PUBLIC_URL}/${r2Key}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`R2 download failed: ${response.status} ${response.statusText} for key: ${r2Key}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
  const filename = r2Key.split("/").pop() ?? "file";

  return { buffer, mimeType, filename };
}

// ── Main job processor ────────────────────────────────────────────────────────

export async function processJob(job: MediaProcessingJob): Promise<void> {
  const jobId = job.id;
  const mediaType = job.media_type as MediaType;
  const pipelineType = job.pipeline_type as PipelineType;

  console.log(`[media-worker] Starting job ${jobId} (${mediaType}/${pipelineType})`);

  // Start heartbeat
  const heartbeatTimer = setInterval(async () => {
    try {
      await heartbeatJob(jobId);
    } catch (e) {
      console.error(`[media-worker] Heartbeat failed for job ${jobId}:`, e);
    }
  }, HEARTBEAT_INTERVAL_MS);

  try {
    await updateJobStatus(jobId, "processing", { started_at: new Date().toISOString() });

    await logEvent({
      job_id: jobId,
      event_type: "job_started",
      event_data: { mediaType, pipelineType, workerId: job.worker_id },
    });

    // Download file from R2
    console.log(`[media-worker] Downloading file from R2: ${job.input_r2_key}`);
    const { buffer, mimeType, filename } = await downloadFromR2(job.input_r2_key);
    console.log(`[media-worker] Downloaded ${buffer.length} bytes (${mimeType})`);

    // Get all steps for this job
    const steps = await getJobSteps(jobId);
    let previousOutputText = "";

    // Execute steps in order
    for (const step of steps) {
      if (step.status === "completed" || step.status === "skipped") {
        previousOutputText = step.output_text ?? previousOutputText;
        continue;
      }

      console.log(`[media-worker] Executing step ${step.step_key} (${step.provider}/${step.model})`);
      await markStepRunning(step.id);

      const result = await executeStepWithFallback({
        step,
        buffer,
        filename,
        mimeType,
        mediaType,
        pipelineType,
        previousOutputText,
        jobId,
      });

      if (result.success) {
        // 1. Validate provider response (basic sanity check)
        const providerValidation = validateProviderResponse(result.outputText);
        if (!providerValidation.isValid) {
          result.success = false;
          result.errorCode = providerValidation.failureCode;
          result.errorMessage = providerValidation.reason;
          result.failureCategory = "invalid_output";
          result.retryable = false;
        } else {
          // 2. Validate extracted output
          const outputValidation = validateOutput({
            mediaType,
            pipelineType,
            stepType: step.step_type,
            text: result.outputText,
          });

          if (!outputValidation.isValid) {
            result.success = false;
            result.errorCode = outputValidation.failureCode;
            result.errorMessage = outputValidation.reason;
            result.failureCategory = outputValidation.failureCategory;
            result.retryable = false;

            await logEvent({
              job_id: jobId,
              step_id: step.id,
              event_type: "media_output_validation_failed",
              event_data: {
                stepKey: step.step_key,
                failureCode: outputValidation.failureCode,
                reason: outputValidation.reason,
                metrics: outputValidation.metrics,
              },
            });
          } else {
            await logEvent({
              job_id: jobId,
              step_id: step.id,
              event_type: "media_output_validation_passed",
              event_data: {
                stepKey: step.step_key,
                metrics: outputValidation.metrics,
              },
            });
          }
        }
      }

      if (result.success) {
        previousOutputText = result.outputText ?? "";
        await markStepCompleted(step.id, previousOutputText, result.durationMs ?? 0);

        await logEvent({
          job_id: jobId,
          step_id: step.id,
          event_type: "step_completed",
          event_data: {
            stepKey: step.step_key,
            provider: result.provider,
            model: result.model,
            charCount: result.charCount,
            durationMs: result.durationMs,
          },
        });
      } else {
        await markStepFailed(
          step.id,
          result.errorCode ?? "UNKNOWN",
          result.errorMessage ?? "Unknown error",
          result.failureCategory ?? "unknown",
          result.durationMs ?? 0
        );

        await logEvent({
          job_id: jobId,
          step_id: step.id,
          event_type: "step_failed",
          event_data: {
            stepKey: step.step_key,
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
            failureCategory: result.failureCategory,
          },
        });

        // Determine if job should retry or fail
        const retryDecision = evaluateRetry(
          result.failureCategory ?? "unknown",
          job.attempt_count + 1,
          job.max_attempts
        );

        if (retryDecision.shouldRetry) {
          await updateJobStatus(jobId, "retryable_failed", {
            next_retry_at: retryDecision.nextRetryAt?.toISOString(),
            attempt_count: job.attempt_count + 1,
            last_error_message: result.errorMessage,
            last_failure_category: result.failureCategory,
          });
        } else if (retryDecision.deadLetter) {
          await updateJobStatus(jobId, "dead_letter", {
            failed_at: new Date().toISOString(),
            last_error_message: `Dead letter: ${result.errorMessage}`,
            last_failure_category: result.failureCategory,
          });
        } else {
          await updateJobStatus(jobId, "failed", {
            failed_at: new Date().toISOString(),
            last_error_message: result.errorMessage,
            last_failure_category: result.failureCategory,
          });
        }

        clearInterval(heartbeatTimer);
        return;
      }
    }

    // All steps completed
    await updateJobStatus(jobId, "completed", {
      completed_at: new Date().toISOString(),
      output_text: previousOutputText,
      output_char_count: previousOutputText.length,
    });

    await logEvent({
      job_id: jobId,
      event_type: "job_completed",
      event_data: { charCount: previousOutputText.length },
    });

    console.log(`[media-worker] Job ${jobId} completed (${previousOutputText.length} chars)`);
  } catch (error: unknown) {
    const { category, code, message } = classifyFailure(error);
    console.error(`[media-worker] Job ${jobId} crashed:`, message);

    await updateJobStatus(jobId, "failed", {
      failed_at: new Date().toISOString(),
      last_error_message: message,
      last_failure_category: category,
    });

    await logEvent({
      job_id: jobId,
      event_type: "job_failed",
      event_data: { errorCode: code, errorMessage: message, failureCategory: category },
    });
  } finally {
    clearInterval(heartbeatTimer);
  }
}

// ── Step executor with fallback ───────────────────────────────────────────────

interface StepResult {
  success: boolean;
  provider?: string;
  model?: string;
  outputText?: string;
  charCount?: number;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  failureCategory?: string;
  retryable?: boolean;
}

async function executeStepWithFallback(params: {
  step: MediaProcessingStep;
  buffer: Buffer;
  filename: string;
  mimeType: string;
  mediaType: MediaType;
  pipelineType: PipelineType;
  previousOutputText: string;
  jobId: string;
}): Promise<StepResult> {
  const { step, buffer, filename, mimeType, mediaType, pipelineType, previousOutputText, jobId } = params;

  const chain = getFallbackChain(mediaType, pipelineType, step.step_type as StepType);
  let fallbackDepth = step.fallback_depth ?? 0;

  while (fallbackDepth < chain.length) {
    const providerConfig = chain[fallbackDepth];
    const provider = getProvider(providerConfig.provider);

    console.log(
      `[media-worker] Step ${step.step_key}: trying ${providerConfig.provider}/${providerConfig.model} (fallback depth ${fallbackDepth})`
    );

    const result = await provider.execute(
      buffer,
      filename,
      mimeType,
      providerConfig.model,
      providerConfig.timeoutMs,
      { previousOutputText }
    );

    if (result.success) {
      return result;
    }

    // Check if we should try next fallback
    const nextFallback = getNextFallback(
      mediaType,
      pipelineType,
      step.step_type as StepType,
      fallbackDepth,
      (result.failureCategory as any) ?? "unknown"
    );

    if (nextFallback) {
      console.log(
        `[media-worker] Step ${step.step_key}: ${providerConfig.model} failed (${result.failureCategory}), trying fallback ${nextFallback.model}`
      );

      await logEvent({
        job_id: jobId,
        step_id: step.id,
        event_type: "fallback_triggered",
        event_data: {
          fromModel: providerConfig.model,
          toModel: nextFallback.model,
          reason: result.errorMessage,
          failureCategory: result.failureCategory,
        },
      });

      // Update fallback depth on step
      await updateStep(step.id, { fallback_depth: fallbackDepth + 1 });
      fallbackDepth++;
    } else {
      // No more fallbacks
      return result;
    }
  }

  return {
    success: false,
    errorCode: "ALL_FALLBACKS_EXHAUSTED",
    errorMessage: "All provider fallbacks exhausted",
    failureCategory: "provider_permanent",
    retryable: false,
  };
}
