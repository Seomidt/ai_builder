/**
 * Phase 9 Migration — Tenant Lifecycle Management
 * 6 new tables: tenants, tenant_settings, tenant_status_history,
 *               tenant_export_requests, tenant_deletion_requests, tenant_domains
 * Idempotent — safe to re-run.
 * INV-TEN7: Backward-compatible — does not drop or alter any existing table/column.
 * INV-TEN11: Does not change existing tenant_id semantics.
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
    // ── Inspect current state ────────────────────────────────────────────────
    const existing = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
      [["tenants","tenant_settings","tenant_status_history","tenant_export_requests","tenant_deletion_requests","tenant_domains"]],
    );
    console.log(`\nExisting Phase 9 tables: ${existing.rows.map((r) => r.table_name).join(", ") || "none"}`);

    // ── 1. tenants ───────────────────────────────────────────────────────────
    console.log("\n── Creating tenants...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.tenants (
        id                   text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_code          text,
        name                 text NOT NULL,
        lifecycle_status     text NOT NULL DEFAULT 'active'
                             CHECK (lifecycle_status IN ('trial','active','suspended','delinquent','offboarding','deleted')),
        tenant_type          text NOT NULL DEFAULT 'customer'
                             CHECK (tenant_type IN ('customer','internal','demo','test')),
        primary_owner_user_id text,
        billing_email        text,
        default_region       text,
        suspended_at         timestamp,
        offboarding_started_at timestamp,
        deleted_at           timestamp,
        metadata             jsonb,
        created_at           timestamp NOT NULL DEFAULT now(),
        updated_at           timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ tenants table");

    // Unique index on tenant_code (partial — only non-null)
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS tenants_tenant_code_unique ON public.tenants (tenant_code) WHERE tenant_code IS NOT NULL`);
    await client.query(`CREATE INDEX IF NOT EXISTS tenants_lifecycle_status_created_idx ON public.tenants (lifecycle_status, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS tenants_tenant_type_created_idx ON public.tenants (tenant_type, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS tenants_primary_owner_user_id_idx ON public.tenants (primary_owner_user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS tenants_created_at_idx ON public.tenants (created_at)`);
    console.log("  ✔ tenants indexes (5)");

    // Verify
    const tenantCols = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='tenants' ORDER BY column_name`);
    console.log(`  ✔ tenants columns (${tenantCols.rows.length}): ${tenantCols.rows.map((r) => r.column_name).join(", ")}`);

    const tenantChecks = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.tenants'::regclass AND contype='c'`);
    console.log(`  ✔ tenants CHECK constraints: ${tenantChecks.rows.map((r) => r.conname).join(", ")}`);

    // ── 2. tenant_settings ───────────────────────────────────────────────────
    console.log("\n── Creating tenant_settings...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.tenant_settings (
        id                    text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id             text NOT NULL REFERENCES public.tenants(id),
        allow_login           boolean NOT NULL DEFAULT true,
        allow_api_access      boolean NOT NULL DEFAULT true,
        allow_ai_runtime      boolean NOT NULL DEFAULT true,
        allow_knowledge_access boolean NOT NULL DEFAULT true,
        allow_billing_access  boolean NOT NULL DEFAULT true,
        tenant_timezone       text,
        locale                text,
        settings_status       text NOT NULL DEFAULT 'active'
                              CHECK (settings_status IN ('active','archived')),
        metadata              jsonb,
        created_at            timestamp NOT NULL DEFAULT now(),
        updated_at            timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ tenant_settings table");

    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS tenant_settings_tenant_id_unique ON public.tenant_settings (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS tenant_settings_tenant_id_idx ON public.tenant_settings (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS tenant_settings_status_created_idx ON public.tenant_settings (settings_status, created_at)`);
    console.log("  ✔ tenant_settings indexes (3)");

    const tsChecks = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.tenant_settings'::regclass AND contype='c'`);
    console.log(`  ✔ tenant_settings CHECK: ${tsChecks.rows.map((r) => r.conname).join(", ")}`);
    const tsFk = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.tenant_settings'::regclass AND contype='f'`);
    console.log(`  ✔ tenant_settings FK: ${tsFk.rows.map((r) => r.conname).join(", ")}`);

    // ── 3. tenant_status_history ─────────────────────────────────────────────
    console.log("\n── Creating tenant_status_history...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.tenant_status_history (
        id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id       text NOT NULL REFERENCES public.tenants(id),
        previous_status text,
        new_status      text NOT NULL
                        CHECK (new_status IN ('trial','active','suspended','delinquent','offboarding','deleted')),
        changed_by      text,
        change_reason   text,
        metadata        jsonb,
        created_at      timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ tenant_status_history table");

    await client.query(`CREATE INDEX IF NOT EXISTS tenant_status_history_tenant_created_idx ON public.tenant_status_history (tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS tenant_status_history_new_status_created_idx ON public.tenant_status_history (new_status, created_at)`);
    console.log("  ✔ tenant_status_history indexes (2)");

    // ── 4. tenant_export_requests ────────────────────────────────────────────
    console.log("\n── Creating tenant_export_requests...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.tenant_export_requests (
        id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id       text NOT NULL REFERENCES public.tenants(id),
        requested_by    text,
        export_status   text NOT NULL DEFAULT 'requested'
                        CHECK (export_status IN ('requested','running','completed','failed','cancelled')),
        export_scope    text NOT NULL DEFAULT 'full'
                        CHECK (export_scope IN ('full','metadata_only','audit_only')),
        filter_summary  jsonb,
        result_summary  jsonb,
        error_message   text,
        created_at      timestamp NOT NULL DEFAULT now(),
        started_at      timestamp,
        completed_at    timestamp
      )
    `);
    console.log("  ✔ tenant_export_requests table");

    await client.query(`CREATE INDEX IF NOT EXISTS tenant_export_requests_tenant_created_idx ON public.tenant_export_requests (tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS tenant_export_requests_status_created_idx ON public.tenant_export_requests (export_status, created_at)`);
    console.log("  ✔ tenant_export_requests indexes (2)");

    // ── 5. tenant_deletion_requests ──────────────────────────────────────────
    console.log("\n── Creating tenant_deletion_requests...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.tenant_deletion_requests (
        id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id        text NOT NULL REFERENCES public.tenants(id),
        requested_by     text,
        deletion_status  text NOT NULL DEFAULT 'requested'
                         CHECK (deletion_status IN ('requested','approved','blocked','running','completed','cancelled','failed')),
        retention_until  timestamp,
        block_reason     text,
        result_summary   jsonb,
        error_message    text,
        created_at       timestamp NOT NULL DEFAULT now(),
        approved_at      timestamp,
        started_at       timestamp,
        completed_at     timestamp
      )
    `);
    console.log("  ✔ tenant_deletion_requests table");

    await client.query(`CREATE INDEX IF NOT EXISTS tenant_deletion_requests_tenant_created_idx ON public.tenant_deletion_requests (tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS tenant_deletion_requests_status_created_idx ON public.tenant_deletion_requests (deletion_status, created_at)`);
    console.log("  ✔ tenant_deletion_requests indexes (2)");

    // ── 6. tenant_domains ────────────────────────────────────────────────────
    console.log("\n── Creating tenant_domains...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.tenant_domains (
        id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id       text NOT NULL REFERENCES public.tenants(id),
        domain          text NOT NULL,
        domain_status   text NOT NULL DEFAULT 'pending'
                        CHECK (domain_status IN ('pending','verified','disabled')),
        verified_at     timestamp,
        metadata        jsonb,
        created_at      timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ tenant_domains table");

    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS tenant_domains_domain_unique ON public.tenant_domains (domain)`);
    await client.query(`CREATE INDEX IF NOT EXISTS tenant_domains_tenant_created_idx ON public.tenant_domains (tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS tenant_domains_status_created_idx ON public.tenant_domains (domain_status, created_at)`);
    console.log("  ✔ tenant_domains indexes (3)");

    // ── 7. RLS ───────────────────────────────────────────────────────────────
    console.log("\n── Enabling RLS...");
    const tenantTables = ["tenants","tenant_settings","tenant_status_history","tenant_export_requests","tenant_deletion_requests","tenant_domains"];
    for (const t of tenantTables) {
      await client.query(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    }
    console.log(`  ✔ RLS enabled on all 6 Phase 9 tables`);

    // Tenant isolation policies for tables with tenant_id column
    const tenantScopedTables = ["tenant_settings","tenant_status_history","tenant_export_requests","tenant_deletion_requests","tenant_domains"];
    for (const t of tenantScopedTables) {
      const policyName = `${t.replace(/_/g, "")}_tenant_isolation`;
      const existing = await client.query(`SELECT 1 FROM pg_policies WHERE tablename=$1 AND policyname=$2`, [t, policyName]);
      if (existing.rows.length === 0) {
        await client.query(`
          CREATE POLICY "${policyName}" ON public.${t}
          USING (
            current_setting('app.current_tenant_id', true) <> ''
            AND tenant_id::text = current_setting('app.current_tenant_id', true)
          )
        `);
        console.log(`  ✔ ${t} tenant isolation policy created`);
      } else {
        console.log(`  ✔ ${t} policy already exists`);
      }
    }

    // Tenants table: admin-only (no tenant_id column in tenants itself — id IS the tenant_id)
    const tenantsPolicy = await client.query(`SELECT 1 FROM pg_policies WHERE tablename='tenants' AND policyname='tenants_self_access'`);
    if (tenantsPolicy.rows.length === 0) {
      await client.query(`
        CREATE POLICY "tenants_self_access" ON public.tenants
        USING (
          current_setting('app.current_tenant_id', true) <> ''
          AND id::text = current_setting('app.current_tenant_id', true)
        )
      `);
      console.log("  ✔ tenants self-access policy created");
    } else {
      console.log("  ✔ tenants self-access policy already exists");
    }

    // ── 8. Full verification ─────────────────────────────────────────────────
    console.log("\n── Verification...");

    const tableR = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1) ORDER BY table_name`,
      [tenantTables],
    );
    console.log(`✔ Tables verified (${tableR.rows.length}/6): ${tableR.rows.map((r) => r.table_name).join(", ")}`);

    const rlsR = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity=true AND tablename = ANY($1)`,
      [tenantTables],
    );
    console.log(`✔ RLS verified (${rlsR.rows.length}/6): ${rlsR.rows.map((r) => r.tablename).join(", ")}`);

    const totalRls = await client.query(`SELECT COUNT(*) as cnt FROM pg_tables WHERE schemaname='public' AND rowsecurity=true`);
    console.log(`✔ Total RLS tables: ${totalRls.rows[0].cnt}`);

    const idxR = await client.query(
      `SELECT indexname, tablename FROM pg_indexes WHERE schemaname='public' AND tablename = ANY($1) ORDER BY tablename, indexname`,
      [tenantTables],
    );
    console.log(`✔ Phase 9 indexes (${idxR.rows.length}): ${idxR.rows.map((r) => r.indexname).join(", ")}`);

    const fkR = await client.query(
      `SELECT c.conname, c.conrelid::regclass as table_name FROM pg_constraint c
       WHERE c.contype = 'f' AND c.conrelid::regclass::text IN ('public.tenant_settings','public.tenant_status_history','public.tenant_export_requests','public.tenant_deletion_requests','public.tenant_domains')`,
    );
    console.log(`✔ FKs (${fkR.rows.length}): ${fkR.rows.map((r) => `${r.table_name}.${r.conname}`).join(", ")}`);

    const ckR = await client.query(
      `SELECT conrelid::regclass as table_name, conname FROM pg_constraint
       WHERE contype='c' AND conrelid::regclass::text IN ('public.tenants','public.tenant_settings','public.tenant_status_history','public.tenant_export_requests','public.tenant_deletion_requests','public.tenant_domains')
       ORDER BY conrelid::regclass, conname`,
    );
    console.log(`✔ CHECK constraints (${ckR.rows.length}): ${ckR.rows.map((r) => `${r.table_name}.${r.conname}`).join(", ")}`);

    // Round-trip test
    const testTenantId = `migrate-test-p9-${Date.now()}`;
    await client.query(
      `INSERT INTO public.tenants (id, name, lifecycle_status, tenant_type) VALUES ($1, 'Migration Test', 'active', 'test')`,
      [testTenantId],
    );
    await client.query(
      `INSERT INTO public.tenant_settings (id, tenant_id) VALUES (gen_random_uuid()::text, $1)`,
      [testTenantId],
    );
    const readBack = await client.query(`SELECT t.id, t.name, ts.allow_login FROM public.tenants t JOIN public.tenant_settings ts ON ts.tenant_id = t.id WHERE t.id = $1`, [testTenantId]);
    console.log(`✔ Round-trip verified: id=${testTenantId} name=${readBack.rows[0].name} allow_login=${readBack.rows[0].allow_login}`);

    // Cleanup
    await client.query(`DELETE FROM public.tenant_settings WHERE tenant_id = $1`, [testTenantId]);
    await client.query(`DELETE FROM public.tenant_status_history WHERE tenant_id = $1`, [testTenantId]);
    await client.query(`DELETE FROM public.tenants WHERE id = $1`, [testTenantId]);
    console.log("✔ Test rows cleaned up");

    // Verify existing tables still accessible (INV-TEN12)
    const legacyR = await client.query(`SELECT COUNT(*) as cnt FROM public.tenant_memberships`);
    console.log(`✔ INV-TEN12: tenant_memberships still accessible (${legacyR.rows[0].cnt} rows)`);

    console.log("\n✔ Phase 9 migration complete");
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("Migration failed:", e.message); process.exit(1); });
