/**
 * migrate-phase5j.ts — Phase 5J DB Migration
 *
 * Applies the partial index and any remaining schema fixups
 * not handled by drizzle-kit push (e.g., partial/conditional indexes).
 *
 * Idempotent — safe to run multiple times.
 *
 * Usage: npx tsx server/lib/ai/migrate-phase5j.ts
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

async function main() {
  console.log("Phase 5J migration — applying partial index...");

  // Partial index on knowledge_asset_versions(checksum_sha256) WHERE NOT NULL
  // drizzle-kit push does not support partial indexes natively — applied here
  await db.execute(sql`
    CREATE INDEX IF NOT EXISTS kav_tenant_checksum_partial_idx 
    ON knowledge_asset_versions(checksum_sha256) 
    WHERE checksum_sha256 IS NOT NULL
  `);
  console.log("  kav_tenant_checksum_partial_idx — OK");

  // Verify all expected Phase 5J indexes exist
  const expectedIndexes = [
    "ka_tenant_kb_type_idx",
    "ka_tenant_current_version_idx",
    "kav_tenant_checksum_partial_idx",
    "kapj_tenant_asset_status_idx",
    "kapj_tenant_version_type_idx",
  ];

  for (const name of expectedIndexes) {
    const r = await db.execute(
      sql.raw(`SELECT indexname FROM pg_indexes WHERE indexname='${name}'`),
    );
    const found = (r as any).rows?.length > 0 || (r as any).length > 0;
    console.log(`  ${name}: ${found ? "EXISTS" : "MISSING ⚠"}`);
  }

  // Verify new columns exist
  const expectedCols = [
    ["knowledge_assets", "updated_by"],
    ["knowledge_asset_versions", "tenant_id"],
    ["knowledge_asset_versions", "ingest_status"],
    ["knowledge_asset_versions", "source_upload_id"],
    ["knowledge_asset_versions", "is_active"],
    ["asset_storage_objects", "uploaded_at"],
    ["knowledge_asset_processing_jobs", "created_by"],
  ];

  for (const [table, col] of expectedCols) {
    const r = await db.execute(
      sql.raw(
        `SELECT column_name FROM information_schema.columns WHERE table_name='${table}' AND column_name='${col}'`,
      ),
    );
    const found = (r as any).rows?.length > 0 || (r as any).length > 0;
    console.log(`  ${table}.${col}: ${found ? "EXISTS" : "MISSING ⚠"}`);
  }

  console.log("\nPhase 5J migration complete.");
  process.exit(0);
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
