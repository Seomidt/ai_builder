/**
 * ocr-queue.ts — Chat OCR async job queue operations.
 *
 * Simple/idempotent operations use Supabase REST (dbInsert/dbUpdate/dbGet).
 * Claim operation (FOR UPDATE SKIP LOCKED) is done with direct pg in the worker.
 */

import { dbInsert, dbUpdate, dbGet } from "./db";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OcrTask {
  id:           string;
  tenantId:     string;
  userId:       string;
  r2Key:        string;
  filename:     string;
  contentType:  string;
  status:       "pending" | "running" | "completed" | "failed";
  provider:     string | null;
  attemptCount: number;
  maxAttempts:  number;
  ocrText:      string | null;
  qualityScore: string | null;
  charCount:    number | null;
  pageCount:    number | null;
  chunkCount:   number | null;
  errorReason:  string | null;
  createdAt:    string;
  startedAt:    string | null;
  completedAt:  string | null;
}

export interface CreateOcrTaskParams {
  tenantId:    string;
  userId:      string;
  r2Key:       string;
  filename:    string;
  contentType: string;
}

// ── Create ────────────────────────────────────────────────────────────────────

export async function createOcrTask(params: CreateOcrTaskParams): Promise<string> {
  const row = await dbInsert("chat_ocr_tasks", {
    tenant_id:    params.tenantId,
    user_id:      params.userId,
    r2_key:       params.r2Key,
    filename:     params.filename,
    content_type: params.contentType,
    status:       "pending",
    attempt_count: 0,
    max_attempts:  3,
  });
  return row.id as string;
}

// ── Get by ID ─────────────────────────────────────────────────────────────────
// Used by ocr-status polling endpoint (no user JWT needed — service role).

const SUPABASE_URL     = process.env.SUPABASE_URL           ?? "";
const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export async function getOcrTask(id: string): Promise<OcrTask | null> {
  const url = `${SUPABASE_URL}/rest/v1/chat_ocr_tasks?id=eq.${encodeURIComponent(id)}&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey:         SUPABASE_SERVICE,
      Authorization:  `Bearer ${SUPABASE_SERVICE}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) return null;
  const rows = await res.json() as Record<string, unknown>[];
  const row = rows[0];
  if (!row) return null;
  return snakeToCamel(row) as unknown as OcrTask;
}

// ── Mark running ──────────────────────────────────────────────────────────────

export async function markOcrRunning(id: string): Promise<void> {
  await dbUpdate("chat_ocr_tasks", { id: `eq.${id}` }, {
    status:     "running",
    started_at: new Date().toISOString(),
  });
}

// ── Mark completed ────────────────────────────────────────────────────────────

export interface OcrCompleteData {
  ocrText:      string;
  qualityScore: number;
  charCount:    number;
  pageCount:    number;
  chunkCount:   number;
  provider:     string;
}

export async function markOcrCompleted(id: string, data: OcrCompleteData): Promise<void> {
  await dbUpdate("chat_ocr_tasks", { id: `eq.${id}` }, {
    status:        "completed",
    ocr_text:      data.ocrText,
    quality_score: data.qualityScore.toFixed(4),
    char_count:    data.charCount,
    page_count:    data.pageCount,
    chunk_count:   data.chunkCount,
    provider:      data.provider,
    completed_at:  new Date().toISOString(),
  });
}

// ── Mark failed ───────────────────────────────────────────────────────────────

export async function markOcrFailed(id: string, reason: string, finalFail: boolean): Promise<void> {
  const patch: Record<string, unknown> = {
    error_reason:  reason.slice(0, 500),
    attempt_count: { raw: "attempt_count + 1" },
  };
  if (finalFail) {
    patch.status       = "failed";
    patch.completed_at = new Date().toISOString();
  } else {
    patch.status = "pending";
    patch.started_at = null;
  }
  // Note: 'raw' trick won't work via REST — use direct pg in worker instead.
  // Here we just set failed state; the worker increments attempts itself.
  await dbUpdate("chat_ocr_tasks", { id: `eq.${id}` }, {
    status:        finalFail ? "failed" : "pending",
    error_reason:  reason.slice(0, 500),
    started_at:    finalFail ? new Date().toISOString() : null,
    completed_at:  finalFail ? new Date().toISOString() : null,
  });
}

// ── Store chunks (batch insert) ───────────────────────────────────────────────

export interface OcrChunk {
  chunkIndex: number;
  content:    string;
  pageRef?:   string;
  embedding?: string;
}

export async function storeOcrChunks(
  taskId:   string,
  tenantId: string,
  chunks:   OcrChunk[],
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

  const url = `${SUPABASE_URL}/rest/v1/chat_ocr_chunks`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      apikey:         SUPABASE_SERVICE,
      Authorization:  `Bearer ${SUPABASE_SERVICE}`,
      "Content-Type": "application/json",
      Prefer:         "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`storeOcrChunks failed: ${res.status} ${txt.slice(0, 200)}`);
  }
}

// ── Internal: snake_case → camelCase ─────────────────────────────────────────

function snakeToCamel(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const camel = k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    out[camel] = v;
  }
  return out;
}
