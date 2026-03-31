/**
 * railway-worker.ts — Phase 5X: OCR Reliability, Fallback, Timeout & Dead-Letter Safety
 *
 * Key improvements over previous version:
 * - Hard timeout on ALL Gemini calls (no more infinite hangs)
 * - Heartbeat every 15s so the reaper can detect stuck jobs
 * - Fallback chain: gemini-2.5-flash (30s) → gemini-1.5-pro (60s)
 * - Deterministic state machine: pending → processing → completed/retryable_failed/dead_letter
 * - Append-only event log (ocr_event_log table)
 * - SOC2: no document content in logs
 */

import "../lib/env";
import * as http from "http";
import { startReaper } from "./ocr-reaper";
import { randomUUID } from "crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Client as PgClient } from "pg";
import { resolveDbUrl } from "../lib/jobs/job-queue";
import { getSupabaseSslConfig } from "../lib/jobs/ssl-config";
import { executeOcrWithFallback } from "../lib/ocr/ocr-orchestrator";
import { classifyError } from "../lib/ocr/ocr-error-classifier";
import { isRetryable, calculateNextRetryAt } from "../lib/ocr/ocr-retry-policy";

// ── Configuration ─────────────────────────────────────────────────────────────

const WORKER_ID        = randomUUID();
const CONCURRENCY      = parseInt(process.env.OCR_CONCURRENCY ?? "2", 10);
const POLL_INTERVAL_MS = parseInt(process.env.OCR_POLL_INTERVAL_MS ?? "5000", 10);
const HEARTBEAT_MS     = parseInt(process.env.OCR_HEARTBEAT_MS ?? "15000", 10);
const HEALTH_PORT      = parseInt(process.env.PORT ?? "8080", 10);

// ── R2 Client ─────────────────────────────────────────────────────────────────

const r2AccountId       = process.env.CF_R2_ACCOUNT_ID        ?? "";
const r2AccessKeyId     = process.env.CF_R2_ACCESS_KEY_ID     ?? "";
const r2SecretAccessKey = process.env.CF_R2_SECRET_ACCESS_KEY ?? "";
const R2_BUCKET         = process.env.CF_R2_BUCKET_NAME       ?? "blissops";

const r2Client = new S3Client({
  region: "auto",
  endpoint: `https://${r2AccountId}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     r2AccessKeyId     || "placeholder",
    secretAccessKey: r2SecretAccessKey || "placeholder",
  },
  forcePathStyle: false,
});

// ── Structured logger (SOC2-safe — no document content logged) ────────────────

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({
    ts:       new Date().toISOString(),
    svc:      "railway-worker",
    workerId: WORKER_ID,
    event,
    ...fields,
  }));
}

// ── DB helpers ────────────────────────────────────────────────────────────────

function newClient(): PgClient {
  return new PgClient({ connectionString: resolveDbUrl(), ssl: getSupabaseSslConfig() });
}

async function withClient<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
  const client = newClient();
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

// ── Event log ─────────────────────────────────────────────────────────────────

async function logEvent(params: {
  tenantId: string;
  jobId: string;
  eventType: string;
  stage?: string;
  provider?: string;
  model?: string;
  attemptCount?: number;
  fallbackDepth?: number;
  traceId?: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  try {
    await withClient(async (client) => {
      await client.query(
        `INSERT INTO ocr_event_log
           (tenant_id, job_id, event_type, stage, provider, model, attempt_count,
            fallback_depth, worker_id, execution_trace_id, payload_jsonb)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          params.tenantId, params.jobId, params.eventType,
          params.stage ?? null, params.provider ?? null, params.model ?? null,
          params.attemptCount ?? null, params.fallbackDepth ?? 0,
          WORKER_ID, params.traceId ?? null,
          JSON.stringify(params.payload ?? {}),
        ]
      );
    });
  } catch (err: any) {
    log("event_log_write_failed", { error: err?.message });
  }
}

// ── Claim jobs (atomic, FOR UPDATE SKIP LOCKED) ───────────────────────────────

interface RawOcrTask {
  id:            string;
  tenant_id:     string;
  r2_key:        string;
  filename:      string;
  content_type:  string;
  attempt_count: number;
  max_attempts:  number;
}

async function claimJobs(limit: number): Promise<RawOcrTask[]> {
  return withClient(async (client) => {
    const res = await client.query<RawOcrTask>(
      `UPDATE chat_ocr_tasks
       SET    status            = 'processing',
              stage             = 'claim',
              attempt_count     = attempt_count + 1,
              claimed_at        = now(),
              started_at        = COALESCE(started_at, now()),
              last_heartbeat_at = now(),
              worker_id         = $2,
              updated_at        = now()
       WHERE  id IN (
         SELECT id FROM chat_ocr_tasks
         WHERE  status IN ('pending', 'retryable_failed', 'running', 'failed')
           AND  (next_retry_at IS NULL OR next_retry_at <= now())
           AND  attempt_count < max_attempts
         ORDER BY created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT $1
       )
       RETURNING id, tenant_id, r2_key, filename, content_type, attempt_count, max_attempts`,
      [limit, WORKER_ID],
    );
    return res.rows;
  });
}

// ── Heartbeat ─────────────────────────────────────────────────────────────────

async function sendHeartbeat(jobId: string): Promise<void> {
  try {
    await withClient(async (client) => {
      await client.query(
        `UPDATE chat_ocr_tasks SET last_heartbeat_at = now(), updated_at = now() WHERE id = $1`,
        [jobId]
      );
    });
  } catch (err: any) {
    log("heartbeat_failed", { jobId, error: err?.message });
  }
}

// ── Stage update ──────────────────────────────────────────────────────────────

async function updateStage(jobId: string, stage: string): Promise<void> {
  try {
    await withClient(async (client) => {
      await client.query(
        `UPDATE chat_ocr_tasks SET stage = $1, last_heartbeat_at = now(), updated_at = now() WHERE id = $2`,
        [stage, jobId]
      );
    });
  } catch (err: any) {
    log("stage_update_failed", { jobId, stage, error: err?.message });
  }
}

// ── Complete job ──────────────────────────────────────────────────────────────

async function completeJob(jobId: string, data: {
  ocrText: string;
  provider: string;
  model: string;
  charCount: number;
  fallbackDepth: number;
}): Promise<void> {
  await withClient(async (client) => {
    await client.query(
      `UPDATE chat_ocr_tasks
       SET    status        = 'completed',
              stage         = 'finalize',
              ocr_text      = $1,
              provider      = $2,
              char_count    = $3,
              quality_score = CASE WHEN $3 > 100 THEN 0.95 ELSE 0.5 END,
              page_count    = 1,
              chunk_count   = GREATEST(1, CEIL($3::float / 2000)),
              fallback_depth = $4,
              completed_at  = now(),
              updated_at    = now()
       WHERE  id = $5`,
      [data.ocrText, `${data.provider}/${data.model}`, data.charCount, data.fallbackDepth, jobId]
    );
  });
}

// ── Fail job ──────────────────────────────────────────────────────────────────

async function failJobWithCategory(jobId: string, params: {
  errorCode: string;
  errorMessage: string;
  failureCategory: string;
  attemptCount: number;
  maxAttempts: number;
  retryable: boolean;
}): Promise<void> {
  const isDead = !params.retryable || params.attemptCount >= params.maxAttempts;
  const nextRetry = isDead ? null : calculateNextRetryAt(params.attemptCount);

  await withClient(async (client) => {
    await client.query(
      `UPDATE chat_ocr_tasks
       SET    status             = $1,
              stage              = NULL,
              last_error_code    = $2,
              last_error_message = $3,
              failure_category   = $4,
              last_error_at      = now(),
              next_retry_at      = $5,
              dead_lettered_at   = $6,
              failed_at          = CASE WHEN $1 IN ('failed','dead_letter') THEN now() ELSE failed_at END,
              updated_at         = now()
       WHERE  id = $7`,
      [
        isDead ? "dead_letter" : "retryable_failed",
        params.errorCode,
        params.errorMessage.slice(0, 500),
        params.failureCategory,
        nextRetry,
        isDead ? new Date() : null,
        jobId,
      ]
    );
  });
}

// ── Download from R2 ──────────────────────────────────────────────────────────

async function downloadFromR2(r2Key: string): Promise<Buffer> {
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: r2Key });
  const response = await r2Client.send(cmd);
  const stream = response.Body as NodeJS.ReadableStream;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// ── Process a single job ──────────────────────────────────────────────────────

async function processJob(job: RawOcrTask): Promise<void> {
  const start   = Date.now();
  const traceId = randomUUID();

  log("job_started", { jobId: job.id, tenantId: job.tenant_id, filename: job.filename, traceId });
  await logEvent({ tenantId: job.tenant_id, jobId: job.id, eventType: "ocr_job_claimed", stage: "claim", attemptCount: job.attempt_count, traceId });

  // Start heartbeat interval
  const heartbeatInterval = setInterval(() => sendHeartbeat(job.id), HEARTBEAT_MS);

  try {
    // ── Stage: download from R2 ────────────────────────────────────────────────
    await updateStage(job.id, "upload");
    log("downloading_from_r2", { jobId: job.id, r2Key: job.r2_key });
    const fileBuffer = await downloadFromR2(job.r2_key);
    log("download_complete", { jobId: job.id, bytes: fileBuffer.length });

    // ── Stage: OCR with fallback chain (hard timeout enforced inside) ──────────
    await updateStage(job.id, "ocr");

    const result = await executeOcrWithFallback(
      fileBuffer,
      job.filename,
      job.content_type,
      async (attempt, provider, model) => {
        const isFallback = attempt > 1;
        log("ai_extraction_attempt", { jobId: job.id, attempt, provider, model, isFallback, traceId });
        await logEvent({
          tenantId: job.tenant_id, jobId: job.id,
          eventType: isFallback ? "ocr_fallback_started" : "ocr_provider_call_started",
          stage: "ocr", provider, model, attemptCount: job.attempt_count,
          fallbackDepth: attempt - 1, traceId,
        });
      }
    );

    if (!result.success) {
      const retryable = isRetryable(result.failureCategory ?? "unknown");
      log("ai_extraction_failed", { jobId: job.id, errorCode: result.errorCode, category: result.failureCategory, retryable, durationMs: result.durationMs, traceId });

      await logEvent({
        tenantId: job.tenant_id, jobId: job.id,
        eventType: result.failureCategory === "timeout" ? "ocr_provider_call_timed_out" : "ocr_provider_call_failed",
        stage: "ocr", provider: result.provider, model: result.model,
        attemptCount: job.attempt_count, traceId,
        payload: { errorCode: result.errorCode, errorMessage: result.errorMessage, durationMs: result.durationMs },
      });

      await failJobWithCategory(job.id, {
        errorCode:       result.errorCode ?? "UNKNOWN",
        errorMessage:    result.errorMessage ?? "Unknown error",
        failureCategory: result.failureCategory ?? "unknown",
        attemptCount:    job.attempt_count,
        maxAttempts:     job.max_attempts,
        retryable,
      });
      return;
    }

    log("ai_extraction_complete", { jobId: job.id, chars: result.text!.length, model: result.model, provider: result.provider, usedFallback: result.usedFallback, durationMs: result.durationMs, traceId });

    // ── Stage: persist result ──────────────────────────────────────────────────
    await updateStage(job.id, "persist");
    await completeJob(job.id, {
      ocrText:      result.text!,
      provider:     result.provider,
      model:        result.model,
      charCount:    result.text!.length,
      fallbackDepth: result.usedFallback ? 1 : 0,
    });

    await logEvent({
      tenantId: job.tenant_id, jobId: job.id, eventType: "ocr_job_completed",
      stage: "finalize", provider: result.provider, model: result.model,
      attemptCount: job.attempt_count, traceId,
      payload: { durationMs: Date.now() - start, chars: result.text!.length, usedFallback: result.usedFallback },
    });

    log("job_completed", { jobId: job.id, tenantId: job.tenant_id, model: result.model, durationMs: Date.now() - start, chars: result.text!.length, usedFallback: result.usedFallback, traceId });

  } catch (e: any) {
    const { category, code, message } = classifyError(e);
    const retryable = isRetryable(category);
    log("job_error", { jobId: job.id, tenantId: job.tenant_id, code, category, retryable, traceId });

    await logEvent({ tenantId: job.tenant_id, jobId: job.id, eventType: "ocr_job_failed", stage: "ocr", traceId, payload: { errorCode: code, errorMessage: message, category } });

    await failJobWithCategory(job.id, {
      errorCode:       code,
      errorMessage:    message,
      failureCategory: category,
      attemptCount:    job.attempt_count,
      maxAttempts:     job.max_attempts,
      retryable,
    }).catch(() => {});

  } finally {
    clearInterval(heartbeatInterval);
  }
}

// ── Health check HTTP server ──────────────────────────────────────────────────

const healthServer = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "railway-worker", workerId: WORKER_ID, ts: new Date().toISOString() }));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

healthServer.listen(HEALTH_PORT, () => {
  log("health_server_started", { port: HEALTH_PORT });
});

// ── Worker loop ───────────────────────────────────────────────────────────────

async function runWorker(): Promise<void> {
  log("worker_started", { concurrency: CONCURRENCY, pollIntervalMs: POLL_INTERVAL_MS, heartbeatMs: HEARTBEAT_MS, supports: "pdf,image,video,audio" });

  // Start the reaper to clean up stuck jobs
  startReaper();

  while (true) {
    try {
      const jobs = await claimJobs(CONCURRENCY);
      if (jobs.length > 0) {
        log("jobs_claimed", { count: jobs.length });
        await Promise.all(jobs.map(job => processJob(job)));
      }
    } catch (err: any) {
      log("worker_loop_error", { error: err?.message ?? String(err) });
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

runWorker().catch(err => {
  console.error("Fatal worker error:", err);
  process.exit(1);
});
