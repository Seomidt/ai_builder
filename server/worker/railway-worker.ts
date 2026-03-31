/**
 * railway-worker.ts — Phase 5Y: Unified Media Processing Platform
 *
 * Thin entrypoint that:
 *  1. Starts the Phase 5Y media-worker loop (new media_processing_jobs table)
 *  2. Starts the Phase 5X OCR worker loop (legacy chat_ocr_tasks table — backward compat)
 *  3. Starts both reapers (media-reaper + ocr-reaper)
 *  4. Exposes a /health HTTP endpoint for Railway health checks
 *
 * All heavy logic lives in:
 *   server/lib/media/media-worker.ts   (Phase 5Y)
 *   server/lib/ocr/ocr-orchestrator.ts (Phase 5X legacy)
 */

import "../lib/env";
import * as http from "http";
import { randomUUID } from "crypto";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Client as PgClient } from "pg";
import { resolveDbUrl } from "../lib/jobs/job-queue";
import { getSupabaseSslConfig } from "../lib/jobs/ssl-config";
import { executeOcrWithFallback } from "../lib/ocr/ocr-orchestrator";
import { isRetryable, calculateNextRetryAt } from "../lib/ocr/ocr-retry-policy";
import { startReaper as startOcrReaper } from "./ocr-reaper";
import { startReaper as startMediaReaper } from "../lib/media/media-reaper";
import { claimNextJob, updateJobStatus, heartbeatJob, logEvent as mediaLogEvent } from "../lib/media/media-persistence";
import { processJob as processMediaJob } from "../lib/media/media-worker";

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

// ── DB helpers (legacy OCR) ───────────────────────────────────────────────────

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

// ── Legacy OCR: claim jobs ────────────────────────────────────────────────────

interface RawOcrTask {
  id:            string;
  tenant_id:     string;
  r2_key:        string;
  filename:      string;
  content_type:  string;
  attempt_count: number;
  max_attempts:  number;
}

async function claimLegacyJobs(limit: number): Promise<RawOcrTask[]> {
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

async function sendLegacyHeartbeat(jobId: string): Promise<void> {
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

async function updateLegacyStage(jobId: string, stage: string): Promise<void> {
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

async function completeLegacyJob(jobId: string, data: {
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

async function failLegacyJob(jobId: string, params: {
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

// ── Legacy OCR: process a single job ─────────────────────────────────────────

async function processLegacyJob(job: RawOcrTask): Promise<void> {
  const traceId = randomUUID();
  log("legacy_job_started", { jobId: job.id, tenantId: job.tenant_id, filename: job.filename, traceId });

  const heartbeatInterval = setInterval(() => sendLegacyHeartbeat(job.id), HEARTBEAT_MS);

  try {
    await updateLegacyStage(job.id, "upload");
    const fileBuffer = await downloadFromR2(job.r2_key);
    log("download_complete", { jobId: job.id, bytes: fileBuffer.length });

    await updateLegacyStage(job.id, "ocr");

    const result = await executeOcrWithFallback(
      fileBuffer,
      job.filename,
      job.content_type,
      async (attempt, provider, model) => {
        log("ai_extraction_attempt", { jobId: job.id, attempt, provider, model, traceId });
      }
    );

    if (!result.success) {
      const retryable = isRetryable(result.failureCategory ?? "unknown");
      await failLegacyJob(job.id, {
        errorCode: result.errorCode ?? "UNKNOWN",
        errorMessage: result.errorMessage ?? "Unknown error",
        failureCategory: result.failureCategory ?? "unknown",
        attemptCount: job.attempt_count,
        maxAttempts: job.max_attempts,
        retryable,
      });
      log("legacy_job_failed", { jobId: job.id, errorCode: result.errorCode, failureCategory: result.failureCategory });
      return;
    }

    await completeLegacyJob(job.id, {
      ocrText: result.text ?? "",
      provider: result.provider ?? "google",
      model: result.model ?? "gemini-2.5-flash",
      charCount: result.charCount ?? 0,
      fallbackDepth: result.fallbackDepth ?? 0,
    });

    log("legacy_job_completed", { jobId: job.id, charCount: result.charCount });
  } catch (err: any) {
    log("legacy_job_crashed", { jobId: job.id, error: err?.message });
    await failLegacyJob(job.id, {
      errorCode: "INTERNAL_ERROR",
      errorMessage: err?.message ?? "Unknown crash",
      failureCategory: "internal",
      attemptCount: job.attempt_count,
      maxAttempts: job.max_attempts,
      retryable: false,
    });
  } finally {
    clearInterval(heartbeatInterval);
  }
}

// ── Phase 5Y: media job loop ──────────────────────────────────────────────────

async function runMediaJobLoop(): Promise<void> {
  log("media_job_loop_started");

  while (true) {
    try {
      const job = await claimNextJob(WORKER_ID);
      if (job) {
        log("media_job_claimed", { jobId: job.id, mediaType: job.media_type, pipelineType: job.pipeline_type });
        processMediaJob(job).catch((err) => {
          log("media_job_unhandled_error", { jobId: job.id, error: err?.message });
        });
      }
    } catch (err: any) {
      log("media_job_loop_error", { error: err?.message });
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ── Legacy OCR: job loop ──────────────────────────────────────────────────────

async function runLegacyOcrLoop(): Promise<void> {
  log("legacy_ocr_loop_started");
  let activeJobs = 0;

  while (true) {
    try {
      const available = CONCURRENCY - activeJobs;
      if (available > 0) {
        const jobs = await claimLegacyJobs(available);
        for (const job of jobs) {
          activeJobs++;
          processLegacyJob(job)
            .catch((err) => log("legacy_job_unhandled", { jobId: job.id, error: err?.message }))
            .finally(() => { activeJobs--; });
        }
      }
    } catch (err: any) {
      log("legacy_ocr_loop_error", { error: err?.message });
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ── Health check server ───────────────────────────────────────────────────────

function startHealthServer(): void {
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", workerId: WORKER_ID, ts: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
  });

  server.listen(HEALTH_PORT, () => {
    log("health_server_started", { port: HEALTH_PORT });
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  log("worker_starting", { concurrency: CONCURRENCY, pollIntervalMs: POLL_INTERVAL_MS });

  startHealthServer();

  // Start both reapers
  startOcrReaper();
  startMediaReaper();

  // Start both job loops concurrently
  await Promise.all([
    runMediaJobLoop(),
    runLegacyOcrLoop(),
  ]);
}

main().catch((err) => {
  console.error("[railway-worker] Fatal error:", err);
  process.exit(1);
});
