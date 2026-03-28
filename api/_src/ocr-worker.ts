/**
 * ocr-worker.ts — Async OCR pipeline for scanned PDFs.
 *
 * Invoked by Vercel Cron every minute: POST /api/ocr-worker
 * Protected by CRON_SECRET env var (Authorization: Bearer <token>).
 *
 * Pipeline per task:
 *   1. Claim pending tasks (SELECT ... FOR UPDATE SKIP LOCKED via direct pg)
 *   2. Fetch file buffer from R2 via GetObjectCommand (no presigned URL needed — server-side)
 *   3. Re-validate scanned status with pdf-parse (false-positive guard)
 *   4. OCR via Gemini 1.5 Flash (primary) → quality check → OpenAI GPT-4o (fallback)
 *   5. Quality gate: mark failed if score < 0.10
 *   6. Chunk (sliding window: 1000 chars, 200 overlap, page-header aware)
 *   7. Embed via OpenAI text-embedding-3-small (batched 20 at a time)
 *   8. Store chunks + embeddings in chat_ocr_chunks
 *   9. Mark completed / failed
 */

import "../../server/lib/env";
import type { IncomingMessage, ServerResponse } from "http";
import { json, err }                            from "./_lib/response";
import {
  markOcrRunning,
  markOcrCompleted,
  markOcrFailed,
  storeOcrChunks,
  type OcrChunk,
}                                               from "./_lib/ocr-queue";

// ── Constants ─────────────────────────────────────────────────────────────────

const CLAIM_LIMIT        = 3;   // max tasks per cron invocation
const SCANNED_THRESHOLD  = 100; // chars — below = scanned
const OCR_TIMEOUT_MS     = 90_000;
const EMBED_BATCH_SIZE   = 20;
const QUALITY_FAIL_SCORE = 0.10; // below this = unreadable
const QUALITY_RETRY_SCORE = 0.35; // below this = try fallback provider

const OCR_PROMPT =
  "Extract ALL text from this scanned PDF document verbatim. " +
  "Begin each page's content with '[Side N]' on its own line (N = page number). " +
  "Preserve the original text structure and line breaks as closely as possible. " +
  "If a page has no readable text, write '[Side N — ingen tekst]' and continue. " +
  "Do not summarize, paraphrase, translate, or add any commentary.";

// ── Timeout helper ────────────────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout: ${label} overskred ${ms / 1000}s`)), ms),
    ),
  ]);
}

// ── Direct pg connection (needed for SKIP LOCKED) ─────────────────────────────

function pgUrl(): string {
  return (
    process.env.BLISSOPS_PG_URL ??
    process.env.SUPABASE_DATABASE_URL ??
    process.env.DATABASE_URL ??
    ""
  );
}

interface RawTask {
  id:           string;
  tenant_id:    string;
  r2_key:       string;
  filename:     string;
  content_type: string;
  attempt_count: number;
  max_attempts:  number;
}

async function claimPendingTasks(): Promise<RawTask[]> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Client } = require("pg");
  const client = new Client({
    connectionString: pgUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query<RawTask>(`
      SELECT id, tenant_id, r2_key, filename, content_type, attempt_count, max_attempts
      FROM   chat_ocr_tasks
      WHERE  status = 'pending'
        AND  attempt_count < max_attempts
      ORDER  BY created_at ASC
      LIMIT  $1
      FOR UPDATE SKIP LOCKED
    `, [CLAIM_LIMIT]);

    const tasks = res.rows;
    if (tasks.length > 0) {
      const ids = tasks.map((t) => `'${t.id}'`).join(",");
      await client.query(`
        UPDATE chat_ocr_tasks
        SET    status = 'running',
               started_at = NOW(),
               attempt_count = attempt_count + 1
        WHERE  id IN (${ids})
      `);
    }

    await client.query("COMMIT");
    return tasks;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    await client.end().catch(() => {});
  }
}

// ── R2 read ───────────────────────────────────────────────────────────────────

async function fetchFromR2(objectKey: string): Promise<Buffer> {
  const { r2Client, R2_BUCKET, R2_CONFIGURED } = await import("../../server/lib/r2/r2-client");
  if (!R2_CONFIGURED) throw new Error("R2 er ikke konfigureret");
  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const cmd  = new GetObjectCommand({ Bucket: R2_BUCKET, Key: objectKey });
  const resp = await r2Client.send(cmd);
  if (!resp.Body) throw new Error("R2 returnerede tom body for: " + objectKey);
  const chunks: Buffer[] = [];
  for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
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
    const parser = new pdfMod.PDFParse({ data: buf });
    const r = await parser.getText();
    return { text: typeof r.text === "string" ? r.text : "", numpages: r.total ?? 0 };
  }
  if (typeof pdfMod === "function") {
    const r = await pdfMod(buf, { max: 50 });
    return { text: r.text ?? "", numpages: r.numpages ?? 0 };
  }
  throw new Error("pdf-parse: ukendt API");
}

// ── OCR providers ─────────────────────────────────────────────────────────────

async function ocrWithGemini(buf: Buffer): Promise<string> {
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
  return (result.response.text() ?? "").trim();
}

async function ocrWithOpenAI(buf: Buffer, filename: string): Promise<string> {
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
  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  return (data.choices?.[0]?.message?.content ?? "").trim();
}

// ── Quality scoring ───────────────────────────────────────────────────────────
// Returns 0-1. Good OCR text scores > 0.60.

function scoreQuality(text: string): number {
  if (!text || text.length < 10) return 0;

  const chars   = text.length;
  const letters = (text.match(/[a-zA-ZæøåÆØÅ\u00C0-\u024F]/g) ?? []).length;
  const words   = text.trim().split(/\s+/).filter((w) => w.length > 0);
  const wcount  = Math.max(words.length, 1);

  // Alpha density (letters / total chars) — good text > 0.50
  const letterRatio = letters / chars;
  let score = Math.min(letterRatio / 0.50, 1.0);

  // Average word length — extreme values indicate garbage
  const avgLen = chars / wcount;
  if (avgLen > 25) score *= 0.30;
  else if (avgLen > 18) score *= 0.60;
  else if (avgLen > 14) score *= 0.80;

  // Ratio of very long tokens (> 20 chars) — encoding artifacts
  const longWords = words.filter((w) => w.length > 20).length;
  const longRatio = longWords / wcount;
  if (longRatio > 0.15) score *= 0.40;
  else if (longRatio > 0.08) score *= 0.70;

  return Math.max(0, Math.min(1, score));
}

// ── Chunking ──────────────────────────────────────────────────────────────────
// Sliding window: size 1000 chars, overlap 200 chars.
// Splits on paragraph boundaries where possible.

function chunkText(text: string, size = 1000, overlap = 200): string[] {
  if (text.length <= size) return text.length > 0 ? [text] : [];

  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    // Try to break on a paragraph boundary within the last 25% of the window
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

async function embedBatch(texts: string[]): Promise<number[][]> {
  const apiKey = (process.env.OPENAI_API_KEY ?? "").trim();
  if (!apiKey || !texts.length) return texts.map(() => []);

  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method:  "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    console.warn(`[ocr-worker] embeddings failed: ${resp.status} ${txt.slice(0, 100)}`);
    return texts.map(() => []);
  }
  const data = await resp.json() as { data: Array<{ embedding: number[] }> };
  return data.data.map((d) => d.embedding);
}

async function embedChunks(chunks: string[]): Promise<(number[] | null)[]> {
  const results: (number[] | null)[] = new Array(chunks.length).fill(null);
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch  = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const embeds = await embedBatch(batch).catch(() => batch.map(() => []));
    for (let j = 0; j < batch.length; j++) {
      results[i + j] = embeds[j]?.length ? embeds[j] : null;
    }
  }
  return results;
}

// ── Process a single task ─────────────────────────────────────────────────────

async function processTask(task: RawTask): Promise<void> {
  const tag = `[ocr-worker:${task.id.slice(0, 8)}]`;
  const isFinalAttempt = task.attempt_count + 1 >= task.max_attempts;

  console.log(`${tag} start r2_key=${task.r2_key} attempt=${task.attempt_count + 1}/${task.max_attempts}`);

  // 1. Fetch from R2
  let buf: Buffer;
  try {
    buf = await fetchFromR2(task.r2_key);
    console.log(`${tag} r2 read bytes=${buf.length}`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${tag} r2 read failed: ${msg}`);
    await markOcrFailed(task.id, "R2 læsning fejlede: " + msg, isFinalAttempt).catch(() => {});
    return;
  }

  // 2. Re-validate with pdf-parse (false-positive guard for non-PDF types)
  let rawText = "";
  let numpages = 0;
  const isPdf = task.content_type === "application/pdf" || task.filename.toLowerCase().endsWith(".pdf");

  if (isPdf) {
    try {
      const parsed = await parsePdf(buf);
      rawText  = (parsed.text ?? "").trim();
      numpages = parsed.numpages;
      console.log(`${tag} pdf-parse chars=${rawText.length} pages=${numpages}`);
    } catch (e) {
      console.warn(`${tag} pdf-parse failed, proceeding to OCR: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 3. If pdf-parse found a real text layer (false positive), use it directly
  if (rawText.length >= SCANNED_THRESHOLD) {
    console.log(`${tag} text-layer found — skipping OCR chars=${rawText.length}`);
    const capped   = rawText.slice(0, 200_000);
    const score    = scoreQuality(capped);
    const texts    = chunkText(capped);
    const embeds   = await embedChunks(texts);
    const chunks: OcrChunk[] = texts.map((content, i) => ({
      chunkIndex: i,
      content,
      embedding:  embeds[i] ? JSON.stringify(embeds[i]) : undefined,
    }));
    await storeOcrChunks(task.id, task.tenant_id, chunks);
    await markOcrCompleted(task.id, {
      ocrText:      capped,
      qualityScore: score,
      charCount:    capped.length,
      pageCount:    numpages,
      chunkCount:   chunks.length,
      provider:     "pdf-parse",
    });
    console.log(`${tag} completed (text-layer) chunks=${chunks.length} quality=${score.toFixed(3)}`);
    return;
  }

  // 4. OCR — Gemini primary, OpenAI fallback
  let ocrText   = "";
  let provider  = "";
  let quality   = 0;

  const geminiKey = (process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? process.env.GEMINI_API_KEY ?? "").trim();
  const openaiKey = (process.env.OPENAI_API_KEY ?? "").trim();

  if (geminiKey) {
    try {
      console.log(`${tag} ocr=gemini`);
      ocrText  = await ocrWithGemini(buf);
      quality  = scoreQuality(ocrText);
      provider = "gemini-1.5-flash";
      console.log(`${tag} gemini done chars=${ocrText.length} quality=${quality.toFixed(3)}`);
    } catch (e) {
      console.warn(`${tag} gemini failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 5. Fallback to OpenAI if quality is low or Gemini not available
  if ((quality < QUALITY_RETRY_SCORE || !ocrText) && openaiKey) {
    try {
      console.log(`${tag} ocr=openai (quality=${quality.toFixed(3)} below threshold or gemini missing)`);
      const fallbackText  = await ocrWithOpenAI(buf, task.filename);
      const fallbackScore = scoreQuality(fallbackText);
      // Keep whichever result is better
      if (fallbackScore > quality || !ocrText) {
        ocrText  = fallbackText;
        quality  = fallbackScore;
        provider = "gpt-4o";
      }
      console.log(`${tag} openai done chars=${ocrText.length} quality=${quality.toFixed(3)}`);
    } catch (e) {
      console.warn(`${tag} openai fallback failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 6. Quality gate
  if (!ocrText || ocrText.length < 20) {
    const reason = !geminiKey && !openaiKey
      ? "Ingen OCR-udbyder konfigureret"
      : "OCR fandt ingen læsbar tekst";
    console.error(`${tag} ${reason}`);
    await markOcrFailed(task.id, reason, isFinalAttempt).catch(() => {});
    return;
  }

  if (quality < QUALITY_FAIL_SCORE) {
    const reason = `Tekst-kvalitet for lav (${(quality * 100).toFixed(0)}%) — dokumentet kan ikke læses`;
    console.error(`${tag} ${reason}`);
    await markOcrFailed(task.id, reason, true).catch(() => {});
    return;
  }

  // 7. Chunk + embed + store
  const capped = ocrText.slice(0, 200_000);
  const texts  = chunkText(capped);
  console.log(`${tag} chunking chunks=${texts.length}`);

  const embeds  = await embedChunks(texts);
  const chunks: OcrChunk[] = texts.map((content, i) => ({
    chunkIndex: i,
    content,
    embedding:  embeds[i] ? JSON.stringify(embeds[i]) : undefined,
  }));

  await storeOcrChunks(task.id, task.tenant_id, chunks);

  await markOcrCompleted(task.id, {
    ocrText:      capped,
    qualityScore: quality,
    charCount:    capped.length,
    pageCount:    numpages,
    chunkCount:   chunks.length,
    provider,
  });

  console.log(`${tag} completed provider=${provider} chunks=${chunks.length} quality=${quality.toFixed(3)}`);
}

// ── Auth helper ───────────────────────────────────────────────────────────────

function isCronAuthorized(req: IncomingMessage): boolean {
  const secret = (process.env.CRON_SECRET ?? "").trim();
  // Vercel cron passes Authorization: Bearer <CRON_SECRET>
  const authHeader = (req.headers["authorization"] ?? "").replace(/^Bearer\s+/i, "").trim();
  if (secret && authHeader === secret) return true;
  // Internal self-trigger via X-Cron-Token header
  const cronToken = (req.headers["x-cron-token"] ?? "").trim();
  if (secret && cronToken === secret) return true;
  // No secret configured — allow in dev/test (Vercel sets CRON_SECRET automatically if you configure it)
  if (!secret) return true;
  return false;
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

  const started = Date.now();
  let tasks: RawTask[] = [];
  try {
    tasks = await claimPendingTasks();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[ocr-worker] claim failed:", msg);
    return err(res, 500, "CLAIM_ERROR", "Kunne ikke hente OCR-opgaver: " + msg);
  }

  console.log(`[ocr-worker] claimed ${tasks.length} task(s)`);
  if (tasks.length === 0) {
    return json(res, { processed: 0, duration_ms: Date.now() - started });
  }

  // Process tasks sequentially to avoid exhausting resources
  const results: Array<{ id: string; ok: boolean; error?: string }> = [];
  for (const task of tasks) {
    try {
      await processTask(task);
      results.push({ id: task.id, ok: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[ocr-worker] task ${task.id} threw: ${msg}`);
      await markOcrFailed(task.id, "Uventet fejl: " + msg, task.attempt_count + 1 >= task.max_attempts).catch(() => {});
      results.push({ id: task.id, ok: false, error: msg });
    }
  }

  return json(res, {
    processed:   tasks.length,
    results,
    duration_ms: Date.now() - started,
  });
}
