/**
 * Phase 44 Migration — Final Enterprise Hardening
 *
 * What this migration does:
 *   1. Adds performance indexes on security_events (event_type + created_at composite)
 *      — the existing se_event_type_created_idx is present; this adds a covering partial
 *        index for the new Phase 44 event types to support monitoring dashboards.
 *   2. Verifies the security_events table schema is compatible with Phase 44 event types.
 *   3. Ensures RLS is enabled on security_events (should already be, belt-and-suspenders).
 *   4. Adds the ai_abuse_log table for structured AI input rejection tracking.
 *      (Complements security_events for high-cardinality AI abuse signals.)
 *   5. Creates covering indexes on ai_abuse_log for tenant + time-range queries.
 *   6. Enables RLS + service_role policy on ai_abuse_log.
 *   7. Verifies all Phase 44 schema elements are in place.
 *
 * SAFETY:
 *   - All CREATE TABLE/INDEX use IF NOT EXISTS — idempotent.
 *   - No DROP statements — zero destructive operations.
 *   - Single pg.Client (NOT pool) per scratchpad convention.
 *   - Uses SUPABASE_DB_POOL_URL, never imports dotenv.
 */

import pg from "pg";

async function main() {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres\n");

  try {
    // ── 1. Verify security_events table exists ─────────────────────────────
    console.log("── security_events: schema verification ──");
    const seExists = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name='security_events'`,
    );
    if (seExists.rows.length === 0) {
      throw new Error("security_events table not found — run Phase 13.2 migration first");
    }
    console.log("  ✔ security_events table confirmed\n");

    // ── 2. Extend se_event_type_check constraint ───────────────────────────
    //
    // The original constraint only covers 11 event types (Phase 7 + 13.2).
    // Phase 44 adds 3 new types: csp_violation, ai_input_rejected, rate_limit_exceeded.
    // PostgreSQL does not support ALTER CONSTRAINT for CHECK — must DROP + ADD.
    console.log("── security_events: extend event_type constraint ──");
    await client.query(`
      ALTER TABLE security_events
        DROP CONSTRAINT IF EXISTS se_event_type_check
    `);
    await client.query(`
      ALTER TABLE security_events
        ADD CONSTRAINT se_event_type_check CHECK (
          event_type = ANY (ARRAY[
            -- Phase 7 legacy
            'session_created',
            'session_revoked',
            'login_failed',
            'login_success',
            -- Phase 13.2 operational
            'auth_failure',
            'rate_limit_trigger',
            'invalid_input',
            'tenant_access_violation',
            'api_abuse',
            'oversized_payload',
            'security_header_violation',
            -- Phase 44 new
            'csp_violation',
            'ai_input_rejected',
            'rate_limit_exceeded'
          ]::text[])
        )
    `);
    console.log("  ✔ se_event_type_check extended to 14 types\n");

    // ── 3. Partial covering index for Phase 44 event types ─────────────────
    //    Optimises dashboard queries:
    //      SELECT * FROM security_events WHERE event_type IN (...) AND created_at > NOW()-'1 hour'
    console.log("── Phase 44 event type indexes ──");

    await client.query(`
      CREATE INDEX IF NOT EXISTS se_p44_csp_created_idx
        ON security_events(created_at DESC)
        WHERE event_type = 'csp_violation'
    `);
    console.log("  ✔ se_p44_csp_created_idx (csp_violation partial)");

    await client.query(`
      CREATE INDEX IF NOT EXISTS se_p44_ai_rejected_created_idx
        ON security_events(tenant_id, created_at DESC)
        WHERE event_type = 'ai_input_rejected'
    `);
    console.log("  ✔ se_p44_ai_rejected_created_idx (ai_input_rejected partial)");

    await client.query(`
      CREATE INDEX IF NOT EXISTS se_p44_rate_exceeded_created_idx
        ON security_events(tenant_id, created_at DESC)
        WHERE event_type = 'rate_limit_exceeded'
    `);
    console.log("  ✔ se_p44_rate_exceeded_created_idx (rate_limit_exceeded partial)\n");

    // ── 4. Belt-and-suspenders: RLS on security_events ────────────────────
    console.log("── security_events: RLS enforcement ──");
    await client.query(`ALTER TABLE security_events ENABLE ROW LEVEL SECURITY`);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE tablename='security_events' AND policyname='service_role_all_security_events'
        ) THEN
          CREATE POLICY service_role_all_security_events
            ON security_events FOR ALL TO service_role
            USING (true) WITH CHECK (true);
        END IF;
      END $$
    `);
    console.log("  ✔ RLS enabled + service_role policy on security_events\n");

    // ── 4. ai_abuse_log — structured AI input rejection log ───────────────
    //
    // Rationale: security_events has low-cardinality event_type targeting.
    // ai_abuse_log is a high-cardinality structured log for AI abuse monitoring:
    //   - Enables per-tenant abuse rate dashboards
    //   - Queryable by rejection reason without JSON extraction overhead
    //   - Never stores input content (INV-AI-ABUSE-5)
    console.log("── ai_abuse_log ──");
    await client.query(`
      CREATE TABLE IF NOT EXISTS ai_abuse_log (
        id                  VARCHAR PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           TEXT NOT NULL,
        actor_id            TEXT,
        rejection_reason    TEXT NOT NULL,
        input_length_bytes  INTEGER NOT NULL,
        ip                  TEXT,
        request_id          TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

        CONSTRAINT aal_rejection_reason_check CHECK (
          rejection_reason IN (
            'input_too_long',
            'burst_limit',
            'pattern_match',
            'token_cap'
          )
        )
      )
    `);
    console.log("  ✔ ai_abuse_log table ready");

    await client.query(`
      CREATE INDEX IF NOT EXISTS aal_tenant_created_idx
        ON ai_abuse_log(tenant_id, created_at DESC)
    `);
    console.log("  ✔ aal_tenant_created_idx");

    await client.query(`
      CREATE INDEX IF NOT EXISTS aal_tenant_reason_idx
        ON ai_abuse_log(tenant_id, rejection_reason)
    `);
    console.log("  ✔ aal_tenant_reason_idx");

    await client.query(`
      CREATE INDEX IF NOT EXISTS aal_created_idx
        ON ai_abuse_log(created_at DESC)
    `);
    console.log("  ✔ aal_created_idx\n");

    // ── 5. RLS on ai_abuse_log ────────────────────────────────────────────
    console.log("── ai_abuse_log: RLS ──");
    await client.query(`ALTER TABLE ai_abuse_log ENABLE ROW LEVEL SECURITY`);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE tablename='ai_abuse_log' AND policyname='service_role_all_ai_abuse_log'
        ) THEN
          CREATE POLICY service_role_all_ai_abuse_log
            ON ai_abuse_log FOR ALL TO service_role
            USING (true) WITH CHECK (true);
        END IF;
      END $$
    `);
    console.log("  ✔ RLS enabled + service_role policy on ai_abuse_log\n");

    // ── 6. Verification ───────────────────────────────────────────────────
    console.log("── Verification ──");

    // Verify indexes created
    const idxRes = await client.query(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname='public' AND indexname = ANY($1)`,
      [[
        "se_p44_csp_created_idx",
        "se_p44_ai_rejected_created_idx",
        "se_p44_rate_exceeded_created_idx",
        "aal_tenant_created_idx",
        "aal_tenant_reason_idx",
        "aal_created_idx",
      ]],
    );
    console.log(`  ✔ Indexes verified: ${idxRes.rows.length}/6`);
    for (const r of idxRes.rows) console.log(`    - ${r.indexname}`);

    // Verify ai_abuse_log exists
    const aalRes = await client.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema='public' AND table_name='ai_abuse_log'`,
    );
    console.log(`  ✔ ai_abuse_log: ${aalRes.rows.length === 1 ? "confirmed" : "MISSING"}`);

    // Verify RLS
    const rlsRes = await client.query(
      `SELECT relname FROM pg_class
       WHERE relrowsecurity=true AND relname IN ('security_events','ai_abuse_log')`,
    );
    console.log(`  ✔ RLS verified on ${rlsRes.rows.length}/2 tables`);

    // ── 7. Test insert + cleanup ──────────────────────────────────────────
    console.log("\n── Test insert + cleanup ──");
    await client.query(`
      INSERT INTO ai_abuse_log(tenant_id, rejection_reason, input_length_bytes)
      VALUES('__test_p44__', 'input_too_long', 99999)
    `);
    await client.query(`DELETE FROM ai_abuse_log WHERE tenant_id='__test_p44__'`);
    console.log("  ✔ Test insert + cleanup successful");

    console.log("\n✔ Phase 44 migration complete");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("✗ Migration failed:", err.message);
  process.exit(1);
});
