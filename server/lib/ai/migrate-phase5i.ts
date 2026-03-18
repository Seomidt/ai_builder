/**
 * migrate-phase5i.ts — Phase 5I
 * Asset Processing Engine
 *
 * Adds required indexes for job dispatch performance (idempotent).
 *
 * Indexes created:
 *   - idx_asset_processing_jobs_queue  (job_status, created_at) — dispatcher poll query
 *   - idx_asset_processing_jobs_asset  (asset_id) — per-asset job listing
 *   - idx_asset_processing_jobs_version (asset_version_id) — per-version job listing
 *
 * Note: kapj_status_created_idx and kapj_asset_created_idx already exist from Phase 5G.
 * These new indexes complement those with explicit query patterns for the dispatcher.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";

async function step(label: string, fn: () => Promise<void>) {
  process.stdout.write(`  [5I] ${label}... `);
  try {
    await fn();
    console.log("OK");
  } catch (err: any) {
    if (/already exists/.test(err.message)) {
      console.log("already exists (OK)");
    } else {
      console.error(`FAILED: ${err.message}`);
      throw err;
    }
  }
}

async function main() {
  console.log("\n========================================");
  console.log("  migrate-phase5i.ts — Phase 5I");
  console.log("  Asset Processing Engine");
  console.log("========================================\n");

  // Verify the Phase 5G table exists
  await step("Verify knowledge_asset_processing_jobs table exists", async () => {
    const result = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'knowledge_asset_processing_jobs'
    `);
    const rows = (result as any).rows ?? [];
    if (rows.length === 0) {
      throw new Error("knowledge_asset_processing_jobs not found — Phase 5G migration required");
    }
  });

  // Required index: dispatcher poll query (job_status, created_at)
  await step("Index idx_asset_processing_jobs_queue", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_asset_processing_jobs_queue
        ON knowledge_asset_processing_jobs (job_status, created_at)
    `);
  });

  // Required index: per-asset job listing
  await step("Index idx_asset_processing_jobs_asset", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_asset_processing_jobs_asset
        ON knowledge_asset_processing_jobs (asset_id)
    `);
  });

  // Required index: per-version job listing
  await step("Index idx_asset_processing_jobs_version", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_asset_processing_jobs_version
        ON knowledge_asset_processing_jobs (asset_version_id)
    `);
  });

  // Additional index: orphan/timeout detection (started_at for active jobs)
  await step("Index idx_asset_processing_jobs_started", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_asset_processing_jobs_started
        ON knowledge_asset_processing_jobs (job_status, started_at)
        WHERE job_status = 'started'
    `);
  });

  // Additional index: retry detection (failed jobs by tenant)
  await step("Index idx_asset_processing_jobs_failed", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS idx_asset_processing_jobs_failed
        ON knowledge_asset_processing_jobs (tenant_id, job_status, attempt_number)
        WHERE job_status = 'failed'
    `);
  });

  console.log("\n========================================");
  console.log("  Phase 5I migration complete.");
  console.log("  5 indexes added to knowledge_asset_processing_jobs.");
  console.log("========================================\n");

  process.exit(0);
}

main().catch((err) => {
  console.error("\nMigration failed:", err);
  process.exit(1);
});
