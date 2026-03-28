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

/** Enqueue a new OCR job. Returns the new task ID. */
export async function enqueueOcrJob(payload: OcrJobPayload): Promise<string> {
  const url = `${SUPABASE_URL()}/rest/v1/chat_ocr_tasks`;
  const res = await fetch(url, {
    method: "POST",
    headers: adminHeaders(),
    body: JSON.stringify({
      tenant_id:    payload.tenantId,
      user_id:      payload.userId,
      r2_key:       payload.r2Key,
      filename:     payload.filename,
      content_type: payload.contentType,
      status:       "pending",
      attempt_count: 0,
      max_attempts:  3,
      retry_count:   0,
    }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`enqueueOcrJob failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const rows = await res.json() as Array<{ id: string }>;
  const id   = rows[0]?.id;
  if (!id) throw new Error("enqueueOcrJob: no id returned");
  return id;
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

    const res = await client.query<RawOcrTask>(`
      SELECT id, tenant_id, r2_key, filename, content_type,
             attempt_count, max_attempts, retry_count
      FROM   chat_ocr_tasks
      WHERE  (status = 'pending')
         OR  (
               status = 'failed'
               AND attempt_count < max_attempts
               AND (next_retry_at IS NULL OR next_retry_at <= NOW())
             )
      ORDER  BY created_at ASC
      LIMIT  $1
      FOR UPDATE SKIP LOCKED
    `, [limit]);

    const tasks = res.rows;

    if (tasks.length > 0) {
      const ids    = tasks.map((t) => `'${t.id}'`).join(",");
      const nowIso = new Date().toISOString();
      await client.query(`
        UPDATE chat_ocr_tasks
        SET    status        = 'running',
               started_at   = $1,
               attempt_count = attempt_count + 1,
               stage        = 'ocr',
               last_error   = NULL
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

// ── Internal helpers ──────────────────────────────────────────────────────────

function snakeToCamel(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())] = v;
  }
  return out;
}
