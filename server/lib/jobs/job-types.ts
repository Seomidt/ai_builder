/**
 * job-types.ts — Shared type definitions for the DB-backed job queue.
 *
 * Designed to be swappable with an external queue (Redis/pg-boss/Upstash)
 * without changing business logic — only the implementation in job-queue.ts
 * would need to change.
 */

// ── Job lifecycle states ───────────────────────────────────────────────────────
// pending     → waiting to be picked up by a worker
// running     → claimed and being processed by exactly one worker
// completed   → successfully processed
// failed      → failed this attempt, will retry if attempt_count < max_attempts
// dead_letter → permanently failed — max retries exceeded, requires manual review

export type JobStatus = "pending" | "running" | "completed" | "failed" | "dead_letter";

// ── Stage labels (sub-state within 'running') ─────────────────────────────────
// ocr         → OCR model call in progress
// chunking    → splitting text into overlapping chunks
// embedding   → generating vector embeddings for chunks
// storing     → writing chunks to DB

export type JobStage = "ocr" | "chunking" | "embedding" | "storing" | null;

// ── Backoff schedule (seconds) ────────────────────────────────────────────────
// retry 1 → +30s, retry 2 → +2m, retry 3 → +10m, retry 4+ → +30m
export const RETRY_BACKOFF_MS: readonly number[] = [
  30_000,      // retry 1
  120_000,     // retry 2
  600_000,     // retry 3
  1_800_000,   // retry 4+
] as const;

/** Compute the earliest timestamp a failed job may be retried. */
export function nextRetryTimestamp(retryCount: number): Date {
  const delay = RETRY_BACKOFF_MS[Math.min(retryCount, RETRY_BACKOFF_MS.length - 1)];
  return new Date(Date.now() + delay);
}

// ── OCR job payload ───────────────────────────────────────────────────────────

export interface OcrJobPayload {
  tenantId:    string;
  userId:      string;
  r2Key:       string;
  filename:    string;
  contentType: string;
  /** SHA-256 of file content — enables idempotent deduplication within a tenant. */
  fileHash?:   string;
}

// ── OCR job row (from DB) ─────────────────────────────────────────────────────

export interface OcrJob {
  id:              string;
  tenantId:        string;
  userId:          string;
  r2Key:           string;
  filename:        string;
  contentType:     string;
  fileHash:        string | null;
  status:          JobStatus;
  provider:        string | null;
  attemptCount:    number;
  maxAttempts:     number;
  retryCount:      number;
  nextRetryAt:     string | null;
  lastError:       string | null;
  stage:           JobStage;
  pagesProcessed:  number;
  chunksProcessed: number;
  ocrText:         string | null;
  qualityScore:    string | null;
  charCount:       number | null;
  pageCount:       number | null;
  chunkCount:      number | null;
  errorReason:     string | null;
  createdAt:       string;
  startedAt:       string | null;
  completedAt:     string | null;
}

// ── Completion data ───────────────────────────────────────────────────────────

export interface OcrJobCompletion {
  ocrText:      string;
  qualityScore: number;
  charCount:    number;
  pageCount:    number;
  chunkCount:   number;
  provider:     string;
}
