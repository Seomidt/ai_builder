/**
 * migrate-phase5m.ts — Phase 5M DB Migration
 *
 * Applies:
 * 1. New table: knowledge_retrieval_candidates (retrieval explainability)
 * 2. RLS + 4 tenant policies on knowledge_retrieval_candidates
 * 3. Performance indexes (5 indexes)
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
  console.log("Phase 5M migration: connected");

  try {
    // ── 1. Create knowledge_retrieval_candidates ───────────────────────────────
    console.log("Step 1: Creating knowledge_retrieval_candidates table...");

    await client.query(`
      CREATE TABLE IF NOT EXISTS knowledge_retrieval_candidates (
        id                          varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id                   text NOT NULL,
        retrieval_run_id            varchar NOT NULL REFERENCES knowledge_retrieval_runs(id),
        chunk_id                    varchar REFERENCES knowledge_chunks(id),
        knowledge_asset_embedding_id varchar REFERENCES knowledge_asset_embeddings(id),
        knowledge_asset_id          varchar REFERENCES knowledge_assets(id),
        knowledge_asset_version_id  varchar REFERENCES knowledge_asset_versions(id),
        source_type                 text,
        source_key                  text,
        similarity_score            numeric(10,8),
        ranking_score               numeric(10,8),
        filter_status               text NOT NULL DEFAULT 'candidate',
        exclusion_reason            text,
        inclusion_reason            text,
        dedup_reason                text,
        candidate_rank              integer,
        final_rank                  integer,
        token_count_estimate        integer,
        created_at                  timestamp NOT NULL DEFAULT now(),
        CONSTRAINT krc_filter_status_check CHECK (filter_status IN ('candidate','excluded','selected')),
        CONSTRAINT krc_similarity_check CHECK (similarity_score IS NULL OR (similarity_score >= 0 AND similarity_score <= 1)),
        CONSTRAINT krc_token_count_check CHECK (token_count_estimate IS NULL OR token_count_estimate >= 0)
      );
    `);
    console.log("  knowledge_retrieval_candidates: table created");

    // ── 2. Indexes ─────────────────────────────────────────────────────────────
    console.log("Step 2: Adding indexes...");

    const indexes = [
      "CREATE INDEX IF NOT EXISTS krc_tenant_run_idx ON knowledge_retrieval_candidates(tenant_id, retrieval_run_id);",
      "CREATE INDEX IF NOT EXISTS krc_tenant_chunk_idx ON knowledge_retrieval_candidates(tenant_id, chunk_id);",
      "CREATE INDEX IF NOT EXISTS krc_tenant_version_idx ON knowledge_retrieval_candidates(tenant_id, knowledge_asset_version_id);",
      "CREATE INDEX IF NOT EXISTS krc_tenant_status_idx ON knowledge_retrieval_candidates(tenant_id, filter_status);",
      "CREATE INDEX IF NOT EXISTS krc_tenant_source_type_idx ON knowledge_retrieval_candidates(tenant_id, source_type);",
    ];
    for (const idx of indexes) {
      await client.query(idx);
    }
    console.log("  Indexes: 5 created");

    // ── 3. Enable RLS ──────────────────────────────────────────────────────────
    console.log("Step 3: Enabling RLS on knowledge_retrieval_candidates...");

    await client.query(`ALTER TABLE knowledge_retrieval_candidates ENABLE ROW LEVEL SECURITY;`);
    await client.query(`ALTER TABLE knowledge_retrieval_candidates FORCE ROW LEVEL SECURITY;`);

    const rlsBase =
      `current_setting('app.current_tenant_id', true) <> '' ` +
      `AND tenant_id::text = current_setting('app.current_tenant_id', true)`;

    const policies = [
      { name: "rls_tenant_select_knowledge_retrieval_candidates", cmd: "SELECT", using: rlsBase, withCheck: null },
      { name: "rls_tenant_insert_knowledge_retrieval_candidates", cmd: "INSERT", using: null, withCheck: rlsBase },
      { name: "rls_tenant_update_knowledge_retrieval_candidates", cmd: "UPDATE", using: rlsBase, withCheck: rlsBase },
      { name: "rls_tenant_delete_knowledge_retrieval_candidates", cmd: "DELETE", using: rlsBase, withCheck: null },
    ];

    for (const p of policies) {
      await client.query(`DROP POLICY IF EXISTS "${p.name}" ON knowledge_retrieval_candidates;`);
      const usingClause = p.using ? `USING (${p.using})` : "";
      const withCheckClause = p.withCheck ? `WITH CHECK (${p.withCheck})` : "";
      await client.query(
        `CREATE POLICY "${p.name}" ON knowledge_retrieval_candidates FOR ${p.cmd} ${usingClause} ${withCheckClause};`,
      );
    }
    console.log("  RLS + 4 tenant policies: created");

    // ── 4. Verification ────────────────────────────────────────────────────────
    console.log("Step 4: Verifying migration...");

    const tableCheck = await client.query(`
      SELECT COUNT(*) as cnt FROM information_schema.tables
      WHERE table_schema='public' AND table_name='knowledge_retrieval_candidates';
    `);
    console.assert(parseInt(tableCheck.rows[0].cnt) === 1, "FAIL: table not created");
    console.log("  Table: present");

    const colCheck = await client.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='knowledge_retrieval_candidates'
      ORDER BY ordinal_position;
    `);
    console.log(`  Columns: ${colCheck.rows.length} (expected: 19)`);
    console.assert(colCheck.rows.length === 19, `FAIL: expected 19 columns, found ${colCheck.rows.length}`);

    const rlsCheck = await client.query(`
      SELECT relrowsecurity, relforcerowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname='knowledge_retrieval_candidates';
    `);
    console.assert(rlsCheck.rows[0].relrowsecurity === true, "FAIL: RLS not enabled");
    console.assert(rlsCheck.rows[0].relforcerowsecurity === true, "FAIL: RLS not forced");
    console.log("  RLS: enabled and forced");

    const polCheck = await client.query(`
      SELECT COUNT(*) as cnt FROM pg_policies
      WHERE schemaname='public' AND tablename='knowledge_retrieval_candidates'
        AND policyname LIKE 'rls_tenant_%';
    `);
    console.assert(parseInt(polCheck.rows[0].cnt) === 4, `FAIL: expected 4 policies`);
    console.log(`  Policies: ${polCheck.rows[0].cnt}/4`);

    const totalRls = await client.query(`
      SELECT COUNT(*) as cnt FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=true;
    `);
    console.log(`  Total RLS tables: ${totalRls.rows[0].cnt} (expected: 97)`);
    console.assert(parseInt(totalRls.rows[0].cnt) === 97, `FAIL: expected 97 RLS tables`);

    const totalPolicies = await client.query(`
      SELECT COUNT(*) as cnt FROM pg_policies
      WHERE schemaname='public' AND policyname LIKE 'rls_tenant_%';
    `);
    console.log(`  Total tenant policies: ${totalPolicies.rows[0].cnt} (expected: 236)`);
    console.assert(parseInt(totalPolicies.rows[0].cnt) === 236, `FAIL: expected 236 tenant policies`);

    console.log("\nPhase 5M migration: COMPLETE");
  } finally {
    await client.end();
  }
}

main().then(() => process.exit(0)).catch((e: unknown) => {
  console.error("Migration failed:", e instanceof Error ? e.message : e);
  process.exit(1);
});
