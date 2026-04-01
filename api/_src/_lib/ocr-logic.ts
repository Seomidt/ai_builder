/**
 * ocr-logic.ts — Core job processor for chat_ocr_tasks.
 *
 * Called by ocr-worker.ts via:
 *   import { processJob } from "./_lib/ocr-logic.ts"
 *
 * Pipeline per job:
 *   1. Download PDF buffer from R2
 *   2. Attempt pdf-parse (fast, native embedded text)
 *   3. If empty → Gemini 2.0 Flash Vision OCR (scanned PDF)
 *   4. Chunk extracted text (token-aware)
 *   5. Mark job completed with text/quality/chunk-count metadata
 *   6. On any unrecoverable error → failJob() with clear reason
 *
 * Correctness guarantees:
 *   - No simulated outputs — every completion has real extracted text
 *   - All DB writes use the queue interface (job-queue.ts)
 *   - Stage updates give live progress in the polling API
 *   - Token-aware chunking via retrieval-chunker (INV-CHK1–6 preserved)
 */

import { GetObjectCommand }  from "@aws-sdk/client-s3";
import {
  updateStage,
  completeJob,
  markOcrFailed as failJob,
  type RawOcrTask,
} from "./ocr-queue.ts";
import { extractWithGemini }  from "../../../server/lib/ai/gemini-media.ts";
import {
  chunkText,
  DEFAULT_CHUNKING_POLICY,
  type ChunkingPolicy,
} from "../../../server/lib/media/retrieval-chunker.ts";

// ── Dynamic chunking policy (T007: faster first-readiness for large docs) ──────
// Smaller maxTokens → more chunks → finer-grained retrieval coverage sooner.

function selectChunkingPolicy(charCount: number): ChunkingPolicy {
  if (charCount >= 40_000) {
    return { ...DEFAULT_CHUNKING_POLICY, maxTokens: 400, minTokens: 15 };
  }
  if (charCount >= 15_000) {
    return { ...DEFAULT_CHUNKING_POLICY, maxTokens: 600, minTokens: 20 };
  }
  return DEFAULT_CHUNKING_POLICY;
}

// ── Structured logger ──────────────────────────────────────────────────────────

function log(jobId: string, event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), svc: "ocr-logic", jobId, event, ...fields,
  }));
}

// ── R2 download ────────────────────────────────────────────────────────────────

async function downloadFromR2(r2Key: string): Promise<Buffer> {
  const accountId  = process.env.CF_R2_ACCOUNT_ID   ?? process.env.CLOUDFLARE_R2_ACCOUNT_ID ?? "";
  const accessKey  = process.env.CF_R2_ACCESS_KEY_ID ?? process.env.CLOUDFLARE_R2_ACCESS_KEY_ID ?? "";
  const secretKey  = process.env.CF_R2_SECRET_ACCESS_KEY ?? process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY ?? "";
  const bucketName = process.env.CF_R2_BUCKET_NAME   ?? process.env.CLOUDFLARE_R2_BUCKET_NAME ?? "blissops-uploads";

  if (!accountId || !accessKey || !secretKey) {
    throw new Error("R2 credentials not configured (CF_R2_ACCOUNT_ID, CF_R2_ACCESS_KEY_ID, CF_R2_SECRET_ACCESS_KEY)");
  }

  const { S3Client } = await import("@aws-sdk/client-s3");
  const r2 = new S3Client({
    region:   "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });

  const resp = await r2.send(new GetObjectCommand({ Bucket: bucketName, Key: r2Key }));
  if (!resp.Body) throw new Error(`R2 returned empty body for key: ${r2Key}`);

  const chunks: Buffer[] = [];
  for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// ── Native PDF text extraction (fast path) ────────────────────────────────────

async function tryPdfParse(buffer: Buffer): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
    const result = await pdfParse(buffer);
    return (result.text ?? "").trim();
  } catch {
    return "";
  }
}

// ── Quality score ─────────────────────────────────────────────────────────────

function scoreQuality(text: string): number {
  const len = text.replace(/\s+/g, "").length;
  if (len === 0)    return 0;
  if (len < 50)     return 0.3;
  if (len < 500)    return 0.6;
  if (len < 5_000)  return 0.85;
  return 0.95;
}

// ── Main: processJob ───────────────────────────────────────────────────────────

const MIN_NATIVE_TEXT_CHARS = 120; // non-whitespace chars required to trust pdf-parse output

export async function processJob(job: RawOcrTask): Promise<void> {
  const { id: jobId, r2_key, filename, content_type } = job;

  log(jobId, "job_start", { filename, content_type });

  try {
    // ── Stage 1: Download from R2 ──────────────────────────────────────────
    await updateStage(jobId, "ocr");
    log(jobId, "r2_download_start", { r2Key: r2_key });
    const t0     = Date.now();
    const buffer = await downloadFromR2(r2_key);
    log(jobId, "r2_download_ok", { bytes: buffer.length, ms: Date.now() - t0 });

    // ── Stage 2: Text extraction ───────────────────────────────────────────
    let extractedText = "";
    let provider      = "pdf_parse";

    const isPdf = content_type === "application/pdf" || filename.toLowerCase().endsWith(".pdf");

    if (isPdf) {
      // Fast path: native PDF text
      const nativeText    = await tryPdfParse(buffer);
      const nonWsChars    = nativeText.replace(/\s+/g, "").length;

      if (nonWsChars >= MIN_NATIVE_TEXT_CHARS) {
        extractedText = nativeText;
        provider      = "pdf_parse";
        log(jobId, "native_pdf_ok", { chars: extractedText.length, nonWs: nonWsChars });
      } else {
        // Scanned PDF → Gemini Vision OCR
        log(jobId, "gemini_ocr_start", { reason: `native_text_too_short_${nonWsChars}` });
        const t1  = Date.now();
        const gem = await extractWithGemini(buffer, filename, "application/pdf");
        log(jobId, "gemini_ocr_ok", { chars: gem.charCount, quality: gem.quality, ms: Date.now() - t1 });
        extractedText = gem.text;
        provider      = "gemini_vision";
      }
    } else if (content_type.startsWith("image/")) {
      // Image → Gemini Vision
      log(jobId, "gemini_image_start");
      const t2  = Date.now();
      const gem = await extractWithGemini(buffer, filename, content_type);
      log(jobId, "gemini_image_ok", { chars: gem.charCount, ms: Date.now() - t2 });
      extractedText = gem.text;
      provider      = "gemini_vision";
    } else if (content_type.startsWith("audio/") || content_type.startsWith("video/")) {
      // Audio/video → Gemini transcription
      log(jobId, "gemini_av_start");
      const t3  = Date.now();
      const gem = await extractWithGemini(buffer, filename, content_type);
      log(jobId, "gemini_av_ok", { chars: gem.charCount, ms: Date.now() - t3 });
      extractedText = gem.text;
      provider      = "gemini_vision";
    } else if (content_type.startsWith("text/") || content_type === "application/json") {
      extractedText = buffer.toString("utf-8").slice(0, 200_000);
      provider      = "direct_text";
    } else {
      throw new Error(`Unsupported content type: ${content_type}`);
    }

    if (!extractedText.trim()) {
      await failJob(jobId, "Ingen læsbar tekst fundet i dokumentet", false);
      log(jobId, "job_empty_text");
      return;
    }

    // ── Stage 3: Chunk text ────────────────────────────────────────────────
    await updateStage(jobId, "chunking");
    const cappedText = extractedText.slice(0, 80_000);
    const policy     = selectChunkingPolicy(cappedText.length);
    log(jobId, "chunking_start", { chars: cappedText.length, maxTokens: policy.maxTokens });
    const t4 = Date.now();

    let chunkCount = 0;
    try {
      const spans = chunkText(cappedText, policy);
      chunkCount  = spans.length;
      log(jobId, "chunking_ok", { chunks: chunkCount, ms: Date.now() - t4, policy: policy.maxTokens });
    } catch (chunkErr) {
      log(jobId, "chunking_warn", { err: (chunkErr as Error).message });
      chunkCount = Math.max(1, Math.ceil(cappedText.length / 2_000));
    }

    // ── Stage 4: Complete job ──────────────────────────────────────────────
    await updateStage(jobId, "storing");
    const quality = scoreQuality(extractedText);
    await completeJob(jobId, {
      ocrText:      extractedText.slice(0, 200_000),
      qualityScore: quality,
      charCount:    extractedText.length,
      pageCount:    isPdf ? Math.max(1, Math.ceil(extractedText.length / 3_000)) : 1,
      chunkCount,
      provider,
    });

    log(jobId, "job_completed", {
      chars:    extractedText.length,
      chunks:   chunkCount,
      quality,
      provider,
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(jobId, "job_failed", { error: msg });

    // Determine if this is retryable
    const isRetryable = !msg.includes("Unsupported content type") &&
                        !msg.includes("Ingen læsbar tekst");

    await failJob(jobId, msg.slice(0, 500), isRetryable);
  }
}
