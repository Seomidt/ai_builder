/**
 * migrate-phase5p.ts — Phase 5P
 *
 * Idempotent migration: Answer Grounding, Citations & Retrieval Observability
 *
 * Creates 2 new tables:
 *   knowledge_answer_runs      (17 columns) + RLS + 2 indexes
 *   knowledge_answer_citations (12 columns) + RLS + 3 indexes
 *
 * RLS count: 97 → 99
 * No existing tables modified.
 */

import pg from "pg";

const RLS_POLICY = `
  current_setting('app.current_tenant_id', true) <> ''
  AND tenant_id::text = current_setting('app.current_tenant_id', true)
`.trim();

async function main() {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  // ── 1. knowledge_answer_runs ──────────────────────────────────────────────

  const answerRunsExists = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='knowledge_answer_runs'`,
  );

  if (answerRunsExists.rowCount === 0) {
    await client.query(`
      CREATE TABLE public.knowledge_answer_runs (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id text NOT NULL,
        retrieval_run_id varchar,
        answer_text text NOT NULL,
        generation_model text NOT NULL,
        generation_latency_ms integer,
        prompt_tokens integer,
        completion_tokens integer,
        context_chunk_count integer,
        fallback_used boolean DEFAULT false,
        fallback_reason text,
        rerank_latency_ms integer,
        shortlist_size integer,
        rerank_provider_latency_ms integer,
        rerank_provider_cost_usd numeric(10,8),
        advanced_rerank_used boolean DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    console.log("  + Table created: knowledge_answer_runs");
  } else {
    console.log("  ✓ Table already exists: knowledge_answer_runs");
  }

  // ── 2. knowledge_answer_citations ─────────────────────────────────────────

  const answerCitExists = await client.query(
    `SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='knowledge_answer_citations'`,
  );

  if (answerCitExists.rowCount === 0) {
    await client.query(`
      CREATE TABLE public.knowledge_answer_citations (
        id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
        answer_run_id varchar NOT NULL REFERENCES public.knowledge_answer_runs(id),
        tenant_id text NOT NULL,
        chunk_id varchar,
        document_id varchar,
        asset_id varchar,
        citation_index integer NOT NULL,
        context_position integer,
        chunk_text_preview text,
        source_uri text,
        final_score numeric(10,8),
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    console.log("  + Table created: knowledge_answer_citations");
  } else {
    console.log("  ✓ Table already exists: knowledge_answer_citations");
  }

  // ── 3. Indexes for knowledge_answer_runs ──────────────────────────────────

  const runIndexes: Array<[string, string]> = [
    ["kar_tenant_run_idx",     "ON public.knowledge_answer_runs (tenant_id, retrieval_run_id)"],
    ["kar_tenant_created_idx", "ON public.knowledge_answer_runs (tenant_id, created_at)"],
  ];

  for (const [idx, def] of runIndexes) {
    const exists = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`, [idx],
    );
    if (exists.rowCount === 0) {
      await client.query(`CREATE INDEX ${idx} ${def}`);
      console.log(`  + Index created: ${idx}`);
    } else {
      console.log(`  ✓ Index exists: ${idx}`);
    }
  }

  // ── 4. Indexes for knowledge_answer_citations ─────────────────────────────

  const citIndexes: Array<[string, string]> = [
    ["kac_answer_run_idx", "ON public.knowledge_answer_citations (answer_run_id)"],
    ["kac_tenant_idx",     "ON public.knowledge_answer_citations (tenant_id)"],
    ["kac_chunk_idx",      "ON public.knowledge_answer_citations (chunk_id)"],
  ];

  for (const [idx, def] of citIndexes) {
    const exists = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`, [idx],
    );
    if (exists.rowCount === 0) {
      await client.query(`CREATE INDEX ${idx} ${def}`);
      console.log(`  + Index created: ${idx}`);
    } else {
      console.log(`  ✓ Index exists: ${idx}`);
    }
  }

  // ── 5. RLS on knowledge_answer_runs ──────────────────────────────────────

  await client.query(`ALTER TABLE public.knowledge_answer_runs ENABLE ROW LEVEL SECURITY`);
  console.log("  ✓ RLS enabled: knowledge_answer_runs");

  const runPolicies: Array<[string, string, string]> = [
    ["kar_tenant_select", "SELECT", `USING (${RLS_POLICY})`],
    ["kar_tenant_insert", "INSERT", `WITH CHECK (${RLS_POLICY})`],
    ["kar_tenant_update", "UPDATE", `USING (${RLS_POLICY})`],
    ["kar_tenant_delete", "DELETE", `USING (${RLS_POLICY})`],
  ];

  for (const [name, cmd, clause] of runPolicies) {
    const pExists = await client.query(
      `SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='knowledge_answer_runs' AND policyname=$1`, [name],
    );
    if (pExists.rowCount === 0) {
      await client.query(
        `CREATE POLICY ${name} ON public.knowledge_answer_runs FOR ${cmd} ${clause}`,
      );
      console.log(`  + Policy created: ${name}`);
    } else {
      console.log(`  ✓ Policy exists: ${name}`);
    }
  }

  // ── 6. RLS on knowledge_answer_citations ──────────────────────────────────

  await client.query(`ALTER TABLE public.knowledge_answer_citations ENABLE ROW LEVEL SECURITY`);
  console.log("  ✓ RLS enabled: knowledge_answer_citations");

  const citPolicies: Array<[string, string, string]> = [
    ["kac_tenant_select", "SELECT", `USING (${RLS_POLICY})`],
    ["kac_tenant_insert", "INSERT", `WITH CHECK (${RLS_POLICY})`],
    ["kac_tenant_update", "UPDATE", `USING (${RLS_POLICY})`],
    ["kac_tenant_delete", "DELETE", `USING (${RLS_POLICY})`],
  ];

  for (const [name, cmd, clause] of citPolicies) {
    const pExists = await client.query(
      `SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='knowledge_answer_citations' AND policyname=$1`, [name],
    );
    if (pExists.rowCount === 0) {
      await client.query(
        `CREATE POLICY ${name} ON public.knowledge_answer_citations FOR ${cmd} ${clause}`,
      );
      console.log(`  + Policy created: ${name}`);
    } else {
      console.log(`  ✓ Policy exists: ${name}`);
    }
  }

  // ── 7. Verify RLS table count ─────────────────────────────────────────────

  const rlsCount = await client.query(
    `SELECT COUNT(*) as cnt FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity=true`,
  );
  const rls = parseInt(rlsCount.rows[0].cnt, 10);
  console.log(`\n✔ RLS-enabled tables: ${rls} (expected 99)`);
  if (rls !== 99) {
    throw new Error(`RLS table count mismatch: expected 99, got ${rls}`);
  }

  // ── 8. Verify knowledge_answer_runs columns ────────────────────────────────

  const karCols = await client.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_answer_runs'`,
  );
  const karColCount = parseInt(karCols.rows[0].cnt, 10);
  console.log(`✔ knowledge_answer_runs columns: ${karColCount} (expected 17)`);
  if (karColCount !== 17) {
    throw new Error(`knowledge_answer_runs column count mismatch: expected 17, got ${karColCount}`);
  }

  // ── 9. Verify knowledge_answer_citations columns ──────────────────────────

  const kacCols = await client.query(
    `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema='public' AND table_name='knowledge_answer_citations'`,
  );
  const kacColCount = parseInt(kacCols.rows[0].cnt, 10);
  console.log(`✔ knowledge_answer_citations columns: ${kacColCount} (expected 12)`);
  if (kacColCount !== 12) {
    throw new Error(`knowledge_answer_citations column count mismatch: expected 12, got ${kacColCount}`);
  }

  // ── 10. Verify all indexes ────────────────────────────────────────────────

  const allIndexes = [
    "kar_tenant_run_idx", "kar_tenant_created_idx",
    "kac_answer_run_idx", "kac_tenant_idx", "kac_chunk_idx",
  ];
  for (const idx of allIndexes) {
    const iV = await client.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1`, [idx],
    );
    if (!iV.rowCount) throw new Error(`Index MISSING: ${idx}`);
    console.log(`✔ Index present: ${idx}`);
  }

  // ── 11. Verify RLS policies ───────────────────────────────────────────────

  const allPolicies = [
    ["knowledge_answer_runs", "kar_tenant_select"],
    ["knowledge_answer_runs", "kar_tenant_insert"],
    ["knowledge_answer_runs", "kar_tenant_update"],
    ["knowledge_answer_runs", "kar_tenant_delete"],
    ["knowledge_answer_citations", "kac_tenant_select"],
    ["knowledge_answer_citations", "kac_tenant_insert"],
    ["knowledge_answer_citations", "kac_tenant_update"],
    ["knowledge_answer_citations", "kac_tenant_delete"],
  ];
  for (const [tbl, pol] of allPolicies) {
    const pV = await client.query(
      `SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename=$1 AND policyname=$2`, [tbl, pol],
    );
    if (!pV.rowCount) throw new Error(`Policy MISSING: ${pol} on ${tbl}`);
    console.log(`✔ Policy present: ${pol} on ${tbl}`);
  }

  await client.end();
  console.log("\n✔ Phase 5P migration complete — all assertions passed");
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("✗ Phase 5P migration failed:", err.message);
  process.exit(1);
});
