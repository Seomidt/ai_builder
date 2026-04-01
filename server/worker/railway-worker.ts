/**
 * Railway Worker Entrypoint
 *
 * Dedicated worker process for knowledge processing jobs.
 * Railway start command: npx ts-node server/worker/railway-worker.ts
 *
 * Env vars used:
 *   SUPABASE_DB_POOL_URL         — required (DB connection)
 *   OPENAI_API_KEY               — required for embeddings + OCR
 *   CF_R2_*                      — required for file fetching
 *   KB_WORKER_POLL_INTERVAL_MS   — optional, default 5000
 *   KB_WORKER_MAX_CONCURRENT     — optional, default 3
 */

import { startKbWorker } from "../lib/knowledge/kb-worker.ts";

const POLL_MS  = parseInt(process.env.KB_WORKER_POLL_INTERVAL_MS ?? "5000", 10);
const MAX_CONC = parseInt(process.env.KB_WORKER_MAX_CONCURRENT   ?? "3",    10);

console.log("[railway-worker] starting dedicated KB worker");
console.log(`[railway-worker] poll=${POLL_MS}ms  maxConcurrent=${MAX_CONC}`);

startKbWorker({ pollIntervalMs: POLL_MS, maxConcurrent: MAX_CONC });

process.on("SIGTERM", () => {
  console.log("[railway-worker] SIGTERM — shutting down");
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("[railway-worker] SIGINT — shutting down");
  process.exit(0);
});
