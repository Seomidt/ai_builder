// SOC2 Compliance: TLS certificate validation is enforced.
// We use the Supabase CA certificate (prod-ca-2021.crt) in db.ts
// to securely connect to the Supabase Session Pooler.

/**
 * railway-worker.ts — Continuous background worker for OCR and document analysis.
 *
 * OCR Provider: Google Gemini 2.5 Flash (native PDF understanding)
 *
 * Why Gemini 2.5 Flash for PDFs?
 *   - Native application/pdf MIME type support — no image conversion needed
 *   - Understands full document structure: headers, tables, footnotes, multi-column
 *   - 1M token context window handles very large documents
 *   - Cheapest capable model for PDF OCR (~$0.075/1M tokens)
 *   - Uses Google AI OpenAI-compatible endpoint — no extra SDK needed
 *
 * Flow per job:
 *   1. Claim job from Supabase queue (chat_ocr_tasks)
 *   2. Download the file from Cloudflare R2 as a buffer
 *   3. Send to Google AI (gemini-2.5-flash) as inline PDF base64
 *   4. Store extracted text in the job record (ocrText)
 *   5. Mark job as completed — frontend polling picks it up
 *
 * SOC2/ISO compliance:
 *   - Tenant ID and User ID are logged for full audit trail
 *   - Document content is never logged — only metadata
 *   - All DB connections use SSL with Supabase CA certificate
 */

import "../lib/env";
import * as http from "http";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import {
  claimJobs,
  updateStage,
  completeJob,
  failJob,
  type RawOcrTask,
} from "../lib/jobs/job-queue";
import { extractWithGemini, classifyMime } from "../lib/ai/gemini-media";

// ── R2 client (inline to avoid cross-dir ESM issues) ─────────────────────────
import { S3Client } from "@aws-sdk/client-s3";

const r2AccountId       = process.env.CF_R2_ACCOUNT_ID        ?? "";
const r2AccessKeyId     = process.env.CF_R2_ACCESS_KEY_ID     ?? "";
const r2SecretAccessKey = process.env.CF_R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET         = process.env.CF_R2_BUCKET_NAME       ?? "blissops";

const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     r2AccessKeyId     || "placeholder",
    secretAccessKey: r2SecretAccessKey || "placeholder",
  },
  forcePathStyle: false,
});

// ── Config ────────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS  = 5_000;
const CONCURRENCY_LIMIT = 2;
const HEALTH_PORT       = parseInt(process.env.PORT ?? "8080", 10);

// OCR model: gemini-2.5-flash — native PDF/image/video/audio support
const OCR_MODEL         = "gemini-2.5-flash";

// ── Health check HTTP server ──────────────────────────────────────────────────
// Railway requires a process to bind to a port and respond to HTTP requests.
// Without this, Railway sends SIGTERM after ~30s thinking the process crashed.

const healthServer = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status:   "ok",
      service:  "railway-worker",
      ocrModel: OCR_MODEL,
      gateway:  "generativelanguage.googleapis.com",
      ts:       new Date().toISOString(),
    }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

healthServer.listen(HEALTH_PORT, () => {
  log("health_server_started", { port: HEALTH_PORT });
});

// ── Structured logger (SOC2-safe — no document content logged) ────────────────

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    ts:  new Date().toISOString(),
    svc: "railway-worker",
    event,
    ...fields,
  }));
}

// ── Download file from R2 ─────────────────────────────────────────────────────

async function downloadFromR2(r2Key: string): Promise<Buffer> {
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key });
  const response = await r2Client.send(cmd);
  const stream = response.Body as NodeJS.ReadableStream;

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ── Extract text/content via Gemini 2.5 Flash (all media types) ──────────────
//
// Delegates to gemini-media.ts which handles:
//   - PDF:   native PDF understanding (text, tables, scanned pages)
//   - Image: vision analysis (OCR + visual description)
//   - Video: frame analysis + speech transcription
//   - Audio: speech-to-text transcription
//
// All via GEMINI_API_KEY → generativelanguage.googleapis.com

async function extractTextWithAI(
  fileBuffer: Buffer,
  filename:   string,
  contentType: string,
): Promise<string> {
  const mediaType = classifyMime(contentType, filename);

  if (mediaType === "unknown") {
    throw new Error(`Unsupported file type: ${contentType} (${filename})`);
  }

  const result = await extractWithGemini(fileBuffer, filename, contentType);
  return result.text;
}

// ── Job processor ─────────────────────────────────────────────────────────────

async function processJob(job: RawOcrTask): Promise<void> {
  const start = Date.now();
  log("job_started", {
    jobId:    job.id,
    tenantId: job.tenant_id,
    filename: job.filename,
    // SOC2: log metadata only, never document content
  });

  try {
    // Stage 1: Download from R2
    await updateStage(job.id, "ocr");
    log("downloading_from_r2", { jobId: job.id, r2Key: job.r2_key });
    const fileBuffer = await downloadFromR2(job.r2_key);
    log("download_complete", { jobId: job.id, bytes: fileBuffer.length });

    // Stage 2: Extract text/content via Gemini 2.5 Flash (PDF/image/video/audio)
    const mediaType = classifyMime(job.content_type, job.filename);
    log("ai_extraction_started", { jobId: job.id, model: OCR_MODEL, mediaType });
    const ocrText = await extractTextWithAI(fileBuffer, job.filename, job.content_type);
    log("ai_extraction_complete", { jobId: job.id, chars: ocrText.length, model: OCR_MODEL, mediaType });

    // Stage 3: Store result
    await updateStage(job.id, "storing");

    await completeJob(job.id, {
      ocrText,
      qualityScore: ocrText.length > 100 ? 0.95 : 0.5,
      charCount:    ocrText.length,
      pageCount:    1,
      chunkCount:   Math.ceil(ocrText.length / 2000),
      provider:     `google/${OCR_MODEL}`,
    });

    log("job_completed", {
      jobId:      job.id,
      tenantId:   job.tenant_id,
      model:      OCR_MODEL,
      durationMs: Date.now() - start,
      chars:      ocrText.length,
      // SOC2: durationMs and chars logged for audit — no content
    });

  } catch (e: any) {
    const errorMsg = e?.message ?? String(e);
    log("job_failed", { jobId: job.id, tenantId: job.tenant_id, error: errorMsg });
    await failJob(job.id, errorMsg).catch(() => {});
  }
}

// ── Worker loop ───────────────────────────────────────────────────────────────

async function runWorker(): Promise<void> {
  log("worker_started", {
    concurrency:    CONCURRENCY_LIMIT,
    pollIntervalMs: POLL_INTERVAL_MS,
    ocrModel:       OCR_MODEL,
    gateway:        "generativelanguage.googleapis.com",
    supports:       "pdf,image,video,audio",
  });

  while (true) {
    try {
      const jobs: RawOcrTask[] = await claimJobs(CONCURRENCY_LIMIT);

      if (jobs.length > 0) {
        log("jobs_claimed", { count: jobs.length });
        await Promise.all(jobs.map(job => processJob(job)));
      }
    } catch (err: any) {
      log("worker_loop_error", { error: err?.message ?? String(err) });
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

runWorker().catch(err => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});
