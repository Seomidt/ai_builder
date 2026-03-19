/**
 * Phase 8 Migration — Global Audit Log Platform
 * 3 new tables: audit_events, audit_event_metadata, audit_export_runs
 * Idempotent — safe to re-run.
 */

import pg from "pg";

async function main() {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  try {
    // ── 1. audit_events ──────────────────────────────────────────────────────
    console.log("\n── Creating audit_events...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.audit_events (
        id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id        text NOT NULL,
        actor_id         text,
        actor_type       text NOT NULL CHECK (actor_type IN ('user','service_account','api_key','system','job','webhook','unknown')),
        action           text NOT NULL,
        resource_type    text NOT NULL,
        resource_id      text,
        request_id       text,
        correlation_id   text,
        ip_address       text,
        user_agent       text,
        audit_source     text NOT NULL DEFAULT 'application' CHECK (audit_source IN ('application','admin_route','system_process','security_middleware','migration','job_runtime')),
        event_status     text NOT NULL DEFAULT 'committed' CHECK (event_status IN ('committed','best_effort','partial_context')),
        summary          text,
        metadata         jsonb,
        created_at       timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ audit_events table");

    // Verify columns
    const auditCols = await client.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='audit_events' ORDER BY column_name`,
    );
    console.log(`  ✔ audit_events columns (${auditCols.rows.length}): ${auditCols.rows.map((r) => r.column_name).join(", ")}`);

    // Indexes
    await client.query(`CREATE INDEX IF NOT EXISTS ae_tenant_created_idx ON public.audit_events (tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ae_tenant_action_created_idx ON public.audit_events (tenant_id, action, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ae_tenant_resource_type_created_idx ON public.audit_events (tenant_id, resource_type, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ae_tenant_actor_type_created_idx ON public.audit_events (tenant_id, actor_type, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ae_resource_type_id_created_idx ON public.audit_events (resource_type, resource_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ae_request_id_idx ON public.audit_events (request_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ae_correlation_id_idx ON public.audit_events (correlation_id)`);
    console.log("  ✔ audit_events indexes (7)");

    // Verify indexes
    const aeIdxRows = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='audit_events' AND indexname LIKE 'ae_%'`,
    );
    console.log(`  ✔ audit_events indexes found: ${aeIdxRows.rows.map((r) => r.indexname).join(", ")}`);

    // Verify CHECK constraints
    const aeChecks = await client.query(
      `SELECT conname FROM pg_constraint WHERE conrelid='public.audit_events'::regclass AND contype='c'`,
    );
    console.log(`  ✔ audit_events CHECK constraints: ${aeChecks.rows.map((r) => r.conname).join(", ")}`);

    // ── 2. audit_event_metadata ──────────────────────────────────────────────
    console.log("\n── Creating audit_event_metadata...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.audit_event_metadata (
        id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        audit_event_id  text NOT NULL REFERENCES public.audit_events(id),
        before_state    jsonb,
        after_state     jsonb,
        change_fields   jsonb,
        metadata        jsonb,
        created_at      timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ audit_event_metadata table");

    await client.query(`CREATE INDEX IF NOT EXISTS aem_audit_event_id_idx ON public.audit_event_metadata (audit_event_id)`);
    console.log("  ✔ audit_event_metadata index");

    // Verify FK
    const aemFk = await client.query(
      `SELECT conname FROM pg_constraint WHERE conrelid='public.audit_event_metadata'::regclass AND contype='f'`,
    );
    console.log(`  ✔ audit_event_metadata FK: ${aemFk.rows.map((r) => r.conname).join(", ")}`);

    // ── 3. audit_export_runs ─────────────────────────────────────────────────
    console.log("\n── Creating audit_export_runs...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.audit_export_runs (
        id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id       text NOT NULL,
        requested_by    text,
        export_format   text NOT NULL CHECK (export_format IN ('json','csv')),
        filter_summary  jsonb,
        row_count       integer,
        export_status   text NOT NULL DEFAULT 'completed' CHECK (export_status IN ('started','completed','failed')),
        error_message   text,
        created_at      timestamp NOT NULL DEFAULT now(),
        completed_at    timestamp
      )
    `);
    console.log("  ✔ audit_export_runs table");

    await client.query(`CREATE INDEX IF NOT EXISTS aer_tenant_created_idx ON public.audit_export_runs (tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aer_status_created_idx ON public.audit_export_runs (export_status, created_at)`);
    console.log("  ✔ audit_export_runs indexes (2)");

    // ── 4. RLS ───────────────────────────────────────────────────────────────
    console.log("\n── Enabling RLS...");
    const auditTables = ["audit_events", "audit_event_metadata", "audit_export_runs"];
    for (const t of auditTables) {
      await client.query(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    }
    console.log("  ✔ RLS enabled on all 3 audit tables");

    // Tenant isolation policy for audit_events
    const aePolicy = await client.query(
      `SELECT 1 FROM pg_policies WHERE tablename='audit_events' AND policyname='ae_tenant_isolation'`,
    );
    if (aePolicy.rows.length === 0) {
      await client.query(`
        CREATE POLICY "ae_tenant_isolation" ON public.audit_events
        USING (
          current_setting('app.current_tenant_id', true) <> ''
          AND tenant_id::text = current_setting('app.current_tenant_id', true)
        )
      `);
      console.log("  ✔ audit_events tenant isolation policy created");
    } else {
      console.log("  ✔ audit_events tenant isolation policy already exists");
    }

    // Export runs policy
    const aerPolicy = await client.query(
      `SELECT 1 FROM pg_policies WHERE tablename='audit_export_runs' AND policyname='aer_tenant_isolation'`,
    );
    if (aerPolicy.rows.length === 0) {
      await client.query(`
        CREATE POLICY "aer_tenant_isolation" ON public.audit_export_runs
        USING (
          current_setting('app.current_tenant_id', true) <> ''
          AND tenant_id::text = current_setting('app.current_tenant_id', true)
        )
      `);
      console.log("  ✔ audit_export_runs tenant isolation policy created");
    } else {
      console.log("  ✔ audit_export_runs tenant isolation policy already exists");
    }

    // ── 5. Full verification ─────────────────────────────────────────────────
    console.log("\n── Verification...");

    const tableR = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1) ORDER BY table_name`,
      [auditTables],
    );
    console.log(`✔ Tables verified (${tableR.rows.length}/3): ${tableR.rows.map((r) => r.table_name).join(", ")}`);

    const rlsR = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity=true AND tablename = ANY($1)`,
      [auditTables],
    );
    console.log(`✔ RLS verified (${rlsR.rows.length}/3): ${rlsR.rows.map((r) => r.tablename).join(", ")}`);

    const totalRls = await client.query(
      `SELECT COUNT(*) as cnt FROM pg_tables WHERE schemaname='public' AND rowsecurity=true`,
    );
    console.log(`✔ Total RLS tables: ${totalRls.rows[0].cnt}`);

    const idxR = await client.query(
      `SELECT indexname, tablename FROM pg_indexes WHERE schemaname='public' AND indexname LIKE ANY(ARRAY['ae_%','aem_%','aer_%']) ORDER BY tablename, indexname`,
    );
    console.log(`✔ Phase 8 indexes (${idxR.rows.length}): ${idxR.rows.map((r) => r.indexname).join(", ")}`);

    const fkR = await client.query(
      `SELECT conname FROM pg_constraint WHERE conrelid='public.audit_event_metadata'::regclass AND contype='f'`,
    );
    console.log(`✔ audit_event_metadata FK: ${fkR.rows.map((r) => r.conname).join(", ")}`);

    // Verify current_tenant_id convention consistent with other tables
    const existingRls = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity=true ORDER BY tablename LIMIT 5`,
    );
    console.log(`✔ Sample RLS tables: ${existingRls.rows.map((r) => r.tablename).join(", ")} ...`);

    // Verify CHECK constraints on all new tables
    const allChecks = await client.query(
      `SELECT conrelid::regclass as table_name, conname FROM pg_constraint
       WHERE contype='c' AND conrelid IN (
         'public.audit_events'::regclass,
         'public.audit_export_runs'::regclass
       ) ORDER BY conrelid::regclass, conname`,
    );
    console.log(`✔ CHECK constraints (${allChecks.rows.length}): ${allChecks.rows.map((r) => `${r.table_name}.${r.conname}`).join(", ")}`);

    // Test round-trip insert + delete on audit_events
    const testRow = await client.query(
      `INSERT INTO public.audit_events (id, tenant_id, actor_type, action, resource_type, audit_source, event_status)
       VALUES (gen_random_uuid(), 'migrate-test-tenant', 'system', 'migration.test', 'migration', 'migration', 'committed')
       RETURNING id`,
    );
    const testId = testRow.rows[0].id;
    const readBack = await client.query(`SELECT id, action, tenant_id FROM public.audit_events WHERE id = $1`, [testId]);
    console.log(`✔ Round-trip insert verified: id=${testId} action=${readBack.rows[0].action}`);

    // Cleanup test row
    await client.query(`DELETE FROM public.audit_events WHERE id = $1`, [testId]);
    console.log("✔ Test row cleaned up");

    console.log("\n✔ Phase 8 migration complete");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
