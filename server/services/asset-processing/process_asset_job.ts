/**
 * process_asset_job.ts — Phase 5I
 * Job Execution Engine
 *
 * Execution flow:
 *   1. Load job (validate exists + tenant scope)
 *   2. Validate asset exists (INV-PROC-2: tenant isolation, INV-PROC-3: asset must exist)
 *   3. Mark job started
 *   4. Execute registered processor
 *   5. Mark job completed or failed (record error + attempt)
 *   6. On failure: update asset processing_state → failed if max retries exceeded
 *
 * INV-PROC-1: concurrent duplicate execution prevented via started-status guard
 * INV-PROC-6: failed jobs remain observable (error_message + attempt_number preserved)
 */

import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import { knowledgeAssets, knowledgeAssetVersions, knowledgeAssetProcessingJobs } from "@shared/schema";
import type { KnowledgeAssetProcessingJob } from "@shared/schema";
import {
  startAssetProcessingJob,
  completeAssetProcessingJob,
  failAssetProcessingJob,
} from "../../lib/ai/knowledge-asset-processing";
import { getProcessor, ProcessorNotFoundError, loadAllProcessors } from "./asset_processor_registry";
import type { ProcessorContext } from "./asset_processor_registry";

// ─── Constants ─────────────────────────────────────────────────────────────────

export const MAX_ATTEMPTS = 3;

export class AssetProcessingError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly jobId?: string,
  ) {
    super(message);
    this.name = "AssetProcessingError";
  }
}

// ─── Load helpers ──────────────────────────────────────────────────────────────

async function loadJob(jobId: string, tenantId: string): Promise<KnowledgeAssetProcessingJob> {
  const [job] = await db
    .select()
    .from(knowledgeAssetProcessingJobs)
    .where(
      and(
        eq(knowledgeAssetProcessingJobs.id, jobId),
        eq(knowledgeAssetProcessingJobs.tenantId, tenantId),
      ),
    )
    .limit(1);

  if (!job) {
    throw new AssetProcessingError(
      `Job ${jobId} not found for tenant ${tenantId} (INV-PROC-2)`,
      "JOB_NOT_FOUND",
      jobId,
    );
  }
  return job;
}

// ─── Main execution ────────────────────────────────────────────────────────────

export interface JobExecutionResult {
  jobId: string;
  jobType: string;
  status: "completed" | "failed" | "skipped";
  assetId: string;
  attemptNumber: number;
  nextJobType?: string;
  errorMessage?: string;
  outputMetadata?: Record<string, unknown>;
  durationMs: number;
}

export async function processAssetJob(
  jobId: string,
  tenantId: string,
): Promise<JobExecutionResult> {
  const start = Date.now();

  await loadAllProcessors();

  // Step 1: Load and validate job
  const job = await loadJob(jobId, tenantId);

  // INV-PROC-1: prevent duplicate concurrent execution
  if (job.jobStatus === "started") {
    throw new AssetProcessingError(
      `Job ${jobId} is already started — concurrent execution prevented (INV-PROC-1)`,
      "CONCURRENT_EXECUTION",
      jobId,
    );
  }

  if (job.jobStatus === "completed") {
    return {
      jobId,
      jobType: job.jobType,
      status: "skipped",
      assetId: job.assetId,
      attemptNumber: job.attemptNumber,
      outputMetadata: { skippedReason: "already completed" },
      durationMs: Date.now() - start,
    };
  }

  if (job.jobStatus === "cancelled" || job.jobStatus === "skipped") {
    return {
      jobId,
      jobType: job.jobType,
      status: "skipped",
      assetId: job.assetId,
      attemptNumber: job.attemptNumber,
      outputMetadata: { skippedReason: `job is ${job.jobStatus}` },
      durationMs: Date.now() - start,
    };
  }

  // Step 2: Load asset (INV-PROC-2/3)
  const [asset] = await db
    .select()
    .from(knowledgeAssets)
    .where(eq(knowledgeAssets.id, job.assetId))
    .limit(1);

  if (!asset) {
    throw new AssetProcessingError(
      `Asset ${job.assetId} not found (INV-PROC-3)`,
      "ASSET_NOT_FOUND",
      jobId,
    );
  }

  if (asset.tenantId !== tenantId) {
    throw new AssetProcessingError(
      `Tenant isolation violation: asset ${job.assetId} belongs to tenant ${asset.tenantId}, not ${tenantId} (INV-PROC-2)`,
      "TENANT_ISOLATION_VIOLATION",
      jobId,
    );
  }

  // Load version if present
  let version = null;
  if (job.assetVersionId) {
    const [v] = await db
      .select()
      .from(knowledgeAssetVersions)
      .where(eq(knowledgeAssetVersions.id, job.assetVersionId))
      .limit(1);
    version = v ?? null;
  }

  // Step 3: Mark started (INV-PROC-1: blocks second concurrent attempt)
  const startedJob = await startAssetProcessingJob(jobId, tenantId);

  // Build processor context
  const ctx: ProcessorContext = {
    job: startedJob,
    asset,
    version,
    tenantId,
  };

  try {
    // Step 4: Execute processor
    const processor = getProcessor(job.jobType);
    const result = await processor(ctx);

    if (!result.success) {
      // Processor signalled failure
      throw new Error(result.errorMessage ?? "Processor returned failure without message");
    }

    // Step 5: Mark completed
    await completeAssetProcessingJob(jobId, tenantId);

    return {
      jobId,
      jobType: job.jobType,
      status: "completed",
      assetId: job.assetId,
      attemptNumber: startedJob.attemptNumber,
      nextJobType: result.nextJobType,
      outputMetadata: result.outputMetadata,
      durationMs: Date.now() - start,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Step 5b: Mark failed (INV-PROC-6: error preserved)
    await failAssetProcessingJob(jobId, tenantId, errorMessage);

    // Update asset processing_state → failed if max retries exceeded
    if (job.attemptNumber >= MAX_ATTEMPTS) {
      await db
        .update(knowledgeAssets)
        .set({ processingState: "failed", updatedAt: new Date() })
        .where(eq(knowledgeAssets.id, job.assetId));
    }

    return {
      jobId,
      jobType: job.jobType,
      status: "failed",
      assetId: job.assetId,
      attemptNumber: startedJob.attemptNumber,
      errorMessage,
      durationMs: Date.now() - start,
    };
  }
}

// ─── Retry helper ──────────────────────────────────────────────────────────────

/**
 * Retry a failed job by creating a new queued attempt.
 * Applies exponential backoff delay (observational — no built-in sleep;
 * caller is responsible for delay if needed).
 *
 * INV-PROC-5: retry is idempotent — creates a fresh job row.
 */
export async function retryAssetProcessingJob(
  failedJobId: string,
  tenantId: string,
): Promise<KnowledgeAssetProcessingJob> {
  const job = await loadJob(failedJobId, tenantId);

  if (job.jobStatus !== "failed") {
    throw new AssetProcessingError(
      `Only failed jobs can be retried — job ${failedJobId} is '${job.jobStatus}'`,
      "INVALID_RETRY_STATUS",
      failedJobId,
    );
  }

  const nextAttempt = job.attemptNumber + 1;
  if (nextAttempt > MAX_ATTEMPTS) {
    throw new AssetProcessingError(
      `Max retry attempts (${MAX_ATTEMPTS}) reached for job ${failedJobId}`,
      "MAX_ATTEMPTS_EXCEEDED",
      failedJobId,
    );
  }

  const [newJob] = await db
    .insert(knowledgeAssetProcessingJobs)
    .values({
      tenantId: job.tenantId,
      assetId: job.assetId,
      assetVersionId: job.assetVersionId,
      jobType: job.jobType,
      jobStatus: "queued",
      attemptNumber: nextAttempt,
      metadata: {
        ...(job.metadata as Record<string, unknown> ?? {}),
        retriedFromJobId: failedJobId,
        retryAttempt: nextAttempt,
        exponentialBackoffSeconds: Math.pow(2, nextAttempt - 1) * 30,
      },
    })
    .returning();

  return newJob;
}

// ─── Observability helpers ─────────────────────────────────────────────────────

/**
 * Detect orphan jobs — started but not completed within a timeout window.
 * INV-PROC-7 + INV-PROC-8: orphan and timeout detection.
 */
export async function detectOrphanJobs(
  tenantId: string,
  timeoutMinutes: number = 30,
): Promise<KnowledgeAssetProcessingJob[]> {
  const cutoff = new Date(Date.now() - timeoutMinutes * 60 * 1000);

  const jobs = await db
    .select()
    .from(knowledgeAssetProcessingJobs)
    .where(
      and(
        eq(knowledgeAssetProcessingJobs.tenantId, tenantId),
        eq(knowledgeAssetProcessingJobs.jobStatus, "started"),
      ),
    );

  // Filter: started before the timeout cutoff (i.e., running too long)
  return jobs.filter((j) => j.startedAt && j.startedAt < cutoff);
}

/**
 * Full observability for a single job (INV-PROC-10).
 */
export function explainJobExecution(job: KnowledgeAssetProcessingJob): Record<string, unknown> {
  const isTimedOut =
    job.jobStatus === "started" &&
    job.startedAt &&
    Date.now() - job.startedAt.getTime() > 30 * 60 * 1000;

  return {
    jobId: job.id,
    jobType: job.jobType,
    jobStatus: job.jobStatus,
    assetId: job.assetId,
    assetVersionId: job.assetVersionId,
    tenantId: job.tenantId,
    attemptNumber: job.attemptNumber,
    maxAttempts: MAX_ATTEMPTS,
    canRetry: job.jobStatus === "failed" && job.attemptNumber < MAX_ATTEMPTS,
    isOrphan: isTimedOut,
    isTimedOut,
    errorMessage: job.errorMessage ?? null,
    startedAt: job.startedAt ?? null,
    completedAt: job.completedAt ?? null,
    createdAt: job.createdAt,
    metadata: job.metadata,
    explanation: [
      `Job type: ${job.jobType}`,
      `Status: ${job.jobStatus}`,
      `Attempt ${job.attemptNumber} of ${MAX_ATTEMPTS}`,
      job.errorMessage ? `Error: ${job.errorMessage}` : null,
      isTimedOut ? "WARNING: Job appears to be timed out (running >30 min)" : null,
    ].filter(Boolean),
  };
}
