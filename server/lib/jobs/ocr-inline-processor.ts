/**
 * ocr-inline-processor.ts — Segment-first OCR processor for scanned PDFs.
 *
 * Called fire-and-forget from /api/upload/finalize when a scanned PDF is
 * detected. Uses the pre-downloaded buffer (skips R2 re-download) and:
 *
 *  1. Splits PDF into individual page PDFs (pdf-lib, pure JS)
 *  2. Processes PAGE 1 first → marks job as partial_ready in DB
 *     (client polling detects this and triggers early chat, ~1–2 s)
 *  3. Processes remaining pages with streaming + semaphore (MAX_CONCURRENT_STREAMS)
 *  4. Writes per-batch progress to chat_ocr_progress table (Phase 5Z.6)
 *  5. Calls completeJob() with full text when all pages are done
 *
 * PHASE 5Z.6 changes:
 *  - ALL pages now use extractWithGeminiStream (no blocking extractWithGemini)
 *  - Semaphore limits concurrency to MAX_CONCURRENT_STREAMS (default 5)
 *  - DB progress written per-batch (BATCH_WRITE_CHARS threshold)
 *  - Observability: streaming_pages_active, stream_chunks_per_second
 *
 * Metrics logged (structured JSON):
 *   first_page_started_at / first_page_completed_at
 *   first_streamed_text_at / full_completion_at
 *   streaming_pages_active / stream_chunks_per_second
 */

import { extractWithGemini, extractWithGeminiStream } from "../ai/gemini-media.ts";
import { isPartialTextUsable }                        from "../media/partial-text-readiness.ts";
import { splitPdfIntoPages }   from "../media/pdf-page-splitter.ts";
import {
  startJobInline,
  updateStage,
  updatePartialText,
  completeJob,
  failJob,
  upsertOcrProgress,
} from "./job-queue.ts";
import { chunkText, DEFAULT_CHUNKING_POLICY, type ChunkingPolicy } from "../media/retrieval-chunker.ts";

// ── Constants ──────────────────────────────────────────────────────────────────

/** Max parallel Gemini streams. Configurable via env. */
const MAX_CONCURRENT_STREAMS = parseInt(process.env.OCR_MAX_CONCURRENT_STREAMS ?? "5", 10);
/** Chars accumulated before a mid-stream DB write is issued. */
const BATCH_WRITE_CHARS = 200;
const MAX_CHARS         = 80_000;

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

// ── Semaphore (backpressure) ──────────────────────────────────────────────────

class Semaphore {
  private _slots: number;
  private _queue: Array<() => void> = [];

  constructor(slots: number) {
    this._slots = slots;
  }

  async acquire(): Promise<void> {
    if (this._slots > 0) { this._slots--; return; }
    await new Promise<void>(resolve => this._queue.push(resolve));
  }

  release(): void {
    if (this._queue.length > 0) {
      this._queue.shift()!();
    } else {
      this._slots++;
    }
  }
}

// ── Single page streaming processor ──────────────────────────────────────────

interface PageStreamResult {
  text:      string;
  model:     string;
  totalSeq:  number;
  durationMs: number;
}

/**
 * Streams a single page via Gemini and calls onBatch() every BATCH_WRITE_CHARS.
 * Safe to run concurrently — semaphore is acquired before calling this.
 */
async function streamPage(
  jobId:     string,
  tenantId:  string,
  buf:       Buffer,
  filename:  string,
  pageIndex: number,
  onBatch:   (pageIndex: number, accumulated: string, batchSeq: number) => Promise<void>,
): Promise<PageStreamResult> {
  const tStart     = Date.now();
  let   accumulated = "";
  let   lastWriteLen = 0;
  let   batchSeq    = 0;
  let   lastModel   = "gemini-2.5-flash";
  let   totalSeq    = 0;
  let   chunkCount  = 0;

  try {
    for await (const chunk of extractWithGeminiStream(
      buf, `${filename}_p${pageIndex + 1}.pdf`, "application/pdf", pageIndex,
    )) {
      accumulated  += chunk.textDelta;
      totalSeq      = chunk.streamSeq;
      lastModel     = chunk.model;
      chunkCount++;

      if (accumulated.length - lastWriteLen >= BATCH_WRITE_CHARS) {
        await onBatch(pageIndex, accumulated, batchSeq++);
        lastWriteLen = accumulated.length;
      }
    }
  } catch (e) {
    log(jobId, "page_stream_failed", { pageIndex, error: (e as Error).message });
  }

  // Final flush
  if (accumulated.length > lastWriteLen) {
    await onBatch(pageIndex, accumulated, batchSeq);
  }

  const durationMs = Date.now() - tStart;
  const chunksPerSec = durationMs > 0 ? Math.round((chunkCount / durationMs) * 1000) : 0;
  log(jobId, "page_stream_complete", {
    pageIndex, chars: accumulated.length, totalSeq,
    model: lastModel, durationMs,
    stream_chunks_per_second: chunksPerSec,
  });

  return { text: accumulated, model: lastModel, totalSeq, durationMs };
}

// ── Multi-page streaming with semaphore ───────────────────────────────────────

/**
 * PHASE 5Z.6: ALL pages now use streaming with semaphore-limited concurrency.
 * Calls onBatch() mid-stream for each page as text arrives.
 */
async function processAllPagesStreaming(
  jobId:     string,
  tenantId:  string,
  pageBuffers: Buffer[],
  filename:  string,
  onBatch:   (pageIndex: number, accumulated: string, batchSeq: number) => Promise<void>,
): Promise<Array<string | null>> {
  const results:  Array<string | null> = new Array(pageBuffers.length).fill(null);
  const semaphore = new Semaphore(MAX_CONCURRENT_STREAMS);
  let   activeCount = 0;

  const tasks = pageBuffers.map(async (buf, i) => {
    await semaphore.acquire();
    activeCount++;
    log(jobId, "streaming_pages_active", { active: activeCount, pageIndex: i });

    try {
      const { text } = await streamPage(jobId, tenantId, buf, filename, i, onBatch);
      results[i] = text.trim() ? text : null;
    } finally {
      activeCount--;
      semaphore.release();
    }
  });

  await Promise.all(tasks);
  return results;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Process an OCR job inline (fire-and-forget) using page-first streaming strategy.
 *
 * @param jobId        chat_ocr_tasks.id
 * @param tenantId     Tenant identifier (for progress table isolation)
 * @param buffer       Pre-downloaded PDF bytes (from upload/finalize handler)
 * @param filename     Original filename
 * @param contentType  MIME type (must be application/pdf for page splitting)
 */
export async function processOcrJobInline(
  jobId:       string,
  buffer:      Buffer,
  filename:    string,
  contentType: string,
  tenantId = "unknown",
): Promise<void> {
  const tJobStart = Date.now();
  log(jobId, "job_start", { filename, contentType, bytes: buffer.length });

  try {
    const started = await startJobInline(jobId);
    if (!started) {
      log(jobId, "job_skip", { reason: "already_running_or_complete" });
      return;
    }

    await updateStage(jobId, "ocr");

    const isPdf = contentType === "application/pdf" || filename.toLowerCase().endsWith(".pdf");

    // ── Non-PDF: single Gemini call ───────────────────────────────────────
    if (!isPdf) {
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
      // Single page: streaming (consistent with multi-page path)
      log(jobId, "single_page_stream_start");
      const tP = Date.now();
      let page1Text = "";

      for await (const chunk of extractWithGeminiStream(
        pageBuffers[0], `${filename}_p1.pdf`, "application/pdf", 0,
      )) {
        page1Text += chunk.textDelta;
      }
      log(jobId, "single_page_stream_ok", { chars: page1Text.length, ms: Date.now() - tP });

      if (!page1Text.trim()) {
        await failJob(jobId, "Ingen læsbar tekst fundet i dokumentet", false);
        return;
      }

      await updateStage(jobId, "chunking");
      const policy = selectPolicy(page1Text.length);
      let   chunks = 0;
      try { chunks = chunkText(page1Text.slice(0, MAX_CHARS), policy).length; } catch { chunks = 1; }

      await completeJob(jobId, {
        ocrText: page1Text.slice(0, 200_000), qualityScore: scoreQuality(page1Text),
        charCount: page1Text.length, pageCount: 1, chunkCount: chunks, provider: "gemini_vision",
      });
      log(jobId, "job_completed", { chars: page1Text.length, totalMs: Date.now() - tJobStart });
      return;
    }

    // ── Multi-page: page 1 first → partial_ready → remaining pages streaming ──

    // ─ Page 1: true streaming with mid-stream partial_ready threshold ─────
    const tP1 = Date.now();
    log(jobId, "first_page_started_at", { ts: new Date().toISOString() });
    let page1Text           = "";
    let firstPartialEmitted = false;

    try {
      for await (const chunk of extractWithGeminiStream(
        pageBuffers[0], `${filename}_p1.pdf`, "application/pdf", 0,
      )) {
        page1Text += chunk.textDelta;

        if (!firstPartialEmitted && isPartialTextUsable(page1Text, 0)) {
          await updatePartialText(jobId, page1Text, "partial_ready");
          // Write progress for page 0
          await upsertOcrProgress(jobId, tenantId, 0, page1Text, "partial_ready");
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
      // Final progress write for page 0
      await upsertOcrProgress(jobId, tenantId, 0, page1Text, "completed");
      if (!firstPartialEmitted) {
        await updatePartialText(jobId, page1Text, "partial_ready");
        log(jobId, "first_chunk_ready_at", { ts: new Date().toISOString(), chars: page1Text.length });
      }
    } else {
      log(jobId, "first_page_empty", { reason: "no_text_extracted" });
    }

    // ─ Remaining pages: PHASE 5Z.6 — ALL streaming with semaphore ────────
    await updateStage(jobId, "continuing");

    const remainingBuffers = pageBuffers.slice(1);
    const remainingResults = await processAllPagesStreaming(
      jobId,
      tenantId,
      remainingBuffers,
      filename,
      async (relativePageIndex, accumulated, _batchSeq) => {
        const absolutePageIndex = relativePageIndex + 1;
        // Determine status from accumulation progress
        const status: "streaming" | "partial_ready" | "completed" = "streaming";
        try {
          await upsertOcrProgress(jobId, tenantId, absolutePageIndex, accumulated, status);
        } catch { /* non-critical — progress table write failures must not kill OCR */ }
      },
    );

    // Mark remaining pages as completed in progress table
    for (let i = 0; i < remainingResults.length; i++) {
      const t = remainingResults[i];
      if (t && t.trim()) {
        try {
          await upsertOcrProgress(jobId, tenantId, i + 1, t, "completed");
        } catch { /* non-critical */ }
      }
    }

    // ─ Assemble full text ─────────────────────────────────────────────────
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

    // ─ Final completion ───────────────────────────────────────────────────
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
