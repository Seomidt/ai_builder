/**
 * migrate-phase5h.ts — Phase 5H
 * Retrieval Orchestration & Context Assembly
 *
 * Phase 5E already created the knowledge_retrieval_runs table.
 * This migration verifies all required schema components are present
 * and adds any missing indexes idempotently.
 *
 * Tables verified:
 *   - knowledge_retrieval_runs (Phase 5E)
 *
 * This migration does NOT create new tables — it validates and hardens
 * the existing retrieval schema.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db";

async function step(label: string, fn: () => Promise<void>) {
  process.stdout.write(`  [5H] ${label}... `);
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
  console.log("  migrate-phase5h.ts — Phase 5H");
  console.log("  Retrieval Orchestration & Context Assembly");
  console.log("========================================\n");

  // Verify knowledge_retrieval_runs exists (created in Phase 5E)
  await step("Verify knowledge_retrieval_runs table exists", async () => {
    const result = await db.execute(sql`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = 'knowledge_retrieval_runs'
    `);
    const rows = (result as any).rows ?? [];
    if (rows.length === 0) {
      throw new Error("knowledge_retrieval_runs table not found — Phase 5E migration required");
    }
  });

  // Ensure embedding_version and retrieval_version columns exist (Phase 5F additions)
  await step("Verify embedding_version on knowledge_retrieval_runs", async () => {
    const result = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'knowledge_retrieval_runs'
        AND column_name = 'embedding_version'
    `);
    const rows = (result as any).rows ?? [];
    if (rows.length === 0) {
      await db.execute(sql`
        ALTER TABLE knowledge_retrieval_runs
          ADD COLUMN IF NOT EXISTS embedding_version text
      `);
    }
  });

  await step("Verify retrieval_version on knowledge_retrieval_runs", async () => {
    const result = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'knowledge_retrieval_runs'
        AND column_name = 'retrieval_version'
    `);
    const rows = (result as any).rows ?? [];
    if (rows.length === 0) {
      await db.execute(sql`
        ALTER TABLE knowledge_retrieval_runs
          ADD COLUMN IF NOT EXISTS retrieval_version text
      `);
    }
  });

  // Ensure Phase 5H-specific index: (tenant_id, knowledge_base_id, query_hash) for cache dedup
  await step("Index krr_tenant_kb_hash_idx", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS krr_tenant_kb_hash_idx
        ON knowledge_retrieval_runs (tenant_id, knowledge_base_id, query_hash)
    `);
  });

  // Ensure index on query_hash alone for direct lookup
  await step("Index krr_query_hash_idx", async () => {
    await db.execute(sql`
      CREATE INDEX IF NOT EXISTS krr_query_hash_idx
        ON knowledge_retrieval_runs (query_hash)
    `);
  });

  console.log("\n========================================");
  console.log("  Phase 5H migration complete.");
  console.log("  knowledge_retrieval_runs table verified and hardened.");
  console.log("========================================\n");

  process.exit(0);
}

main().catch((err) => {
  console.error("\nMigration failed:", err);
  process.exit(1);
});
