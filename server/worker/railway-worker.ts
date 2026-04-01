/**
 * Railway Worker Entrypoint
 *
 * Dedicated worker process for knowledge processing jobs.
 * Railway start command: npx ts-node server/worker/railway-worker.ts
 *
 * Uses dynamic import() to bridge CJS ts-node → ESM project modules.
 *
 * Env vars used:
 *   SUPABASE_DB_POOL_URL         — required (DB connection)
 *   OPENAI_API_KEY / GEMINI_API_KEY — required for embeddings + OCR
 *   CF_R2_*                      — required for file fetching
 *   KB_WORKER_POLL_INTERVAL_MS   — optional, default 5000
 *   KB_WORKER_MAX_CONCURRENT     — optional, default 3
 */

const POLL_MS  = parseInt(process.env.KB_WORKER_POLL_INTERVAL_MS ?? "5000", 10);
const MAX_CONC = parseInt(process.env.KB_WORKER_MAX_CONCURRENT   ?? "3",    10);

console.log("[railway-worker] starting dedicated KB worker");
console.log(`[railway-worker] poll=${POLL_MS}ms  maxConcurrent=${MAX_CONC}`);

(async () => {
  try {
    const { startKbWorker } = await import("../lib/knowledge/kb-worker");
    await startKbWorker({ pollIntervalMs: POLL_MS, maxConcurrent: MAX_CONC });
  } catch (err) {
    console.error("[railway-worker] fatal startup error:", err);
    process.exit(1);
  }
})();

process.on("SIGTERM", () => {
  console.log("[railway-worker] SIGTERM — shutting down");
  process.exit(0);
});
process.on("SIGINT", () => {
  console.log("[railway-worker] SIGINT — shutting down");
  process.exit(0);
});
