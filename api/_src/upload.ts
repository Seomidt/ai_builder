/**
 * api/_src/upload.ts — Thin Vercel handler for direct-to-R2 upload flow.
 *
 * PHASE: SMART ATTACHMENT UPLOAD
 *
 * Routes:
 *   POST /api/upload/url      — generate presigned R2 PUT URL (file never touches Vercel)
 *   POST /api/upload/finalize — post-upload: extract content, route A/B, return context
 *
 * Upload path:
 *   Browser → (presigned PUT) → R2          (large files bypass Vercel entirely)
 *   Browser → POST /api/upload/url          (small JSON request to Vercel)
 *   Browser → POST /api/upload/finalize     (small JSON request to Vercel)
 *   Vercel  ← reads from R2 for extraction  (server-side, not through request body)
 *
 * Scanned PDF flow (async OCR):
 *   finalize → SCANNED_PDF detected → createOcrTask → return { mode: "OCR_PENDING", taskId }
 *   Cron /api/ocr-worker runs every minute → OCR → chunk → embed → store
 *   Frontend polls GET /api/ocr-status?id=<taskId> until completed/failed
 *
 * This handler does NOT receive file bytes. Ever.
 */

import "../../server/lib/env";
import type { IncomingMessage, ServerResponse } from "http";
import { authenticate }                         from "./_lib/auth";
import { json, err, readBody, pathSegments }    from "./_lib/response";

// ── Allowed MIME types (single source of truth lives in kb-upload-service) ────
const ALLOWED_MIME_TYPES: Record<string, string> = {
  "application/pdf":          "document",
  "application/msword":       "document",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "text/plain":               "document",
  "text/csv":                 "document",
  "text/markdown":            "document",
  "text/html":                "document",
  "application/vnd.ms-excel": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "document",
  "application/rtf":          "document",
  "image/jpeg":               "image",
  "image/png":                "image",
  "image/gif":                "image",
  "image/webp":               "image",
  "image/tiff":               "image",
  "image/bmp":                "image",
  "video/mp4":                "video",
  "video/quicktime":          "video",
  "video/x-msvideo":          "video",
  "video/webm":               "video",
  "video/mpeg":               "video",
};

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024; // 100 MB

// ── CORS helper ───────────────────────────────────────────────────────────────

function cors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin",  "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

// ── Structured logging ────────────────────────────────────────────────────────

function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

// ── POST /api/upload/url ──────────────────────────────────────────────────────
// Returns a presigned R2 PUT URL. File bytes never come through Vercel.

interface UrlRequestBody {
  filename:    string;
  contentType: string;
  size:        number;
  sourceId?:   string | null;
  context?:    "chat" | "storage";
}

interface UrlResponseBody {
  uploadUrl:  string;
  objectKey:  string;
  expiresIn:  number;
}

async function handleUrl(
  req: IncomingMessage,
  res: ServerResponse,
  tenantId: string,
  userId: string,
): Promise<void> {
  const body = await readBody<UrlRequestBody>(req);
  const { filename, contentType, size, context = "chat" } = body;

  // ── Validate ───────────────────────────────────────────────────────────────
  if (!filename || !contentType || typeof size !== "number") {
    return err(res, 400, "INVALID_INPUT", "filename, contentType og size er påkrævet");
  }
  const docCategory = ALLOWED_MIME_TYPES[contentType];
  if (!docCategory) {
    log("upload.url.rejected", { tenantId, contentType, reason: "unsupported_mime" });
    return err(res, 415, "UNSUPPORTED_MIME", `Filtypen "${contentType}" understøttes ikke`);
  }
  if (size > MAX_UPLOAD_BYTES) {
    log("upload.url.rejected", { tenantId, size, reason: "file_too_large" });
    return err(res, 413, "FILE_TOO_LARGE", `Filen overstiger grænsen på ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`);
  }

  // ── Generate tenant-scoped object key ──────────────────────────────────────
  const safeFilename = filename.replace(/[^a-zA-Z0-9._\-]/g, "-").slice(0, 200);
  const objectKey    = `tenants/${tenantId}/uploads/${context}/${Date.now()}-${safeFilename}`;

  // ── Generate presigned PUT URL ─────────────────────────────────────────────
  const { r2Client, R2_BUCKET, R2_CONFIGURED } = await import("../../server/lib/r2/r2-client");
  if (!R2_CONFIGURED) {
    log("upload.url.error", { tenantId, reason: "r2_not_configured" });
    return err(res, 503, "R2_NOT_CONFIGURED", "Filopbevaring er ikke konfigureret");
  }

  const { PutObjectCommand }  = await import("@aws-sdk/client-s3");
  const { getSignedUrl }      = await import("@aws-sdk/s3-request-presigner");

  const command    = new PutObjectCommand({
    Bucket:      R2_BUCKET,
    Key:         objectKey,
    ContentType: contentType,
  });
  const expiresIn  = 900; // 15 minutes
  const uploadUrl  = await getSignedUrl(r2Client, command, { expiresIn });

  log("upload.url.created", {
    tenantId, userId, objectKey, contentType,
    size_bytes: size, context, expires_in: expiresIn,
  });

  const response: UrlResponseBody = { uploadUrl, objectKey, expiresIn };
  return json(res, response);
}

// ── POST /api/upload/finalize ─────────────────────────────────────────────────
// After browser uploads directly to R2, call this to:
//   1. Verify object belongs to tenant (key prefix check)
//   2. Route A/B
//   3. Extract content (Mode A) or acknowledge pipeline start (Mode B)
//   4. For scanned PDFs: create async OCR task → return OCR_PENDING immediately
//   5. Return document context for chat OR asset info for storage

interface FinalizeRequestBody {
  objectKey:    string;
  filename:     string;
  contentType:  string;
  size:         number;
  sourceId?:    string | null;
  context:      "chat" | "storage";
  message?:     string | null;
  fileCount?:   number;
}

async function handleFinalize(
  req: IncomingMessage,
  res: ServerResponse,
  tenantId: string,
  userId: string,
): Promise<void> {
  const body = await readBody<FinalizeRequestBody>(req);
  const {
    objectKey, filename, contentType, size,
    context = "chat", message = null, fileCount = 1,
    sourceId = null,
  } = body;

  // ── Validate inputs ────────────────────────────────────────────────────────
  if (!objectKey || !filename || !contentType || typeof size !== "number") {
    return err(res, 400, "INVALID_INPUT", "objectKey, filename, contentType og size er påkrævet");
  }

  // ── Tenant isolation: key must start with tenant prefix ───────────────────
  const expectedPrefix = `tenants/${tenantId}/`;
  if (!objectKey.startsWith(expectedPrefix)) {
    log("upload.finalize.security", { tenantId, objectKey, reason: "key_prefix_mismatch" });
    return err(res, 403, "FORBIDDEN", "Ugyldig object key");
  }

  // ── A/B routing decision ───────────────────────────────────────────────────
  const { decideAttachmentProcessingMode } = await import("../../server/lib/chat/attachment-router");
  const routing = decideAttachmentProcessingMode({
    mimeType:  contentType,
    sizeBytes: size,
    fileCount: fileCount ?? 1,
    context:   context as "chat" | "storage",
  });

  log("upload.finalize.routing", {
    tenantId, userId, objectKey, contentType,
    size_bytes: size, context, mode: routing.mode, reason: routing.reason,
    size_bucket: size < 1_000_000 ? "<1MB" : size < 4_000_000 ? "1-4MB" : size < 10_000_000 ? "4-10MB" : ">10MB",
  });

  // ── Mode A: direct chat extraction ────────────────────────────────────────
  if (routing.mode === "A" && context === "chat") {
    const { processDirectAttachment } = await import("../../server/lib/chat/direct-attachment-processor");
    const result = await processDirectAttachment({ objectKey, filename, contentType, sizeBytes: size });

    // Scanned PDF → async OCR pipeline
    if (result.code === "SCANNED_PDF") {
      return handleOcrPending(res, { tenantId, userId, objectKey, filename, contentType, routing });
    }

    if (result.status === "error" || result.status === "unsupported") {
      // Fallback to B if direct processing fails
      log("upload.finalize.fallback_to_b", {
        tenantId, objectKey, reason: result.message ?? result.status,
      });
      return json(res, {
        mode:    "B_FALLBACK",
        routing: routing.reason,
        message: result.message ?? "Filen kunne ikke behandles direkte.",
        results: [],
      });
    }

    log("upload.finalize.mode_a.ok", {
      tenantId, objectKey, char_count: result.char_count,
    });

    return json(res, {
      mode:    "A",
      routing: routing.reason,
      results: [result],
    });
  }

  // ── Mode B: large/complex file — extract from R2 with full-doc handling ───
  if (context === "storage" && sourceId) {
    log("upload.finalize.mode_b.storage", { tenantId, sourceId, objectKey });

    try {
      const { registerR2Asset } = await import("../../server/lib/knowledge/kb-r2-asset");
      const asset = await registerR2Asset({
        tenantId,
        uploadedBy: userId,
        knowledgeBaseId: sourceId,
        objectKey,
        filename,
        mimeType: contentType,
        fileSizeBytes: size,
      });

      log("upload.finalize.mode_b.storage.ok", { tenantId, assetId: asset.id });
      return json(res, { mode: "B", routing: routing.reason, asset });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log("upload.finalize.mode_b.storage.error", { tenantId, objectKey, error: msg });
      return err(res, 500, "INGESTION_ERROR", msg);
    }
  }

  // ── Mode B chat: extract from R2 with larger budget for full document ─────
  const { processDirectAttachment } = await import("../../server/lib/chat/direct-attachment-processor");
  const result = await processDirectAttachment({ objectKey, filename, contentType, sizeBytes: size });

  // Scanned PDF in Mode B → async OCR too
  if (result.code === "SCANNED_PDF") {
    return handleOcrPending(res, { tenantId, userId, objectKey, filename, contentType, routing });
  }

  if (result.status === "ok") {
    log("upload.finalize.mode_b.chat.ok", {
      tenantId, objectKey, char_count: result.char_count,
    });
    return json(res, {
      mode:    "B",
      routing: routing.reason,
      results: [result],
    });
  }

  // Failed to extract
  log("upload.finalize.mode_b.chat.error", {
    tenantId, objectKey, status: result.status, message: result.message,
  });
  return json(res, {
    mode:    "B",
    routing: routing.reason,
    message: result.message ?? "Dokumentet kunne ikke behandles.",
    results: [],
  });
}

// ── OCR_PENDING helper ────────────────────────────────────────────────────────

interface OcrPendingContext {
  tenantId:    string;
  userId:      string;
  objectKey:   string;
  filename:    string;
  contentType: string;
  routing:     { reason: string };
}

async function handleOcrPending(
  res: ServerResponse,
  ctx: OcrPendingContext,
): Promise<void> {
  const { createOcrTask } = await import("./_lib/ocr-queue");
  try {
    // ── Compute SHA-256 of file content for idempotent deduplication ──────────
    // We fetch the file from R2 here (it is already uploaded).
    // If R2 fetch fails we fall back to hash=undefined (still enqueues, just no dedup).
    let fileHash: string | undefined;
    try {
      const { r2Client, R2_BUCKET, R2_CONFIGURED } = await import("../../server/lib/r2/r2-client");
      if (R2_CONFIGURED) {
        const { GetObjectCommand } = await import("@aws-sdk/client-s3");
        const r2Res = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: ctx.objectKey }));
        if (r2Res.Body) {
          const chunks: Buffer[] = [];
          for await (const chunk of r2Res.Body as AsyncIterable<Uint8Array>) {
            chunks.push(Buffer.from(chunk));
          }
          const buf   = Buffer.concat(chunks);
          const { createHash } = await import("crypto");
          fileHash = createHash("sha256").update(buf).digest("hex");
        }
      }
    } catch {
      // Non-fatal — hash omitted, job will be created without dedup
      fileHash = undefined;
    }

    const result = await createOcrTask({
      tenantId:    ctx.tenantId,
      userId:      ctx.userId,
      r2Key:       ctx.objectKey,
      filename:    ctx.filename,
      contentType: ctx.contentType,
      fileHash,
    });

    const { id: taskId, reused } = result;

    log("upload.finalize.ocr_pending", {
      tenantId:  ctx.tenantId,
      userId:    ctx.userId,
      objectKey: ctx.objectKey,
      taskId,
      reused,
      hasHash: !!fileHash,
    });

    // If reused=true: the file has already been processed (or is being processed).
    // Return the existing task ID — frontend polling will pick up the correct status.
    if (!reused) {
      // Best-effort: trigger the worker immediately (won't block response).
      // If this fails the cron will pick it up within a minute.
      triggerWorker(ctx.tenantId).catch(() => {});
    }

    return json(res, {
      mode:    "OCR_PENDING",
      routing: ctx.routing.reason,
      taskId,
      reused,
      pollUrl: `/api/ocr-status?id=${taskId}`,
      message: reused
        ? "Dette dokument er allerede i systemet. Hentet fra eksisterende behandling."
        : "PDF er scannet — OCR er sat i gang. Dokumentet vil være klar om få øjeblikke.",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("upload.finalize.ocr_task_error", { tenantId: ctx.tenantId, error: msg });
    return json(res, {
      mode:    "B_FALLBACK",
      routing: ctx.routing.reason,
      message: "PDF er scannet og kunne ikke behandles automatisk.",
      results: [],
    });
  }
}

// ── Fire-and-forget worker trigger ────────────────────────────────────────────
// Best-effort. Vercel cron provides reliability guarantee.

async function triggerWorker(tenantId: string): Promise<void> {
  const secret  = (process.env.CRON_SECRET ?? "").trim();
  const baseUrl = process.env.VERCEL_URL
    ? `https://${process.env.VERCEL_URL}`
    : process.env.NEXT_PUBLIC_APP_URL
    ?? "";
  if (!baseUrl) return;

  await fetch(`${baseUrl}/api/ocr-worker`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": secret ? `Bearer ${secret}` : "",
      "X-Tenant-Id":   tenantId,
    },
    signal: AbortSignal.timeout(5_000),
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  if (req.method !== "POST") {
    return err(res, 405, "METHOD_NOT_ALLOWED", "Kun POST er tilladt");
  }

  const auth = await authenticate(req);
  if (auth.status !== "ok" || !auth.user) {
    return err(res, 401, "UNAUTHENTICATED", "Login krævet");
  }

  const { user } = auth;
  const tenantId = user.organizationId;
  const userId   = user.id;

  // Route on path segment: /api/upload/url or /api/upload/finalize
  const segments = pathSegments(req, "/api/upload");
  const action   = segments[0] ?? "";

  if (action === "url")      return handleUrl(req, res, tenantId, userId);
  if (action === "finalize") return handleFinalize(req, res, tenantId, userId);

  return err(res, 404, "NOT_FOUND", `Upload route ikke fundet: ${action}`);
}
