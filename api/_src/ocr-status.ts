/**
 * ocr-status.ts — Polling endpoint for async OCR tasks.
 *
 * GET /api/ocr-status?id=<taskId>
 *
 * Response (completed):
 *   { status, taskId, ocrText, charCount, chunkCount, qualityScore, pageCount, provider, completedAt }
 *
 * Response (pending/running):
 *   { status, taskId, stage, pagesProcessed, chunksProcessed, attemptCount,
 *     createdAt, startedAt }
 *
 * Response (failed):
 *   { status, taskId, errorReason, attemptCount, maxAttempts, nextRetryAt, retryCount }
 *
 * Response (dead_letter):
 *   { status, taskId, errorReason, attemptCount, maxAttempts }
 */

import "../../server/lib/env.ts";
import type { IncomingMessage, ServerResponse } from "http";
import { authenticate }                         from "./_lib/auth.ts";
import { json, err }                            from "./_lib/response.ts";
import { getOcrTask }                           from "./_lib/ocr-queue.ts";

// ── CORS ─────────────────────────────────────────────────────────────────────

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ── Vercel handler ────────────────────────────────────────────────────────────

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method !== "GET") return err(res, 405, "METHOD_NOT_ALLOWED", "Kun GET er tilladt");

  const auth = await authenticate(req);
  if (auth.status !== "ok" || !auth.user) {
    return err(res, 401, "UNAUTHENTICATED", "Login krævet");
  }

  const url    = new URL(req.url ?? "/", "http://localhost");
  const taskId = url.searchParams.get("id") ?? "";
  if (!taskId) return err(res, 400, "MISSING_ID", "id query parameter krævet");

  const task = await getOcrTask(taskId);
  if (!task) return err(res, 404, "NOT_FOUND", "OCR-opgave ikke fundet");

  // Tenant isolation — user must belong to the same tenant
  if (task.tenantId !== auth.user.organizationId) {
    return err(res, 403, "FORBIDDEN", "Ingen adgang til denne OCR-opgave");
  }

  if (task.status === "completed") {
    return json(res, {
      status:       "completed",
      taskId:       task.id,
      ocrText:      task.ocrText,
      charCount:    task.charCount,
      chunkCount:   task.chunkCount,
      qualityScore: task.qualityScore ? parseFloat(task.qualityScore) : null,
      pageCount:    task.pageCount,
      provider:     task.provider,
      completedAt:  task.completedAt,
    });
  }

  if (task.status === "dead_letter") {
    return json(res, {
      status:       "dead_letter",
      taskId:       task.id,
      errorReason:  task.lastError ?? task.errorReason ?? "Permanent fejl — manuelt gennemsyn krævet",
      attemptCount: task.attemptCount,
      maxAttempts:  task.maxAttempts,
    });
  }

  if (task.status === "failed") {
    return json(res, {
      status:       "failed",
      taskId:       task.id,
      errorReason:  task.lastError ?? task.errorReason ?? "Ukendt fejl",
      attemptCount: task.attemptCount,
      maxAttempts:  task.maxAttempts,
      nextRetryAt:  task.nextRetryAt,
      retryCount:   task.retryCount,
    });
  }

  // pending or running — include stage + progress for live UI feedback
  return json(res, {
    status:          task.status,        // "pending" | "running"
    taskId:          task.id,
    stage:           task.stage ?? null, // "ocr" | "chunking" | "embedding" | "storing" | null
    pagesProcessed:  task.pagesProcessed  ?? 0,
    chunksProcessed: task.chunksProcessed ?? 0,
    attemptCount:    task.attemptCount,
    maxAttempts:     task.maxAttempts,
    createdAt:       task.createdAt,
    startedAt:       task.startedAt,
  });
}
