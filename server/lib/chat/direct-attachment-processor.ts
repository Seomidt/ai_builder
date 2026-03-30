/**
 * Direct Attachment Processor — Mode A (Manus-Only Optimized).
 *
 * Reads a file that has already been uploaded to R2 via presigned URL,
 * extracts text/content, and returns it ready for direct chat usage.
 *
 * PDF extraction is now delegated to the async OCR pipeline (Manus)
 * to remove the 'pdf-parse' dependency and ensure 110% SaaS stability.
 */

import { GetObjectCommand } from "@aws-sdk/client-s3";
import { r2Client, R2_BUCKET, R2_CONFIGURED } from "../r2/r2-client.ts";

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

  // PDF: Always route to async OCR in Manus-Only architecture.
  // This removes the need for 'pdf-parse' and ensures high-quality extraction.
  if (isPdfMime(contentType, filename)) {
    console.log(`[direct-processor] pdf detected — routing to async OCR (Manus)`);
    return {
      filename, mime_type: contentType, char_count: 0, extracted_text: "",
      status:  "scanned_pdf",
      code:    "SCANNED_PDF",
      message: `PDF sendt til asynkron behandling via Manus`,
      source:  "r2_direct",
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

  return {
    filename, mime_type: contentType, char_count: 0, extracted_text: "",
    status: "unsupported", code: "UNSUPPORTED",
    message: `Filtype "${contentType}" understøttes ikke til direkte behandling. Upload PDF eller en tekstfil.`,
    source: "r2_direct",
  };
}
