/**
 * Phase 46 — Supabase migration: tenant_files table
 *
 * Creates the canonical file metadata table with:
 *   - tenant isolation (organization_id NOT NULL)
 *   - enum constraints (visibility, upload_status, scan_status)
 *   - composite indexes for tenant-heavy query paths
 *   - unique constraint on object_key
 *   - RLS: service_role only (tenant-facing access via application layer)
 *
 * Run: npx tsx server/lib/storage/migrate-phase46.ts
 */

import pg from "pg";

const POOL_URL = process.env.SUPABASE_DB_POOL_URL;
if (!POOL_URL) throw new Error("SUPABASE_DB_POOL_URL is required");

async function migrate(): Promise<void> {
  const client = new pg.Client({ connectionString: POOL_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();

  try {
    console.log("\n── Phase 46: tenant_files migration ──────────────────────────────────\n");

    // ── 1. Create table ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS tenant_files (
        id                    text        NOT NULL DEFAULT gen_random_uuid()::text,
        organization_id       text        NOT NULL,
        client_id             text,
        owner_user_id         text,
        bucket                text        NOT NULL,
        object_key            text        NOT NULL,
        original_filename     text        NOT NULL,
        mime_type             text        NOT NULL,
        size_bytes            bigint      NOT NULL,
        checksum_sha256       text        NOT NULL,
        category              text        NOT NULL,
        visibility            text        NOT NULL DEFAULT 'private',
        upload_status         text        NOT NULL DEFAULT 'pending',
        scan_status           text        NOT NULL DEFAULT 'not_scanned',
        created_at            timestamptz NOT NULL DEFAULT now(),
        uploaded_at           timestamptz,
        deleted_at            timestamptz,
        delete_scheduled_at   timestamptz,
        metadata              jsonb       NOT NULL DEFAULT '{}'::jsonb,
        CONSTRAINT tenant_files_pkey             PRIMARY KEY (id),
        CONSTRAINT tenant_files_object_key_uniq  UNIQUE (object_key)
      )
    `);
    console.log("  ✔ tenant_files table created");

    // ── 2. Add enum constraints (safe to re-run) ─────────────────────────────
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'tf_visibility_check' AND conrelid = 'tenant_files'::regclass
        ) THEN
          ALTER TABLE tenant_files
          ADD CONSTRAINT tf_visibility_check
          CHECK (visibility IN ('private','tenant_internal'));
        END IF;
      END $$
    `);
    console.log("  ✔ visibility CHECK constraint");

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'tf_upload_status_check' AND conrelid = 'tenant_files'::regclass
        ) THEN
          ALTER TABLE tenant_files
          ADD CONSTRAINT tf_upload_status_check
          CHECK (upload_status IN ('pending','uploaded','failed','deleted'));
        END IF;
      END $$
    `);
    console.log("  ✔ upload_status CHECK constraint");

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'tf_scan_status_check' AND conrelid = 'tenant_files'::regclass
        ) THEN
          ALTER TABLE tenant_files
          ADD CONSTRAINT tf_scan_status_check
          CHECK (scan_status IN ('not_scanned','pending_scan','clean','rejected'));
        END IF;
      END $$
    `);
    console.log("  ✔ scan_status CHECK constraint");

    // ── 3. Indexes ───────────────────────────────────────────────────────────
    const indexes = [
      {
        name: "tf_org_idx",
        sql: `CREATE INDEX IF NOT EXISTS tf_org_idx ON tenant_files (organization_id)`,
      },
      {
        name: "tf_org_created_idx",
        sql: `CREATE INDEX IF NOT EXISTS tf_org_created_idx ON tenant_files (organization_id, created_at DESC)`,
      },
      {
        name: "tf_org_category_created_idx",
        sql: `CREATE INDEX IF NOT EXISTS tf_org_category_created_idx ON tenant_files (organization_id, category, created_at DESC)`,
      },
      {
        name: "tf_org_client_created_idx",
        sql: `CREATE INDEX IF NOT EXISTS tf_org_client_created_idx ON tenant_files (organization_id, client_id, created_at DESC) WHERE client_id IS NOT NULL`,
      },
      {
        name: "tf_upload_status_idx",
        sql: `CREATE INDEX IF NOT EXISTS tf_upload_status_idx ON tenant_files (organization_id, upload_status)`,
      },
      {
        name: "tf_scan_status_pending_idx",
        sql: `CREATE INDEX IF NOT EXISTS tf_scan_status_pending_idx ON tenant_files (scan_status) WHERE scan_status = 'pending_scan'`,
      },
      {
        name: "tf_delete_scheduled_idx",
        sql: `CREATE INDEX IF NOT EXISTS tf_delete_scheduled_idx ON tenant_files (delete_scheduled_at) WHERE delete_scheduled_at IS NOT NULL AND deleted_at IS NOT NULL`,
      },
      {
        name: "tf_active_rows_idx",
        sql: `CREATE INDEX IF NOT EXISTS tf_active_rows_idx ON tenant_files (organization_id, upload_status) WHERE deleted_at IS NULL`,
      },
    ];

    for (const idx of indexes) {
      await client.query(idx.sql);
      console.log(`  ✔ ${idx.name}`);
    }

    // ── 4. RLS ───────────────────────────────────────────────────────────────
    await client.query(`ALTER TABLE tenant_files ENABLE ROW LEVEL SECURITY`);
    console.log("  ✔ RLS enabled");

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_policies
          WHERE tablename = 'tenant_files' AND policyname = 'tf_service_role_all'
        ) THEN
          CREATE POLICY tf_service_role_all
            ON tenant_files FOR ALL TO service_role
            USING (true) WITH CHECK (true);
        END IF;
      END $$
    `);
    console.log("  ✔ service_role policy (all operations)");

    // Note: No authenticated user policy — tenant access is mediated through
    // the application layer which verifies organization_id ownership.
    // Tenant users never query tenant_files directly via Supabase client.

    // ── 5. Verify ────────────────────────────────────────────────────────────
    const check = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM information_schema.columns
         WHERE table_name = 'tenant_files' AND table_schema = 'public') AS col_count,
        (SELECT COUNT(*) FROM information_schema.table_constraints
         WHERE table_name = 'tenant_files' AND constraint_type = 'CHECK') AS check_count,
        (SELECT COUNT(*) FROM pg_indexes WHERE tablename = 'tenant_files') AS idx_count,
        (SELECT rowsecurity FROM pg_tables WHERE tablename = 'tenant_files') AS rls_enabled
    `);

    const r = check.rows[0];
    console.log(`\n  Verification:`);
    console.log(`    Columns:     ${r.col_count}`);
    console.log(`    CHECK constr: ${r.check_count}`);
    console.log(`    Indexes:     ${r.idx_count}`);
    console.log(`    RLS enabled: ${r.rls_enabled}`);

    console.log("\n  ✔ Phase 46 migration complete\n");
  } finally {
    await client.end();
  }
}

migrate().catch(err => {
  console.error("[Phase46Migration] FAILED:", err.message);
  process.exit(1);
});
