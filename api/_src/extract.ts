/**
 * extract.ts — Multipart file extraction endpoint.
 *
 * POST /api/extract  (multipart/form-data, one or more files)
 *
 * Extracts text from uploaded files and returns structured results.
 * Used by legacy/non-R2 flows (e.g. direct browser uploads without presigned URL).
 *
 * NOTE: Scanned PDFs return status="error" with a clear message directing the
 * user to use the /api/upload flow (which supports async OCR via job queue).
 * Sync OCR is intentionally NOT supported here — it would block the request
 * for 30-90 seconds and is not production-safe.
 */

import type { IncomingMessage, ServerResponse } from "http";
import { authenticate }                         from "./_lib/auth";
import { json, err }                            from "./_lib/response";
import Busboy                                   from "busboy";

// ── Timeouts + thresholds ─────────────────────────────────────────────────────
const PDF_PARSE_TIMEOUT_MS = 25_000;
const SCANNED_THRESHOLD    = 100; // chars — below this = treat as scanned PDF

function withRaceTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, r) =>
      setTimeout(() => r(new Error(`${label} overskred ${ms / 1000}s`)), ms),
    ),
  ]);
}

// ── PDF text extraction (pdf-parse v1 + v2) ───────────────────────────────────

async function parsePdfBuffer(buf: Buffer): Promise<{ text: string; numpages: number }> {
  const g = globalThis as any;
  if (!g.DOMMatrix) g.DOMMatrix = class DOMMatrix { constructor() { (this as any).a=1;(this as any).b=0;(this as any).c=0;(this as any).d=1;(this as any).e=0;(this as any).f=0; } };
  if (!g.ImageData) g.ImageData = class ImageData {};
  if (!g.Path2D)    g.Path2D    = class Path2D {};
  if (!g.DOMPoint)  g.DOMPoint  = class DOMPoint {};
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfMod = require("pdf-parse");

  if (pdfMod.PDFParse) {
    const parser = new pdfMod.PDFParse({ data: buf });
    const result = await withRaceTimeout(parser.getText(), PDF_PARSE_TIMEOUT_MS, "PDF-parsing (v2)");
    return { text: typeof result.text === "string" ? result.text : "", numpages: result.total ?? 0 };
  }
  if (typeof pdfMod === "function") {
    const result = await withRaceTimeout(pdfMod(buf, { max: 50 }), PDF_PARSE_TIMEOUT_MS, "PDF-parsing (v1)");
    return { text: result.text ?? "", numpages: result.numpages ?? 0 };
  }
  throw new Error("pdf-parse: ukendt API");
}

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

  // ── PDF ────────────────────────────────────────────────────────────────────
  if (isPdfMime(mime, filename)) {
    try {
      const { text: rawText, numpages } = await parsePdfBuffer(buf);
      const textTrimmed = (rawText ?? "").trim();

      if (textTrimmed.length >= SCANNED_THRESHOLD) {
        // Normal text-layer PDF
        return { text: textTrimmed.slice(0, 80_000), status: "ok" };
      }

      // Scanned/image-based PDF — no sync OCR (not production-safe)
      console.log(`[extract] pdf=scanned pages=${numpages} raw_chars=${textTrimmed.length}`);
      return {
        text: "",
        status: "error",
        message:
          `PDF er scannet/billede-baseret (${numpages} sider) og kan ikke læses direkte. ` +
          "Brug venligst upload-knappen i chatten — den understøtter automatisk OCR.",
      };
    } catch (e) {
      console.error("[extract] pdf-parse error:", (e as Error).message);
      return { text: "", status: "error", message: "PDF-parsing fejlede: " + (e as Error).message };
    }
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
