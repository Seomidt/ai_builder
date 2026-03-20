/**
 * Phase Performance Hardening — RPC v2 (cursor pagination + server-side filter)
 *
 * Upgrades all 4 page RPCs:
 *   get_projects_page(p_limit, p_cursor)
 *   get_runs_page(p_limit, p_cursor, p_status)
 *   get_architectures_page(p_limit, p_cursor)
 *   get_integrations_page(p_limit, p_cursor)
 *
 * Return shape:  { items: [...], nextCursor: text | null }
 * Cursor:        last item's ordering column (updated_at / created_at) as ISO text
 * Filter:        p_status for runs (text, allowlisted server-side)
 *
 * Usage:
 *   npx tsx server/scripts/migrate-page-rpcs-v2.ts
 */

import pg from "pg";
const { Client } = pg;

async function run(): Promise<void> {
  const client = new Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  console.log("Page RPC v2 — Cursor Pagination + Server-side Filter");
  console.log("====================================================");

  try {
    // ── Drop old signatures ───────────────────────────────────────────────────
    console.log("\n[0/6] Dropping v1 stubs …");
    await client.query(`DROP FUNCTION IF EXISTS get_projects_page() CASCADE;`);
    await client.query(`DROP FUNCTION IF EXISTS get_runs_page() CASCADE;`);
    await client.query(`DROP FUNCTION IF EXISTS get_architectures_page() CASCADE;`);
    await client.query(`DROP FUNCTION IF EXISTS get_integrations_page() CASCADE;`);
    // Also drop v2 if re-running
    await client.query(`DROP FUNCTION IF EXISTS get_projects_page(int, text) CASCADE;`);
    await client.query(`DROP FUNCTION IF EXISTS get_runs_page(int, text, text) CASCADE;`);
    await client.query(`DROP FUNCTION IF EXISTS get_architectures_page(int, text) CASCADE;`);
    await client.query(`DROP FUNCTION IF EXISTS get_integrations_page(int, text) CASCADE;`);
    console.log("  Done");

    // ── 1. get_projects_page ──────────────────────────────────────────────────
    console.log("\n[1/6] get_projects_page(p_limit, p_cursor) …");
    await client.query(`
      CREATE OR REPLACE FUNCTION get_projects_page(
        p_limit  int  DEFAULT 50,
        p_cursor text DEFAULT NULL
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY INVOKER
      STABLE
      AS $$
      DECLARE
        v_limit  int := LEAST(COALESCE(p_limit, 50), 100);
        v_items  jsonb;
      BEGIN
        SELECT COALESCE(jsonb_agg(p), '[]'::jsonb) INTO v_items
        FROM (
          SELECT jsonb_build_object(
            'id',          id,
            'name',        name,
            'slug',        slug,
            'status',      status::text,
            'description', description,
            'createdAt',   created_at,
            '_cursor',     to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          ) AS p
          FROM projects
          WHERE organization_id IN (
            SELECT organization_id FROM organization_members WHERE user_id = auth.uid()::text
          )
          AND (p_cursor IS NULL OR updated_at < p_cursor::timestamptz)
          ORDER BY updated_at DESC NULLS LAST
          LIMIT v_limit
        ) sub;

        RETURN jsonb_build_object(
          'items',       COALESCE(v_items, '[]'::jsonb),
          'nextCursor',  CASE
            WHEN jsonb_array_length(COALESCE(v_items, '[]'::jsonb)) < v_limit THEN NULL
            ELSE v_items->( jsonb_array_length(v_items) - 1 )->>'_cursor'
          END
        );
      END;
      $$;
    `);
    await client.query(`GRANT EXECUTE ON FUNCTION get_projects_page(int, text) TO anon, authenticated;`);
    console.log("  ✅ get_projects_page(p_limit, p_cursor)");

    // ── 2. get_runs_page ──────────────────────────────────────────────────────
    console.log("\n[2/6] get_runs_page(p_limit, p_cursor, p_status) …");
    await client.query(`
      CREATE OR REPLACE FUNCTION get_runs_page(
        p_limit  int  DEFAULT 50,
        p_cursor text DEFAULT NULL,
        p_status text DEFAULT NULL
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY INVOKER
      STABLE
      AS $$
      DECLARE
        v_limit  int := LEAST(COALESCE(p_limit, 50), 100);
        v_status text := NULL;
        v_items  jsonb;
      BEGIN
        -- Allowlist status filter — invalid values silently ignored (treated as NULL)
        IF p_status IN ('pending','running','completed','failed','cancelled') THEN
          v_status := p_status;
        END IF;

        SELECT COALESCE(jsonb_agg(r), '[]'::jsonb) INTO v_items
        FROM (
          SELECT jsonb_build_object(
            'id',          id,
            'runNumber',   run_number,
            'status',      status::text,
            'title',       title,
            'goal',        goal,
            'createdAt',   created_at,
            'startedAt',   started_at,
            'finishedAt',  finished_at,
            'completedAt', completed_at,
            '_cursor',     to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          ) AS r
          FROM ai_runs
          WHERE organization_id IN (
            SELECT organization_id FROM organization_members WHERE user_id = auth.uid()::text
          )
          AND (p_cursor IS NULL OR created_at < p_cursor::timestamptz)
          AND (v_status IS NULL OR status::text = v_status)
          ORDER BY created_at DESC
          LIMIT v_limit
        ) sub;

        RETURN jsonb_build_object(
          'items',      COALESCE(v_items, '[]'::jsonb),
          'nextCursor', CASE
            WHEN jsonb_array_length(COALESCE(v_items, '[]'::jsonb)) < v_limit THEN NULL
            ELSE v_items->( jsonb_array_length(v_items) - 1 )->>'_cursor'
          END
        );
      END;
      $$;
    `);
    await client.query(`GRANT EXECUTE ON FUNCTION get_runs_page(int, text, text) TO anon, authenticated;`);
    console.log("  ✅ get_runs_page(p_limit, p_cursor, p_status)");

    // ── 3. get_architectures_page ─────────────────────────────────────────────
    console.log("\n[3/6] get_architectures_page(p_limit, p_cursor) …");
    await client.query(`
      CREATE OR REPLACE FUNCTION get_architectures_page(
        p_limit  int  DEFAULT 50,
        p_cursor text DEFAULT NULL
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY INVOKER
      STABLE
      AS $$
      DECLARE
        v_limit int := LEAST(COALESCE(p_limit, 50), 100);
        v_items jsonb;
      BEGIN
        SELECT COALESCE(jsonb_agg(a), '[]'::jsonb) INTO v_items
        FROM (
          SELECT jsonb_build_object(
            'id',               id,
            'name',             name,
            'slug',             slug,
            'status',           status::text,
            'description',      description,
            'category',         category,
            'currentVersionId', current_version_id,
            'createdAt',        created_at,
            '_cursor',          to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          ) AS a
          FROM architecture_profiles
          WHERE organization_id IN (
            SELECT organization_id FROM organization_members WHERE user_id = auth.uid()::text
          )
          AND (p_cursor IS NULL OR updated_at < p_cursor::timestamptz)
          ORDER BY updated_at DESC NULLS LAST
          LIMIT v_limit
        ) sub;

        RETURN jsonb_build_object(
          'items',      COALESCE(v_items, '[]'::jsonb),
          'nextCursor', CASE
            WHEN jsonb_array_length(COALESCE(v_items, '[]'::jsonb)) < v_limit THEN NULL
            ELSE v_items->( jsonb_array_length(v_items) - 1 )->>'_cursor'
          END
        );
      END;
      $$;
    `);
    await client.query(`GRANT EXECUTE ON FUNCTION get_architectures_page(int, text) TO anon, authenticated;`);
    console.log("  ✅ get_architectures_page(p_limit, p_cursor)");

    // ── 4. get_integrations_page ──────────────────────────────────────────────
    console.log("\n[4/6] get_integrations_page(p_limit, p_cursor) …");
    await client.query(`
      CREATE OR REPLACE FUNCTION get_integrations_page(
        p_limit  int  DEFAULT 20,
        p_cursor text DEFAULT NULL
      )
      RETURNS jsonb
      LANGUAGE plpgsql
      SECURITY INVOKER
      STABLE
      AS $$
      DECLARE
        v_limit int := LEAST(COALESCE(p_limit, 20), 50);
        v_items jsonb;
      BEGIN
        SELECT COALESCE(jsonb_agg(i), '[]'::jsonb) INTO v_items
        FROM (
          SELECT jsonb_build_object(
            'id',        id,
            'provider',  provider::text,
            'status',    status::text,
            'createdAt', created_at,
            '_cursor',   to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          ) AS i
          FROM integrations
          WHERE organization_id IN (
            SELECT organization_id FROM organization_members WHERE user_id = auth.uid()::text
          )
          AND (p_cursor IS NULL OR created_at < p_cursor::timestamptz)
          ORDER BY created_at DESC
          LIMIT v_limit
        ) sub;

        RETURN jsonb_build_object(
          'items',      COALESCE(v_items, '[]'::jsonb),
          'nextCursor', CASE
            WHEN jsonb_array_length(COALESCE(v_items, '[]'::jsonb)) < v_limit THEN NULL
            ELSE v_items->( jsonb_array_length(v_items) - 1 )->>'_cursor'
          END
        );
      END;
      $$;
    `);
    await client.query(`GRANT EXECUTE ON FUNCTION get_integrations_page(int, text) TO anon, authenticated;`);
    console.log("  ✅ get_integrations_page(p_limit, p_cursor)");

    // ── 5. Verify ─────────────────────────────────────────────────────────────
    console.log("\n[5/6] Verifying …");
    const check = await client.query(`
      SELECT proname, pronargs, prosecdef FROM pg_proc
      WHERE proname IN ('get_projects_page','get_runs_page','get_architectures_page','get_integrations_page')
        AND pronamespace = 'public'::regnamespace
      ORDER BY proname
    `);
    for (const r of check.rows) {
      const sec = r.prosecdef ? "SECURITY DEFINER ❌" : "SECURITY INVOKER ✅";
      console.log(`  ${r.proname}(${r.pronargs} args): ${sec}`);
    }

    // ── 6. Confirm enum type exists ───────────────────────────────────────────
    console.log("\n[6/6] Confirming ai_run_status enum …");
    const enumCheck = await client.query(`
      SELECT typname FROM pg_type WHERE typname = 'ai_run_status'
    `);
    if (enumCheck.rows.length > 0) {
      console.log("  ✅ ai_run_status enum exists");
    } else {
      console.log("  ⚠️  ai_run_status enum not found — status filter will use text cast fallback");
    }

    console.log("\n====================================================");
    console.log("✅ Page RPC v2 migration complete");
    console.log("   4 RPCs upgraded · cursor pagination · server-side status filter");

  } finally {
    await client.end();
  }
}

run().catch((err: unknown) => {
  console.error("Migration failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
