/**
 * Phase 27 — Job Queue Inspector
 * Provides operational visibility into knowledge processing jobs.
 *
 * Covers: active jobs, failed jobs, retry state, throughput metrics.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface JobQueueSummary {
  queued:    number;
  running:   number;
  completed: number;
  failed:    number;
  cancelled: number;
  total:     number;
}

export interface JobThroughputMetrics {
  period:        string; // e.g. "last_1h" | "last_24h" | "last_7d"
  completed:     number;
  failed:        number;
  successRate:   number; // 0–1
  avgDurationMs: number | null;
  peakQueueDepth: number;
}

export interface FailedJobEntry {
  id:            string;
  tenantId:      string;
  jobType:       string;
  attemptCount:  number;
  maxAttempts:   number;
  failureReason: string | null;
  createdAt:     string;
  lastRetryAt:   string | null;
  retryExhausted: boolean;
}

export interface ActiveJobEntry {
  id:           string;
  tenantId:     string;
  jobType:      string;
  status:       string;
  priority:     number;
  attemptCount: number;
  startedAt:    string | null;
  lockedAt:     string | null;
  heartbeatAt:  string | null;
  ageSeconds:   number;
}

export interface JobTypeBreakdown {
  jobType:   string;
  queued:    number;
  running:   number;
  completed: number;
  failed:    number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeNum(val: unknown): number {
  const n = Number(val); return isNaN(n) ? 0 : n;
}

// ── Queue Summary ─────────────────────────────────────────────────────────────

export async function getJobQueueSummary(tenantId?: string): Promise<JobQueueSummary> {
  const where = tenantId ? `WHERE tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";
  const r = await db.execute(sql.raw(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued')    AS queued,
      COUNT(*) FILTER (WHERE status = 'running')   AS running,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status = 'failed')    AS failed,
      COUNT(*) FILTER (WHERE status = 'cancelled') AS cancelled,
      COUNT(*)                                     AS total
    FROM knowledge_processing_jobs
    ${where}
  `));
  const row = (r.rows[0] as any) ?? {};
  return {
    queued:    safeNum(row.queued),
    running:   safeNum(row.running),
    completed: safeNum(row.completed),
    failed:    safeNum(row.failed),
    cancelled: safeNum(row.cancelled),
    total:     safeNum(row.total),
  };
}

// ── Active Jobs ───────────────────────────────────────────────────────────────

export async function getActiveJobs(limit = 50, tenantId?: string): Promise<ActiveJobEntry[]> {
  const now = new Date().toISOString();
  const filter = tenantId ? `AND tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";
  const r = await db.execute(sql.raw(`
    SELECT
      id, tenant_id, job_type, status, priority, attempt_count,
      started_at, locked_at, heartbeat_at, created_at,
      EXTRACT(EPOCH FROM (NOW() - created_at)) AS age_seconds
    FROM knowledge_processing_jobs
    WHERE status IN ('queued','running')
    ${filter}
    ORDER BY priority ASC, created_at ASC
    LIMIT ${limit}
  `));
  return (r.rows as any[]).map(row => ({
    id:           row.id,
    tenantId:     row.tenant_id,
    jobType:      row.job_type,
    status:       row.status,
    priority:     safeNum(row.priority),
    attemptCount: safeNum(row.attempt_count),
    startedAt:    row.started_at ? new Date(row.started_at).toISOString() : null,
    lockedAt:     row.locked_at  ? new Date(row.locked_at).toISOString()  : null,
    heartbeatAt:  row.heartbeat_at ? new Date(row.heartbeat_at).toISOString() : null,
    ageSeconds:   safeNum(row.age_seconds),
  }));
}

// ── Failed Jobs ───────────────────────────────────────────────────────────────

export async function getFailedJobs(limit = 50, tenantId?: string): Promise<FailedJobEntry[]> {
  const filter = tenantId ? `AND tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";
  const r = await db.execute(sql.raw(`
    SELECT id, tenant_id, job_type, attempt_count, max_attempts,
           failure_reason, created_at, started_at
    FROM knowledge_processing_jobs
    WHERE status = 'failed'
    ${filter}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `));
  return (r.rows as any[]).map(row => ({
    id:             row.id,
    tenantId:       row.tenant_id,
    jobType:        row.job_type,
    attemptCount:   safeNum(row.attempt_count),
    maxAttempts:    safeNum(row.max_attempts),
    failureReason:  row.failure_reason ?? null,
    createdAt:      new Date(row.created_at).toISOString(),
    lastRetryAt:    row.started_at ? new Date(row.started_at).toISOString() : null,
    retryExhausted: safeNum(row.attempt_count) >= safeNum(row.max_attempts),
  }));
}

// ── Retry Status ──────────────────────────────────────────────────────────────

export interface RetryStatusReport {
  retryExhaustedCount: number;
  retryPendingCount:   number;
  retrySuccessCount:   number;
  exhaustedRatio:      number;
}

export async function getRetryStatus(tenantId?: string): Promise<RetryStatusReport> {
  const filter = tenantId ? `AND tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";
  const r = await db.execute(sql.raw(`
    SELECT
      COUNT(*) FILTER (WHERE status='failed' AND attempt_count >= max_attempts) AS exhausted,
      COUNT(*) FILTER (WHERE status='failed' AND attempt_count < max_attempts)  AS retry_pending,
      COUNT(*) FILTER (WHERE status='completed' AND attempt_count > 1)          AS retry_success
    FROM knowledge_processing_jobs
    WHERE status IN ('failed','completed')
    ${filter}
  `));
  const row = (r.rows[0] as any) ?? {};
  const exhausted     = safeNum(row.exhausted);
  const retryPending  = safeNum(row.retry_pending);
  const retrySuccess  = safeNum(row.retry_success);
  const total         = exhausted + retryPending + retrySuccess;
  return {
    retryExhaustedCount: exhausted,
    retryPendingCount:   retryPending,
    retrySuccessCount:   retrySuccess,
    exhaustedRatio:      total > 0 ? exhausted / total : 0,
  };
}

// ── Throughput Metrics ────────────────────────────────────────────────────────

export async function getJobThroughput(
  windowHours: 1 | 24 | 168,
  tenantId?: string,
): Promise<JobThroughputMetrics> {
  const cutoff = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const filter = tenantId ? `AND tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";
  const periodLabel = windowHours === 1 ? "last_1h" : windowHours === 24 ? "last_24h" : "last_7d";

  const [throughputRow, depthRow] = await Promise.all([
    db.execute(sql.raw(`
      SELECT
        COUNT(*) FILTER (WHERE status='completed') AS completed,
        COUNT(*) FILTER (WHERE status='failed')    AS failed,
        AVG(
          EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
        ) FILTER (WHERE status='completed' AND completed_at IS NOT NULL AND started_at IS NOT NULL) AS avg_ms
      FROM knowledge_processing_jobs
      WHERE created_at >= '${cutoff}'
      ${filter}
    `)),
    db.execute(sql.raw(`
      SELECT MAX(cnt) AS peak FROM (
        SELECT COUNT(*) AS cnt
        FROM knowledge_processing_jobs
        WHERE status IN ('queued','running')
          AND created_at >= '${cutoff}'
          ${filter}
        GROUP BY DATE_TRUNC('minute', created_at)
      ) t
    `)),
  ]);

  const t   = (throughputRow.rows[0] as any) ?? {};
  const d   = (depthRow.rows[0]     as any) ?? {};
  const completed = safeNum(t.completed);
  const failed    = safeNum(t.failed);
  const total     = completed + failed;

  return {
    period:        periodLabel,
    completed,
    failed,
    successRate:   total > 0 ? completed / total : 1,
    avgDurationMs: t.avg_ms != null ? safeNum(t.avg_ms) : null,
    peakQueueDepth: safeNum(d.peak),
  };
}

// ── Job Type Breakdown ────────────────────────────────────────────────────────

export async function getJobTypeBreakdown(tenantId?: string): Promise<JobTypeBreakdown[]> {
  const filter = tenantId ? `WHERE tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";
  const r = await db.execute(sql.raw(`
    SELECT
      job_type,
      COUNT(*) FILTER (WHERE status='queued')    AS queued,
      COUNT(*) FILTER (WHERE status='running')   AS running,
      COUNT(*) FILTER (WHERE status='completed') AS completed,
      COUNT(*) FILTER (WHERE status='failed')    AS failed
    FROM knowledge_processing_jobs
    ${filter}
    GROUP BY job_type
    ORDER BY (COUNT(*) FILTER (WHERE status IN ('queued','running'))) DESC
  `));
  return (r.rows as any[]).map(row => ({
    jobType:   row.job_type,
    queued:    safeNum(row.queued),
    running:   safeNum(row.running),
    completed: safeNum(row.completed),
    failed:    safeNum(row.failed),
  }));
}

// ── Stale Jobs (running but no heartbeat) ────────────────────────────────────

export interface StaleJobEntry {
  id:           string;
  tenantId:     string;
  jobType:      string;
  startedAt:    string | null;
  heartbeatAt:  string | null;
  staleSeconds: number;
}

export async function getStaleJobs(thresholdMinutes = 30): Promise<StaleJobEntry[]> {
  const r = await db.execute(sql.raw(`
    SELECT id, tenant_id, job_type, started_at, heartbeat_at,
           EXTRACT(EPOCH FROM (NOW() - COALESCE(heartbeat_at, started_at, created_at))) AS stale_sec
    FROM knowledge_processing_jobs
    WHERE status = 'running'
      AND COALESCE(heartbeat_at, started_at, created_at) < NOW() - INTERVAL '${thresholdMinutes} minutes'
    ORDER BY stale_sec DESC
    LIMIT 100
  `));
  return (r.rows as any[]).map(row => ({
    id:           row.id,
    tenantId:     row.tenant_id,
    jobType:      row.job_type,
    startedAt:    row.started_at   ? new Date(row.started_at).toISOString()   : null,
    heartbeatAt:  row.heartbeat_at ? new Date(row.heartbeat_at).toISOString() : null,
    staleSeconds: safeNum(row.stale_sec),
  }));
}
