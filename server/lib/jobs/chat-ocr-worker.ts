/**
 * chat-ocr-worker.ts — Railway-native OCR polling worker.
 *
 * Polls chat_ocr_tasks for pending jobs and processes them in-process.
 * This replaces the Vercel serverless ocr-worker.ts for Railway deployments.
 *
 * Pipeline per job:
 *   1. Claim job (FOR UPDATE SKIP LOCKED)
 *   2. Fetch PDF/image from R2
 *   3. Extract text (pdf-parse for text PDFs, OpenAI Vision for scanned/images)
 *   4. Mark completed with extracted text
 *
 * Start via: CHAT_OCR_WORKER=true (env flag in Railway)
 */

import { claimJobs, updateStage, completeJob, failJob } from "./job-queue.ts";
import type { RawOcrTask } from "./job-queue.ts";

let _intervalId: ReturnType<typeof setInterval> | null = null;

const POLL_MS       = parseInt(process.env.CHAT_OCR_POLL_MS   ?? "4000", 10);
const MAX_CONCURRENT = parseInt(process.env.CHAT_OCR_MAX_CONC ?? "3",    10);

function log(msg: string, extra: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "chat-ocr-worker", msg, ...extra }));
}

export function startChatOcrWorker(): void {
  if (_intervalId) return;
  log("starting", { pollMs: POLL_MS, maxConcurrent: MAX_CONCURRENT });

  _intervalId = setInterval(() => {
    runCycle().catch((err) =>
      log("cycle_error", { error: (err as Error).message }),
    );
  }, POLL_MS);
}

export function stopChatOcrWorker(): void {
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
  log("stopped");
}

// ── Cycle ──────────────────────────────────────────────────────────────────────

async function runCycle(): Promise<void> {
  const jobs = await claimJobs(MAX_CONCURRENT);
  if (jobs.length === 0) return;

  log("jobs_claimed", { count: jobs.length });
  await Promise.all(jobs.map((job) =>
    processOcrJob(job).catch((err) =>
      log("job_unhandled_crash", { jobId: job.id, error: (err as Error).message }),
    ),
  ));
}

// ── Job processor ──────────────────────────────────────────────────────────────

async function processOcrJob(job: RawOcrTask): Promise<void> {
  const start = Date.now();
  log("job_started", { jobId: job.id, filename: job.filename, contentType: job.content_type });

  try {
    await updateStage(job.id, "ocr");

    // 1. Fetch file from R2
    const buffer = await fetchFromR2(job.r2_key);

    // 2. Extract text based on content type
    let extractedText = "";
    const isPdf = job.content_type === "application/pdf" || job.filename?.toLowerCase().endsWith(".pdf");
    const isImage = job.content_type?.startsWith("image/");

    if (isPdf) {
      extractedText = await extractPdfText(buffer, job.id);
    } else if (isImage) {
      extractedText = await extractImageText(buffer, job.content_type, job.id);
    } else {
      // Fallback: try as text
      extractedText = buffer.toString("utf-8").trim();
    }

    if (!extractedText || extractedText.trim().length < 10) {
      // If pdf-parse returned nothing, try OpenAI Vision as fallback (scanned PDF)
      if (isPdf) {
        log("pdf_parse_empty_trying_vision", { jobId: job.id });
        extractedText = await extractPdfViaVision(buffer, job.id);
      }
    }

    if (!extractedText || extractedText.trim().length === 0) {
      throw new Error("Ingen tekst kunne udtrækkes fra dokumentet. Dokumentet kan være krypteret eller tomt.");
    }

    await updateStage(job.id, "storing");

    const charCount  = extractedText.length;
    const wordCount  = extractedText.split(/\s+/).filter(Boolean).length;
    const chunkCount = Math.ceil(wordCount / 900);

    await completeJob(job.id, {
      ocrText:      extractedText.slice(0, 200_000), // cap at 200k chars
      qualityScore: 0.95,
      charCount,
      pageCount:    1,
      chunkCount,
      provider:     "railway-ocr-worker",
    });

    log("job_completed", { jobId: job.id, charCount, durationMs: Date.now() - start });
  } catch (err) {
    const reason = (err as Error).message ?? String(err);
    log("job_failed", { jobId: job.id, error: reason, durationMs: Date.now() - start });
    await failJob(job.id, reason, true).catch(() => {});
  }
}

// ── R2 fetch ───────────────────────────────────────────────────────────────────

async function fetchFromR2(r2Key: string): Promise<Buffer> {
  const { R2_CONFIGURED, R2_BUCKET, r2Client } = await import("../r2/r2-client");
  if (!R2_CONFIGURED) throw new Error("R2 storage not configured");

  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const resp = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }));

  const chunks: Buffer[] = [];
  const stream = resp.Body as NodeJS.ReadableStream;
  await new Promise<void>((res, rej) => {
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", res);
    stream.on("error", rej);
  });
  return Buffer.concat(chunks);
}

// ── PDF text extraction ────────────────────────────────────────────────────────

async function extractPdfText(buffer: Buffer, jobId: string): Promise<string> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string; numpages: number }>;
    const result = await pdfParse(buffer);
    const text = result.text?.trim() ?? "";
    log("pdf_parse_result", { jobId, chars: text.length, pages: result.numpages });
    return text;
  } catch (err) {
    log("pdf_parse_error", { jobId, error: (err as Error).message });
    return "";
  }
}

// ── Image OCR via OpenAI Vision ────────────────────────────────────────────────

async function extractImageText(buffer: Buffer, mimeType: string, jobId: string): Promise<string> {
  const { isOpenAIAvailable, getOpenAIClient } = await import("../openai-client.ts");
  if (!isOpenAIAvailable()) {
    throw new Error("OpenAI API key not configured — cannot perform OCR on image");
  }

  const supportedTypes = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"];
  if (!supportedTypes.includes(mimeType)) {
    throw new Error(`OCR not supported for MIME type '${mimeType}'`);
  }

  const base64  = buffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;
  const client  = getOpenAIClient();

  log("vision_ocr_start", { jobId, mimeType, bufferKb: Math.round(buffer.length / 1024) });

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
          { type: "text", text: "Extract all text visible in this image. Return only the extracted text verbatim, preserving structure where possible. If no text is present, return the single word: EMPTY" },
        ],
      },
    ],
    max_tokens: 4096,
  });

  const extracted = response.choices[0]?.message?.content?.trim() ?? "";
  if (!extracted || extracted === "EMPTY") return "";
  log("vision_ocr_done", { jobId, chars: extracted.length });
  return extracted;
}

// ── Scanned PDF via Vision (convert first page to image) ──────────────────────

async function extractPdfViaVision(buffer: Buffer, jobId: string): Promise<string> {
  const { isOpenAIAvailable, getOpenAIClient } = await import("../openai-client.ts");
  if (!isOpenAIAvailable()) {
    throw new Error("OpenAI API key not configured — cannot perform vision OCR on scanned PDF");
  }

  // Send the raw PDF bytes as base64 to GPT-4o-mini which supports PDF natively
  const base64  = buffer.toString("base64");
  const dataUrl = `data:application/pdf;base64,${base64}`;
  const client  = getOpenAIClient();

  log("pdf_vision_ocr_start", { jobId, bufferKb: Math.round(buffer.length / 1024) });

  try {
    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl, detail: "high" } },
            { type: "text", text: "This is a scanned PDF document. Extract ALL text content visible in this document. Return only the extracted text verbatim, preserving paragraph structure. If no text is present, return the single word: EMPTY" },
          ],
        },
      ],
      max_tokens: 16384,
    });

    const extracted = response.choices[0]?.message?.content?.trim() ?? "";
    if (!extracted || extracted === "EMPTY") return "";
    log("pdf_vision_ocr_done", { jobId, chars: extracted.length });
    return extracted;
  } catch (err) {
    log("pdf_vision_ocr_error", { jobId, error: (err as Error).message });
    throw err;
  }
}
