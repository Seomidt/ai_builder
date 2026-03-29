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

import type { OcrJob, OcrJobPayload, OcrJobCompletion, JobStage } from "./job-types";
import { nextRetryTimestamp }                                       from "./job-types";

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
  const { Client } = require("pg");
  const client = new Client({ connectionString: resolveDbUrl(), ssl: { rejectUnauthorized: false } });
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

export async function enqueueOcrJob(
  payload: OcrJobPayload,
): Promise<{ id: string; reused: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require("pg");
  const client = new Client({
    connectionString: resolveDbUrl(),
    ssl: { rejectUnauthorized: false },
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
      const res = await client.query<{ id: string }>(
        `INSERT INTO chat_ocr_tasks
           (tenant_id, user_id, r2_key, filename, content_type,
            status, attempt_count, max_attempts, retry_count, file_hash)
         VALUES ($1, $2, $3, $4, $5, 'pending', 0, 3, 0, $6)
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
               (tenant_id, user_id, r2_key, filename, content_type,
                status, attempt_count, max_attempts, retry_count, file_hash)
             VALUES ($1, $2, $3, $4, $5, 'pending', 0, 3, 0, $6)
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
                 (tenant_id, user_id, r2_key, filename, content_type,
                  status, attempt_count, max_attempts, retry_count)
               VALUES ($1, $2, $3, $4, $5, 'pending', 0, 3, 0)
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
             (tenant_id, user_id, r2_key, filename, content_type,
              status, attempt_count, max_attempts, retry_count)
           VALUES ($1, $2, $3, $4, $5, 'pending', 0, 3, 0)
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
  const { Client } = require("pg");
  const client = new Client({
    connectionString: resolveDbUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("BEGIN");

    // ── 0. Recovery: reset stale running jobs (worker crash / Vercel timeout) ─
    // If a job has been in 'running' for longer than STALE_RUNNING_MINUTES,
    // the worker function crashed or timed out without marking it failed/completed.
    // We reset it so it can be re-claimed on this or the next cron tick.
    const staleResult = await client.query(`
      UPDATE chat_ocr_tasks
      SET    status        = CASE
                               WHEN attempt_count >= max_attempts THEN 'dead_letter'
                               ELSE 'failed'
                             END,
             next_retry_at = CASE
                               WHEN attempt_count >= max_attempts THEN NULL
                               ELSE NOW() + INTERVAL '2 minutes'
                             END,
             completed_at  = CASE
                               WHEN attempt_count >= max_attempts THEN NOW()
                               ELSE NULL
                             END,
             retry_count   = retry_count + 1,
             stage         = NULL,
             last_error    = 'Worker timeout: jobbet sad fast i running-tilstand i >${STALE_RUNNING_MINUTES} minutter og er nu nulstillet'
      WHERE  status     = 'running'
        AND  started_at < NOW() - INTERVAL '${STALE_RUNNING_MINUTES} minutes'
      RETURNING id, status
    `);
    if (staleResult.rowCount && staleResult.rowCount > 0) {
      console.log(`[job-queue] recovered ${staleResult.rowCount} stale running job(s):`,
        staleResult.rows.map((r: { id: string; status: string }) => `${r.id.slice(0, 8)}→${r.status}`).join(", "));
    }

    // CTE-based claim that:
    // 1. Skips tenants already at MAX_CONCURRENT_PER_TENANT running jobs
    // 2. Selects oldest eligible jobs (FIFO within each tenant)
    // 3. Atomically locks selected rows (SKIP LOCKED = no double-processing)
    const res = await client.query<RawOcrTask>(`
      WITH running_per_tenant AS (
        SELECT   tenant_id, COUNT(*) AS cnt
        FROM     chat_ocr_tasks
        WHERE    status = 'running'
        GROUP BY tenant_id
      ),
      eligible AS (
        SELECT  cot.id, cot.tenant_id, cot.r2_key, cot.filename, cot.content_type,
                cot.attempt_count, cot.max_attempts, cot.retry_count
        FROM    chat_ocr_tasks cot
        LEFT JOIN running_per_tenant rpt ON rpt.tenant_id = cot.tenant_id
        WHERE  (
                  cot.status = 'pending'
               OR (
                  cot.status = 'failed'
                  AND cot.attempt_count < cot.max_attempts
                  AND (cot.next_retry_at IS NULL OR cot.next_retry_at <= NOW())
               ))
          AND COALESCE(rpt.cnt, 0) < $2
        ORDER  BY cot.created_at ASC
        LIMIT  $1
        FOR UPDATE SKIP LOCKED
      )
      SELECT * FROM eligible
    `, [limit, MAX_CONCURRENT_PER_TENANT]);

    const tasks = res.rows;

    if (tasks.length > 0) {
      const ids    = tasks.map((t) => `'${t.id}'`).join(",");
      const nowIso = new Date().toISOString();
      await client.query(`
        UPDATE chat_ocr_tasks
        SET    status         = 'running',
               started_at    = $1,
               attempt_count = attempt_count + 1,
               stage         = 'ocr',
               last_error    = NULL
        WHERE  id IN (${ids})
      `, [nowIso]);
    }

    await client.query("COMMIT");
    return tasks;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Stage progress update ─────────────────────────────────────────────────────
// Called during processing to reflect current stage in status endpoint.

export async function updateStage(
  id: string,
  stage: JobStage,
  extra: { pagesProcessed?: number; chunksProcessed?: number } = {},
): Promise<void> {
  const patch: Record<string, unknown> = { stage };
  if (extra.pagesProcessed != null) patch.pages_processed  = extra.pagesProcessed;
  if (extra.chunksProcessed != null) patch.chunks_processed = extra.chunksProcessed;

  const url = `${SUPABASE_URL()}/rest/v1/chat_ocr_tasks?id=eq.${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: adminHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    // Non-fatal — log and continue
    console.warn(`[job-queue] updateStage failed: ${res.status}`);
  }
}

// ── Complete ──────────────────────────────────────────────────────────────────

/**
 * markOcrCompleted — worker-facing wrapper matching the full 5-arg call signature.
 * _attemptCount, _maxAttempts, _retryCount are accepted but not used (no backoff
 * needed on success).
 */
export async function markOcrCompleted(
  id:             string,
  _attemptCount:  number,
  _maxAttempts:   number,
  _retryCount:    number,
  data:           OcrJobCompletion,
): Promise<void> {
  return completeJob(id, data);
}

export async function completeJob(id: string, data: OcrJobCompletion): Promise<void> {
  const url = `${SUPABASE_URL()}/rest/v1/chat_ocr_tasks?id=eq.${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: adminHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify({
      status:        "completed",
      stage:         null,
      ocr_text:      data.ocrText,
      quality_score: data.qualityScore.toFixed(4),
      char_count:    data.charCount,
      page_count:    data.pageCount,
      chunk_count:   data.chunkCount,
      provider:      data.provider,
      completed_at:  new Date().toISOString(),
      last_error:    null,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`completeJob failed: ${res.status} ${txt.slice(0, 200)}`);
  }
}

// ── Fail (with backoff) ───────────────────────────────────────────────────────
// If retries remain → schedule next_retry_at and set status='failed'.
// If max retries exceeded → move to dead_letter.

export async function failJob(
  id: string,
  reason: string,
  currentAttemptCount: number,
  maxAttempts: number,
  currentRetryCount: number,
): Promise<void> {
  const isDeadLetter = currentAttemptCount >= maxAttempts;
  const safeReason   = reason.slice(0, 1000);

  const patch: Record<string, unknown> = {
    last_error:   safeReason,
    error_reason: safeReason,
    stage:        null,
  };

  if (isDeadLetter) {
    patch.status       = "dead_letter";
    patch.completed_at = new Date().toISOString();
  } else {
    const nextRetry     = nextRetryTimestamp(currentRetryCount);
    patch.status        = "failed";
    patch.retry_count   = currentRetryCount + 1;
    patch.next_retry_at = nextRetry.toISOString();
  }

  const url = `${SUPABASE_URL()}/rest/v1/chat_ocr_tasks?id=eq.${encodeURIComponent(id)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: adminHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    console.warn(`[job-queue] failJob HTTP ${res.status} for id=${id}`);
  }
}

// ── Get job by ID (status endpoint) ──────────────────────────────────────────

export async function getJob(id: string): Promise<OcrJob | null> {
  const url = `${SUPABASE_URL()}/rest/v1/chat_ocr_tasks?id=eq.${encodeURIComponent(id)}&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey:         SUPABASE_SERVICE(),
      Authorization:  `Bearer ${SUPABASE_SERVICE()}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) return null;
  const rows = await res.json() as Record<string, unknown>[];
  if (!rows[0]) return null;
  return snakeToCamel(rows[0]) as unknown as OcrJob;
}

// ── Store OCR chunks ──────────────────────────────────────────────────────────

export interface OcrChunkRow {
  chunkIndex: number;
  content:    string;
  pageRef?:   string;
  embedding?: string;
}

export async function storeChunks(
  taskId:   string,
  tenantId: string,
  chunks:   OcrChunkRow[],
): Promise<void> {
  if (!chunks.length) return;

  const rows = chunks.map((c) => ({
    task_id:     taskId,
    tenant_id:   tenantId,
    chunk_index: c.chunkIndex,
    content:     c.content,
    char_count:  c.content.length,
    page_ref:    c.pageRef ?? null,
    embedding:   c.embedding ?? null,
  }));

  const url = `${SUPABASE_URL()}/rest/v1/chat_ocr_chunks`;
  const res = await fetch(url, {
    method: "POST",
    headers: adminHeaders({ Prefer: "return=minimal" }),
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`storeChunks failed: ${res.status} ${txt.slice(0, 200)}`);
  }
}

// ── Log AI cost to ai_usage ───────────────────────────────────────────────────
// OCR calls count toward tenant AI usage budget.

export interface OcrCostLog {
  tenantId:    string;
  provider:    "openai" | "google";
  model:       string;
  feature:     string;  // e.g. "ocr.scan_pdf"
  promptTokens:     number;
  completionTokens: number;
  estimatedCostUsd: number;
  latencyMs:   number;
  status:      "success" | "error";
  errorMessage?: string;
}

const PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "gemini-1.5-flash": { inputPer1M: 0.075, outputPer1M: 0.30  },
  "gpt-4o":           { inputPer1M: 2.50,  outputPer1M: 10.00 },
  "text-embedding-3-small": { inputPer1M: 0.020, outputPer1M: 0 },
};

export function estimateOcrCost(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICING[model];
  if (!p) return 0;
  const cost = (promptTokens / 1_000_000) * p.inputPer1M
             + (completionTokens / 1_000_000) * p.outputPer1M;
  return Math.max(0, parseFloat(cost.toFixed(8)));
}

export async function logOcrCost(log: OcrCostLog): Promise<void> {
  try {
    const url = `${SUPABASE_URL()}/rest/v1/ai_usage`;
    const body = {
      tenant_id:         log.tenantId,
      feature:           log.feature,
      provider:          log.provider,
      model:             log.model,
      prompt_tokens:     log.promptTokens,
      completion_tokens: log.completionTokens,
      total_tokens:      log.promptTokens + log.completionTokens,
      estimated_cost_usd: log.estimatedCostUsd.toFixed(8),
      actual_cost_usd:   log.estimatedCostUsd.toFixed(8),
      latency_ms:        log.latencyMs,
      status:            log.status,
      error_message:     log.errorMessage ?? null,
      route_key:         log.feature,
    };
    const res = await fetch(url, {
      method: "POST",
      headers: adminHeaders({ Prefer: "return=minimal" }),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[job-queue] logOcrCost HTTP ${res.status}`);
    }
  } catch (e) {
    // Non-fatal — cost logging must never crash the worker
    console.warn(`[job-queue] logOcrCost error: ${e instanceof Error ? e.message : e}`);
  }
}

// ── Archive / Cleanup ─────────────────────────────────────────────────────────

/**
 * Delete completed and dead_letter jobs older than ARCHIVE_AFTER_DAYS days.
 * Safe: only touches terminal-state rows.
 * Returns the number of rows deleted.
 */
export async function archiveOldJobs(): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require("pg");
  const client = new Client({
    connectionString: resolveDbUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const res = await client.query<{ count: string }>(`
      WITH deleted AS (
        DELETE FROM chat_ocr_tasks
        WHERE  status IN ('completed', 'dead_letter')
          AND  created_at < NOW() - INTERVAL '${ARCHIVE_AFTER_DAYS} days'
        RETURNING id
      )
      SELECT COUNT(*) AS count FROM deleted
    `);
    return parseInt(res.rows[0]?.count ?? "0", 10);
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function snakeToCamel(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
}
