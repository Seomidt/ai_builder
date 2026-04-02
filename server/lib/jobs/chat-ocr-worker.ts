/**
 * chat-ocr-worker.ts — PHASE 5Z.7
 *
 * In-process polling worker for chat_ocr_tasks.
 * Started from server/index.ts when CHAT_OCR_WORKER=true or ON_RAILWAY=true.
 *
 * Flow per cycle:
 *  1. Query pending (or failed + eligible) chat_ocr_tasks
 *  2. For each: download from R2, call processOcrJobInline()
 *  3. processOcrJobInline → startJobInline() claims atomically (WHERE status='pending')
 *     If two workers race, only one wins — the other returns early (no-op)
 *
 * Safety invariants:
 *  - Never crashes the web server — all errors caught + logged
 *  - Concurrency controlled by _maxConcurrent semaphore
 *  - Idempotent: processOcrJobInline's startJobInline() is atomic
 */

import { Client as PgClient }         from "pg";
import { resolveDbUrl }               from "./job-queue.ts";
import { getSupabaseSslConfig }        from "./ssl-config.ts";
import { processOcrJobInline }         from "./ocr-inline-processor.ts";

// ── State ──────────────────────────────────────────────────────────────────────

let _intervalId:    ReturnType<typeof setInterval> | null = null;
let _cycleRunning = false;
let _maxConcurrent = 3;

// ── Public API ─────────────────────────────────────────────────────────────────

export function startChatOcrWorker(opts?: {
  pollIntervalMs?: number;
  maxConcurrent?:  number;
}): void {
  if (_intervalId) return;
  const pollMs = opts?.pollIntervalMs
    ?? parseInt(process.env.CHAT_OCR_POLL_INTERVAL_MS ?? "5000", 10);
  _maxConcurrent = opts?.maxConcurrent
    ?? parseInt(process.env.CHAT_OCR_MAX_CONCURRENT ?? "3", 10);

  console.log(`[chat-ocr-worker] starting — poll=${pollMs}ms  maxConcurrent=${_maxConcurrent}`);

  _intervalId = setInterval(() => {
    if (_cycleRunning) return;
    _cycleRunning = true;
    runWorkerCycle()
      .catch((err) => console.error("[chat-ocr-worker] cycle error:", err))
      .finally(() => { _cycleRunning = false; });
  }, pollMs);
}

export function stopChatOcrWorker(): void {
  if (_intervalId) { clearInterval(_intervalId); _intervalId = null; }
  console.log("[chat-ocr-worker] stopped");
}

// ── Cycle ──────────────────────────────────────────────────────────────────────

interface PendingRow {
  id:           string;
  tenant_id:    string;
  r2_key:       string;
  filename:     string;
  content_type: string;
}

async function runWorkerCycle(): Promise<void> {
  const jobs = await claimPendingJobs(_maxConcurrent);
  if (jobs.length === 0) return;

  console.log(`[chat-ocr-worker] claimed ${jobs.length} job(s)`);

  await Promise.all(jobs.map((job) => processJob(job)));
}

/**
 * Fetch pending (or failed+eligible) jobs without locking —
 * processOcrJobInline → startJobInline() does the atomic claim.
 */
async function claimPendingJobs(limit: number): Promise<PendingRow[]> {
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  await client.connect();
  try {
    const res = await client.query<PendingRow>(
      `SELECT id, tenant_id, r2_key, filename, content_type
       FROM   chat_ocr_tasks
       WHERE  status IN ('pending', 'failed')
         AND  (next_retry_at IS NULL OR next_retry_at <= now())
         AND  attempt_count < max_attempts
       ORDER  BY created_at ASC
       LIMIT  $1`,
      [limit],
    );
    return res.rows;
  } finally {
    await client.end().catch(() => {});
  }
}

async function processJob(job: PendingRow): Promise<void> {
  const { id, tenant_id, r2_key, filename, content_type } = job;
  try {
    const buffer = await downloadFromR2(r2_key);
    await processOcrJobInline(id, buffer, filename, content_type, tenant_id);
  } catch (err) {
    console.error(
      `[chat-ocr-worker] job ${id} failed:`,
      (err as Error).message,
    );
    // Mark failed so retry logic can pick it up next cycle
    await markJobFailed(id, (err as Error).message).catch(() => {});
  }
}

// ── R2 download ────────────────────────────────────────────────────────────────

async function downloadFromR2(r2Key: string): Promise<Buffer> {
  const { r2Client, R2_BUCKET, R2_CONFIGURED } = await import("../r2/r2-client");
  if (!R2_CONFIGURED) throw new Error("R2 not configured — cannot download OCR file");

  const { GetObjectCommand } = await import("@aws-sdk/client-s3");
  const resp = await r2Client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key }));
  if (!resp.Body) throw new Error(`R2 returned empty body for key: ${r2Key}`);

  const chunks: Uint8Array[] = [];
  for await (const chunk of resp.Body as AsyncIterable<Uint8Array>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ── Failure stamp ──────────────────────────────────────────────────────────────

async function markJobFailed(jobId: string, reason: string): Promise<void> {
  const client = new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
  await client.connect();
  try {
    await client.query(
      `UPDATE chat_ocr_tasks
       SET    status        = 'failed',
              error_reason  = $1,
              next_retry_at = now() + interval '2 minutes',
              updated_at    = now()
       WHERE  id = $2
         AND  status = 'running'`,
      [reason.slice(0, 1000), jobId],
    );
  } finally {
    await client.end().catch(() => {});
  }
}
