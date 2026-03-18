/**
 * asset_processing_dispatcher.ts — Phase 5I
 * Batch Job Dispatcher
 *
 * Responsibilities:
 *   - Poll queued jobs from knowledge_asset_processing_jobs
 *   - Assign jobs for execution
 *   - Prevent concurrent duplicate execution (INV-PROC-1)
 *   - Execute processors in batches
 *   - Track dispatch results
 *
 * Dispatch query:
 *   SELECT * FROM knowledge_asset_processing_jobs
 *   WHERE job_status = 'queued'
 *   ORDER BY created_at
 *   LIMIT batch_size
 */

import { eq, and, asc, inArray } from "drizzle-orm";
import { db } from "../../db";
import { knowledgeAssetProcessingJobs } from "@shared/schema";
import type { KnowledgeAssetProcessingJob } from "@shared/schema";
import { processAssetJob, type JobExecutionResult } from "./process_asset_job";
import { loadAllProcessors } from "./asset_processor_registry";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DispatchOptions {
  tenantId?: string;
  batchSize?: number;
  jobTypes?: string[];
}

export interface DispatchBatchResult {
  batchId: string;
  jobsFound: number;
  jobsDispatched: number;
  completed: number;
  failed: number;
  skipped: number;
  results: JobExecutionResult[];
  durationMs: number;
}

// ─── Poll queued jobs ─────────────────────────────────────────────────────────

async function pollQueuedJobs(
  opts: DispatchOptions,
): Promise<KnowledgeAssetProcessingJob[]> {
  const batchSize = opts.batchSize ?? 10;

  const query = db
    .select()
    .from(knowledgeAssetProcessingJobs)
    .where(eq(knowledgeAssetProcessingJobs.jobStatus, "queued"))
    .orderBy(asc(knowledgeAssetProcessingJobs.createdAt))
    .limit(batchSize);

  let jobs = await query;

  // Filter by tenant if specified
  if (opts.tenantId) {
    jobs = jobs.filter((j) => j.tenantId === opts.tenantId);
  }

  // Filter by job type if specified
  if (opts.jobTypes && opts.jobTypes.length > 0) {
    jobs = jobs.filter((j) => opts.jobTypes!.includes(j.jobType));
  }

  return jobs;
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Dispatch a batch of queued jobs.
 * Jobs are executed sequentially per tenant to respect INV-PROC-1.
 *
 * For production use, jobs from different tenants can be parallelized.
 * Within the same tenant, sequential execution prevents resource contention.
 */
export async function dispatchProcessingBatch(
  opts: DispatchOptions = {},
): Promise<DispatchBatchResult> {
  const start = Date.now();
  const batchId = `dispatch-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  await loadAllProcessors();

  const jobs = await pollQueuedJobs(opts);
  const results: JobExecutionResult[] = [];

  for (const job of jobs) {
    try {
      const result = await processAssetJob(job.id, job.tenantId);
      results.push(result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      results.push({
        jobId: job.id,
        jobType: job.jobType,
        status: "failed",
        assetId: job.assetId,
        attemptNumber: job.attemptNumber,
        errorMessage,
        durationMs: 0,
      });
    }
  }

  const completed = results.filter((r) => r.status === "completed").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  return {
    batchId,
    jobsFound: jobs.length,
    jobsDispatched: jobs.length,
    completed,
    failed,
    skipped,
    results,
    durationMs: Date.now() - start,
  };
}

/**
 * Get a queue health summary — observable without executing jobs.
 * INV-PROC-10: full observability.
 */
export async function getQueueHealthSummary(tenantId?: string): Promise<Record<string, unknown>> {
  const allJobs = await db
    .select()
    .from(knowledgeAssetProcessingJobs)
    .where(
      tenantId
        ? eq(knowledgeAssetProcessingJobs.tenantId, tenantId)
        : eq(knowledgeAssetProcessingJobs.jobStatus, knowledgeAssetProcessingJobs.jobStatus),
    )
    .orderBy(asc(knowledgeAssetProcessingJobs.createdAt));

  const byStatus = allJobs.reduce(
    (acc, j) => {
      acc[j.jobStatus] = (acc[j.jobStatus] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const byType = allJobs.reduce(
    (acc, j) => {
      acc[j.jobType] = (acc[j.jobType] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );

  const queued = byStatus["queued"] ?? 0;
  const started = byStatus["started"] ?? 0;
  const completed = byStatus["completed"] ?? 0;
  const failed = byStatus["failed"] ?? 0;

  // Detect potential orphans (started > 30 min ago)
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const potentialOrphans = allJobs.filter(
    (j) => j.jobStatus === "started" && j.startedAt && j.startedAt < cutoff,
  ).length;

  return {
    tenantId: tenantId ?? "all",
    totalJobs: allJobs.length,
    queued,
    started,
    completed,
    failed,
    skipped: byStatus["skipped"] ?? 0,
    cancelled: byStatus["cancelled"] ?? 0,
    potentialOrphans,
    byStatus,
    byType,
    queueHealthy: queued === 0 && started === 0 && potentialOrphans === 0,
    explanation: [
      `Total jobs: ${allJobs.length}`,
      `Queued: ${queued} | Started: ${started} | Completed: ${completed} | Failed: ${failed}`,
      potentialOrphans > 0 ? `WARNING: ${potentialOrphans} potential orphan jobs detected` : "No orphan jobs detected",
    ],
  };
}
