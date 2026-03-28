/**
 * ocr-status.ts — Polling endpoint for async OCR tasks.
 *
 * GET /api/ocr-status?id=<taskId>
 *
 * Response (completed):
 *   { status: "completed", ocrText, charCount, chunkCount, qualityScore, pageCount, provider }
 *
 * Response (pending/running):
 *   { status: "pending" | "running", createdAt, startedAt }
 *
 * Response (failed):
 *   { status: "failed", errorReason }
 */

import "../../server/lib/env";
import type { IncomingMessage, ServerResponse } from "http";
import { authenticate }                         from "./_lib/auth";
import { json, err }                            from "./_lib/response";
import { getOcrTask }                           from "./_lib/ocr-queue";

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

  if (task.status === "failed") {
    return json(res, {
      status:      "failed",
      taskId:      task.id,
      errorReason: task.errorReason ?? "Ukendt fejl",
      attempt:     task.attemptCount,
    });
  }

  // pending or running
  return json(res, {
    status:      task.status,
    taskId:      task.id,
    createdAt:   task.createdAt,
    startedAt:   task.startedAt,
    attemptCount: task.attemptCount,
  });
}
