/**
 * KB Worker Entrypoint — Storage 1.3
 *
 * Dedicated worker process for knowledge processing jobs.
 * Start with: tsx server/worker.ts
 *
 * This file ONLY starts the worker — no web server, no API routes.
 * Safe to deploy as a separate Railway/Fly service alongside the web app.
 *
 * Env vars used:
 *   SUPABASE_DB_POOL_URL         — required (DB connection)
 *   OPENAI_API_KEY               — required for embeddings + OCR
 *   CF_R2_*                      — required for file fetching
 *   KB_WORKER_POLL_INTERVAL_MS   — optional, default 5000
 *   KB_WORKER_MAX_CONCURRENT     — optional, default 3
 */

import { startKbWorker } from "./lib/knowledge/kb-worker.ts";

const POLL_MS   = parseInt(process.env.KB_WORKER_POLL_INTERVAL_MS ?? "5000", 10);
const MAX_CONC  = parseInt(process.env.KB_WORKER_MAX_CONCURRENT   ?? "3",    10);

console.log("[kb-worker-process] starting dedicated worker");
console.log(`[kb-worker-process] poll=${POLL_MS}ms  maxConcurrent=${MAX_CONC}`);

startKbWorker({ pollIntervalMs: POLL_MS, maxConcurrent: MAX_CONC });

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[kb-worker-process] SIGTERM — shutting down");
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("[kb-worker-process] SIGINT — shutting down");
  process.exit(0);
});
