/**
 * ocr-inline-processor.ts — Segment-first OCR processor for scanned PDFs.
 *
 * Called fire-and-forget from /api/upload/finalize when a scanned PDF is
 * detected. Uses the pre-downloaded buffer (skips R2 re-download) and:
 *
 *  1. Splits PDF into individual page PDFs (pdf-lib, pure JS)
 *  2. Processes PAGE 1 first → marks job as partial_ready in DB
 *     (client polling detects this and triggers early chat, ~3–5 s)
 *  3. Processes remaining pages with concurrency=3 in background
 *  4. Calls completeJob() with full text when all pages are done
 *
 * Metrics logged (structured JSON):
 *   first_page_started_at / first_page_completed_at
 *   first_chunk_ready_at / full_completion_at
 *
 * Multi-tenant isolation: job is already scoped to tenantId by enqueueOcrJob.
 * Idempotency: if job is not in 'pending' state, start is skipped gracefully.
 */

import { extractWithGemini, extractWithGeminiStream } from "../ai/gemini-media.ts";
import { isPartialTextUsable }                       from "../media/partial-text-readiness.ts";
import { splitPdfIntoPages }  from "../media/pdf-page-splitter.ts";
import {
  startJobInline,
  updateStage,
  updatePartialText,
  completeJob,
  failJob,
} from "./job-queue.ts";
import { chunkText, DEFAULT_CHUNKING_POLICY, type ChunkingPolicy } from "../media/retrieval-chunker.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

const CONCURRENCY = 3;    // parallel Gemini calls for pages 2–N
const MAX_CHARS   = 80_000; // cap per job (same as monolithic path)

// ── Logger ────────────────────────────────────────────────────────────────────

function log(jobId: string, event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), svc: "ocr-inline", jobId, event, ...fields,
  }));
}

// ── Quality estimator ─────────────────────────────────────────────────────────

function scoreQuality(text: string): number {
  const len = text.replace(/\s+/g, "").length;
  if (len === 0)    return 0;
  if (len < 50)     return 0.3;
  if (len < 500)    return 0.6;
  if (len < 5_000)  return 0.85;
  return 0.95;
}

// ── Chunking policy ───────────────────────────────────────────────────────────

function selectPolicy(charCount: number): ChunkingPolicy {
  if (charCount >= 40_000) return { ...DEFAULT_CHUNKING_POLICY, maxTokens: 400, minTokens: 15 };
  if (charCount >= 15_000) return { ...DEFAULT_CHUNKING_POLICY, maxTokens: 600, minTokens: 20 };
  return DEFAULT_CHUNKING_POLICY;
}

// ── Concurrency-limited page processor ───────────────────────────────────────

async function processPages(
  pageBuffers: Buffer[],
  filename: string,
): Promise<Array<string | null>> {
  const results: Array<string | null> = new Array(pageBuffers.length).fill(null);
  let   cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < pageBuffers.length) {
      const i   = cursor++;
      const buf = pageBuffers[i];
      try {
        const { text } = await extractWithGemini(buf, `${filename}_page${i + 1}.pdf`, "application/pdf");
        results[i] = text || null;
      } catch (e) {
        log("?", "page_ocr_failed", { pageIndex: i, error: (e as Error).message });
        results[i] = null;
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return results;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Process an OCR job inline (fire-and-forget) using page-first strategy.
 *
 * @param jobId        chat_ocr_tasks.id
 * @param buffer       Pre-downloaded PDF bytes (from upload/finalize handler)
 * @param filename     Original filename
 * @param contentType  MIME type (must be application/pdf for page splitting)
 */
export async function processOcrJobInline(
  jobId:       string,
  buffer:      Buffer,
  filename:    string,
  contentType: string,
): Promise<void> {
  const tJobStart = Date.now();
  log(jobId, "job_start", { filename, contentType, bytes: buffer.length });

  try {
    // Atomically mark job as running (skips if already running/completed)
    const started = await startJobInline(jobId);
    if (!started) {
      log(jobId, "job_skip", { reason: "already_running_or_complete" });
      return;
    }

    await updateStage(jobId, "ocr");

    // ── PDFs: page-split strategy ─────────────────────────────────────────
    const isPdf = contentType === "application/pdf" || filename.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      // Non-PDF (image/audio/video): single Gemini call, no splitting
      log(jobId, "single_call_start", { contentType });
      const t = Date.now();
      const { text, charCount } = await extractWithGemini(buffer, filename, contentType);
      log(jobId, "single_call_ok", { chars: charCount, ms: Date.now() - t });

      if (!text.trim()) {
        await failJob(jobId, "Ingen læsbar tekst fundet i dokumentet", false);
        return;
      }

      await updateStage(jobId, "chunking");
      const policy     = selectPolicy(text.length);
      let   chunkCount = 0;
      try { chunkCount = chunkText(text.slice(0, MAX_CHARS), policy).length; } catch { chunkCount = 1; }

      await completeJob(jobId, {
        ocrText: text.slice(0, 200_000), qualityScore: scoreQuality(text),
        charCount, pageCount: 1, chunkCount, provider: "gemini_vision",
      });
      log(jobId, "job_completed", { chars: charCount, provider: "gemini_vision", totalMs: Date.now() - tJobStart });
      return;
    }

    // ── PDF: split into pages ─────────────────────────────────────────────
    const { pageBuffers, pageCount } = await splitPdfIntoPages(buffer);
    log(jobId, "pdf_split_ok", { pageCount, bytes: buffer.length });

    if (pageCount === 1) {
      // Single page: process as-is (monolithic call, same as before but with job tracking)
      log(jobId, "single_page_ocr_start");
      const t1 = Date.now();
      const { text, charCount } = await extractWithGemini(pageBuffers[0], filename, "application/pdf");
      log(jobId, "single_page_ocr_ok", { chars: charCount, ms: Date.now() - t1 });

      if (!text.trim()) {
        await failJob(jobId, "Ingen læsbar tekst fundet i dokumentet", false);
        return;
      }

      await updateStage(jobId, "chunking");
      const policy = selectPolicy(text.length);
      let   chunks = 0;
      try { chunks = chunkText(text.slice(0, MAX_CHARS), policy).length; } catch { chunks = 1; }

      await completeJob(jobId, {
        ocrText: text.slice(0, 200_000), qualityScore: scoreQuality(text),
        charCount, pageCount: 1, chunkCount: chunks, provider: "gemini_vision",
      });
      log(jobId, "job_completed", { chars: charCount, totalMs: Date.now() - tJobStart });
      return;
    }

    // ── Multi-page: page 1 first → partial_ready → remaining pages ────────

    // ── Page 1 — PHASE 5Z.5: TRUE STREAMING (no hidden blocking await) ─────
    const tP1 = Date.now();
    log(jobId, "first_page_started_at", { ts: new Date().toISOString() });
    let page1Text           = "";
    let firstPartialEmitted = false;
    try {
      for await (const chunk of extractWithGeminiStream(
        pageBuffers[0], `${filename}_p1.pdf`, "application/pdf", 0,
      )) {
        page1Text += chunk.textDelta;

        // Emit partial readiness as soon as threshold is met — mid-stream.
        // This allows client polling to trigger an early AI answer while
        // Gemini is still producing the remaining tokens for page 1.
        if (!firstPartialEmitted && isPartialTextUsable(page1Text, 0)) {
          await updatePartialText(jobId, page1Text, "partial_ready");
          log(jobId, "first_streamed_text_at", {
            ts: new Date().toISOString(),
            upload_to_first_streamed_ocr_text_ms: Date.now() - tJobStart,
            chars: page1Text.length,
            streamSeq: chunk.streamSeq,
            model: chunk.model,
          });
          firstPartialEmitted = true;
        }
      }
    } catch (e) {
      log(jobId, "first_page_failed", { error: (e as Error).message });
    }
    const tP1Done = Date.now();
    log(jobId, "first_page_completed_at", { ts: new Date().toISOString(), ms: tP1Done - tP1 });

    if (page1Text.trim()) {
      if (!firstPartialEmitted) {
        // Threshold was never met mid-stream (e.g. very short/noisy page).
        // Still publish so client can start a best-effort early answer.
        await updatePartialText(jobId, page1Text, "partial_ready");
        log(jobId, "first_chunk_ready_at", { ts: new Date().toISOString(), chars: page1Text.length });
      }
    } else {
      log(jobId, "first_page_empty", { reason: "no_text_extracted" });
    }

    // ── Remaining pages (concurrency=3) ───────────────────────────────────
    await updateStage(jobId, "continuing");
    const remainingResults = await processPages(pageBuffers.slice(1), filename);

    // Assemble full text (page 1 + successful remaining pages)
    const allTexts: string[] = [];
    if (page1Text.trim()) allTexts.push(page1Text);
    for (const t of remainingResults) {
      if (t && t.trim()) allTexts.push(t);
    }

    const fullText = allTexts.join("\n\n");

    if (!fullText.trim()) {
      await failJob(jobId, "Ingen læsbar tekst fundet i dokumentet", false);
      return;
    }

    // ── Final completion ──────────────────────────────────────────────────
    await updateStage(jobId, "chunking");
    const charCount  = fullText.length;
    const policy     = selectPolicy(charCount);
    let   chunkCount = 0;
    try { chunkCount = chunkText(fullText.slice(0, MAX_CHARS), policy).length; } catch { chunkCount = 1; }

    await completeJob(jobId, {
      ocrText:      fullText.slice(0, 200_000),
      qualityScore: scoreQuality(fullText),
      charCount,
      pageCount,
      chunkCount,
      provider: "gemini_vision",
    });

    const totalMs = Date.now() - tJobStart;
    log(jobId, "full_completion_at", { ts: new Date().toISOString(), totalMs });
    log(jobId, "job_completed", {
      chars: charCount, pages: pageCount, chunks: chunkCount,
      provider: "gemini_vision", totalMs,
    });

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log(jobId, "job_failed", { error: msg });
    const retryable = !msg.includes("Ingen læsbar tekst") && !msg.includes("Unsupported content");
    await failJob(jobId, msg.slice(0, 500), retryable);
  }
}
