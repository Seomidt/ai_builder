/**
 * migrate-dashboard-direct.ts — Remove server hop for dashboard data.
 *
 * Run once:  npx tsx server/scripts/migrate-dashboard-direct.ts
 *
 * Changes:
 *   1. DROP get_dashboard_summary(p_org_id text)  — old parameterised version
 *   2. CREATE get_dashboard_summary()              — new zero-param version
 *      Org derived from auth.uid() via organization_members.
 *      Client passes NO tenant data — pure JWT-based isolation.
 *
 * Security model:
 *   SECURITY INVOKER + RLS ensures only the caller's org data is returned.
 *   auth.uid() is set by PostgREST from the client JWT — unforgeable.
 *   No p_org_id from client → no cross-tenant spoofing possible.
 *
 * Classification: D (migration/script). NOT imported by any runtime file.
 */

import pg from "pg";

const cs = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL;
if (!cs) {
  console.error("ERROR: Set SUPABASE_DB_POOL_URL or DATABASE_URL");
  process.exit(1);
}

const client = new pg.Client({
  connectionString: cs,
  ssl: process.env.SUPABASE_DB_POOL_URL ? { rejectUnauthorized: false } : undefined,
});

async function run(): Promise<void> {
  await client.connect();
  console.log("[migrate-dashboard-direct] Connected to Postgres");

  // ── Step 1: Drop old parameterised version ────────────────────────────────
  await client.query(`DROP FUNCTION IF EXISTS get_dashboard_summary(text);`);
  console.log("[migrate-dashboard-direct] Dropped get_dashboard_summary(text)");

  // ── Step 2: Create zero-param version — org derived from auth.uid() ──────
  // SECURITY INVOKER: runs as the calling user.
  //   auth.uid()  is set by PostgREST from the Supabase JWT in Authorization header.
  //   RLS on all tables restricts rows to the caller's org automatically.
  // No p_org_id parameter — client sends NO tenant identifier.
  // The membership lookup derives the org — any forged JWT would fail Supabase
  // authentication before this function is even called.

  await client.query(`
    CREATE OR REPLACE FUNCTION get_dashboard_summary()
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = public
    AS $$
    DECLARE
      v_org_id               text;
      v_org_name             text;
      v_project_count        bigint;
      v_active_run_count     bigint;
      v_arch_count           bigint;
      v_int_count            bigint;
      v_recent_runs          jsonb;
      v_recent_projects      jsonb;
    BEGIN
      -- Derive org from authenticated user. auth.uid() is set by PostgREST
      -- from the JWT in the Authorization header — client cannot spoof it.
      -- Cast auth.uid() (uuid) to text to match varchar user_id column.
      SELECT organization_id INTO v_org_id
        FROM organization_members
        WHERE user_id = auth.uid()::text
        LIMIT 1;

      IF v_org_id IS NULL THEN
        RETURN jsonb_build_object(
          'orgName',                    'Unknown',
          'projectCount',               0,
          'activeRunCount',             0,
          'architectureCount',          0,
          'configuredIntegrationCount', 0,
          'recentRuns',                 '[]'::jsonb,
          'recentProjects',             '[]'::jsonb
        );
      END IF;

      SELECT name INTO v_org_name
        FROM organizations WHERE id = v_org_id LIMIT 1;

      SELECT COUNT(*) INTO v_project_count
        FROM projects WHERE organization_id = v_org_id AND status = 'active';

      SELECT COUNT(*) INTO v_active_run_count
        FROM ai_runs WHERE organization_id = v_org_id AND status = 'running';

      SELECT COUNT(*) INTO v_arch_count
        FROM architecture_profiles WHERE organization_id = v_org_id AND status = 'active';

      SELECT COUNT(*) INTO v_int_count
        FROM integrations WHERE organization_id = v_org_id AND status = 'active';

      SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_recent_runs
        FROM (
          SELECT jsonb_build_object(
            'id',        id,
            'status',    status,
            'createdAt', created_at
          ) AS r
          FROM ai_runs
          WHERE organization_id = v_org_id
          ORDER BY created_at DESC
          LIMIT 5
        ) sub;

      SELECT COALESCE(jsonb_agg(p), '[]'::jsonb) INTO v_recent_projects
        FROM (
          SELECT jsonb_build_object(
            'id',        id,
            'name',      name,
            'status',    status,
            'updatedAt', updated_at
          ) AS p
          FROM projects
          WHERE organization_id = v_org_id
          ORDER BY updated_at DESC
          LIMIT 5
        ) sub;

      RETURN jsonb_build_object(
        'orgName',                    COALESCE(v_org_name, v_org_id),
        'projectCount',               v_project_count,
        'activeRunCount',             v_active_run_count,
        'architectureCount',          v_arch_count,
        'configuredIntegrationCount', v_int_count,
        'recentRuns',                 v_recent_runs,
        'recentProjects',             v_recent_projects
      );
    END;
    $$;
  `);
  console.log("[migrate-dashboard-direct] Created get_dashboard_summary() — zero-param, JWT-derived org");

  // ── Step 3: Grant execute to anon + authenticated roles ───────────────────
  // anon: not strictly needed (users are authenticated) but harmless.
  // authenticated: required — PostgREST calls function as 'authenticated' role.
  await client.query(`
    GRANT EXECUTE ON FUNCTION get_dashboard_summary() TO anon, authenticated;
  `);
  console.log("[migrate-dashboard-direct] Granted EXECUTE to anon, authenticated");

  await client.end();
  console.log("[migrate-dashboard-direct] Done — RPC updated, no p_org_id from client.");
}

run().catch((err) => {
  console.error("[migrate-dashboard-direct] FAILED:", err.message);
  client.end().catch(() => {});
  process.exit(1);
});
