/**
 * extract.ts — Multipart file extraction endpoint (Manus-Only Optimized).
 *
 * POST /api/extract  (multipart/form-data, one or more files)
 *
 * Extracts text from uploaded files and returns structured results.
 * Used by legacy/non-R2 flows (e.g. direct browser uploads without presigned URL).
 *
 * PDF extraction is now disabled in this synchronous endpoint to remove
 * the 'pdf-parse' dependency. Users are directed to the /api/upload flow
 * which supports high-quality async OCR via Manus.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { authenticate }                         from "./_lib/auth";
import { json, err }                            from "./_lib/response";
import Busboy                                   from "busboy";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ExtractResult {
  filename:       string;
  mime_type:      string;
  char_count:     number;
  extracted_text: string;
  status:         "ok" | "unsupported" | "error";
  message?:       string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/x-ndjson"
  );
}

function isPdfMime(mime: string, filename: string): boolean {
  return mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
}

async function extractFromBuffer(
  buf: Buffer,
  mime: string,
  filename: string,
): Promise<{ text: string; status: "ok" | "unsupported" | "error"; message?: string }> {
  // ── Plain text ─────────────────────────────────────────────────────────────
  if (isTextMime(mime)) {
    const text = buf.toString("utf-8").slice(0, 80_000);
    return { text, status: "ok" };
  }

  // ── PDF (Disabled in sync flow) ────────────────────────────────────────────
  if (isPdfMime(mime, filename)) {
    return {
      text: "",
      status: "error",
      message:
        "Direkte PDF-læsning er deaktiveret for at sikre maksimal stabilitet. " +
        "Brug venligst upload-knappen i chatten — den understøtter fuld asynkron analyse via Manus.",
    };
  }

  // ── Unsupported ────────────────────────────────────────────────────────────
  return {
    text:    "",
    status:  "unsupported",
    message: `Filtype '${mime}' understøttes ikke. Upload PDF eller en tekstfil (.txt, .csv).`,
  };
}

// ── Vercel handler ────────────────────────────────────────────────────────────

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") return err(res, 405, "METHOD_NOT_ALLOWED", "Kun POST");

  // Auth check
  const auth = await authenticate(req);
  if (auth.status === "lockdown") return err(res, 403, "LOCKDOWN", "Platform er i lockdown");
  if (auth.status !== "ok")       return err(res, 401, "UNAUTHENTICATED", "Login krævet");

  const contentType = (req.headers["content-type"] ?? "");
  if (!contentType.includes("multipart/form-data")) {
    return err(res, 400, "INVALID_CONTENT_TYPE", "Forventet multipart/form-data");
  }

  return new Promise<void>((resolve) => {
    const bb = Busboy({ headers: req.headers as Record<string, string>, limits: { fileSize: 26 * 1024 * 1024 } });

    const results: ExtractResult[] = [];
    const pending: Promise<void>[] = [];

    bb.on("file", (fieldname, stream, info) => {
      const { filename, mimeType } = info;
      const chunks: Buffer[] = [];

      stream.on("data", (chunk: Buffer) => chunks.push(chunk));

      const p = new Promise<void>((resFile) => {
        stream.on("end", async () => {
          const buf = Buffer.concat(chunks);
          if (!buf.length) {
            results.push({ filename, mime_type: mimeType, char_count: 0, extracted_text: "", status: "error", message: "Tom fil" });
            return resFile();
          }
          const { text, status, message } = await extractFromBuffer(buf, mimeType, filename);
          results.push({
            filename,
            mime_type:      mimeType,
            char_count:     text.length,
            extracted_text: text,
            status,
            message,
          });
          resFile();
        });

        stream.on("error", (e: Error) => {
          results.push({ filename, mime_type: mimeType, char_count: 0, extracted_text: "", status: "error", message: e.message });
          resFile();
        });
      });

      pending.push(p);
    });

    bb.on("finish", async () => {
      await Promise.all(pending);
      json(res, { results });
      resolve();
    });

    bb.on("error", (e: Error) => {
      console.error("[extract] busboy error:", e.message);
      err(res, 500, "PARSE_ERROR", "Fil-parsing fejlede");
      resolve();
    });

    req.pipe(bb);
  });
}
