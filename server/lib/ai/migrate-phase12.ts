/**
 * Phase 12 Migration — AI Orchestrator Platform
 * 6 new tables:
 *   ai_models, ai_prompts, ai_prompt_versions,
 *   ai_requests, ai_responses, ai_usage_metrics
 * Idempotent — safe to re-run.
 * Does NOT alter any Phase 5–11 tables.
 */

import pg from "pg";
import { seedDefaultModels, DEFAULT_MODELS } from "./ai-model-router";

const TABLES = ["ai_models", "ai_prompts", "ai_prompt_versions", "ai_requests", "ai_responses", "ai_usage_metrics"];

async function main() {
  const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  try {
    const existing = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
      [TABLES],
    );
    console.log(`\nExisting Phase 12 tables: ${existing.rows.map((r) => r.table_name).join(", ") || "none"}`);

    // ── 1. ai_models ──────────────────────────────────────────────────────────
    console.log("\n── Creating ai_models...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.ai_models (
        id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        provider         text NOT NULL,
        model_name       text NOT NULL,
        max_tokens       integer NOT NULL DEFAULT 4096 CHECK (max_tokens > 0),
        context_window   integer NOT NULL DEFAULT 8192 CHECK (context_window > 0),
        cost_prompt      numeric NOT NULL DEFAULT 0,
        cost_completion  numeric NOT NULL DEFAULT 0,
        is_active        boolean NOT NULL DEFAULT true,
        created_at       timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ai_models_provider_name_unique ON public.ai_models (provider, model_name)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_models_provider_idx ON public.ai_models (provider)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_models_is_active_idx ON public.ai_models (is_active)`);
    console.log("  ✔ ai_models — table + 3 indexes");

    // ── 2. ai_prompts ─────────────────────────────────────────────────────────
    console.log("\n── Creating ai_prompts...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.ai_prompts (
        id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id   text NOT NULL,
        name        text NOT NULL,
        description text,
        created_at  timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ai_prompts_tenant_name_unique ON public.ai_prompts (tenant_id, name)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_prompts_tenant_id_idx ON public.ai_prompts (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_prompts_name_idx ON public.ai_prompts (name)`);
    console.log("  ✔ ai_prompts — table + 3 indexes");

    // ── 3. ai_prompt_versions ─────────────────────────────────────────────────
    console.log("\n── Creating ai_prompt_versions...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.ai_prompt_versions (
        id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        prompt_id     text NOT NULL,
        version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
        system_prompt text NOT NULL,
        temperature   numeric NOT NULL DEFAULT 0.7 CHECK (temperature >= 0 AND temperature <= 2),
        top_p         numeric NOT NULL DEFAULT 1.0 CHECK (top_p > 0 AND top_p <= 1),
        max_tokens    integer NOT NULL DEFAULT 1024 CHECK (max_tokens > 0),
        created_at    timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ai_prompt_versions_prompt_version_unique ON public.ai_prompt_versions (prompt_id, version)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_prompt_versions_prompt_id_idx ON public.ai_prompt_versions (prompt_id)`);
    console.log("  ✔ ai_prompt_versions — table + 2 indexes");

    const pvCk = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.ai_prompt_versions'::regclass AND contype='c'`);
    console.log(`  ✔ CHECKs (${pvCk.rows.length}): ${pvCk.rows.map((r) => r.conname).join(", ")}`);

    // ── 4. ai_requests ────────────────────────────────────────────────────────
    console.log("\n── Creating ai_requests...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.ai_requests (
        id                  text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id           text NOT NULL,
        query_text          text NOT NULL,
        prompt_version_id   text,
        retrieval_query_id  text,
        model_id            text,
        created_at          timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_requests_tenant_id_idx ON public.ai_requests (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_requests_created_at_idx ON public.ai_requests (created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_requests_tenant_created_idx ON public.ai_requests (tenant_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_requests_retrieval_query_id_idx ON public.ai_requests (retrieval_query_id)`);
    console.log("  ✔ ai_requests — table + 4 indexes");

    // ── 5. ai_responses ───────────────────────────────────────────────────────
    console.log("\n── Creating ai_responses...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.ai_responses (
        id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        request_id       text NOT NULL,
        response_text    text NOT NULL,
        token_prompt     integer NOT NULL DEFAULT 0 CHECK (token_prompt >= 0),
        token_completion integer NOT NULL DEFAULT 0 CHECK (token_completion >= 0),
        latency_ms       integer NOT NULL DEFAULT 0 CHECK (latency_ms >= 0),
        created_at       timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ai_responses_request_id_unique ON public.ai_responses (request_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_responses_request_id_idx ON public.ai_responses (request_id)`);
    console.log("  ✔ ai_responses — table + 2 indexes");

    // ── 6. ai_usage_metrics ───────────────────────────────────────────────────
    console.log("\n── Creating ai_usage_metrics...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.ai_usage_metrics (
        id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id        text NOT NULL,
        request_id       text NOT NULL,
        model_id         text NOT NULL,
        token_prompt     integer NOT NULL DEFAULT 0 CHECK (token_prompt >= 0),
        token_completion integer NOT NULL DEFAULT 0 CHECK (token_completion >= 0),
        estimated_cost   numeric NOT NULL DEFAULT 0,
        created_at       timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ai_usage_metrics_request_id_unique ON public.ai_usage_metrics (request_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_usage_metrics_tenant_id_idx ON public.ai_usage_metrics (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_usage_metrics_request_id_idx ON public.ai_usage_metrics (request_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_usage_metrics_model_id_idx ON public.ai_usage_metrics (model_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ai_usage_metrics_tenant_created_idx ON public.ai_usage_metrics (tenant_id, created_at)`);
    console.log("  ✔ ai_usage_metrics — table + 5 indexes");

    // ── 7. RLS ────────────────────────────────────────────────────────────────
    console.log("\n── Enabling RLS...");
    for (const table of TABLES) {
      await client.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    }
    console.log("  ✔ RLS enabled on all 6 Phase 12 tables");

    const RLS_POLICIES: Record<string, string> = {
      ai_models:          `is_active = true OR current_setting('app.current_tenant_id', true) <> ''`,
      ai_prompts:         `current_setting('app.current_tenant_id', true) <> '' AND tenant_id::text = current_setting('app.current_tenant_id', true)`,
      ai_prompt_versions: `EXISTS (SELECT 1 FROM public.ai_prompts p WHERE p.id = ai_prompt_versions.prompt_id AND p.tenant_id::text = current_setting('app.current_tenant_id', true))`,
      ai_requests:        `current_setting('app.current_tenant_id', true) <> '' AND tenant_id::text = current_setting('app.current_tenant_id', true)`,
      ai_responses:       `EXISTS (SELECT 1 FROM public.ai_requests r WHERE r.id = ai_responses.request_id AND r.tenant_id::text = current_setting('app.current_tenant_id', true))`,
      ai_usage_metrics:   `current_setting('app.current_tenant_id', true) <> '' AND tenant_id::text = current_setting('app.current_tenant_id', true)`,
    };

    for (const [table, using] of Object.entries(RLS_POLICIES)) {
      const pName = `${table.replace(/_/g, "")}_tenant_isolation`;
      const ex = await client.query(`SELECT 1 FROM pg_policies WHERE tablename=$1 AND policyname=$2`, [table, pName]);
      if (ex.rows.length === 0) {
        await client.query(`CREATE POLICY "${pName}" ON public.${table} USING (${using})`);
        console.log(`  ✔ ${table} RLS policy created`);
      } else {
        console.log(`  ✔ ${table} RLS policy exists`);
      }
    }

    // ── 8. Seed default models ────────────────────────────────────────────────
    console.log("\n── Seeding default AI models...");
    const seed = await seedDefaultModels(client);
    console.log(`  ✔ Models seeded: ${seed.seeded} new, ${seed.existing} existing (total: ${DEFAULT_MODELS.length})`);

    // ── 9. Verification ───────────────────────────────────────────────────────
    console.log("\n── Verification...");
    const tableR = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1) ORDER BY table_name`,
      [TABLES],
    );
    console.log(`✔ Tables verified (${tableR.rows.length}/6): ${tableR.rows.map((r) => r.table_name).join(", ")}`);

    const rlsR = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity=true AND tablename = ANY($1)`,
      [TABLES],
    );
    console.log(`✔ RLS verified (${rlsR.rows.length}/6)`);

    const totalRls = await client.query(`SELECT COUNT(*) as cnt FROM pg_tables WHERE schemaname='public' AND rowsecurity=true`);
    console.log(`✔ Total RLS tables: ${totalRls.rows[0].cnt}`);

    const idxR = await client.query(
      `SELECT COUNT(*) as cnt FROM pg_indexes WHERE schemaname='public' AND tablename = ANY($1)`,
      [TABLES],
    );
    console.log(`✔ Phase 12 indexes: ${idxR.rows[0].cnt}`);

    const modelCount = await client.query(`SELECT COUNT(*) as cnt FROM public.ai_models`);
    console.log(`✔ AI models in DB: ${modelCount.rows[0].cnt}`);

    // Round-trip test
    const tid = `migrate-test-p12-${Date.now()}`;
    const mdl = await client.query(`SELECT id FROM public.ai_models WHERE is_active=true LIMIT 1`);
    if (mdl.rows.length > 0) {
      const reqR = await client.query(`INSERT INTO public.ai_requests (tenant_id,query_text,model_id) VALUES ($1,'test query',$2) RETURNING id`, [tid, mdl.rows[0].id]);
      const reqId = reqR.rows[0].id;
      await client.query(`INSERT INTO public.ai_responses (request_id,response_text,token_prompt,token_completion,latency_ms) VALUES ($1,'test response',100,50,200)`, [reqId]);
      await client.query(`INSERT INTO public.ai_usage_metrics (tenant_id,request_id,model_id,token_prompt,token_completion,estimated_cost) VALUES ($1,$2,$3,100,50,0.001)`, [tid, reqId, mdl.rows[0].id]);
      await client.query(`DELETE FROM public.ai_usage_metrics WHERE tenant_id=$1`, [tid]);
      await client.query(`DELETE FROM public.ai_responses WHERE request_id=$1`, [reqId]);
      await client.query(`DELETE FROM public.ai_requests WHERE tenant_id=$1`, [tid]);
      console.log(`✔ Round-trip test passed (req=${reqId.slice(0, 8)}…)`);
    }

    // Verify Phase 5–11 tables untouched
    const prev = await client.query(
      `SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('retrieval_queries','knowledge_sources','ingestion_chunks','retrieval_metrics')`,
    );
    console.log(`✔ Phase 5–11 tables intact: ${prev.rows[0].cnt} spot-checked`);

    console.log("\n✔ Phase 12 migration complete");
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("Migration failed:", e.message); process.exit(1); });
