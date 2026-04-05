/**
 * api/_src/upload.ts — Thin Vercel handler for direct-to-R2 upload flow.
 *
 * PHASE: SMART ATTACHMENT UPLOAD (Manus-Only Async Edition)
 *
 * Routes:
 *   POST /api/upload/url      — generate presigned R2 PUT URL (file never touches Vercel)
 *   POST /api/upload/finalize — post-upload: extract content, route A/B, return context
 *
 * Manus-Only Strategy:
 *   All PDF files are now routed to the async OCR pipeline (Mode B / OCR_PENDING).
 *   This prevents Vercel timeouts (121s+) and allows Manus to handle the 
 *   processing, model selection, and cost optimization in the background.
 */

import "../../server/lib/env.ts";
import type { IncomingMessage, ServerResponse } from "http";
import { authenticate }                         from "./_lib/auth.ts";
import { json, err, readBody, pathSegments }    from "./_lib/response.ts";

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

  // ── PDF fast-path: try native text extraction first ─────────────────────────
  // pdf-parse is fast (<1s) and works for text-based PDFs.
  // Only fall back to the slow async OCR pipeline for scanned/image PDFs.
  const isPdf = contentType === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
  if (isPdf) {
    const MIN_NATIVE_TEXT_CHARS = 120;
    try {
      const { r2Client: r2, R2_BUCKET: bucket } = await import("../../server/lib/r2/r2-client");
      const { GetObjectCommand } = await import("@aws-sdk/client-s3");
      const r2Resp = await r2.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
      const chunks: Buffer[] = [];
      for await (const chunk of r2Resp.Body as AsyncIterable<Uint8Array>) {
        chunks.push(Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);
      const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
      const parsed = await pdfParse(buffer);
      const nativeText = (parsed.text ?? "").trim();
      const nonWsChars = nativeText.replace(/\s+/g, "").length;

      if (nonWsChars >= MIN_NATIVE_TEXT_CHARS) {
        log("upload.finalize.pdf_fast_path", { tenantId, objectKey, filename, chars: nativeText.length, nonWs: nonWsChars });
        return json(res, {
          mode: "A",
          routing: "PDF native text (fast path)",
          results: [{
            filename,
            mime_type: contentType,
            char_count: nativeText.length,
            extracted_text: nativeText,
            status: "ok",
            source: "r2_direct",
          }],
        });
      }
      log("upload.finalize.pdf_native_too_short", { tenantId, objectKey, filename, nonWs: nonWsChars });
    } catch (fastPathErr) {
      log("upload.finalize.pdf_fast_path_error", { tenantId, objectKey, filename, error: String(fastPathErr) });
    }

    log("upload.finalize.pdf_ocr_fallback", { tenantId, objectKey, filename, size });
    return handleOcrPending(res, { 
      tenantId, userId, objectKey, filename, contentType, sizeBytes: size, 
      routing: { reason: "Scanned PDF — async OCR pipeline" } 
    });
  }

  // ── A/B routing decision for non-PDFs ──────────────────────────────────────
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
  });

  // ── Mode A: direct chat extraction (Non-PDFs) ──────────────────────────────
  if (routing.mode === "A" && context === "chat") {
    const { processDirectAttachment } = await import("../../server/lib/chat/direct-attachment-processor");
    const result = await processDirectAttachment({ objectKey, filename, contentType, sizeBytes: size });

    if (result.status === "ok") {
      log("upload.finalize.mode_a.ok", { tenantId, objectKey, char_count: result.char_count });
      return json(res, { mode: "A", routing: routing.reason, results: [result] });
    }
  }

  // ── Mode B: large/complex file (Non-PDFs) ──────────────────────────────────
  if (context === "storage" && sourceId) {
    try {
      const { registerR2Asset } = await import("../../server/lib/knowledge/kb-r2-asset");
      const asset = await registerR2Asset({
        tenantId, uploadedBy: userId, knowledgeBaseId: sourceId,
        objectKey, filename, mimeType: contentType, fileSizeBytes: size,
      });
      return json(res, { mode: "B", routing: routing.reason, asset });
    } catch (e) {
      return err(res, 500, "INGESTION_ERROR", e instanceof Error ? e.message : String(e));
    }
  }

  // Default fallback for other types
  return json(res, {
    mode:    "B",
    routing: routing.reason,
    message: "Dokumentet modtaget og sat i kø til behandling.",
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
  sizeBytes?:  number;
  routing:     { reason: string };
}

async function handleOcrPending(
  res: ServerResponse,
  ctx: OcrPendingContext,
): Promise<void> {
  const { createOcrTask } = await import("./_lib/ocr-queue");
  try {
    // ── Skip hash for all files in Manus-Only mode to ensure instant response ──
    // The hash can be computed by the worker/Manus later if needed for dedup.
    const fileHash: string | undefined = undefined;

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
      tenantId: ctx.tenantId, userId: ctx.userId, objectKey: ctx.objectKey, taskId, reused
    });

    // Best-effort: trigger the worker immediately (won't block response).
    if (!reused) {
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
        : "Dokumentet er modtaget. Manus analyserer det nu i baggrunden.",
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("upload.finalize.ocr_task_error", { tenantId: ctx.tenantId, error: msg });
    return json(res, {
      mode:    "B_FALLBACK",
      routing: ctx.routing.reason,
      message: `Fejl ved oprettelse af opgave: ${msg.slice(0, 300)}`,
      results: [],
    });
  }
}

// ── Fire-and-forget worker trigger ────────────────────────────────────────────

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
  }).catch(() => {});
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

  const segments = pathSegments(req, "/api/upload");
  const action   = segments[0] ?? "";

  if (action === "url")      return handleUrl(req, res, tenantId, userId);
  if (action === "finalize") return handleFinalize(req, res, tenantId, userId);

  return err(res, 404, "NOT_FOUND", `Upload route ikke fundet: ${action}`);
}
