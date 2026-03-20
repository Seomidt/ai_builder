/**
 * migrate-runtime-rpc.ts — Supabase RPC functions for runtime data access.
 *
 * Run once:  npx tsx server/scripts/migrate-runtime-rpc.ts
 *
 * Creates / replaces:
 *   1. get_dashboard_summary(p_org_id text) — single HTTP round-trip for dashboard
 *      bootstrap. SECURITY INVOKER so existing RLS SELECT policies apply.
 *
 *   2. create_ai_run(p_org_id, p_project_id, ...) — atomic sequential run_number
 *      assignment per org. SECURITY DEFINER + manual membership check.
 *
 * Also creates composite indexes for dashboard queries (idempotent — IF NOT EXISTS).
 *
 * Classification: D (migration/script only). NOT imported by any runtime file.
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
  console.log("[migrate-runtime-rpc] Connected to Postgres");

  // ── 1. get_dashboard_summary ──────────────────────────────────────────────
  // SECURITY INVOKER: runs as the calling Supabase user → RLS SELECT policies apply.
  //
  // BUG FIX (v2): removed ORDER BY inside jsonb_agg() — the column alias `r` /
  // `p` is a jsonb value, NOT a row type, so r."createdAt" is invalid SQL.
  // The subquery ORDER BY created_at DESC + LIMIT 5 already guarantees order;
  // jsonb_agg() aggregates rows in the order they arrive from the subquery.

  await client.query(`
    CREATE OR REPLACE FUNCTION get_dashboard_summary(p_org_id text)
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY INVOKER
    SET search_path = public
    AS $$
    DECLARE
      v_org_name text;
      v_project_count bigint;
      v_active_run_count bigint;
      v_arch_count bigint;
      v_int_count bigint;
      v_recent_runs jsonb;
      v_recent_projects jsonb;
    BEGIN
      SELECT name INTO v_org_name
        FROM organizations WHERE id = p_org_id LIMIT 1;

      SELECT COUNT(*) INTO v_project_count
        FROM projects WHERE organization_id = p_org_id AND status = 'active';

      SELECT COUNT(*) INTO v_active_run_count
        FROM ai_runs WHERE organization_id = p_org_id AND status = 'running';

      SELECT COUNT(*) INTO v_arch_count
        FROM architecture_profiles WHERE organization_id = p_org_id AND status = 'active';

      SELECT COUNT(*) INTO v_int_count
        FROM integrations WHERE organization_id = p_org_id AND status = 'active';

      -- FIX v2: jsonb_agg(r) without ORDER BY clause.
      -- "r" is a jsonb value alias, not a row type. r."createdAt" is invalid SQL.
      -- Order is guaranteed by the inner ORDER BY created_at DESC LIMIT 5.
      SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_recent_runs
        FROM (
          SELECT jsonb_build_object(
            'id',        id,
            'status',    status,
            'createdAt', created_at
          ) AS r
          FROM ai_runs
          WHERE organization_id = p_org_id
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
          WHERE organization_id = p_org_id
          ORDER BY updated_at DESC
          LIMIT 5
        ) sub;

      RETURN jsonb_build_object(
        'orgName',                    COALESCE(v_org_name, p_org_id),
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
  console.log("[migrate-runtime-rpc] ✓ get_dashboard_summary (v2 — bug fixed)");

  // ── 2. create_ai_run ──────────────────────────────────────────────────────
  // SECURITY DEFINER: elevated privileges for atomic MAX(run_number) + INSERT.

  await client.query(`
    CREATE OR REPLACE FUNCTION create_ai_run(
      p_org_id                  text,
      p_project_id              text,
      p_architecture_profile_id text,
      p_architecture_version_id text,
      p_created_by              text,
      p_title                   text    DEFAULT NULL,
      p_description             text    DEFAULT NULL,
      p_goal                    text    DEFAULT NULL,
      p_tags                    text[]  DEFAULT NULL,
      p_pipeline_version        text    DEFAULT NULL
    )
    RETURNS jsonb
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
    DECLARE
      v_next_num integer;
      v_new_id   text;
      v_result   jsonb;
    BEGIN
      IF auth.uid() IS NOT NULL THEN
        IF NOT EXISTS (
          SELECT 1 FROM organization_members
          WHERE organization_id = p_org_id AND user_id = auth.uid()
        ) THEN
          RAISE EXCEPTION 'Access denied: caller is not a member of org %', p_org_id;
        END IF;
      END IF;

      SELECT COALESCE(MAX(run_number), 0) + 1 INTO v_next_num
        FROM ai_runs WHERE organization_id = p_org_id;

      v_new_id := gen_random_uuid()::text;

      INSERT INTO ai_runs (
        id, organization_id, project_id, architecture_profile_id,
        architecture_version_id, run_number, status, title, description,
        goal, tags, pipeline_version, created_by, created_at, updated_at
      ) VALUES (
        v_new_id, p_org_id, p_project_id, p_architecture_profile_id,
        p_architecture_version_id, v_next_num, 'pending', p_title, p_description,
        p_goal, p_tags, p_pipeline_version, p_created_by, NOW(), NOW()
      );

      SELECT to_jsonb(r) INTO v_result FROM ai_runs r WHERE r.id = v_new_id;
      RETURN v_result;
    END;
    $$;
  `);
  console.log("[migrate-runtime-rpc] ✓ create_ai_run");

  // ── 3. Composite indexes for dashboard queries ────────────────────────────
  // These make the RPC's 7 sequential inner SELECTs index-only scans.
  // All CREATE INDEX ... IF NOT EXISTS — safe to re-run.

  const indexes = [
    // COUNT WHERE org AND status (removes double-index-scan for bi-column filter)
    `CREATE INDEX IF NOT EXISTS idx_projects_org_status
       ON projects(organization_id, status)
       WHERE status = 'active'`,
    `CREATE INDEX IF NOT EXISTS idx_ai_runs_org_status
       ON ai_runs(organization_id, status)
       WHERE status IN ('running', 'pending')`,
    `CREATE INDEX IF NOT EXISTS idx_arch_profiles_org_status
       ON architecture_profiles(organization_id, status)
       WHERE status = 'active'`,
    `CREATE INDEX IF NOT EXISTS idx_integrations_org_status
       ON integrations(organization_id, status)
       WHERE status = 'active'`,
    // ORDER BY created_at / updated_at DESC LIMIT 5 (covering index → index-only scan)
    `CREATE INDEX IF NOT EXISTS idx_ai_runs_org_created
       ON ai_runs(organization_id, created_at DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_projects_org_updated
       ON projects(organization_id, updated_at DESC)`,
  ];

  for (const sql of indexes) {
    const name = sql.match(/IF NOT EXISTS (\S+)/)?.[1] ?? "?";
    const t0 = Date.now();
    await client.query(sql);
    console.log(`[migrate-runtime-rpc] ✓ index ${name} (${Date.now() - t0}ms)`);
  }

  await client.end();
  console.log("[migrate-runtime-rpc] Done.");
}

run().catch((err) => {
  console.error("[migrate-runtime-rpc] FAILED:", err.message);
  client.end().catch(() => {});
  process.exit(1);
});
