/**
 * Phase Page-RPC — Tenant Page Data Path Migration
 *
 * Creates one RPC per major tenant page, each returning a minimal camelCase
 * jsonb payload. Org scope derived from auth.uid() via organization_members.
 * All functions are SECURITY INVOKER (RLS enforces tenant isolation).
 *
 * Also adds 2 missing composite indexes for ORDER BY access patterns.
 *
 * Usage:
 *   npx tsx server/scripts/migrate-page-rpcs.ts
 */

import pg from "pg";
const { Client } = pg;

async function run(): Promise<void> {
  const client = new Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  console.log("Page RPC Migration — Tenant Page Data Path");
  console.log("============================================");

  try {
    // ── Drop old versions if they exist ───────────────────────────────────────
    console.log("\n[0/6] Dropping old page RPC stubs (if any) …");
    const drops = [
      "get_projects_page()",
      "get_runs_page()",
      "get_architectures_page()",
      "get_integrations_page()",
    ];
    for (const fn of drops) {
      await client.query(`DROP FUNCTION IF EXISTS ${fn} CASCADE;`);
      console.log(`  Dropped (if existed): ${fn}`);
    }

    // ── 1. get_projects_page() ────────────────────────────────────────────────
    console.log("\n[1/6] Creating get_projects_page() …");
    await client.query(`
      CREATE OR REPLACE FUNCTION get_projects_page()
      RETURNS jsonb
      LANGUAGE sql
      SECURITY INVOKER
      STABLE
      AS $$
        SELECT COALESCE(jsonb_agg(p), '[]'::jsonb)
        FROM (
          SELECT jsonb_build_object(
            'id',          id,
            'name',        name,
            'slug',        slug,
            'status',      status::text,
            'description', description,
            'createdAt',   created_at
          ) AS p
          FROM projects
          WHERE organization_id IN (
            SELECT organization_id
            FROM   organization_members
            WHERE  user_id = auth.uid()::text
          )
          ORDER BY updated_at DESC NULLS LAST
          LIMIT 50
        ) sub;
      $$;
    `);
    await client.query(`GRANT EXECUTE ON FUNCTION get_projects_page() TO anon, authenticated;`);
    console.log("  ✅ get_projects_page() OK");

    // ── 2. get_runs_page() ────────────────────────────────────────────────────
    console.log("\n[2/6] Creating get_runs_page() …");
    await client.query(`
      CREATE OR REPLACE FUNCTION get_runs_page()
      RETURNS jsonb
      LANGUAGE sql
      SECURITY INVOKER
      STABLE
      AS $$
        SELECT COALESCE(jsonb_agg(r), '[]'::jsonb)
        FROM (
          SELECT jsonb_build_object(
            'id',           id,
            'runNumber',    run_number,
            'status',       status::text,
            'title',        title,
            'goal',         goal,
            'createdAt',    created_at,
            'startedAt',    started_at,
            'finishedAt',   finished_at,
            'completedAt',  completed_at
          ) AS r
          FROM ai_runs
          WHERE organization_id IN (
            SELECT organization_id
            FROM   organization_members
            WHERE  user_id = auth.uid()::text
          )
          ORDER BY created_at DESC
          LIMIT 50
        ) sub;
      $$;
    `);
    await client.query(`GRANT EXECUTE ON FUNCTION get_runs_page() TO anon, authenticated;`);
    console.log("  ✅ get_runs_page() OK");

    // ── 3. get_architectures_page() ───────────────────────────────────────────
    console.log("\n[3/6] Creating get_architectures_page() …");
    await client.query(`
      CREATE OR REPLACE FUNCTION get_architectures_page()
      RETURNS jsonb
      LANGUAGE sql
      SECURITY INVOKER
      STABLE
      AS $$
        SELECT COALESCE(jsonb_agg(a), '[]'::jsonb)
        FROM (
          SELECT jsonb_build_object(
            'id',               id,
            'name',             name,
            'slug',             slug,
            'status',           status::text,
            'description',      description,
            'category',         category,
            'currentVersionId', current_version_id,
            'createdAt',        created_at
          ) AS a
          FROM architecture_profiles
          WHERE organization_id IN (
            SELECT organization_id
            FROM   organization_members
            WHERE  user_id = auth.uid()::text
          )
          ORDER BY updated_at DESC NULLS LAST
          LIMIT 50
        ) sub;
      $$;
    `);
    await client.query(`GRANT EXECUTE ON FUNCTION get_architectures_page() TO anon, authenticated;`);
    console.log("  ✅ get_architectures_page() OK");

    // ── 4. get_integrations_page() ────────────────────────────────────────────
    console.log("\n[4/6] Creating get_integrations_page() …");
    await client.query(`
      CREATE OR REPLACE FUNCTION get_integrations_page()
      RETURNS jsonb
      LANGUAGE sql
      SECURITY INVOKER
      STABLE
      AS $$
        SELECT COALESCE(jsonb_agg(i), '[]'::jsonb)
        FROM (
          SELECT jsonb_build_object(
            'id',        id,
            'provider',  provider::text,
            'status',    status::text,
            'createdAt', created_at
          ) AS i
          FROM integrations
          WHERE organization_id IN (
            SELECT organization_id
            FROM   organization_members
            WHERE  user_id = auth.uid()::text
          )
          ORDER BY created_at DESC
          LIMIT 20
        ) sub;
      $$;
    `);
    await client.query(`GRANT EXECUTE ON FUNCTION get_integrations_page() TO anon, authenticated;`);
    console.log("  ✅ get_integrations_page() OK");

    // ── 5. Missing composite indexes ──────────────────────────────────────────
    console.log("\n[5/6] Adding missing composite indexes …");

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_arch_profiles_org_updated
      ON architecture_profiles (organization_id, updated_at DESC NULLS LAST);
    `);
    console.log("  ✅ idx_arch_profiles_org_updated");

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_integrations_org_created
      ON integrations (organization_id, created_at DESC);
    `);
    console.log("  ✅ idx_integrations_org_created");

    // ── 6. Verify RPCs ────────────────────────────────────────────────────────
    console.log("\n[6/6] Verifying RPCs …");
    const fns = [
      "get_projects_page",
      "get_runs_page",
      "get_architectures_page",
      "get_integrations_page",
    ];
    const check = await client.query(`
      SELECT proname FROM pg_proc
      WHERE proname = ANY($1) AND pronamespace = 'public'::regnamespace
    `, [fns]);
    const found = new Set(check.rows.map((r: { proname: string }) => r.proname));
    for (const fn of fns) {
      if (found.has(fn)) {
        console.log(`  ✅ ${fn}()`);
      } else {
        console.error(`  ❌ MISSING: ${fn}()`);
        process.exit(1);
      }
    }

    console.log("\n============================================");
    console.log("✅ Page RPC migration completed successfully");
    console.log("   4 RPCs created · 2 indexes added");

  } finally {
    await client.end();
  }
}

run().catch((err: unknown) => {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
