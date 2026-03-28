/**
 * Direct Attachment Processor — Mode A.
 *
 * Reads a file that has already been uploaded to R2 via presigned URL,
 * extracts text/content, and returns it ready for direct chat usage.
 *
 * Safe only for small/simple files (≤ 4 MB). For larger files or video/audio,
 * the attachment router sends requests to Mode B instead.
 *
 * Supported types for direct extraction:
 *   - PDF  (pdf-parse, lazy-loaded) — scanned PDFs return code SCANNED_PDF (async OCR)
 *   - Plain text / CSV / Markdown
 *   - Images (returned as-is for vision models, no text extraction)
 *
 * Video/audio: NOT supported here — always routes to B.
 */

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, R2_BUCKET, R2_CONFIGURED } from "../r2/r2-client";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DirectProcessInput {
  objectKey:   string;
  filename:    string;
  contentType: string;
  sizeBytes:   number;
}

export interface DirectProcessResult {
  filename:       string;
  mime_type:      string;
  char_count:     number;
  extracted_text: string;
  status:         "ok" | "unsupported" | "error" | "scanned_pdf";
  /** Machine-readable code for programmatic handling in the caller. */
  code?:          "SCANNED_PDF" | "PDF_ERROR" | "R2_ERROR" | "UNSUPPORTED";
  message?:       string;
  source:         "r2_direct";
}

// ── Timeouts ──────────────────────────────────────────────────────────────────

const PDF_PARSE_TIMEOUT_MS = 25_000;
const SCANNED_THRESHOLD    = 100; // chars below this → treat as scanned/image-based

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} overskred ${ms / 1000}s`)), ms),
    ),
  ]);
}

// ── PDF text extraction — supports pdf-parse v1 + v2 ─────────────────────────

async function extractPdfText(buf: Buffer): Promise<{ text: string; numpages: number }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfMod = require("pdf-parse");

  if (pdfMod.PDFParse) {
    const parser = new pdfMod.PDFParse({ data: buf });
    const result = await withTimeout(parser.getText(), PDF_PARSE_TIMEOUT_MS, "PDF-parsing (v2)");
    return {
      text:     typeof result.text === "string" ? result.text : "",
      numpages: typeof result.total === "number" ? result.total : 0,
    };
  }

  if (typeof pdfMod === "function") {
    const result = await withTimeout(pdfMod(buf, { max: 50 }), PDF_PARSE_TIMEOUT_MS, "PDF-parsing (v1)");
    return { text: result.text ?? "", numpages: result.numpages ?? 0 };
  }

  throw new Error("pdf-parse modul har ukendt API");
}

// ── Text MIME check ───────────────────────────────────────────────────────────

function isTextMime(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml"
  );
}

function isPdfMime(mime: string, filename: string): boolean {
  return mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
}

function isImageMime(mime: string): boolean {
  return mime.startsWith("image/");
}

// ── R2 read helper ────────────────────────────────────────────────────────────

async function readFromR2(objectKey: string): Promise<Buffer> {
  if (!R2_CONFIGURED) {
    throw new Error("R2 er ikke konfigureret — CF_R2_ACCOUNT_ID/CF_R2_ACCESS_KEY_ID/CF_R2_SECRET_ACCESS_KEY mangler");
  }
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: objectKey });
  const resp = await r2Client.send(cmd);
  if (!resp.Body) throw new Error("R2 returnerede tom body for nøgle: " + objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ── Main processor ────────────────────────────────────────────────────────────

export async function processDirectAttachment(
  input: DirectProcessInput,
): Promise<DirectProcessResult> {
  const { objectKey, filename, contentType, sizeBytes } = input;

  console.log(`[direct-processor] mode=A key=${objectKey} mime=${contentType} size=${sizeBytes}b`);

  // Images: return metadata without text extraction (vision models use URL/key)
  if (isImageMime(contentType)) {
    return {
      filename,
      mime_type:      contentType,
      char_count:     0,
      extracted_text: `[Billede: ${filename}]`,
      status:         "ok",
      source:         "r2_direct",
    };
  }

  let buf: Buffer;
  try {
    buf = await readFromR2(objectKey);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[direct-processor] r2 read failed: ${msg}`);
    return {
      filename, mime_type: contentType, char_count: 0, extracted_text: "",
      status: "error", code: "R2_ERROR", message: msg, source: "r2_direct",
    };
  }

  // Plain text
  if (isTextMime(contentType)) {
    const text = buf.toString("utf-8").slice(0, 80_000);
    console.log(`[direct-processor] text extracted chars=${text.length}`);
    return {
      filename, mime_type: contentType, char_count: text.length,
      extracted_text: text, status: "ok", source: "r2_direct",
    };
  }

  // PDF — extract text layer only. Scanned PDFs hand off to async OCR.
  if (isPdfMime(contentType, filename)) {
    try {
      const { text: rawText, numpages } = await extractPdfText(buf);
      const textTrimmed = (rawText ?? "").trim();

      if (textTrimmed.length >= SCANNED_THRESHOLD) {
        // Normal text-layer PDF — use as-is
        const capped = textTrimmed.slice(0, 80_000);
        console.log(`[direct-processor] pdf=text pages=${numpages} chars_raw=${textTrimmed.length} chars_used=${capped.length}`);
        return {
          filename, mime_type: contentType, char_count: capped.length,
          extracted_text: capped, status: "ok", source: "r2_direct",
        };
      }

      // Scanned/image-based PDF — signal caller to create async OCR task
      console.log(`[direct-processor] pdf=scanned pages=${numpages} raw_chars=${textTrimmed.length} — returning SCANNED_PDF`);
      return {
        filename, mime_type: contentType, char_count: 0, extracted_text: "",
        status:  "scanned_pdf",
        code:    "SCANNED_PDF",
        message: `PDF er scannet/billede-baseret (${numpages} sider) — afventer asynkron OCR`,
        source:  "r2_direct",
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[direct-processor] pdf-parse error: ${msg}`);
      return {
        filename, mime_type: contentType, char_count: 0, extracted_text: "",
        status: "error", code: "PDF_ERROR",
        message: "PDF-parsing fejlede: " + msg, source: "r2_direct",
      };
    }
  }

  return {
    filename, mime_type: contentType, char_count: 0, extracted_text: "",
    status: "unsupported", code: "UNSUPPORTED",
    message: `Filtype "${contentType}" understøttes ikke til direkte behandling. Upload PDF eller en tekstfil.`,
    source: "r2_direct",
  };
}
