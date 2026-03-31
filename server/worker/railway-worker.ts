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

// Google AI (OpenAI-compatible endpoint — no extra SDK needed)
// GEMINI_API_KEY is set in Railway environment variables.
const GEMINI_API_KEY    = process.env.GEMINI_API_KEY  ?? "";
const GEMINI_BASE_URL   = "https://generativelanguage.googleapis.com/v1beta/openai";

// OCR model: gemini-2.5-flash — native PDF support, cheapest capable model
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
      gateway:  GEMINI_BASE_URL,
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

// ── Extract text via Manus-Gateway → gemini-2.5-flash (native PDF) ───────────
//
// Manus-Gateway is OpenAI-compatible. We pass the PDF as a base64 data URL
// in the image_url field — Gemini 2.5 Flash natively understands application/pdf.
//
// This approach:
//   - Requires no separate Google API key (uses existing OPENAI_API_KEY)
//   - Manus automatically selects the cheapest model that can handle the task
//   - Gemini handles scanned PDFs, tables, multi-column layouts, and footnotes
//   - Max inline size: ~20 MB (sufficient for most contracts and reports)

async function extractTextWithAI(
  fileBuffer: Buffer,
  filename: string,
  contentType: string,
): Promise<string> {
  const isPdf     = contentType === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
  const mimeType  = isPdf ? "application/pdf" : (contentType || "application/octet-stream");
  const base64    = fileBuffer.toString("base64");

  const prompt = `Udtræk og returner ALT tekst fra dette dokument præcist som det fremgår.

Regler:
- Udtræk HELE dokumentets tekstindhold — ingen udeladelser
- Bevar dokumentets struktur (overskrifter, afsnit, tabeller, lister, sidenumre)
- Inkludér alle tal, datoer, navne og juridiske termer præcist
- Svar KUN med dokumentets tekst — ingen kommentarer, forklaringer eller opsummeringer
- Bevar det originale sprog (dansk, engelsk osv.)
- Tabeller: bevar kolonner og rækker med tabulering
- Hvis dokumentet er scannet/billede-baseret: transskribér al synlig tekst

Dokument: ${filename}`;

  const requestBody = {
    model:       OCR_MODEL,
    temperature: 0,
    max_tokens:  16000,
    messages: [
      {
        role:    "user",
        content: [
          {
            type:      "text",
            text:      prompt,
          },
          {
            type:      "image_url",
            image_url: {
              url: `data:${mimeType};base64,${base64}`,
            },
          },
        ],
      },
    ],
  };

  const response = await fetch(`${GEMINI_BASE_URL}/chat/completions`, {
    method:  "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${GEMINI_API_KEY}`,
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Manus-Gateway OCR error ${response.status}: ${errText.slice(0, 300)}`);
  }

  const data = await response.json() as {
    choices: Array<{ message: { content: string } }>;
    model?:  string;
    usage?:  { total_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
  };

  const text = data.choices?.[0]?.message?.content ?? "";
  return text;
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

    // Stage 2: Extract text via Google AI → gemini-2.5-flash
    log("ai_extraction_started", { jobId: job.id, model: OCR_MODEL, gateway: GEMINI_BASE_URL });
    const ocrText = await extractTextWithAI(fileBuffer, job.filename, job.content_type);
    log("ai_extraction_complete", { jobId: job.id, chars: ocrText.length, model: OCR_MODEL });

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
    gateway:        GEMINI_BASE_URL,
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
