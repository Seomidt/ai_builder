/**
 * ocr-logic.ts — Real OCR processing using R2 + Gemini 2.5 Flash.
 *
 * Fetches the file from R2 and runs Gemini OCR with hard timeout.
 * Primary: gemini-2.5-flash (30s timeout)
 * Fallback: gemini-1.5-pro (55s timeout)
 *
 * NOTE: env.ts is intentionally NOT imported here — it must be loaded
 * by the entry point (railway-worker.ts or ocr-worker.ts) before this
 * module is imported.
 */

import {
  updateStage,
  completeJob,
  failJob,
  type RawOcrTask,
} from "./ocr-queue.ts";

// ── Structured logger ─────────────────────────────────────────────────────────
function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "ocr-logic", event, ...fields }));
}

// ── Hard timeout wrapper ──────────────────────────────────────────────────────
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`TIMEOUT: ${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

// ── R2 fetch ──────────────────────────────────────────────────────────────────
async function fetchFromR2(r2Key: string): Promise<Buffer> {
  const accountId  = process.env.R2_ACCOUNT_ID       ?? "";
  const bucketName = process.env.R2_BUCKET_NAME       ?? process.env.R2_BUCKET ?? "";
  const accessKey  = process.env.R2_ACCESS_KEY_ID     ?? "";
  const secretKey  = process.env.R2_SECRET_ACCESS_KEY ?? "";

  if (!accountId || !bucketName || !accessKey || !secretKey) {
    throw new Error("R2 credentials not configured");
  }

  const { S3Client, GetObjectCommand } = await import("@aws-sdk/client-s3" as any);
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
  });

  const resp = await client.send(new GetObjectCommand({ Bucket: bucketName, Key: r2Key }));
  const stream = resp.Body as AsyncIterable<Uint8Array>;
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

// ── Gemini OCR ────────────────────────────────────────────────────────────────
async function extractWithGemini(
  buffer: Buffer,
  filename: string,
  mimeType: string,
  jobId: string,
  model = "gemini-2.5-flash",
): Promise<string> {
  const GEMINI_KEY = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_AI_API_KEY ?? "";
  if (!GEMINI_KEY) throw new Error("GEMINI_API_KEY not set");

  const base64 = buffer.toString("base64");
  const isPdf  = mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf");

  log("gemini_ocr_start", { jobId, model, filename, bufferKb: Math.round(buffer.length / 1024) });

  const body = {
    contents: [{
      parts: [
        {
          text: isPdf
            ? `Udtræk og returner ALT tekst fra dette PDF-dokument præcist som det fremgår. Bevar struktur (overskrifter, afsnit, tabeller, lister). Inkludér alle tal, datoer, navne og juridiske termer præcist. Svar KUN med dokumentets tekst. Dokument: ${filename}`
            : `Udtræk al synlig tekst fra dette billede præcist som det fremgår, og beskriv billedets indhold. Billede: ${filename}`,
        },
        { inline_data: { mime_type: mimeType, data: base64 } },
      ],
    }],
    generationConfig: { maxOutputTokens: 16000, temperature: 0 },
  };

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), model === "gemini-2.5-flash" ? 28_000 : 52_000);

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal },
    );

    if (!resp.ok) {
      const errText = await resp.text();
      throw new Error(`Gemini ${model} error ${resp.status}: ${errText.slice(0, 300)}`);
    }

    const data = await resp.json() as any;
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
    log("gemini_ocr_done", { jobId, model, chars: text.length });
    return text;
  } finally {
    clearTimeout(abortTimer);
  }
}

// ── Main job processor ────────────────────────────────────────────────────────
export async function processJob(job: RawOcrTask): Promise<void> {
  const start = Date.now();
  log("job_started", { jobId: job.id, filename: job.filename, contentType: job.content_type });

  try {
    await updateStage(job.id, "ocr");

    // 1. Fetch file from R2
    log("r2_fetch_start", { jobId: job.id, r2Key: job.r2_key });
    const buffer = await withTimeout(fetchFromR2(job.r2_key), 20_000, "R2 fetch");
    log("r2_fetch_done", { jobId: job.id, bufferKb: Math.round(buffer.length / 1024) });

    // 2. Extract text via Gemini (primary: 2.5-flash, fallback: 1.5-pro)
    const mimeType = job.content_type || "application/pdf";
    let extractedText = "";

    try {
      extractedText = await withTimeout(
        extractWithGemini(buffer, job.filename, mimeType, job.id, "gemini-2.5-flash"),
        32_000,
        "Gemini 2.5 Flash OCR",
      );
    } catch (primaryErr: any) {
      log("gemini_flash_failed_trying_pro", { jobId: job.id, error: primaryErr.message });
      extractedText = await withTimeout(
        extractWithGemini(buffer, job.filename, mimeType, job.id, "gemini-1.5-pro"),
        56_000,
        "Gemini 1.5 Pro OCR",
      );
    }

    if (!extractedText || extractedText.trim().length < 10) {
      throw new Error("Ingen tekst kunne udtrækkes. Dokumentet kan være krypteret, tomt eller utilgængeligt.");
    }

    // 3. Store result
    await updateStage(job.id, "storing");
    const charCount  = extractedText.length;
    const wordCount  = extractedText.split(/\s+/).filter(Boolean).length;
    const chunkCount = Math.ceil(wordCount / 900);

    await completeJob(job.id, {
      ocrText:      extractedText.slice(0, 200_000),
      qualityScore: 0.95,
      charCount,
      pageCount:    1,
      chunkCount,
      provider:     "gemini-2.5-flash",
    });

    log("job_completed", { jobId: job.id, charCount, durationMs: Date.now() - start });

  } catch (e: any) {
    const errorMsg = e.message || String(e);
    log("job_failed", { jobId: job.id, error: errorMsg, durationMs: Date.now() - start });
    await failJob(job.id, errorMsg, true).catch(() => {});
  }
}
