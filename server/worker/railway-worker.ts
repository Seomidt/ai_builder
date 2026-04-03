/**
 * Railway Worker Entrypoint — compiled via esbuild → dist/worker.cjs
 *
 * Production start: node dist/worker.cjs
 * Do NOT run raw .ts in production.
 */

import { startKbWorker } from "../lib/knowledge/kb-worker";

const POLL_MS  = parseInt(process.env.KB_WORKER_POLL_INTERVAL_MS ?? "5000", 10);
const MAX_CONC = parseInt(process.env.KB_WORKER_MAX_CONCURRENT   ?? "3",    10);

console.log("[railway-worker] starting");
console.log(`[railway-worker] poll=${POLL_MS}ms  maxConcurrent=${MAX_CONC}`);

startKbWorker({ pollIntervalMs: POLL_MS, maxConcurrent: MAX_CONC });

console.log("[railway-worker] kb-worker import succeeded — polling started");

process.on("SIGTERM", () => { console.log("[railway-worker] SIGTERM"); process.exit(0); });
process.on("SIGINT",  () => { console.log("[railway-worker] SIGINT");  process.exit(0); });
