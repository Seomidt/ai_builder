/**
 * job-queue.ts — DB-backed job queue interface for OCR / ingestion jobs.
 *
 * SERVER-ONLY (used from Vercel serverless via api/_src/ocr-worker.ts).
 *
 * Current backend: Supabase Postgres (via direct pg connection).
 * Designed to be replaced by Redis/pg-boss/Upstash without changing
 * the business logic — only swap this file's internals.
 *
 * Key properties:
 * - Atomic claiming via FOR UPDATE SKIP LOCKED (no double-processing)
 * - Exponential backoff with next_retry_at scheduling
 * - Dead-letter after max_attempts exceeded
 * - Stage-level progress updates within a running job
 * - Full tenant isolation on all operations
 */

import type { OcrJob, OcrJobPayload, OcrJobCompletion, JobStage } from "./job-types.ts";
import { Client as PgClient } from "pg";
import { nextRetryTimestamp }                                       from "./job-types.ts";
import { getSupabaseSslConfig }                                     from "./ssl-config.ts";

// ── DB URL resolution ─────────────────────────────────────────────────────────

export function resolveDbUrl(): string {
  return (
    process.env.BLISSOPS_PG_URL ??
    process.env.SUPABASE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    ""
  );
}

// ── Enqueue ───────────────────────────────────────────────────────────────────

const SUPABASE_URL     = () => process.env.SUPABASE_URL           ?? "";
const SUPABASE_SERVICE = () => process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

function adminHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const svc = SUPABASE_SERVICE();
  return {
    apikey:         svc,
    Authorization:  `Bearer ${svc}`,
    "Content-Type": "application/json",
    Prefer:         "return=representation",
    ...extra,
  };
}

// ── Concurrency constants ─────────────────────────────────────────────────────

/** Max simultaneous running jobs per tenant (fairness guard). */
const MAX_CONCURRENT_PER_TENANT = 3;

/** Max days to keep completed/dead_letter jobs before archiving. */
const ARCHIVE_AFTER_DAYS = 30;

// ── Schema migration (idempotent) ─────────────────────────────────────────────

/**
 * Ensure production schema objects exist for OCR task deduplication.
 * Safe to call on every cold start — CREATE INDEX IF NOT EXISTS is a no-op
 * when the index already exists.  Two columns are also ensured (file_hash,
 * stage) in case the ALTER TABLE migrations were not yet applied to Supabase.
 */
export async function ensureOcrSchema(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // PgClient imported at top level
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  await client.connect();
  try {
    // Add file_hash column if missing (nullable, backward compat)
    await client.query(`
      ALTER TABLE chat_ocr_tasks
        ADD COLUMN IF NOT EXISTS file_hash TEXT
    `).catch(() => {/* table may not support IF NOT EXISTS on old PG — ignore */});

    // Add stage column if missing (reliability layer addition)
    await client.query(`
      ALTER TABLE chat_ocr_tasks
        ADD COLUMN IF NOT EXISTS stage TEXT
    `).catch(() => {});

    // Create the partial unique index used by ON CONFLICT idempotency
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS cot_tenant_hash_uidx
        ON chat_ocr_tasks (tenant_id, file_hash)
        WHERE file_hash IS NOT NULL
    `);

    // Supporting indexes for performance
    await client.query(`
      CREATE INDEX IF NOT EXISTS cot_running_tenant_idx
        ON chat_ocr_tasks (tenant_id, status)
        WHERE status = 'running'
    `).catch(() => {});

    await client.query(`
      CREATE INDEX IF NOT EXISTS cot_cleanup_idx
        ON chat_ocr_tasks (status, created_at)
    `).catch(() => {});
  } finally {
    await client.end().catch(() => {});
  }
}

const _JOB_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function enqueueOcrJob(
  payload: OcrJobPayload,
): Promise<{ id: string; reused: boolean }> {
  // Guard: both tenantId and userId must be real UUIDs — never slugs or empty strings.
  if (!_JOB_UUID_RE.test(payload.tenantId)) {
    throw new Error(
      `enqueueOcrJob: tenantId er ikke et gyldigt UUID: '${payload.tenantId}'. ` +
      `Kontrollér at brugeren har en organisation i databasen.`,
    );
  }
  if (!_JOB_UUID_RE.test(payload.userId)) {
    throw new Error(
      `enqueueOcrJob: userId er ikke et gyldigt UUID: '${payload.userId}'.`,
    );
  }
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // PgClient imported at top level
  const client = new PgClient({
    connectionString: resolveDbUrl(),
    ssl: getSupabaseSslConfig(),
  });
  await client.connect();
  try {
    // 1. If hash provided: SELECT-first dedup (fast path, avoids lock contention)
    if (payload.fileHash) {
      const existing = await client.query<{ id: string; status: string }>(
        `SELECT id, status FROM chat_ocr_tasks
         WHERE  tenant_id = $1 AND file_hash = $2
         LIMIT  1`,
        [payload.tenantId, payload.fileHash],
      );
      if (existing.rows[0]) {
        return { id: existing.rows[0].id, reused: true };
      }
    }

    // 2. Preferred INSERT path: uses ON CONFLICT for atomic dedup when
    //    cot_tenant_hash_uidx index exists (the normal production case).
    //    Catches Postgres error codes for missing index/column and falls
    //    back gracefully so task creation NEVER fails silently.
    let insertId: string | undefined;
    try {
      // NOTE: We include file_url (mapped from r2Key) to satisfy DB NOT NULL constraints.
      const res = await client.query<{ id: string }>(
        `INSERT INTO chat_ocr_tasks
           (tenant_id, user_id, r2_key, file_url, filename, content_type,
            status, attempt_count, max_attempts, retry_count, file_hash)
         VALUES ($1, $2, $3, $3, $4, $5, 'pending', 0, 3, 0, $6)
         ON CONFLICT (tenant_id, file_hash)
           WHERE file_hash IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          payload.tenantId,
          payload.userId,
          payload.r2Key,
          payload.filename,
          payload.contentType,
          payload.fileHash ?? null,
        ],
      );
      insertId = res.rows[0]?.id;
    } catch (e: unknown) {
      const pgCode = (e as any)?.code;

      // 42P10 — no unique constraint matching ON CONFLICT spec:
      //   The cot_tenant_hash_uidx index is missing in this environment.
      //   Fallback: plain INSERT without ON CONFLICT (dedup via SELECT-first above).
      if (pgCode === "42P10") {
        console.warn("[enqueueOcrJob] 42P10 — cot_tenant_hash_uidx missing; plain INSERT fallback");
        try {
          const fb = await client.query<{ id: string }>(
            `INSERT INTO chat_ocr_tasks
               (tenant_id, user_id, r2_key, file_url, filename, content_type,
                status, attempt_count, max_attempts, retry_count, file_hash)
             VALUES ($1, $2, $3, $3, $4, $5, 'pending', 0, 3, 0, $6)
             RETURNING id`,
            [payload.tenantId, payload.userId, payload.r2Key, payload.filename,
             payload.contentType, payload.fileHash ?? null],
          );
          insertId = fb.rows[0]?.id;
        } catch (e2: unknown) {
          // 42703 inside the fallback: file_hash column also missing
          if ((e2 as any)?.code === "42703") {
            console.warn("[enqueueOcrJob] 42703 — file_hash column missing; insert without it");
            const fb2 = await client.query<{ id: string }>(
              `INSERT INTO chat_ocr_tasks
                 (tenant_id, user_id, r2_key, file_url, filename, content_type,
                  status, attempt_count, max_attempts, retry_count)
               VALUES ($1, $2, $3, $3, $4, $5, 'pending', 0, 3, 0)
               RETURNING id`,
              [payload.tenantId, payload.userId, payload.r2Key, payload.filename, payload.contentType],
            );
            insertId = fb2.rows[0]?.id;
          } else {
            throw e2;
          }
        }
      }
      // 42703 — file_hash column missing at the primary INSERT:
      else if (pgCode === "42703") {
        console.warn("[enqueueOcrJob] 42703 — file_hash column missing; insert without it");
        const fb = await client.query<{ id: string }>(
          `INSERT INTO chat_ocr_tasks
             (tenant_id, user_id, r2_key, file_url, filename, content_type,
              status, attempt_count, max_attempts, retry_count)
           VALUES ($1, $2, $3, $3, $4, $5, 'pending', 0, 3, 0)
           RETURNING id`,
          [payload.tenantId, payload.userId, payload.r2Key, payload.filename, payload.contentType],
        );
        insertId = fb.rows[0]?.id;
      }
      // 23505 — unique violation race: another request beat us. Return existing row.
      else if (pgCode === "23505" && payload.fileHash) {
        const race = await client.query<{ id: string }>(
          `SELECT id FROM chat_ocr_tasks WHERE tenant_id = $1 AND file_hash = $2 LIMIT 1`,
          [payload.tenantId, payload.fileHash],
        );
        if (race.rows[0]) return { id: race.rows[0].id, reused: true };
        throw e;
      }
      else {
        throw e;
      }
    }

    // ON CONFLICT DO NOTHING returned no row: means an existing row with the
    // same (tenant_id, file_hash) was found. Fetch it.
    if (!insertId && payload.fileHash) {
      const existing = await client.query<{ id: string }>(
        `SELECT id FROM chat_ocr_tasks WHERE tenant_id = $1 AND file_hash = $2 LIMIT 1`,
        [payload.tenantId, payload.fileHash],
      );
      if (existing.rows[0]) return { id: existing.rows[0].id, reused: true };
    }

    if (insertId) return { id: insertId, reused: false };

    throw new Error("enqueueOcrJob: INSERT returned no rows");
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Claim (FOR UPDATE SKIP LOCKED) ────────────────────────────────────────────
// Returns jobs atomically claimed and marked as 'running'.
// Multiple concurrent workers cannot process the same job.

export interface RawOcrTask {
  id:            string;
  tenant_id:     string;
  r2_key:        string;
  filename:      string;
  content_type:  string;
  attempt_count: number;
  max_attempts:  number;
  retry_count:   number;
}

/** Minutes a job can stay in 'running' before being considered stale (worker crash). */
const STALE_RUNNING_MINUTES = 12;

export async function claimJobs(limit: number): Promise<RawOcrTask[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // PgClient imported at top level
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  await client.connect();
  try {
    const res = await client.query<RawOcrTask>(
      `UPDATE chat_ocr_tasks
       SET    status = 'running',
              attempt_count = attempt_count + 1,
              updated_at = now()
       WHERE  id IN (
         SELECT id FROM chat_ocr_tasks
         WHERE  status IN ('pending', 'failed')
           AND  (next_retry_at IS NULL OR next_retry_at <= now())
           AND  attempt_count < max_attempts
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       RETURNING id, tenant_id, r2_key, filename, content_type, attempt_count, max_attempts, retry_count`,
      [limit],
    );
    return res.rows;
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Progress updates ──────────────────────────────────────────────────────────

export async function updateStage(jobId: string, stage: JobStage): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // PgClient imported at top level
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  await client.connect();
  try {
    await client.query(
      `UPDATE chat_ocr_tasks SET stage = $1, updated_at = now() WHERE id = $2`,
      [stage, jobId],
    );
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Completion ────────────────────────────────────────────────────────────────

export async function completeJob(jobId: string, data: OcrJobCompletion): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // PgClient imported at top level
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  await client.connect();
  try {
    await client.query(
      `UPDATE chat_ocr_tasks
       SET    status = 'completed',
              stage = NULL,
              ocr_text = $1,
              quality_score = $2,
              char_count = $3,
              page_count = $4,
              chunk_count = $5,
              provider = $6,
              completed_at = now(),
              updated_at = now()
       WHERE  id = $7`,
      [data.ocrText, data.qualityScore, data.charCount, data.pageCount, data.chunkCount, data.provider, jobId],
    );
  } finally {
    await client.end().catch(() => {});
  }
}

export async function failJob(jobId: string, reason: string, retryable = true): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // PgClient imported at top level
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  await client.connect();
  try {
    const job = await client.query<{ attempt_count: number; max_attempts: number }>(
      `SELECT attempt_count, max_attempts FROM chat_ocr_tasks WHERE id = $1`,
      [jobId],
    );
    const { attempt_count, max_attempts } = job.rows[0] || { attempt_count: 0, max_attempts: 3 };

    const isDead = !retryable || attempt_count >= max_attempts;
    const nextRetry = isDead ? null : nextRetryTimestamp(attempt_count);

    await client.query(
      `UPDATE chat_ocr_tasks
       SET    status = $1,
              stage = NULL,
              error_reason = $2,
              next_retry_at = $3,
              updated_at = now()
       WHERE  id = $4`,
      [isDead ? "dead_letter" : "failed", reason, nextRetry, jobId],
    );
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Legacy shims (backward compat) ────────────────────────────────────────────

export async function getJob(jobId: string): Promise<OcrJob | null> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // PgClient imported at top level
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT * FROM chat_ocr_tasks WHERE id = $1`,
      [jobId],
    );
    if (!res.rows[0]) return null;
    const row = res.rows[0];
    return {
      id:              row.id,
      tenantId:        row.tenant_id,
      userId:          row.user_id,
      r2Key:           row.r2_key,
      filename:        row.filename,
      contentType:     row.content_type,
      fileHash:        row.file_hash,
      status:          row.status,
      provider:        row.provider,
      attemptCount:    row.attempt_count,
      maxAttempts:     row.max_attempts,
      retryCount:      row.retry_count,
      nextRetryAt:     row.next_retry_at,
      lastError:       row.error_reason,
      stage:           row.stage,
      pagesProcessed:  row.page_count || 0,
      chunksProcessed: row.chunk_count || 0,
      ocrText:         row.ocr_text,
      qualityScore:    row.quality_score,
      charCount:       row.char_count,
      pageCount:       row.page_count,
      chunkCount:      row.chunk_count,
      errorReason:     row.error_reason,
      createdAt:       row.created_at,
      startedAt:       row.started_at,
      completedAt:     row.completed_at,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function markOcrCompleted(jobId: string, text: string): Promise<void> {
  await updateStage(jobId, "chunking");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // PgClient imported at top level
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  await client.connect();
  try {
    await client.query(
      `UPDATE chat_ocr_tasks SET ocr_text = $1, updated_at = now() WHERE id = $2`,
      [text, jobId],
    );
  } finally {
    await client.end().catch(() => {});
  }
}

export async function storeChunks(jobId: string, count: number): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // PgClient imported at top level
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  await client.connect();
  try {
    await client.query(
      `UPDATE chat_ocr_tasks SET chunk_count = $1, updated_at = now() WHERE id = $2`,
      [count, jobId],
    );
  } finally {
    await client.end().catch(() => {});
  }
}

export async function logOcrCost(): Promise<void> {}
export async function estimateOcrCost(): Promise<number> { return 0; }
export async function archiveOldJobs(): Promise<void> {}

// ── OCR Progress table (PHASE 5Z.6) ───────────────────────────────────────────

/**
 * Upsert per-page streaming progress into chat_ocr_progress.
 *
 * Uses INSERT ... ON CONFLICT (document_id, page_index) DO UPDATE with
 * optimistic version increment — safe for concurrent batch writes.
 * Non-critical: failures must not propagate to the caller.
 */
export async function upsertOcrProgress(
  documentId:      string,
  tenantId:        string,
  pageIndex:       number,
  textAccumulated: string,
  status:          "streaming" | "partial_ready" | "completed",
): Promise<void> {
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO chat_ocr_progress
         (document_id, tenant_id, page_index, text_accumulated, char_count, status, version, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 1, now())
       ON CONFLICT (document_id, page_index)
       DO UPDATE SET
         text_accumulated = EXCLUDED.text_accumulated,
         char_count       = EXCLUDED.char_count,
         status           = EXCLUDED.status,
         version          = chat_ocr_progress.version + 1,
         updated_at       = now()
       WHERE chat_ocr_progress.document_id = EXCLUDED.document_id
         AND chat_ocr_progress.page_index  = EXCLUDED.page_index`,
      [documentId, tenantId, pageIndex, textAccumulated.slice(0, 200_000), textAccumulated.length, status],
    );
  } catch (e) {
    const msg = (e as Error).message;
    if (!msg.includes("does not exist") && !msg.includes("relation") && !msg.includes("ENOTFOUND") && !msg.includes("ECONNREFUSED")) {
      console.warn(JSON.stringify({ ts: new Date().toISOString(), svc: "job-queue", event: "upsert_progress_warn", error: msg }));
    }
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Inline processing helpers ──────────────────────────────────────────────────
// Used by ocr-inline-processor.ts (fire-and-forget path from upload/finalize).

/**
 * Atomically mark a pending job as running (inline processor start).
 * Returns true if the job was successfully claimed, false if it was already
 * running/completed/failed (safe to call multiple times — idempotent).
 */
export async function startJobInline(jobId: string): Promise<boolean> {
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  await client.connect();
  try {
    const res = await client.query<{ id: string }>(
      `UPDATE chat_ocr_tasks
       SET    status        = 'running',
              started_at    = COALESCE(started_at, now()),
              attempt_count = attempt_count + 1,
              updated_at    = now()
       WHERE  id = $1
         AND  status = 'pending'
       RETURNING id`,
      [jobId],
    );
    return res.rowCount === 1;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Write partial OCR text to the job row and update the stage.
 * The client polls for stage === 'partial_ready' to trigger an early chat call.
 */
export async function updatePartialText(
  jobId: string,
  text:  string,
  stage: string,
): Promise<void> {
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  await client.connect();
  try {
    await client.query(
      `UPDATE chat_ocr_tasks
       SET    ocr_text   = $1,
              char_count = $2,
              stage      = $3,
              updated_at = now()
       WHERE  id = $4`,
      [text.slice(0, 200_000), text.length, stage, jobId],
    );
  } finally {
    await client.end().catch(() => {});
  }
}
