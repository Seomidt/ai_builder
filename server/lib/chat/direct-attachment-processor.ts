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

// ── Timeouts ──────────────────────────────────────────────────────────────────

const PDF_PARSE_TIMEOUT_MS = 25_000;
const OCR_TIMEOUT_MS       = 50_000;
const SCANNED_THRESHOLD    = 100; // chars below this = treat as scanned/image-based

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

// ── OCR via vision model (Gemini 1.5 Flash primary, OpenAI GPT-4o fallback) ──
//
// Called when pdf-parse returns < SCANNED_THRESHOLD chars — indicates a
// scanned/image-based PDF. Both providers support sending the raw PDF bytes
// without any page-to-image conversion.

const OCR_PROMPT =
  "Extract ALL text from this scanned PDF document verbatim. " +
  "Begin each page's content with '[Side N]' on its own line (N = page number). " +
  "Preserve the original text structure and line breaks as closely as possible. " +
  "If a page has no readable text, write '[Side N — ingen tekst]' and continue. " +
  "Do not summarize, paraphrase, translate, or add any commentary.";

async function ocrWithGemini(buf: Buffer, apiKey: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const model = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: "gemini-1.5-flash" });
  const result = await withTimeout(
    model.generateContent([
      { inlineData: { data: buf.toString("base64"), mimeType: "application/pdf" } },
      OCR_PROMPT,
    ]),
    OCR_TIMEOUT_MS,
    "Gemini OCR",
  );
  return result.response.text().trim();
}

async function ocrWithOpenAI(buf: Buffer, filename: string, apiKey: string): Promise<string> {
  const base64 = buf.toString("base64");
  const resp = await withTimeout(
    fetch("https://api.openai.com/v1/chat/completions", {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{
          role: "user",
          content: [
            { type: "file", file: { filename, file_data: `data:application/pdf;base64,${base64}` } },
            { type: "text", text: OCR_PROMPT },
          ],
        }],
        max_tokens: 16000,
      }),
    }),
    OCR_TIMEOUT_MS,
    "OpenAI OCR",
  );
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`OpenAI OCR HTTP ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

async function ocrPdfWithVision(buf: Buffer, filename: string): Promise<string> {
  const geminiKey = (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? "").trim();
  if (geminiKey) {
    console.log("[direct-processor] ocr=gemini");
    return ocrWithGemini(buf, geminiKey);
  }
  const openaiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (openaiKey) {
    console.log("[direct-processor] ocr=openai");
    return ocrWithOpenAI(buf, filename, openaiKey);
  }
  throw new Error("Ingen OCR-udbyder konfigureret — GOOGLE_GENERATIVE_AI_API_KEY eller OPENAI_API_KEY kræves");
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

  // PDF — try text extraction, OCR fallback for scanned/image-based PDFs
  if (isPdfMime(contentType, filename)) {
    try {
      const { text: rawText, numpages } = await extractPdfText(buf);
      const textTrimmed = (rawText ?? "").trim();

      if (textTrimmed.length >= SCANNED_THRESHOLD) {
        // Normal text-layer PDF — use as-is
        const capped = textTrimmed.slice(0, 80_000);
        console.log(`[direct-processor] pdf=text pages=${numpages} chars_raw=${textTrimmed.length} chars_used=${capped.length}`);
        return { filename, mime_type: contentType, char_count: capped.length, extracted_text: capped, status: "ok", source: "r2_direct" };
      }

      // Scanned/image-based PDF — attempt OCR via vision model
      console.log(`[direct-processor] pdf=scanned pages=${numpages} raw_chars=${textTrimmed.length} — starting OCR`);
      try {
        const ocrText = await ocrPdfWithVision(buf, filename);
        if (!ocrText || ocrText.length < 20) {
          return {
            filename, mime_type: contentType, char_count: 0, extracted_text: "",
            status: "error",
            message: "PDF er scannet/billede-baseret og OCR kunne ikke finde læsbar tekst.",
            source: "r2_direct",
          };
        }
        const capped = ocrText.slice(0, 80_000);
        console.log(`[direct-processor] pdf=ocr chars=${capped.length}`);
        return { filename, mime_type: contentType, char_count: capped.length, extracted_text: capped, status: "ok", source: "r2_direct" };
      } catch (ocrErr) {
        const ocrMsg = ocrErr instanceof Error ? ocrErr.message : String(ocrErr);
        console.error(`[direct-processor] ocr failed: ${ocrMsg}`);
        return {
          filename, mime_type: contentType, char_count: 0, extracted_text: "",
          status: "error",
          message: `PDF er scannet og OCR fejlede: ${ocrMsg}`,
          source: "r2_direct",
        };
      }
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
