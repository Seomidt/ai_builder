/**
 * measure-dashboard-latency.ts — Dashboard latency profiler
 *
 * Run: npx tsx server/scripts/measure-dashboard-latency.ts
 *
 * Measures:
 *   1. Cold PostgREST HTTP roundtrip (organizations)
 *   2. RPC get_dashboard_summary execution time + payload size
 *   3. Individual table query times (projects, ai_runs, architectures, integrations)
 *   4. Index usage via EXPLAIN (via pg client)
 */

import "../lib/env.ts";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const DB_URL = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL!;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing required env vars");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const result = await fn();
  const elapsed = Date.now() - t0;
  console.log(`  [${elapsed.toString().padStart(5)}ms] ${label}`);
  return result;
}

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════════");
  console.log("   DASHBOARD LATENCY PROFILER");
  console.log("══════════════════════════════════════════════\n");

  // ── Step 1: Find an org to test with ─────────────────────────────────────
  console.log("▶ STEP 1: Resolve test org");
  const { data: orgs, error: orgErr } = await time("GET /organizations LIMIT 1", () =>
    admin.from("organizations").select("id, name").limit(1),
  );
  if (orgErr || !orgs?.length) {
    console.error("Cannot find org:", orgErr?.message ?? "empty");
    process.exit(1);
  }
  const orgId = orgs[0].id;
  const orgName = orgs[0].name;
  console.log(`  Org: ${orgName} (${orgId})\n`);

  // ── Step 2: RPC cold call (x3 for warm average) ──────────────────────────
  console.log("▶ STEP 2: RPC get_dashboard_summary (3 calls) — zero-param, JWT-derived org");
  console.log("  NOTE: admin client call returns zeros (no JWT auth.uid()). Client JWT call measures real latency.");
  let rpcPayloadBytes = 0;
  for (let i = 0; i < 3; i++) {
    const { data, error } = await time(`call ${i + 1}`, () =>
      admin.rpc("get_dashboard_summary"),
    );
    if (error) console.error("    ERROR:", error.message);
    else {
      const bytes = JSON.stringify(data).length;
      rpcPayloadBytes = bytes;
      if (i === 0) {
        console.log(`  Payload (bytes): ${bytes}`);
        console.log(`  Payload: ${JSON.stringify(data)}`);
      }
    }
  }
  console.log(`  Final payload size: ${rpcPayloadBytes} bytes\n`);

  // ── Step 3: Individual table timings ────────────────────────────────────
  console.log("▶ STEP 3: Individual table PostgREST queries (no RLS)");
  await time("COUNT projects WHERE org + status=active", () =>
    admin.from("projects").select("id", { count: "exact", head: true })
      .eq("organization_id", orgId).eq("status", "active"),
  );
  await time("COUNT ai_runs WHERE org + status=running", () =>
    admin.from("ai_runs").select("id", { count: "exact", head: true })
      .eq("organization_id", orgId).eq("status", "running"),
  );
  await time("COUNT architecture_profiles WHERE org + status=active", () =>
    admin.from("architecture_profiles").select("id", { count: "exact", head: true })
      .eq("organization_id", orgId).eq("status", "active"),
  );
  await time("COUNT integrations WHERE org + status=active", () =>
    admin.from("integrations").select("id", { count: "exact", head: true })
      .eq("organization_id", orgId).eq("status", "active"),
  );
  await time("SELECT id,status,created_at FROM ai_runs ORDER BY created_at DESC LIMIT 5", () =>
    admin.from("ai_runs").select("id,status,created_at")
      .eq("organization_id", orgId).order("created_at", { ascending: false }).limit(5),
  );
  await time("SELECT id,name,status,updated_at FROM projects ORDER BY updated_at DESC LIMIT 5", () =>
    admin.from("projects").select("id,name,status,updated_at")
      .eq("organization_id", orgId).order("updated_at", { ascending: false }).limit(5),
  );
  console.log("");

  // ── Step 4: EXPLAIN ANALYZE on slowest queries via pg ────────────────────
  console.log("▶ STEP 4: EXPLAIN (BUFFERS) for critical queries via pg");
  const client = new pg.Client({
    connectionString: DB_URL,
    ssl: DB_URL?.includes("supabase") ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();

  const queries = [
    {
      label: "COUNT projects (org + status=active)",
      sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT COUNT(*) FROM projects WHERE organization_id = $1 AND status = 'active'`,
    },
    {
      label: "COUNT ai_runs (org + status=running)",
      sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT COUNT(*) FROM ai_runs WHERE organization_id = $1 AND status = 'running'`,
    },
    {
      label: "COUNT architecture_profiles (org + status=active)",
      sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT COUNT(*) FROM architecture_profiles WHERE organization_id = $1 AND status = 'active'`,
    },
    {
      label: "COUNT integrations (org + status=active)",
      sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT COUNT(*) FROM integrations WHERE organization_id = $1 AND status = 'active'`,
    },
    {
      label: "Recent ai_runs ORDER BY created_at LIMIT 5",
      sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT id,status,created_at FROM ai_runs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT 5`,
    },
    {
      label: "Recent projects ORDER BY updated_at LIMIT 5",
      sql: `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) SELECT id,name,status,updated_at FROM projects WHERE organization_id = $1 ORDER BY updated_at DESC LIMIT 5`,
    },
  ];

  for (const q of queries) {
    console.log(`\n  ── ${q.label}`);
    const t0 = Date.now();
    try {
      const res = await client.query(q.sql, [orgId]);
      const elapsed = Date.now() - t0;
      const plan = (res.rows as Array<{ "QUERY PLAN": string }>).map((r) => r["QUERY PLAN"]).join("\n");
      const seqScan = plan.includes("Seq Scan");
      const actualTime = plan.match(/actual time=[\d.]+\.\.([\d.]+)/)?.[1];
      console.log(`  Duration: ${elapsed}ms | Seq Scan: ${seqScan ? "⚠️  YES" : "✅ no"} | Actual: ${actualTime ?? "?"}ms`);
      if (seqScan) {
        console.log("  PLAN:");
        plan.split("\n").slice(0, 5).forEach((l) => console.log("    " + l));
      }
    } catch (e: unknown) {
      console.log(`  ERROR: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── Step 5: Check existing indexes ──────────────────────────────────────
  console.log("\n\n▶ STEP 5: Existing indexes on key tables");
  const indexQuery = await client.query(`
    SELECT
      tablename,
      indexname,
      indexdef
    FROM pg_indexes
    WHERE tablename IN ('projects', 'ai_runs', 'architecture_profiles', 'integrations', 'organizations')
    ORDER BY tablename, indexname;
  `);
  for (const row of indexQuery.rows as Array<{ tablename: string; indexname: string; indexdef: string }>) {
    const hasStat = row.indexdef.includes("status");
    const hasOrg  = row.indexdef.includes("organization_id");
    const hasCreated = row.indexdef.includes("created_at");
    const hasUpdated = row.indexdef.includes("updated_at");
    const tags = [
      hasStat    && "status",
      hasOrg     && "org_id",
      hasCreated && "created_at",
      hasUpdated && "updated_at",
    ].filter(Boolean).join("+");
    console.log(`  ${row.tablename}.${row.indexname} [${tags || "other"}]`);
  }

  await client.end();

  // ── Step 6: Full bootstrap endpoint timing (HTTP) ────────────────────────
  console.log("\n\n▶ STEP 6: Full /api/dashboard/bootstrap HTTP timing (3 calls)");
  const baseUrl = "http://localhost:5000";
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(`${baseUrl}/api/dashboard/bootstrap`, {
        headers: { Authorization: "Bearer INTERNAL_TEST" },
      });
      const body = await res.text();
      const elapsed = Date.now() - t0;
      console.log(`  call ${i + 1}: ${elapsed}ms | status ${res.status} | size ${body.length}B | X-Cache: ${res.headers.get("X-Cache") ?? "none"}`);
    } catch (e: unknown) {
      console.log(`  call ${i + 1}: ERROR ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  console.log("\n══════════════════════════════════════════════");
  console.log("   PROFILING COMPLETE");
  console.log("══════════════════════════════════════════════\n");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
