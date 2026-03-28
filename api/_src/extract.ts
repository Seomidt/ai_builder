import type { IncomingMessage, ServerResponse } from "http";
import { authenticate }                         from "./_lib/auth";
import { json, err }                            from "./_lib/response";
import Busboy                                   from "busboy";
// pdf-parse — supports both v1 (function) and v2 (class-based) API.
// v2 with PDFParse class is fast even on scanned PDFs (returns empty text quickly).
const PDF_PARSE_TIMEOUT_MS = 25_000;

function withPdfTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, r) =>
      setTimeout(() => r(new Error(`PDF-parsing overskred ${ms / 1000}s`)), ms),
    ),
  ]);
}

async function parsePdfBuffer(buf: Buffer): Promise<{ text: string; numpages: number }> {
  const g = globalThis as any;
  if (!g.DOMMatrix) g.DOMMatrix = class DOMMatrix { constructor() { (this as any).a=1;(this as any).b=0;(this as any).c=0;(this as any).d=1;(this as any).e=0;(this as any).f=0; } };
  if (!g.ImageData) g.ImageData = class ImageData {};
  if (!g.Path2D)    g.Path2D    = class Path2D {};
  if (!g.DOMPoint)  g.DOMPoint  = class DOMPoint {};
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfMod = require("pdf-parse");

  // v2: class API
  if (pdfMod.PDFParse) {
    const parser = new pdfMod.PDFParse({ data: buf });
    const result = await withPdfTimeout(parser.getText(), PDF_PARSE_TIMEOUT_MS);
    return { text: typeof result.text === "string" ? result.text : "", numpages: result.total ?? 0 };
  }
  // v1: function API
  if (typeof pdfMod === "function") {
    const result = await withPdfTimeout(pdfMod(buf, { max: 50 }), PDF_PARSE_TIMEOUT_MS);
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
      const { text: rawText } = await parsePdfBuffer(buf);
      const text = (rawText ?? "").trim().slice(0, 80_000);
      if (!text) return {
        text: "", status: "error",
        message: "PDF indeholder ingen læsbar tekst. Dokumentet er sandsynligvis scannet (billede-baseret PDF). Kopiér teksten manuelt og indsæt den i chatten.",
      };
      return { text, status: "ok" };
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

  // Auth check — authenticate returnerer { status, user }
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
