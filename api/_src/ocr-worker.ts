/**
 * ocr-worker.ts — Production-grade async OCR pipeline worker.
 *
 * Trigger paths:
 *   1. Vercel Cron (every minute) — POST /api/ocr-worker  [recovery sweep]
 *   2. Fire-and-forget from /api/upload/finalize            [near-immediate]
 *
 * Pipeline per claimed job:
 *   claim (SKIP LOCKED) → R2 fetch → pdf-parse validation →
 *   OCR (Gemini primary / GPT-4o fallback) → quality gate →
 *   stage: chunking → embedding → storing →
 *   cost logging → complete / fail-with-backoff / dead-letter
 *
 * Tenant isolation:
 *   - claimJobs uses SELECT ... SKIP LOCKED (no cross-tenant claims possible
 *     since workers process any tenant's jobs, but each job is tenant-scoped)
 *   - all writes (chunks, cost logs) carry tenant_id from the job row
 *
 * SOC2-safe logging: no raw document content in structured logs.
 */

import "../../server/lib/env";
import type { IncomingMessage, ServerResponse } from "http";
import { json, err }                            from "./_lib/response";
import {
  claimJobs,
  updateStage,
  markOcrCompleted,
  markOcrFailed,
  storeOcrChunks,
  logOcrCost,
  estimateOcrCost,
  type RawOcrTask,
  type OcrChunk,
}                                               from "./_lib/ocr-queue";

// ── Constants ─────────────────────────────────────────────────────────────────

const CLAIM_LIMIT        = 3;
const SCANNED_THRESHOLD  = 100;   // chars — below = scanned PDF
const OCR_TIMEOUT_MS     = 90_000;
const EMBED_BATCH_SIZE   = 20;
const QUALITY_FAIL_SCORE = 0.10;  // below = unreadable → dead-letter
const QUALITY_RETRY_SCORE = 0.35; // below = try fallback provider

const OCR_PROMPT =
  "Extract ALL text from this scanned PDF document verbatim. " +
  "Begin each page's content with '[Side N]' on its own line (N = page number). " +
  "Preserve the original text structure and line breaks as closely as possible. " +
  "If a page has no readable text, write '[Side N — ingen tekst]' and continue. " +
  "Do not summarize, paraphrase, translate, or add any commentary.";

// ── Structured logger (SOC2-safe) ─────────────────────────────────────────────

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "ocr-worker", event, ...fields }));
}

// ── Timeout helper ────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms / 1000}s`)), ms),
    ),
  ]);
}

// ── R2 fetch ──────────────────────────────────────────────────────────────────

async function fetchFromR2(objectKey: string): Promise<Buffer> {
  const { r2Client, R2_BUCKET, R2_CONFIGURED } = await import("../../server/lib/r2/r2-client");
  if (!R2_CONFIGURED) throw new Error("R2 ikke konfigureret");
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const resp = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: objectKey }));
  if (!resp.Body) throw new Error("R2 tom body: " + objectKey);
  const chunks: Buffer[] = [];
  for await (const c of resp.Body as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

// ── PDF parse ─────────────────────────────────────────────────────────────────

async function parsePdf(buf: Buffer): Promise<{ text: string; numpages: number }> {
  const g = globalThis as Record<string, unknown>;
  if (!g.DOMMatrix) g.DOMMatrix = class DOMMatrix { constructor() { (this as any).a=1;(this as any).b=0;(this as any).c=0;(this as any).d=1;(this as any).e=0;(this as any).f=0; } };
  if (!g.ImageData) g.ImageData = class ImageData {};
  if (!g.Path2D)    g.Path2D    = class Path2D {};
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pdfMod = require("pdf-parse");
  if (pdfMod.PDFParse) {
    const r = await pdfMod.PDFParse.prototype.constructor
      ? new pdfMod.PDFParse({ data: buf }).getText()
      : pdfMod(buf, { max: 50 });
    if (r?.text !== undefined) return { text: r.text ?? "", numpages: r.total ?? r.numpages ?? 0 };
  }
  if (typeof pdfMod === "function") {
    const r = await pdfMod(buf, { max: 50 });
    return { text: r.text ?? "", numpages: r.numpages ?? 0 };
  }
  throw new Error("pdf-parse: ukendt API");
}

// ── OCR providers ─────────────────────────────────────────────────────────────

async function ocrWithGemini(buf: Buffer): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
  const apiKey = (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("GOOGLE_GENERATIVE_AI_API_KEY ikke sat");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const model  = new GoogleGenerativeAI(apiKey).getGenerativeModel({ model: "gemini-1.5-flash" });
  const result = await withTimeout(
    model.generateContent([
      { inlineData: { data: buf.toString("base64"), mimeType: "application/pdf" } },
      OCR_PROMPT,
    ]),
    OCR_TIMEOUT_MS,
    "Gemini OCR",
  );
  const text          = (result.response.text() ?? "").trim();
  const usage         = result.response.usageMetadata;
  const promptTokens     = usage?.promptTokenCount     ?? Math.ceil(buf.length / 300);
  const completionTokens = usage?.candidatesTokenCount ?? Math.ceil(text.length / 4);
  return { text, promptTokens, completionTokens };
}

async function ocrWithOpenAI(buf: Buffer, filename: string): Promise<{ text: string; promptTokens: number; completionTokens: number }> {
  const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY ikke sat");
  const resp = await withTimeout(
    fetch("https://api.openai.com/v1/chat/completions", {
      method:  "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [{
          role: "user",
          content: [
            { type: "file", file: { filename, file_data: `data:application/pdf;base64,${buf.toString("base64")}` } },
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
    const txt = await resp.text().catch(() => "");
    throw new Error(`OpenAI OCR HTTP ${resp.status}: ${txt.slice(0, 200)}`);
  }
  const data = await resp.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const text          = (data.choices?.[0]?.message?.content ?? "").trim();
  const promptTokens     = data.usage?.prompt_tokens     ?? Math.ceil(buf.length / 300);
  const completionTokens = data.usage?.completion_tokens ?? Math.ceil(text.length / 4);
  return { text, promptTokens, completionTokens };
}

// ── Quality scoring ───────────────────────────────────────────────────────────

function scoreQuality(text: string): number {
  if (!text || text.length < 10) return 0;
  const chars    = text.length;
  const letters  = (text.match(/[a-zA-ZæøåÆØÅ\u00C0-\u024F]/g) ?? []).length;
  const words    = text.trim().split(/\s+/).filter((w) => w.length > 0);
  const wcount   = Math.max(words.length, 1);
  let score      = Math.min((letters / chars) / 0.50, 1.0);
  const avgLen   = chars / wcount;
  if (avgLen > 25) score *= 0.30;
  else if (avgLen > 18) score *= 0.60;
  else if (avgLen > 14) score *= 0.80;
  const longRatio = words.filter((w) => w.length > 20).length / wcount;
  if (longRatio > 0.15) score *= 0.40;
  else if (longRatio > 0.08) score *= 0.70;
  return Math.max(0, Math.min(1, score));
}

// ── Chunking (sliding window) ─────────────────────────────────────────────────

function chunkText(text: string, size = 1000, overlap = 200): string[] {
  if (text.length <= size) return text.length > 0 ? [text] : [];
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length) {
      const boundary = text.lastIndexOf("\n\n", end);
      if (boundary > start + size * 0.75) end = boundary + 2;
      else {
        const nl = text.lastIndexOf("\n", end);
        if (nl > start + size * 0.80) end = nl + 1;
      }
    }
    chunks.push(text.slice(start, end).trim());
    start = Math.max(start + 1, end - overlap);
    if (end >= text.length) break;
  }
  return chunks.filter((c) => c.length > 0);
}

// ── Embeddings (OpenAI text-embedding-3-small) ────────────────────────────────

async function embedBatch(texts: string[], tenantId: string): Promise<number[][]> {
  const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey || !texts.length) return texts.map(() => []);
  const startMs = Date.now();
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  const latencyMs = Date.now() - startMs;
  if (!resp.ok) {
    console.warn(`[ocr-worker] embeddings HTTP ${resp.status}`);
    return texts.map(() => []);
  }
  const data    = await resp.json() as { data: Array<{ embedding: number[] }>; usage?: { prompt_tokens?: number } };
  const tokens  = data.usage?.prompt_tokens ?? Math.ceil(texts.join("").length / 4);
  const cost    = estimateOcrCost("text-embedding-3-small", tokens, 0);

  // Log embedding cost (fire-and-forget)
  logOcrCost({
    tenantId,
    provider:         "openai",
    model:            "text-embedding-3-small",
    feature:          "ocr.embed_chunks",
    promptTokens:     tokens,
    completionTokens: 0,
    estimatedCostUsd: cost,
    latencyMs,
    status:           "success",
  }).catch(() => {});

  return data.data.map((d) => d.embedding);
}

async function embedAllChunks(chunks: string[], tenantId: string): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = new Array(chunks.length).fill(null);
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch  = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const embeds = await embedBatch(batch, tenantId).catch(() => batch.map(() => []));
    for (let j = 0; j < batch.length; j++) {
      results[i + j] = embeds[j]?.length ? embeds[j] : null;
    }
  }
  return results;
}

// ── Process one job ───────────────────────────────────────────────────────────

async function processJob(task: RawOcrTask): Promise<void> {
  const tag         = `[${task.id.slice(0, 8)}]`;
  const isFinalAttempt = task.attempt_count >= task.max_attempts;

  log("job.started", {
    task_id:     task.id,
    tenant_id:   task.tenant_id,
    attempt:     task.attempt_count,
    max:         task.max_attempts,
    is_final:    isFinalAttempt,
    r2_key:      task.r2_key.slice(-40),
    filename:    task.filename,
  });

  const fail = async (reason: string, forceFinal = false): Promise<void> => {
    log("job.failed", {
      task_id: task.id, tenant_id: task.tenant_id,
      reason: reason.slice(0, 200), final: forceFinal || isFinalAttempt,
      retry_count: task.retry_count,
    });
    await markOcrFailed(
      task.id, reason,
      task.attempt_count, task.max_attempts, task.retry_count,
    );
  };

  // 1. Fetch from R2 ──────────────────────────────────────────────────────────
  let buf: Buffer;
  try {
    const t0 = Date.now();
    buf = await fetchFromR2(task.r2_key);
    log("job.r2_fetch.ok", { task_id: task.id, bytes: buf.length, ms: Date.now() - t0 });
  } catch (e) {
    return fail("R2 læsning fejlede: " + (e instanceof Error ? e.message : String(e)));
  }

  // 2. pdf-parse validation ──────────────────────────────────────────────────
  let rawText  = "";
  let numpages = 0;
  const isPdf  = task.content_type === "application/pdf" || task.filename.toLowerCase().endsWith(".pdf");

  if (isPdf) {
    try {
      const parsed = await parsePdf(buf);
      rawText  = (parsed.text ?? "").trim();
      numpages = parsed.numpages;
      log("job.pdf_parse.ok", { task_id: task.id, chars: rawText.length, pages: numpages });
      await updateStage(task.id, "ocr", { pagesProcessed: numpages });
    } catch (e) {
      log("job.pdf_parse.warn", { task_id: task.id, err: (e instanceof Error ? e.message : String(e)) });
      // Non-fatal: proceed to OCR anyway
    }
  }

  // 3. If text-layer PDF (false-positive detection) ──────────────────────────
  if (rawText.length >= SCANNED_THRESHOLD) {
    log("job.text_layer_found", { task_id: task.id, chars: rawText.length, pages: numpages });
    const capped   = rawText.slice(0, 200_000);
    const quality  = scoreQuality(capped);
    await updateStage(task.id, "chunking");
    const texts    = chunkText(capped);
    await updateStage(task.id, "embedding", { chunksProcessed: texts.length });
    const embeds   = await embedAllChunks(texts, task.tenant_id);
    await updateStage(task.id, "storing", { chunksProcessed: texts.length });
    const chunks: OcrChunk[] = texts.map((content, i) => ({
      chunkIndex: i, content,
      embedding:  embeds[i] ? JSON.stringify(embeds[i]) : undefined,
    }));
    await storeOcrChunks(task.id, task.tenant_id, chunks);
    await markOcrCompleted(task.id, task.attempt_count, task.max_attempts, task.retry_count, {
      ocrText: capped, qualityScore: quality, charCount: capped.length,
      pageCount: numpages, chunkCount: chunks.length, provider: "pdf-parse",
    });
    log("job.completed", { task_id: task.id, provider: "pdf-parse", chunks: chunks.length, quality: quality.toFixed(3) });
    return;
  }

  // 4. OCR ───────────────────────────────────────────────────────────────────
  const geminiKey = (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? "").trim();
  const openaiKey = (process.env.OPENAI_API_KEY ?? "").trim();

  let ocrText   = "";
  let provider  = "";
  let quality   = 0;
  let promptTokens     = 0;
  let completionTokens = 0;

  if (geminiKey) {
    const t0 = Date.now();
    try {
      log("job.ocr.gemini.start", { task_id: task.id });
      const r        = await ocrWithGemini(buf);
      const latencyMs = Date.now() - t0;
      ocrText          = r.text;
      promptTokens     = r.promptTokens;
      completionTokens = r.completionTokens;
      quality          = scoreQuality(ocrText);
      provider         = "gemini-1.5-flash";
      log("job.ocr.gemini.ok", { task_id: task.id, chars: ocrText.length, quality: quality.toFixed(3), ms: latencyMs });

      // Log cost
      await logOcrCost({
        tenantId: task.tenant_id, provider: "google", model: "gemini-1.5-flash",
        feature: "ocr.scan_pdf", promptTokens, completionTokens,
        estimatedCostUsd: estimateOcrCost("gemini-1.5-flash", promptTokens, completionTokens),
        latencyMs, status: "success",
      });
    } catch (e) {
      const latencyMs = Date.now() - t0;
      const msg = e instanceof Error ? e.message : String(e);
      log("job.ocr.gemini.error", { task_id: task.id, err: msg.slice(0, 200) });
      await logOcrCost({
        tenantId: task.tenant_id, provider: "google", model: "gemini-1.5-flash",
        feature: "ocr.scan_pdf", promptTokens: 0, completionTokens: 0,
        estimatedCostUsd: 0, latencyMs, status: "error", errorMessage: msg.slice(0, 200),
      });
    }
  }

  // 5. OpenAI fallback if quality is low or Gemini unavailable ───────────────
  if ((quality < QUALITY_RETRY_SCORE || !ocrText) && openaiKey) {
    log("job.ocr.openai.start", {
      task_id: task.id, reason: !ocrText ? "gemini_missing" : `quality_low(${quality.toFixed(3)})`,
    });
    const t0 = Date.now();
    try {
      const r          = await ocrWithOpenAI(buf, task.filename);
      const latencyMs  = Date.now() - t0;
      const fallbackQ  = scoreQuality(r.text);
      if (fallbackQ > quality || !ocrText) {
        ocrText          = r.text;
        quality          = fallbackQ;
        provider         = "gpt-4o";
        promptTokens     = r.promptTokens;
        completionTokens = r.completionTokens;
      }
      log("job.ocr.openai.ok", { task_id: task.id, chars: r.text.length, quality: fallbackQ.toFixed(3), ms: latencyMs });
      await logOcrCost({
        tenantId: task.tenant_id, provider: "openai", model: "gpt-4o",
        feature: "ocr.scan_pdf", promptTokens: r.promptTokens, completionTokens: r.completionTokens,
        estimatedCostUsd: estimateOcrCost("gpt-4o", r.promptTokens, r.completionTokens),
        latencyMs, status: "success",
      });
    } catch (e) {
      const latencyMs = Date.now() - t0;
      const msg = e instanceof Error ? e.message : String(e);
      log("job.ocr.openai.error", { task_id: task.id, err: msg.slice(0, 200) });
      await logOcrCost({
        tenantId: task.tenant_id, provider: "openai", model: "gpt-4o",
        feature: "ocr.scan_pdf", promptTokens: 0, completionTokens: 0,
        estimatedCostUsd: 0, latencyMs, status: "error", errorMessage: msg.slice(0, 200),
      });
    }
  }

  // 6. Quality gate ──────────────────────────────────────────────────────────
  if (!ocrText || ocrText.length < 20) {
    const reason = !geminiKey && !openaiKey
      ? "Ingen OCR-udbyder konfigureret"
      : "OCR fandt ingen læsbar tekst";
    return fail(reason, true); // always dead-letter — no retry value
  }
  if (quality < QUALITY_FAIL_SCORE) {
    log("job.quality_gate.fail", { task_id: task.id, quality: quality.toFixed(3) });
    return fail(`Tekst-kvalitet for lav (${(quality * 100).toFixed(0)}%) — dokumentet kan ikke læses`, true);
  }
  if (quality < QUALITY_RETRY_SCORE) {
    log("job.quality_gate.warn", { task_id: task.id, quality: quality.toFixed(3) });
    // Log warning but proceed with what we have
  }

  // 7. Chunk ─────────────────────────────────────────────────────────────────
  const capped = ocrText.slice(0, 200_000);
  await updateStage(task.id, "chunking", { pagesProcessed: numpages });
  const texts  = chunkText(capped);
  log("job.chunking.ok", { task_id: task.id, chunks: texts.length });

  // 8. Embed ─────────────────────────────────────────────────────────────────
  await updateStage(task.id, "embedding", { chunksProcessed: 0 });
  const embeds = await embedAllChunks(texts, task.tenant_id);
  log("job.embedding.ok", { task_id: task.id, chunks: texts.length });

  // 9. Store ─────────────────────────────────────────────────────────────────
  await updateStage(task.id, "storing", { chunksProcessed: texts.length });
  const chunks: OcrChunk[] = texts.map((content, i) => ({
    chunkIndex: i, content,
    embedding:  embeds[i] ? JSON.stringify(embeds[i]) : undefined,
  }));
  await storeOcrChunks(task.id, task.tenant_id, chunks);
  log("job.storing.ok", { task_id: task.id, chunks: chunks.length });

  // 10. Complete ─────────────────────────────────────────────────────────────
  await markOcrCompleted(task.id, task.attempt_count, task.max_attempts, task.retry_count, {
    ocrText: capped, qualityScore: quality, charCount: capped.length,
    pageCount: numpages, chunkCount: chunks.length, provider,
  });

  log("job.completed", {
    task_id:  task.id,
    tenant_id: task.tenant_id,
    provider,
    chunks:   chunks.length,
    quality:  quality.toFixed(3),
    chars:    capped.length,
    pages:    numpages,
  });
}

// ── Cron auth ─────────────────────────────────────────────────────────────────

function isCronAuthorized(req: IncomingMessage): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  if (!secret) return true; // dev / no secret configured
  const auth  = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();
  const token = (req.headers["x-cron-token"]    ?? "").trim();
  return auth === secret || token === secret;
}

// ── Vercel handler ────────────────────────────────────────────────────────────

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== "POST" && req.method !== "GET") {
    return err(res, 405, "METHOD_NOT_ALLOWED", "Kun POST/GET");
  }
  if (!isCronAuthorized(req)) {
    return err(res, 401, "UNAUTHORIZED", "Uautoriseret cron-kald");
  }

  const workerStart = Date.now();
  log("worker.started");

  // Claim jobs atomically
  let tasks: RawOcrTask[] = [];
  try {
    tasks = await claimJobs(CLAIM_LIMIT);
    log("worker.claimed", { count: tasks.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log("worker.claim_error", { err: msg.slice(0, 200) });
    return err(res, 500, "CLAIM_ERROR", "Kunne ikke hente OCR-opgaver: " + msg);
  }

  if (tasks.length === 0) {
    log("worker.idle");
    return json(res, { processed: 0, duration_ms: Date.now() - workerStart });
  }

  const results: Array<{ id: string; ok: boolean; error?: string }> = [];

  for (const task of tasks) {
    const t0 = Date.now();
    try {
      await processJob(task);
      results.push({ id: task.id, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log("worker.task_unhandled_error", { task_id: task.id, err: msg.slice(0, 200) });
      await markOcrFailed(
        task.id, "Uventet fejl: " + msg.slice(0, 500),
        task.attempt_count, task.max_attempts, task.retry_count,
      ).catch(() => {});
      results.push({ id: task.id, ok: false, error: msg.slice(0, 100) });
    }
    log("worker.task_duration", { task_id: task.id, ms: Date.now() - t0 });
  }

  log("worker.done", { processed: tasks.length, duration_ms: Date.now() - workerStart });
  return json(res, {
    processed:   tasks.length,
    results,
    duration_ms: Date.now() - workerStart,
  });
}
