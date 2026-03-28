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
 *   - PDF  (pdf-parse, lazy-loaded)
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
  status:         "ok" | "unsupported" | "error";
  message?:       string;
  source:         "r2_direct";
}

// ── PDF lazy loader (same pattern as api/_src/extract.ts) ─────────────────────

function loadPdfParse(): (buf: Buffer) => Promise<{ text: string; numpages: number }> {
  const g = globalThis as any;
  if (!g.DOMMatrix)  g.DOMMatrix  = class DOMMatrix  { constructor() { (this as any).a=1;(this as any).b=0;(this as any).c=0;(this as any).d=1;(this as any).e=0;(this as any).f=0; } };
  if (!g.ImageData)  g.ImageData  = class ImageData  {};
  if (!g.Path2D)     g.Path2D     = class Path2D     {};
  if (!g.DOMPoint)   g.DOMPoint   = class DOMPoint   {};
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require("pdf-parse");
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
    return { filename, mime_type: contentType, char_count: 0, extracted_text: "", status: "error", message: msg, source: "r2_direct" };
  }

  // Plain text
  if (isTextMime(contentType)) {
    // Mode A: 4 MB max → text is at most ~4M chars, safe to pass all to chat
    const text = buf.toString("utf-8").slice(0, 80_000);
    console.log(`[direct-processor] text extracted chars=${text.length}`);
    return { filename, mime_type: contentType, char_count: text.length, extracted_text: text, status: "ok", source: "r2_direct" };
  }

  // PDF
  if (isPdfMime(contentType, filename)) {
    try {
      const pdfParse = loadPdfParse();
      const result   = await pdfParse(buf);
      const text     = (result.text ?? "").trim();
      if (!text) {
        return { filename, mime_type: contentType, char_count: 0, extracted_text: "", status: "error", message: "PDF indeholder ingen læsbar tekst (muligvis scanned billede)", source: "r2_direct" };
      }
      // Mode A files are ≤ 4 MB — typical extracted text is well within 40K chars
      // We still cap at 80K to be safe for API token limits
      const capped = text.slice(0, 80_000);
      console.log(`[direct-processor] pdf extracted pages=${result.numpages} chars_raw=${text.length} chars_used=${capped.length}`);
      return { filename, mime_type: contentType, char_count: capped.length, extracted_text: capped, status: "ok", source: "r2_direct" };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[direct-processor] pdf-parse error: ${msg}`);
      return { filename, mime_type: contentType, char_count: 0, extracted_text: "", status: "error", message: "PDF-parsing fejlede: " + msg, source: "r2_direct" };
    }
  }

  return {
    filename, mime_type: contentType, char_count: 0, extracted_text: "",
    status: "unsupported",
    message: `Filtype "${contentType}" understøttes ikke til direkte behandling. Upload PDF eller en tekstfil.`,
    source: "r2_direct",
  };
}
