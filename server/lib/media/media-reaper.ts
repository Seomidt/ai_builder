// ============================================================
// PHASE 5Y — Unified Media Processing Platform
// media-reaper.ts — Stuck job cleanup with stale heartbeat detection
// ============================================================

import { findStuckJobs, resetStuckJob, logEvent } from "./media-persistence.ts";

const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000;  // 5 minutes
const REAPER_INTERVAL_MS   = 60 * 1000;       // Run every 60 seconds

let reaperTimer: ReturnType<typeof setInterval> | null = null;

export async function runReaperCycle(): Promise<void> {
  try {
    const stuckJobs = await findStuckJobs(HEARTBEAT_TIMEOUT_MS);

    if (stuckJobs.length === 0) return;

    console.log(`[media-reaper] Found ${stuckJobs.length} stuck job(s), resetting...`);

    for (const job of stuckJobs) {
      const staleFor = job.heartbeat_at
        ? Math.round((Date.now() - new Date(job.heartbeat_at).getTime()) / 1000)
        : "unknown";

      const reason = `Heartbeat stale for ${staleFor}s (timeout: ${HEARTBEAT_TIMEOUT_MS / 1000}s)`;

      await resetStuckJob(job.id, reason);

      await logEvent({
        job_id: job.id,
        event_type: "job_reset_by_reaper",
        event_data: {
          reason,
          staleForSeconds: staleFor,
          workerId: job.worker_id,
        },
      });

      console.log(`[media-reaper] Reset job ${job.id}: ${reason}`);
    }
  } catch (error: unknown) {
    console.error("[media-reaper] Reaper cycle failed:", (error as Error).message);
  }
}

export function startReaper(): void {
  if (reaperTimer) return; // Already running

  console.log(`[media-reaper] Starting reaper (interval: ${REAPER_INTERVAL_MS / 1000}s, timeout: ${HEARTBEAT_TIMEOUT_MS / 1000}s)`);

  // Run immediately on start
  runReaperCycle().catch((e) =>
    console.error("[media-reaper] Initial cycle failed:", e)
  );

  reaperTimer = setInterval(() => {
    runReaperCycle().catch((e) =>
      console.error("[media-reaper] Reaper cycle failed:", e)
    );
  }, REAPER_INTERVAL_MS);
}

export function stopReaper(): void {
  if (reaperTimer) {
    clearInterval(reaperTimer);
    reaperTimer = null;
    console.log("[media-reaper] Reaper stopped");
  }
}
