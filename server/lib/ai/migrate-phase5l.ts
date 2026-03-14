/**
 * migrate-phase5l.ts — Phase 5L DB Migration
 *
 * Applies:
 * 1. Three new columns on knowledge_asset_versions:
 *    - embedding_status text CHECK (... | NULL)
 *    - index_lifecycle_state text CHECK (... | NULL)
 *    - index_lifecycle_updated_at timestamp
 * 2. New table: knowledge_asset_embeddings (multimodal asset-level embeddings)
 * 3. RLS + 4 tenant policies on knowledge_asset_embeddings
 * 4. Performance indexes on knowledge_asset_embeddings + knowledge_asset_versions
 *
 * Uses single pg.Client (NOT pool) to avoid deadlocks.
 * Idempotent: all DDL wrapped in IF NOT EXISTS / DO blocks.
 */

import pg from "pg";

async function main() {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("Phase 5L migration: connected");

  try {
    // ── 1. Add columns to knowledge_asset_versions ────────────────────────────
    console.log("Step 1: Adding lifecycle columns to knowledge_asset_versions...");

    await client.query(`
      DO $$ BEGIN
        ALTER TABLE knowledge_asset_versions
          ADD COLUMN IF NOT EXISTS embedding_status text,
          ADD COLUMN IF NOT EXISTS index_lifecycle_state text,
          ADD COLUMN IF NOT EXISTS index_lifecycle_updated_at timestamp;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);

    // Add CHECK constraints if not present
    await client.query(`
      DO $$ BEGIN
        ALTER TABLE knowledge_asset_versions
          ADD CONSTRAINT kav_embedding_status_check
          CHECK (embedding_status IS NULL OR embedding_status IN ('not_ready','pending','indexed','stale','failed'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    await client.query(`
      DO $$ BEGIN
        ALTER TABLE knowledge_asset_versions
          ADD CONSTRAINT kav_index_lifecycle_state_check
          CHECK (index_lifecycle_state IS NULL OR index_lifecycle_state IN ('not_ready','pending','indexed','stale','failed'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$;
    `);

    console.log("  knowledge_asset_versions: columns added");

    // ── 2. Create knowledge_asset_embeddings ──────────────────────────────────
    console.log("Step 2: Creating knowledge_asset_embeddings table...");

    await client.query(`
      CREATE TABLE IF NOT EXISTS knowledge_asset_embeddings (
        id                  varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id           text NOT NULL,
        asset_id            varchar NOT NULL REFERENCES knowledge_assets(id),
        asset_version_id    varchar NOT NULL REFERENCES knowledge_asset_versions(id),
        source_type         text NOT NULL,
        source_key          text NOT NULL,
        source_checksum     text,
        source_priority     integer NOT NULL DEFAULT 99,
        text_length         integer,
        embedding_provider  text NOT NULL,
        embedding_model     text NOT NULL,
        embedding_version   text,
        embedding_dimensions integer,
        embedding_vector    real[],
        embedding_status    text NOT NULL DEFAULT 'pending',
        indexed_at          timestamp,
        stale_reason        text,
        failure_reason      text,
        is_active           boolean NOT NULL DEFAULT true,
        metadata            jsonb,
        created_at          timestamp NOT NULL DEFAULT now(),
        updated_at          timestamp NOT NULL DEFAULT now(),
        CONSTRAINT kae_source_type_check CHECK (source_type IN ('parsed_text','ocr_text','transcript_text','caption_text','video_frame_text','imported_text')),
        CONSTRAINT kae_embedding_status_check CHECK (embedding_status IN ('pending','completed','failed','stale')),
        CONSTRAINT kae_source_priority_check CHECK (source_priority >= 1 AND source_priority <= 99)
      );
    `);
    console.log("  knowledge_asset_embeddings: table created");

    // ── 3. Indexes on knowledge_asset_embeddings ──────────────────────────────
    console.log("Step 3: Adding indexes...");

    const embIndexes = [
      "CREATE INDEX IF NOT EXISTS kae_tenant_version_idx ON knowledge_asset_embeddings(tenant_id, asset_version_id);",
      "CREATE INDEX IF NOT EXISTS kae_tenant_asset_idx ON knowledge_asset_embeddings(tenant_id, asset_id);",
      "CREATE INDEX IF NOT EXISTS kae_tenant_source_type_idx ON knowledge_asset_embeddings(tenant_id, source_type, embedding_status);",
      "CREATE INDEX IF NOT EXISTS kae_tenant_status_active_idx ON knowledge_asset_embeddings(tenant_id, embedding_status, is_active);",
      "CREATE INDEX IF NOT EXISTS kae_tenant_version_status_idx ON knowledge_asset_embeddings(tenant_id, asset_version_id, embedding_status);",
    ];
    for (const idx of embIndexes) {
      await client.query(idx);
    }

    const kavIndexes = [
      "CREATE INDEX IF NOT EXISTS kav_tenant_lifecycle_idx ON knowledge_asset_versions(tenant_id, index_lifecycle_state);",
      "CREATE INDEX IF NOT EXISTS kav_tenant_embedding_status_idx ON knowledge_asset_versions(tenant_id, embedding_status);",
    ];
    for (const idx of kavIndexes) {
      await client.query(idx);
    }
    console.log("  Indexes: created");

    // ── 4. Enable RLS on knowledge_asset_embeddings ───────────────────────────
    console.log("Step 4: Enabling RLS on knowledge_asset_embeddings...");

    await client.query(`ALTER TABLE knowledge_asset_embeddings ENABLE ROW LEVEL SECURITY;`);
    await client.query(`ALTER TABLE knowledge_asset_embeddings FORCE ROW LEVEL SECURITY;`);

    // 4 tenant-scoped policies (per Phase 5K.1 pattern)
    const rlsBase =
      `current_setting('app.current_tenant_id', true) <> '' ` +
      `AND tenant_id::text = current_setting('app.current_tenant_id', true)`;

    const policies = [
      {
        name: "rls_tenant_select_knowledge_asset_embeddings",
        cmd: "SELECT",
        using: rlsBase,
        withCheck: null,
      },
      {
        name: "rls_tenant_insert_knowledge_asset_embeddings",
        cmd: "INSERT",
        using: null,
        withCheck: rlsBase,
      },
      {
        name: "rls_tenant_update_knowledge_asset_embeddings",
        cmd: "UPDATE",
        using: rlsBase,
        withCheck: rlsBase,
      },
      {
        name: "rls_tenant_delete_knowledge_asset_embeddings",
        cmd: "DELETE",
        using: rlsBase,
        withCheck: null,
      },
    ];

    for (const policy of policies) {
      // Drop first for idempotency
      await client.query(
        `DROP POLICY IF EXISTS "${policy.name}" ON knowledge_asset_embeddings;`,
      );
      const usingClause = policy.using ? `USING (${policy.using})` : "";
      const withCheckClause = policy.withCheck ? `WITH CHECK (${policy.withCheck})` : "";
      await client.query(`
        CREATE POLICY "${policy.name}" ON knowledge_asset_embeddings
        FOR ${policy.cmd} ${usingClause} ${withCheckClause};
      `);
    }
    console.log("  RLS + 4 tenant policies: created");

    // ── 5. Verification ───────────────────────────────────────────────────────
    console.log("Step 5: Verifying migration...");

    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='knowledge_asset_versions'
        AND column_name IN ('embedding_status','index_lifecycle_state','index_lifecycle_updated_at')
      ORDER BY column_name;
    `);
    console.assert(colCheck.rows.length === 3, `FAIL: expected 3 new columns, found ${colCheck.rows.length}`);
    console.log(`  knowledge_asset_versions new columns: ${colCheck.rows.map((r: { column_name: string }) => r.column_name).join(", ")}`);

    const tableCheck = await client.query(`
      SELECT COUNT(*) as cnt FROM information_schema.tables
      WHERE table_schema='public' AND table_name='knowledge_asset_embeddings';
    `);
    console.assert(parseInt(tableCheck.rows[0].cnt) === 1, "FAIL: knowledge_asset_embeddings table not found");
    console.log("  knowledge_asset_embeddings table: present");

    const rlsCheck = await client.query(`
      SELECT relrowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname='public' AND c.relname='knowledge_asset_embeddings';
    `);
    console.assert(rlsCheck.rows[0]?.relrowsecurity === true, "FAIL: RLS not enabled");
    console.log("  RLS: enabled on knowledge_asset_embeddings");

    const polCheck = await client.query(`
      SELECT COUNT(*) as cnt FROM pg_policies
      WHERE schemaname='public' AND tablename='knowledge_asset_embeddings'
        AND policyname LIKE 'rls_tenant_%';
    `);
    console.assert(parseInt(polCheck.rows[0].cnt) === 4, `FAIL: expected 4 policies, found ${polCheck.rows[0].cnt}`);
    console.log(`  Tenant policies: ${polCheck.rows[0].cnt}/4 present`);

    // Verify total RLS table count is now 96
    const totalRls = await client.query(`
      SELECT COUNT(*) as cnt FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=true;
    `);
    console.log(`  Total tables with RLS: ${totalRls.rows[0].cnt} (expected: 96)`);
    console.assert(parseInt(totalRls.rows[0].cnt) === 96, `FAIL: expected 96 RLS tables`);

    // Verify total policy count is now 232
    const totalPolicies = await client.query(`
      SELECT COUNT(*) as cnt FROM pg_policies
      WHERE schemaname='public' AND policyname LIKE 'rls_tenant_%';
    `);
    console.log(`  Total tenant policies: ${totalPolicies.rows[0].cnt} (expected: 232)`);
    console.assert(parseInt(totalPolicies.rows[0].cnt) === 232, `FAIL: expected 232 tenant policies`);

    console.log("\nPhase 5L migration: COMPLETE");
  } finally {
    await client.end();
  }
}

main().then(() => process.exit(0)).catch((e: unknown) => {
  console.error("Migration failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
