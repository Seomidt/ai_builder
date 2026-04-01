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
import { getOcrTaskStatus }                     from "../../server/lib/media/media-persistence.ts";

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

  // Try legacy chat_ocr_tasks first
  const task = await getOcrTask(taskId);

  if (!task) {
    // Fall back to Phase 5Y media_processing_jobs
    const mediaTask = await getOcrTaskStatus(taskId);
    if (!mediaTask) return err(res, 404, "NOT_FOUND", "Opgave ikke fundet");

    if (mediaTask.status === "completed") {
      // Read-path protection: Filter out known simulated/fake outputs
      const text = mediaTask.result || "";
      const isSimulated = text.includes("Analysen er gennemført") || 
                          text.includes("simulated") || 
                          text.includes("placeholder") ||
                          text.includes("Dette er en simuleret");
                          
      if (isSimulated) {
        return json(res, { status: "failed", taskId, errorReason: "Ugyldigt output (simuleret data opdaget)" });
      }

      return json(res, { status: "completed", taskId, ocrText: mediaTask.result ?? "", charCount: (mediaTask.result ?? "").length, completedAt: new Date().toISOString() });
    }
    if (mediaTask.status === "dead_letter" || mediaTask.status === "failed") {
      return json(res, { status: mediaTask.status, taskId, errorReason: mediaTask.error ?? "Permanent fejl" });
    }
    if (mediaTask.status === "retryable_failed") {
      return json(res, { status: "retryable_failed", taskId, errorReason: mediaTask.error ?? "Midlertidig fejl — prøver igen" });
    }
    return json(res, { status: mediaTask.status, taskId, stage: mediaTask.stage ?? null });
  }

  // Tenant isolation — user must belong to the same tenant
  if (task.tenantId !== auth.user.organizationId) {
    return err(res, 403, "FORBIDDEN", "Ingen adgang til denne OCR-opgave");
  }

  if (task.status === "completed") {
    // Read-path protection: Filter out known simulated/fake outputs
    const text = task.ocrText || "";
    const isSimulated = text.includes("Analysen er gennemført") || 
                        text.includes("simulated") || 
                        text.includes("placeholder") ||
                        text.includes("Dette er en simuleret");
                        
    if (isSimulated) {
      return json(res, {
        status:       "failed",
        taskId:       task.id,
        errorReason:  "Ugyldigt output (simuleret data opdaget)",
        attemptCount: task.attemptCount,
        maxAttempts:  task.maxAttempts,
      });
    }

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

  // pending, running, processing, retryable_failed — include stage + progress for live UI feedback
  return json(res, {
    status:          task.status,
    taskId:          task.id,
    stage:           task.stage ?? null,
    pagesProcessed:  task.pagesProcessed  ?? 0,
    chunksProcessed: task.chunksProcessed ?? 0,
    attemptCount:    task.attemptCount,
    maxAttempts:     task.maxAttempts,
    createdAt:       task.createdAt,
    startedAt:       task.startedAt,
  });
}
