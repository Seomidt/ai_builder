/**
 * Phase 19 — Job Dispatcher
 * Enqueue, cancel, and inspect background jobs.
 *
 * INV-JOB1: Jobs have canonical unique IDs.
 * INV-JOB6: Idempotent execution via idempotencyKey.
 * INV-JOB5: Tenant-safe — no cross-tenant job access.
 */

import { db } from "../../db.ts";
import { jobs } from "@shared/schema";
import { eq, sql as drizzleSql } from "drizzle-orm";

const VALID_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
const VALID_JOB_TYPES = [
  "ingestion_pipeline",
  "evaluation_run",
  "agent_workflow",
  "ai_orchestration",
  "scheduled_task",
  "report_generation",
  "data_export",
  "embedding_rebuild",
  "budget_snapshot",
  "anomaly_scan",
] as const;

export type JobType = (typeof VALID_JOB_TYPES)[number] | string;

export interface DispatchJobParams {
  jobType: JobType;
  tenantId?: string;
  payload?: Record<string, unknown>;
  priority?: number;
  idempotencyKey?: string;
  maxAttempts?: number;
  retryPolicy?: { backoffMs?: number; multiplier?: number; maxBackoffMs?: number };
  scheduledAt?: Date;
}

export interface DispatchResult {
  id: string;
  jobType: string;
  status: string;
  idempotent: boolean;
}

/**
 * Dispatch (enqueue) a new background job.
 * INV-JOB6: If idempotencyKey is provided and a pending/running job with
 * the same key exists, returns the existing job instead of creating a duplicate.
 */
export async function dispatchJob(params: DispatchJobParams): Promise<DispatchResult> {
  if (!params.jobType?.trim()) throw new Error("jobType is required");

  const priority = Math.min(10, Math.max(1, params.priority ?? 5));
  const maxAttempts = Math.min(10, Math.max(1, params.maxAttempts ?? 3));

  // INV-JOB6: Idempotency check
  if (params.idempotencyKey) {
    const existing = await db.execute(drizzleSql`
      SELECT id, job_type, status FROM jobs
      WHERE idempotency_key = ${params.idempotencyKey}
        AND status IN ('pending', 'running')
      LIMIT 1
    `);
    if (existing.rows.length > 0) {
      const row = existing.rows[0] as Record<string, unknown>;
      return { id: row.id as string, jobType: row.job_type as string, status: row.status as string, idempotent: true };
    }
  }

  const rows = await db
    .insert(jobs)
    .values({
      jobType: params.jobType.trim(),
      tenantId: params.tenantId ?? null,
      payload: (params.payload ?? null) as Record<string, unknown> | null,
      status: "pending",
      priority,
      idempotencyKey: params.idempotencyKey ?? null,
      maxAttempts,
      retryPolicy: (params.retryPolicy ?? null) as Record<string, unknown> | null,
      scheduledAt: params.scheduledAt ?? null,
    })
    .returning({ id: jobs.id, jobType: jobs.jobType, status: jobs.status });

  return { ...rows[0], idempotent: false };
}

/**
 * Cancel a pending job. Running/completed jobs cannot be cancelled.
 */
export async function cancelJob(jobId: string, tenantId?: string): Promise<{ cancelled: boolean; reason?: string }> {
  const rows = await db.execute(drizzleSql`
    SELECT id, status, tenant_id FROM jobs WHERE id = ${jobId} LIMIT 1
  `);
  const job = rows.rows[0] as Record<string, unknown> | undefined;
  if (!job) return { cancelled: false, reason: "Job not found" };
  if (tenantId && job.tenant_id !== tenantId) return { cancelled: false, reason: "Not authorized" };
  if (job.status !== "pending") return { cancelled: false, reason: `Cannot cancel job in status '${job.status as string}'` };

  await db.execute(drizzleSql`
    UPDATE jobs SET status = 'cancelled', updated_at = NOW() WHERE id = ${jobId}
  `);
  return { cancelled: true };
}

/**
 * List jobs with optional filters. Tenant-safe — always filters by tenantId if provided.
 */
export async function listJobs(filter?: {
  tenantId?: string;
  status?: string;
  jobType?: string;
  limit?: number;
}): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(filter?.limit ?? 50, 200);
  const tenantClause = filter?.tenantId ? drizzleSql`AND tenant_id = ${filter.tenantId}` : drizzleSql``;
  const statusClause = filter?.status ? drizzleSql`AND status = ${filter.status}` : drizzleSql``;
  const typeClause = filter?.jobType ? drizzleSql`AND job_type = ${filter.jobType}` : drizzleSql``;

  const rows = await db.execute(drizzleSql`
    SELECT id, job_type, tenant_id, status, priority, max_attempts, idempotency_key, scheduled_at, created_at
    FROM jobs
    WHERE 1=1 ${tenantClause} ${statusClause} ${typeClause}
    ORDER BY priority ASC, created_at ASC
    LIMIT ${limit}
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * Get a single job with full detail.
 */
export async function getJob(jobId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM jobs WHERE id = ${jobId} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

/**
 * Mark a job status transition (internal use — called by job-runner).
 */
export async function updateJobStatus(
  jobId: string,
  status: string,
): Promise<{ updated: boolean }> {
  await db.execute(drizzleSql`
    UPDATE jobs SET status = ${status}, updated_at = NOW() WHERE id = ${jobId}
  `);
  return { updated: true };
}
