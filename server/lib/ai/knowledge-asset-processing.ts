/**
 * knowledge-asset-processing.ts — Phase 5G
 * Service layer for async multimodal asset processing jobs.
 * (Distinct from Phase 5B knowledge-processing.ts — document pipeline.)
 *
 * Design contracts:
 * - No actual OCR/transcription/ML execution in this phase.
 * - Job lifecycle is deterministic: queued → started → completed | failed.
 * - Jobs are append-oriented — no in-place status rewrites.
 * - Tenant isolation on every query.
 */

import { and, eq, desc } from "drizzle-orm";
import { db } from "../../db";
import {
  knowledgeAssetProcessingJobs,
  type InsertKnowledgeAssetProcessingJob,
  type KnowledgeAssetProcessingJob,
} from "@shared/schema";

// ─── Constants ────────────────────────────────────────────────────────────────

export const JOB_TYPES = [
  "parse_document",
  "ocr_image",
  "caption_image",
  "extract_video_metadata",
  "extract_audio",
  "transcribe_audio",
  "sample_video_frames",
  "segment_video",
  "chunk_text",
  "embed_text",
  "embed_image",
  "index_asset",
  "reindex_asset",
  "delete_index",
] as const;

export const JOB_STATUSES = [
  "queued",
  "started",
  "completed",
  "failed",
  "skipped",
  "cancelled",
] as const;

export type JobType = typeof JOB_TYPES[number];
export type JobStatus = typeof JOB_STATUSES[number];

// Deterministic transition graph
const VALID_TRANSITIONS: Record<JobStatus, JobStatus[]> = {
  queued:    ["started", "skipped", "cancelled"],
  started:   ["completed", "failed", "cancelled"],
  completed: [],
  failed:    [],
  skipped:   [],
  cancelled: [],
};

// ─── enqueueAssetProcessingJob ────────────────────────────────────────────────

export async function enqueueAssetProcessingJob(
  input: InsertKnowledgeAssetProcessingJob,
): Promise<KnowledgeAssetProcessingJob> {
  if (!JOB_TYPES.includes(input.jobType as JobType)) {
    throw new Error(`Invalid job_type: ${input.jobType}. Allowed: ${JOB_TYPES.join(", ")}`);
  }

  const jobStatus = (input.jobStatus ?? "queued") as JobStatus;
  if (jobStatus !== "queued") {
    throw new Error("New jobs must start in 'queued' status");
  }

  const [row] = await db
    .insert(knowledgeAssetProcessingJobs)
    .values({ ...input, jobStatus: "queued" })
    .returning();

  return row;
}

// ─── startAssetProcessingJob ──────────────────────────────────────────────────

export async function startAssetProcessingJob(
  jobId: string,
  tenantId: string,
): Promise<KnowledgeAssetProcessingJob> {
  const job = await _getJobById(jobId, tenantId);
  _assertTransition(job.jobStatus as JobStatus, "started");

  const [updated] = await db
    .update(knowledgeAssetProcessingJobs)
    .set({ jobStatus: "started", startedAt: new Date() })
    .where(
      and(
        eq(knowledgeAssetProcessingJobs.id, jobId),
        eq(knowledgeAssetProcessingJobs.tenantId, tenantId),
      ),
    )
    .returning();

  return updated;
}

// ─── completeAssetProcessingJob ───────────────────────────────────────────────

export async function completeAssetProcessingJob(
  jobId: string,
  tenantId: string,
  metadata?: Record<string, unknown>,
): Promise<KnowledgeAssetProcessingJob> {
  const job = await _getJobById(jobId, tenantId);
  _assertTransition(job.jobStatus as JobStatus, "completed");

  const [updated] = await db
    .update(knowledgeAssetProcessingJobs)
    .set({
      jobStatus: "completed",
      completedAt: new Date(),
      metadata: metadata ? (metadata as any) : job.metadata,
    })
    .where(
      and(
        eq(knowledgeAssetProcessingJobs.id, jobId),
        eq(knowledgeAssetProcessingJobs.tenantId, tenantId),
      ),
    )
    .returning();

  return updated;
}

// ─── failAssetProcessingJob ───────────────────────────────────────────────────

export async function failAssetProcessingJob(
  jobId: string,
  tenantId: string,
  errorMessage: string,
): Promise<KnowledgeAssetProcessingJob> {
  const job = await _getJobById(jobId, tenantId);
  _assertTransition(job.jobStatus as JobStatus, "failed");

  const [updated] = await db
    .update(knowledgeAssetProcessingJobs)
    .set({ jobStatus: "failed", errorMessage, completedAt: new Date() })
    .where(
      and(
        eq(knowledgeAssetProcessingJobs.id, jobId),
        eq(knowledgeAssetProcessingJobs.tenantId, tenantId),
      ),
    )
    .returning();

  return updated;
}

// ─── listAssetProcessingJobs ──────────────────────────────────────────────────

export async function listAssetProcessingJobs(
  tenantId: string,
  options?: {
    assetId?: string;
    jobType?: JobType;
    jobStatus?: JobStatus;
    limit?: number;
  },
): Promise<KnowledgeAssetProcessingJob[]> {
  const conditions = [eq(knowledgeAssetProcessingJobs.tenantId, tenantId)];

  if (options?.assetId) {
    conditions.push(eq(knowledgeAssetProcessingJobs.assetId, options.assetId));
  }
  if (options?.jobType) {
    conditions.push(eq(knowledgeAssetProcessingJobs.jobType, options.jobType));
  }
  if (options?.jobStatus) {
    conditions.push(eq(knowledgeAssetProcessingJobs.jobStatus, options.jobStatus));
  }

  return db
    .select()
    .from(knowledgeAssetProcessingJobs)
    .where(and(...conditions))
    .orderBy(desc(knowledgeAssetProcessingJobs.createdAt))
    .limit(options?.limit ?? 100);
}

// ─── explainAssetProcessingState ─────────────────────────────────────────────

export async function explainAssetProcessingState(
  tenantId: string,
  assetId: string,
): Promise<{
  assetId: string;
  tenantId: string;
  jobs: KnowledgeAssetProcessingJob[];
  totalJobs: number;
  queued: number;
  started: number;
  completed: number;
  failed: number;
  skipped: number;
  cancelled: number;
  hasActiveJob: boolean;
  lastJobType: string | null;
  lastJobStatus: string | null;
  explanation: string[];
}> {
  const jobs = await listAssetProcessingJobs(tenantId, { assetId, limit: 200 });

  const counts = { queued: 0, started: 0, completed: 0, failed: 0, skipped: 0, cancelled: 0 };
  for (const j of jobs) {
    const s = j.jobStatus as JobStatus;
    if (s in counts) counts[s]++;
  }

  const hasActiveJob = counts.queued > 0 || counts.started > 0;
  const lastJob = jobs[0] ?? null;

  const explanation: string[] = [
    `Asset processing state for ${assetId} (tenant=${tenantId})`,
    `Total jobs: ${jobs.length}`,
    `Queued: ${counts.queued} | Started: ${counts.started} | Completed: ${counts.completed}`,
    `Failed: ${counts.failed} | Skipped: ${counts.skipped} | Cancelled: ${counts.cancelled}`,
    `Active job in progress: ${hasActiveJob}`,
    lastJob
      ? `Last job: type=${lastJob.jobType} status=${lastJob.jobStatus} at=${lastJob.createdAt?.toISOString()}`
      : "No jobs recorded",
  ];

  return {
    assetId,
    tenantId,
    jobs,
    totalJobs: jobs.length,
    ...counts,
    hasActiveJob,
    lastJobType: lastJob?.jobType ?? null,
    lastJobStatus: lastJob?.jobStatus ?? null,
    explanation,
  };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

async function _getJobById(
  jobId: string,
  tenantId: string,
): Promise<KnowledgeAssetProcessingJob> {
  const [row] = await db
    .select()
    .from(knowledgeAssetProcessingJobs)
    .where(
      and(
        eq(knowledgeAssetProcessingJobs.id, jobId),
        eq(knowledgeAssetProcessingJobs.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (!row) throw new Error(`Processing job not found: ${jobId}`);
  return row;
}

function _assertTransition(current: JobStatus, next: JobStatus): void {
  const allowed = VALID_TRANSITIONS[current];
  if (!allowed.includes(next)) {
    throw new Error(
      `Invalid job status transition: ${current} → ${next}. Allowed from ${current}: ${allowed.join(", ") || "none"}`,
    );
  }
}
