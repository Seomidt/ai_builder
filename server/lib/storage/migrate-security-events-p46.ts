/**
 * Phase 46 — Extend security_events.event_type CHECK constraint
 * Adds 10 storage_* event types to the existing 14 security event types.
 *
 * Run: npx tsx server/lib/storage/migrate-security-events-p46.ts
 */

import pg from "pg";

const POOL_URL = process.env.SUPABASE_DB_POOL_URL;
if (!POOL_URL) throw new Error("SUPABASE_DB_POOL_URL is required");

async function migrate(): Promise<void> {
  const client = new pg.Client({ connectionString: POOL_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    console.log("\n── Phase 46: security_events event_type constraint update ──────────────\n");

    await client.query(`ALTER TABLE security_events DROP CONSTRAINT IF EXISTS se_event_type_check`);
    console.log("  ✔ Dropped old se_event_type_check");

    await client.query(`
      ALTER TABLE security_events
      ADD CONSTRAINT se_event_type_check
      CHECK (event_type = ANY (ARRAY[
        'session_created',
        'session_revoked',
        'login_failed',
        'login_success',
        'auth_failure',
        'rate_limit_trigger',
        'invalid_input',
        'tenant_access_violation',
        'api_abuse',
        'oversized_payload',
        'security_header_violation',
        'csp_violation',
        'ai_input_rejected',
        'rate_limit_exceeded',
        'storage_upload_requested',
        'storage_upload_completed',
        'storage_upload_failed',
        'storage_download_url_issued',
        'storage_file_deleted',
        'storage_file_delete_failed',
        'storage_scan_pending',
        'storage_scan_clean',
        'storage_scan_rejected',
        'storage_unauthorized_storage_access_attempt'
      ]::text[]))
    `);
    console.log("  ✔ Added storage_* event types (14 → 24 total event types)");

    const verify = await client.query(`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE table_name = 'security_events' AND constraint_name = 'se_event_type_check'
    `);
    if (verify.rows.length === 0) throw new Error("se_event_type_check constraint not found after migration");
    console.log("  ✔ Constraint verified");

    console.log("\n  ✔ Phase 46 security_events migration complete\n");
  } finally {
    await client.end();
  }
}

migrate().catch(err => {
  console.error("[Phase46SecurityEvents] FAILED:", err.message);
  process.exit(1);
});
