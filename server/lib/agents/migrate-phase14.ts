/**
 * Phase 14 Migration — AI Agents Execution Platform
 * 6 new tables: ai_agents, ai_agent_versions, ai_workflows, ai_workflow_steps,
 *               ai_agent_runs, ai_agent_run_logs
 * Idempotent — safe to re-run.
 */

import pg from "pg";

const TABLES = ["ai_agents", "ai_agent_versions", "ai_workflows", "ai_workflow_steps", "ai_agent_runs", "ai_agent_run_logs"];

async function main() {
  const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  try {
    const existing = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1)`, [TABLES]);
    console.log(`\nExisting Phase 14 tables: ${existing.rows.map((r) => r.table_name).join(", ") || "none"}`);

    // ── 1. ai_agents ───────────────────────────────────────────────────────────
    console.log("\n── Creating ai_agents...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.ai_agents (
        id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id   text NOT NULL,
        agent_name  text NOT NULL,
        description text,
        created_at  timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ai_agents_tenant_name_unique ON public.ai_agents (tenant_id, agent_name)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_agents_tenant_id_idx ON public.ai_agents (tenant_id)`);
    console.log("  ✔ ai_agents — table + 2 indexes");

    // ── 2. ai_agent_versions ──────────────────────────────────────────────────
    console.log("\n── Creating ai_agent_versions...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.ai_agent_versions (
        id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        agent_id          text NOT NULL,
        version           integer NOT NULL,
        prompt_version_id text,
        model_id          text,
        max_iterations    integer NOT NULL DEFAULT 10
                          CHECK (max_iterations >= 1 AND max_iterations <= 10),
        created_at        timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ai_agent_versions_agent_version_unique ON public.ai_agent_versions (agent_id, version)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_agent_versions_agent_id_idx ON public.ai_agent_versions (agent_id)`);
    console.log("  ✔ ai_agent_versions — table + 2 indexes (1 unique)");

    // ── 3. ai_workflows ───────────────────────────────────────────────────────
    console.log("\n── Creating ai_workflows...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.ai_workflows (
        id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id     text NOT NULL,
        workflow_name text NOT NULL,
        created_at    timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ai_workflows_tenant_name_unique ON public.ai_workflows (tenant_id, workflow_name)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_workflows_tenant_id_idx ON public.ai_workflows (tenant_id)`);
    console.log("  ✔ ai_workflows — table + 2 indexes");

    // ── 4. ai_workflow_steps ──────────────────────────────────────────────────
    console.log("\n── Creating ai_workflow_steps...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.ai_workflow_steps (
        id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        workflow_id      text NOT NULL,
        step_order       integer NOT NULL
                         CHECK (step_order >= 1 AND step_order <= 20),
        step_type        text NOT NULL DEFAULT 'agent'
                         CHECK (step_type IN ('agent','transform','condition','output')),
        agent_version_id text,
        created_at       timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ai_workflow_steps_workflow_order_unique ON public.ai_workflow_steps (workflow_id, step_order)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_workflow_steps_workflow_id_idx ON public.ai_workflow_steps (workflow_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_workflow_steps_order_idx ON public.ai_workflow_steps (step_order)`);
    console.log("  ✔ ai_workflow_steps — table + 3 indexes (1 unique)");

    // ── 5. ai_agent_runs ──────────────────────────────────────────────────────
    console.log("\n── Creating ai_agent_runs...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.ai_agent_runs (
        id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id        text NOT NULL,
        agent_version_id text NOT NULL,
        workflow_id      text,
        run_status       text NOT NULL DEFAULT 'pending'
                         CHECK (run_status IN ('pending','running','completed','failed','aborted','timeout')),
        started_at       timestamp NOT NULL DEFAULT now(),
        completed_at     timestamp
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_agent_runs_tenant_id_idx ON public.ai_agent_runs (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_agent_runs_agent_version_id_idx ON public.ai_agent_runs (agent_version_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_agent_runs_status_idx ON public.ai_agent_runs (run_status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_agent_runs_started_at_idx ON public.ai_agent_runs (started_at)`);
    console.log("  ✔ ai_agent_runs — table + 4 indexes");

    // ── 6. ai_agent_run_logs ──────────────────────────────────────────────────
    console.log("\n── Creating ai_agent_run_logs...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.ai_agent_run_logs (
        id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        run_id         text NOT NULL,
        step_index     integer NOT NULL CHECK (step_index >= 0),
        input_payload  jsonb NOT NULL DEFAULT '{}'::jsonb,
        output_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        latency_ms     integer,
        created_at     timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_agent_run_logs_run_id_idx ON public.ai_agent_run_logs (run_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_agent_run_logs_step_index_idx ON public.ai_agent_run_logs (step_index)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_agent_run_logs_created_at_idx ON public.ai_agent_run_logs (created_at)`);
    console.log("  ✔ ai_agent_run_logs — table + 3 indexes");

    // ── 7. RLS ────────────────────────────────────────────────────────────────
    console.log("\n── Enabling RLS...");
    for (const t of TABLES) await client.query(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    console.log("  ✔ RLS enabled on all 6 Phase 14 tables");

    const RLS: Record<string, string> = {
      ai_agents: `current_setting('app.current_tenant_id', true) <> '' AND tenant_id::text = current_setting('app.current_tenant_id', true)`,
      ai_agent_versions: `EXISTS (SELECT 1 FROM public.ai_agents a WHERE a.id=ai_agent_versions.agent_id AND a.tenant_id::text=current_setting('app.current_tenant_id',true))`,
      ai_workflows: `current_setting('app.current_tenant_id', true) <> '' AND tenant_id::text = current_setting('app.current_tenant_id', true)`,
      ai_workflow_steps: `EXISTS (SELECT 1 FROM public.ai_workflows w WHERE w.id=ai_workflow_steps.workflow_id AND w.tenant_id::text=current_setting('app.current_tenant_id',true))`,
      ai_agent_runs: `current_setting('app.current_tenant_id', true) <> '' AND tenant_id::text = current_setting('app.current_tenant_id', true)`,
      ai_agent_run_logs: `EXISTS (SELECT 1 FROM public.ai_agent_runs r WHERE r.id=ai_agent_run_logs.run_id AND r.tenant_id::text=current_setting('app.current_tenant_id',true))`,
    };

    for (const [tbl, using] of Object.entries(RLS)) {
      const pName = `${tbl.replace(/_/g, "")}_tenant_isolation`;
      const ex = await client.query(`SELECT 1 FROM pg_policies WHERE tablename=$1 AND policyname=$2`, [tbl, pName]);
      if (!ex.rows.length) {
        await client.query(`CREATE POLICY "${pName}" ON public.${tbl} USING (${using})`);
        console.log(`  ✔ ${tbl} RLS policy created`);
      } else {
        console.log(`  ✔ ${tbl} RLS policy exists`);
      }
    }

    // ── 8. Verification ───────────────────────────────────────────────────────
    console.log("\n── Verification...");
    const tableR = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name=ANY($1) ORDER BY table_name`, [TABLES]);
    console.log(`✔ Tables verified (${tableR.rows.length}/6): ${tableR.rows.map((r) => r.table_name).join(", ")}`);

    const rlsR = await client.query(`SELECT COUNT(*) as cnt FROM pg_tables WHERE schemaname='public' AND rowsecurity=true AND tablename=ANY($1)`, [TABLES]);
    console.log(`✔ Phase 14 RLS verified (${rlsR.rows[0].cnt}/6)`);

    const totalRls = await client.query(`SELECT COUNT(*) as cnt FROM pg_tables WHERE schemaname='public' AND rowsecurity=true`);
    console.log(`✔ Total RLS tables: ${totalRls.rows[0].cnt}`);

    const idxR = await client.query(`SELECT COUNT(*) as cnt FROM pg_indexes WHERE schemaname='public' AND tablename=ANY($1)`, [TABLES]);
    console.log(`✔ Phase 14 indexes: ${idxR.rows[0].cnt}`);

    // Round-trip test
    const tid = `p14-test-${Date.now()}`;
    const ag = await client.query(`INSERT INTO public.ai_agents (tenant_id,agent_name) VALUES ($1,'test-agent') RETURNING id`, [tid]);
    const av = await client.query(`INSERT INTO public.ai_agent_versions (agent_id,version) VALUES ($1,1) RETURNING id`, [ag.rows[0].id]);
    const wf = await client.query(`INSERT INTO public.ai_workflows (tenant_id,workflow_name) VALUES ($1,'test-wf') RETURNING id`, [tid]);
    const st = await client.query(`INSERT INTO public.ai_workflow_steps (workflow_id,step_order,step_type) VALUES ($1,1,'agent') RETURNING id`, [wf.rows[0].id]);
    const run = await client.query(`INSERT INTO public.ai_agent_runs (tenant_id,agent_version_id) VALUES ($1,$2) RETURNING id`, [tid, av.rows[0].id]);
    const log = await client.query(`INSERT INTO public.ai_agent_run_logs (run_id,step_index,input_payload,output_payload) VALUES ($1,0,'{}','{}') RETURNING id`, [run.rows[0].id]);
    console.log(`✔ Round-trip: agent=${ag.rows[0].id.slice(0,8)}… ver=${av.rows[0].id.slice(0,8)}… wf=${wf.rows[0].id.slice(0,8)}… run=${run.rows[0].id.slice(0,8)}…`);

    await client.query(`DELETE FROM public.ai_agent_run_logs WHERE id=$1`, [log.rows[0].id]);
    await client.query(`DELETE FROM public.ai_agent_runs WHERE id=$1`, [run.rows[0].id]);
    await client.query(`DELETE FROM public.ai_workflow_steps WHERE id=$1`, [st.rows[0].id]);
    await client.query(`DELETE FROM public.ai_workflows WHERE tenant_id=$1`, [tid]);
    await client.query(`DELETE FROM public.ai_agent_versions WHERE agent_id=$1`, [ag.rows[0].id]);
    await client.query(`DELETE FROM public.ai_agents WHERE tenant_id=$1`, [tid]);
    console.log("✔ Test rows cleaned up");

    const prev = await client.query(`SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('prompt_policies','ai_models','retrieval_queries','knowledge_sources')`);
    console.log(`✔ Phase 5–13 tables intact: ${prev.rows[0].cnt} spot-checked`);
    console.log("\n✔ Phase 14 migration complete");
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("Migration failed:", e.message); process.exit(1); });
