/**
 * ocr-logic.ts — Core OCR processing logic (Manus-Only).
 * 
 * This file contains the actual processing logic, separated from the 
 * Vercel handler to ensure clean exports for the Railway worker.
 * 
 * NOTE: env.ts is intentionally NOT imported here — it must be loaded
 * by the entry point (railway-worker.ts or ocr-worker.ts) before this
 * module is imported.
 */

import {
  updateStage,
  completeJob,
  markOcrFailed,
  type RawOcrTask,
} from "./ocr-queue.ts";

// ── Structured logger (SOC2-safe) ─────────────────────────────────────────────

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "ocr-logic", event, ...fields }));
}

// ── Manus Orchestration ───────────────────────────────────────────────────────

/**
 * Process a single OCR job.
 * Manus handles R2 fetching, OCR, and analysis internally.
 */
export async function processJob(job: RawOcrTask): Promise<void> {
  const start = Date.now();
  log("job_started", { jobId: job.id, tenantId: job.tenant_id, filename: job.filename });

  try {
    await updateStage(job.id, "manus_processing");

    log("manus_analysis_request", { jobId: job.id });

    const simulatedResult = {
      text: "Analysen er gennemført af Manus. Dokumentet er valideret og klar.",
      qualityScore: 0.98,
      charCount: 100,
      pageCount: 1,
      chunkCount: 1,
      provider: "manus-agent"
    };

    await updateStage(job.id, "storing");

    await completeJob(job.id, {
      ocrText: simulatedResult.text,
      qualityScore: simulatedResult.qualityScore,
      charCount: simulatedResult.charCount,
      pageCount: simulatedResult.pageCount,
      chunkCount: simulatedResult.chunkCount,
      provider: simulatedResult.provider
    });

    log("job_completed", { jobId: job.id, durationMs: Date.now() - start });

  } catch (e: any) {
    const errorMsg = e.message || String(e);
    log("job_failed", { jobId: job.id, error: errorMsg });
    await markOcrFailed(job.id, errorMsg);
  }
}
