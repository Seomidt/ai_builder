/**
 * ocr-chat-orchestrator.ts — PHASE 5Z.7
 *
 * Server-driven OCR → Chat handoff.
 *
 * Replaces client-polling as the mechanism that decides when to start answer
 * generation. The orchestrator is called from ocr-inline-processor.ts at the
 * moment `partial_ready` or `completed` OCR text is successfully persisted.
 *
 * Responsibilities:
 *  1. Compute a deterministic trigger key for the current OCR readiness state
 *  2. Guard against duplicate triggers (same trigger key → no-op)
 *  3. Write a `chat_answer_requests` row to persist the trigger event
 *  4. Update observability timestamps on `chat_ocr_tasks`
 *  5. Push an SSE event to all listeners on the task's SSE channel
 *
 * Invariants:
 *  INV-OCO1: Same trigger key never creates two answer requests.
 *  INV-OCO2: Trigger key changes only on meaningful OCR state improvement.
 *  INV-OCO3: Zero-char OCR state never creates an answer request.
 *  INV-OCO4: All DB operations are wrapped in try/catch — non-fatal.
 *  INV-OCO5: Tenant isolation: trigger key encodes tenantId.
 */

import { createHash }  from "node:crypto";
import { Client as PgClient } from "pg";

// ── Types ──────────────────────────────────────────────────────────────────────

export type OcrTriggerMode = "partial" | "complete";

export interface OcrChatTriggerInput {
  jobId:        string;
  tenantId:     string;
  charCount:    number;
  stage:        string;   // "partial_ready" | "completed" | etc.
  status:       string;   // "running" | "completed"
  mode:         OcrTriggerMode;
  triggerReason?: string;
  /** Optional — included in partial_ready SSE event so client can start chat immediately. */
  ocrText?:     string;
}

export interface OcrChatTriggerResult {
  triggered:   boolean;
  triggerKey:  string;
  reason:      string;   // why triggered or skipped
  requestId:   string | null;
}

// ── In-process SSE push registry ──────────────────────────────────────────────
// Map<taskId, Set<(event: object) => void>>
// Populated by /api/ocr-task-stream connections (routes.ts).

type SsePushFn = (event: { type: string; data: object }) => void;
const _sseListeners = new Map<string, Set<SsePushFn>>();

export function registerOcrSseListener(taskId: string, fn: SsePushFn): () => void {
  if (!_sseListeners.has(taskId)) _sseListeners.set(taskId, new Set());
  _sseListeners.get(taskId)!.add(fn);
  return () => {
    const set = _sseListeners.get(taskId);
    if (set) { set.delete(fn); if (set.size === 0) _sseListeners.delete(taskId); }
  };
}

function pushSseEvent(taskId: string, type: string, data: object): void {
  const set = _sseListeners.get(taskId);
  if (!set || set.size === 0) return;
  for (const fn of set) {
    try { fn({ type, data }); } catch { /* client disconnected */ }
  }
}

// ── Trigger key ───────────────────────────────────────────────────────────────

/**
 * Computes a stable, deterministic trigger key from the current OCR state.
 *
 * Key changes when:
 *  - charCount crosses a meaningful threshold (bucket: floor to nearest 500)
 *  - status changes (running → completed)
 *  - stage changes (partial_ready → completed)
 *
 * Same key = no new trigger. Different key = eligible for new trigger.
 *
 * INV-OCO2: key encodes tenantId to prevent cross-tenant collisions.
 */
export function computeOcrChatTriggerKey(
  tenantId:  string,
  jobId:     string,
  charCount: number,
  stage:     string,
  status:    string,
): string {
  const charBucket = Math.floor(charCount / 500) * 500;  // 0, 500, 1000, ...
  const payload    = `${tenantId}:${jobId}:${charBucket}:${stage}:${status}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 32);
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

function resolveDbUrl(): string {
  const url = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL;
  if (!url) throw new Error("No DATABASE_URL configured");
  return url;
}

function getSslConfig() {
  return { rejectUnauthorized: false };
}

/**
 * Inserts a chat_answer_requests row.
 * ON CONFLICT (task_id, trigger_key) DO NOTHING → idempotent.
 * Returns the row id if inserted, null if it already existed.
 */
async function insertAnswerRequestIfNew(
  tenantId:      string,
  taskId:        string,
  triggerKey:    string,
  mode:          OcrTriggerMode,
  triggerReason: string,
): Promise<string | null> {
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSslConfig() });
  await client.connect();
  try {
    const res = await client.query<{ id: string }>(
      `INSERT INTO chat_answer_requests
         (tenant_id, task_id, trigger_key, mode, status, trigger_reason)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       ON CONFLICT (task_id, trigger_key) DO NOTHING
       RETURNING id`,
      [tenantId, taskId, triggerKey, mode, triggerReason],
    );
    return res.rows[0]?.id ?? null;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Stamps observability columns on chat_ocr_tasks.
 * Fire-and-forget safe — errors are swallowed.
 */
async function stampOcrTaskTrigger(
  jobId:       string,
  triggerKey:  string,
  isFirst:     boolean,
): Promise<void> {
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSslConfig() });
  await client.connect();
  try {
    const now = new Date();
    if (isFirst) {
      await client.query(
        `UPDATE chat_ocr_tasks
         SET    partial_ready_written_at     = COALESCE(partial_ready_written_at, $1),
                ocr_chat_trigger_attempted_at = $1,
                ocr_chat_trigger_key          = $2,
                updated_at                    = $1
         WHERE  id = $3`,
        [now, triggerKey, jobId],
      );
    } else {
      await client.query(
        `UPDATE chat_ocr_tasks
         SET    ocr_chat_trigger_attempted_at = $1,
                ocr_chat_trigger_key          = $2,
                updated_at                    = $1
         WHERE  id = $3`,
        [now, triggerKey, jobId],
      );
    }
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Main orchestrator ──────────────────────────────────────────────────────────

/**
 * Called from ocr-inline-processor.ts each time OCR text is persisted.
 *
 * Flow:
 *  1. Guard: charCount must be > 0
 *  2. Compute trigger key
 *  3. INSERT INTO chat_answer_requests ON CONFLICT DO NOTHING
 *  4. If inserted (new key) → stamp chat_ocr_tasks + push SSE
 *  5. If not inserted (existing key) → no-op (idempotent)
 *
 * All DB errors are caught — this must never crash the OCR pipeline.
 */
export async function triggerOcrChat(input: OcrChatTriggerInput): Promise<OcrChatTriggerResult> {
  const { jobId, tenantId, charCount, stage, status, mode, triggerReason } = input;

  // INV-OCO3: refuse trigger on empty text
  if (charCount <= 0) {
    return { triggered: false, triggerKey: "", reason: "charCount=0: no usable text", requestId: null };
  }

  const triggerKey = computeOcrChatTriggerKey(tenantId, jobId, charCount, stage, status);
  const reason     = triggerReason ?? `${mode}:${stage}:chars=${charCount}`;

  try {
    const requestId = await insertAnswerRequestIfNew(tenantId, jobId, triggerKey, mode, reason);

    if (requestId === null) {
      // Already exists — duplicate trigger suppressed
      return { triggered: false, triggerKey, reason: "duplicate_trigger_suppressed", requestId: null };
    }

    // New trigger — stamp observability + push SSE
    const isFirstTrigger = mode === "partial";
    await stampOcrTaskTrigger(jobId, triggerKey, isFirstTrigger).catch(() => {});

    // SSE push — synchronous, in-process
    // Push both a typed progress event (partial_ready / completed) AND answer_triggered
    const sseProgressType = mode === "partial" ? "partial_ready" : "completed";
    pushSseEvent(jobId, sseProgressType, {
      taskId:    jobId,
      triggerKey,
      charCount,
      ...(mode === "partial" && input.ocrText ? { ocrText: input.ocrText.slice(0, 80_000) } : {}),
    });
    pushSseEvent(jobId, "answer_triggered", {
      taskId:        jobId,
      triggerKey,
      mode,
      stage,
      status,
      charCount,
      triggerReason: reason,
      triggeredAt:   new Date().toISOString(),
    });

    console.log(JSON.stringify({
      ts:   new Date().toISOString(),
      svc:  "ocr-orchestrator",
      jobId,
      event: "ocr_chat_triggered",
      triggerKey,
      mode,
      charCount,
      reason,
      requestId,
    }));

    return { triggered: true, triggerKey, reason, requestId };

  } catch (err) {
    // INV-OCO4: non-fatal — log but do not throw
    console.warn(JSON.stringify({
      ts:    new Date().toISOString(),
      svc:   "ocr-orchestrator",
      jobId,
      event: "ocr_chat_trigger_error",
      error: (err as Error).message,
    }));
    return { triggered: false, triggerKey, reason: `db_error: ${(err as Error).message}`, requestId: null };
  }
}
