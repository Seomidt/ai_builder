/**
 * ocr-worker.ts — Enterprise-grade Manus-Only OCR pipeline worker.
 *
 * This worker has been streamlined to remove direct OpenAI and Gemini integrations.
 * It now functions as a high-level orchestrator that delegates all heavy lifting
 * (OCR, analysis, and model selection) to Manus.
 */

import "../../server/lib/env.ts";
import type { IncomingMessage, ServerResponse } from "http";
import { json, err }                            from "./_lib/response.ts";
import { claimJobs }                            from "./_lib/ocr-queue.ts";
import { processJob }                           from "./_lib/ocr-logic.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const CLAIM_LIMIT        = 5; 

// ── Structured logger (SOC2-safe) ─────────────────────────────────────────────

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), svc: "ocr-worker", event, ...fields }));
}

// ── Vercel / Cron Handler ─────────────────────────────────────────────────────

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") return err(res, 405, "Method Not Allowed");

  try {
    const jobs = await claimJobs(CLAIM_LIMIT);
    if (jobs.length === 0) {
      return json(res, 200, { status: "idle", message: "Ingen opgaver i køen" });
    }

    log("jobs_claimed", { count: jobs.length });

    // Process jobs in parallel
    await Promise.all(jobs.map(job => processJob(job)));

    return json(res, 200, { 
      status: "success", 
      processed: jobs.length,
      message: `${jobs.length} opgaver behandlet af Manus`
    });
  } catch (e: any) {
    log("handler_error", { error: e.message });
    return err(res, 500, e.message);
  }
}
