/**
 * ocr-worker.ts — Production OCR pipeline worker.
 *
 * POST /api/ocr-worker  (called by Railway cron / scheduled trigger)
 *
 * Flow:
 *  1. Boot-time self-check (env vars, DB reachability, critical imports)
 *  2. Claim up to CLAIM_LIMIT pending jobs (FOR UPDATE SKIP LOCKED)
 *  3. Process all claimed jobs in parallel (MAX_SEGMENT_CONCURRENCY)
 *  4. Return structured result
 *
 * Concurrency model:
 *  CLAIM_LIMIT          = 8   — max jobs claimed per cron tick
 *  MAX_SEGMENT_CONCURRENCY = 4 — max parallel processJob() calls
 *  Per-job timeout guard keeps stale-running jobs from blocking
 */

import "../../server/lib/env.ts";
import type { IncomingMessage, ServerResponse } from "http";
import { json, err }                            from "./_lib/response.ts";
import { claimJobs }                            from "./_lib/ocr-queue.ts";
import { processJob }                           from "./_lib/ocr-logic.ts";

// ── Constants ─────────────────────────────────────────────────────────────────

const CLAIM_LIMIT            = 8;   // max jobs per cron tick
const MAX_SEGMENT_CONCURRENCY = 4;  // max parallel processJob() calls
const JOB_TIMEOUT_MS         = 5 * 60_000; // 5 min per-job hard timeout

// ── Structured logger ─────────────────────────────────────────────────────────

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    ts: new Date().toISOString(), svc: "ocr-worker", event, ...fields,
  }));
}

// ── Boot-time self-check ─────────────────────────────────────────────────────
// Fails loudly if the runtime is broken — prevents silent crash loops.

async function bootSelfCheck(): Promise<{ ok: boolean; issues: string[] }> {
  const issues: string[] = [];

  // 1. Critical env vars
  const dbUrl = process.env.BLISSOPS_PG_URL ?? process.env.SUPABASE_DATABASE_URL ?? process.env.DATABASE_URL ?? "";
  if (!dbUrl) issues.push("MISSING_ENV: BLISSOPS_PG_URL / SUPABASE_DATABASE_URL / DATABASE_URL — DB unreachable");

  const r2Account = process.env.CF_R2_ACCOUNT_ID ?? process.env.CLOUDFLARE_R2_ACCOUNT_ID ?? "";
  if (!r2Account) issues.push("MISSING_ENV: CF_R2_ACCOUNT_ID — R2 downloads unavailable");

  const geminiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "";
  if (!geminiKey) issues.push("MISSING_ENV: GEMINI_API_KEY — Gemini OCR unavailable (scanned PDFs will fail)");

  // 2. Critical imports
  try {
    await import("./_lib/ocr-logic.ts");
  } catch (e) {
    issues.push(`IMPORT_FAIL: ocr-logic.ts — ${(e as Error).message}`);
  }

  try {
    await import("./_lib/ocr-queue.ts");
  } catch (e) {
    issues.push(`IMPORT_FAIL: ocr-queue.ts — ${(e as Error).message}`);
  }

  // 3. DB reachability (quick probe)
  if (dbUrl) {
    try {
      const { Client } = await import("pg");
      const { getSupabaseSslConfig } = await import("../../server/lib/jobs/ssl-config.ts");
      const client = new Client({ connectionString: dbUrl, ssl: getSupabaseSslConfig(), connectionTimeoutMillis: 5000 });
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
    } catch (e) {
      issues.push(`DB_UNREACHABLE: ${(e as Error).message.slice(0, 200)}`);
    }
  }

  return { ok: issues.length === 0, issues };
}

// ── Controlled concurrency helper ─────────────────────────────────────────────

async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<Array<{ item: T; error: string | null }>> {
  const results: Array<{ item: T; error: string | null }> = [];
  const queue   = [...items];
  let active    = 0;

  return new Promise((resolve) => {
    function next(): void {
      while (active < limit && queue.length > 0) {
        const item = queue.shift()!;
        active++;
        fn(item)
          .then(() => { results.push({ item, error: null }); })
          .catch((e) => { results.push({ item, error: (e as Error).message }); })
          .finally(() => {
            active--;
            next();
            if (active === 0 && queue.length === 0) resolve(results);
          });
      }
      if (active === 0 && queue.length === 0) resolve(results);
    }
    next();
  });
}

// ── Per-job timeout wrapper ───────────────────────────────────────────────────

function withTimeout<T>(promise: Promise<T>, ms: number, jobId: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Job ${jobId} timed out after ${ms / 1000}s`)), ms),
    ),
  ]);
}

// ── Vercel / Cron Handler ─────────────────────────────────────────────────────

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (req.method !== "POST") return err(res, 405, "Method Not Allowed");

  const tickStart = Date.now();

  // ── Boot check ───────────────────────────────────────────────────────────
  const { ok: bootOk, issues } = await bootSelfCheck();
  if (!bootOk) {
    log("boot_check_failed", { issues });
    // Non-fatal: log issues but still attempt to process if DB is available
    if (issues.some((i) => i.startsWith("DB_UNREACHABLE") || i.startsWith("IMPORT_FAIL"))) {
      return err(res, 503, `Worker boot check failed: ${issues.join("; ")}`);
    }
    // Env-only warnings: log and continue (jobs may succeed for native PDFs)
    log("boot_check_warnings", { issues });
  } else {
    log("boot_check_ok");
  }

  try {
    const claimStart = Date.now();
    const jobs       = await claimJobs(CLAIM_LIMIT);

    log("jobs_claimed", {
      count:      jobs.length,
      claimMs:    Date.now() - claimStart,
      limit:      CLAIM_LIMIT,
      concurrency: MAX_SEGMENT_CONCURRENCY,
    });

    if (jobs.length === 0) {
      return json(res, 200, { status: "idle", message: "Ingen opgaver i køen", tickMs: Date.now() - tickStart });
    }

    // ── Process with controlled concurrency ──────────────────────────────
    const results = await runWithConcurrencyLimit(jobs, MAX_SEGMENT_CONCURRENCY, (job) =>
      withTimeout(processJob(job), JOB_TIMEOUT_MS, job.id),
    );

    const succeeded = results.filter((r) => r.error === null).length;
    const failed    = results.filter((r) => r.error !== null).length;

    log("tick_complete", {
      processed: jobs.length,
      succeeded,
      failed,
      tickMs:    Date.now() - tickStart,
      errors:    results.filter((r) => r.error).map((r) => ({ jobId: (r.item as any).id, error: r.error })),
    });

    return json(res, 200, {
      status:     failed > 0 ? "partial_success" : "success",
      processed:  jobs.length,
      succeeded,
      failed,
      tickMs:     Date.now() - tickStart,
    });

  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log("handler_error", { error: msg });
    return err(res, 500, msg);
  }
}
