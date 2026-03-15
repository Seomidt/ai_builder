/**
 * Phase 11 Migration — Retrieval Engine Platform
 * 4 new tables:
 *   retrieval_queries, retrieval_results,
 *   retrieval_query_metrics, retrieval_feedback
 * Idempotent — safe to re-run.
 * Does NOT alter Phase 5 retrieval_metrics or any Phase 10 tables.
 */

import pg from "pg";

async function main() {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  const TABLES = ["retrieval_queries","retrieval_results","retrieval_query_metrics","retrieval_feedback"];

  try {
    // Check existing
    const existing = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
      [TABLES],
    );
    console.log(`\nExisting Phase 11 tables: ${existing.rows.map((r) => r.table_name).join(", ") || "none"}`);

    // Ensure pg_trgm for SIMILARITY()
    await client.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm`);
    console.log("✔ pg_trgm extension ensured");

    // ── 1. retrieval_queries ──────────────────────────────────────────────────
    console.log("\n── Creating retrieval_queries...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.retrieval_queries (
        id                 text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id          text NOT NULL,
        query_text         text NOT NULL,
        query_embedding    jsonb,
        retrieval_strategy text NOT NULL DEFAULT 'hybrid'
                           CHECK (retrieval_strategy IN ('vector','lexical','hybrid')),
        top_k              integer NOT NULL DEFAULT 10
                           CHECK (top_k BETWEEN 1 AND 100),
        created_at         timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS retrieval_queries_tenant_id_idx ON public.retrieval_queries (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS retrieval_queries_created_at_idx ON public.retrieval_queries (created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS retrieval_queries_tenant_strategy_idx ON public.retrieval_queries (tenant_id, retrieval_strategy)`);
    console.log("  ✔ retrieval_queries — table + 3 indexes");

    const rqV = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='retrieval_queries' ORDER BY ordinal_position`);
    console.log(`  ✔ columns (${rqV.rows.length}): ${rqV.rows.map((r) => r.column_name).join(", ")}`);
    const rqCk = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.retrieval_queries'::regclass AND contype='c'`);
    console.log(`  ✔ CHECKs (${rqCk.rows.length}): ${rqCk.rows.map((r) => r.conname).join(", ")}`);

    // ── 2. retrieval_results ──────────────────────────────────────────────────
    console.log("\n── Creating retrieval_results...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.retrieval_results (
        id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        query_id       text NOT NULL,
        chunk_id       text NOT NULL,
        score_vector   numeric,
        score_lexical  numeric,
        score_combined numeric NOT NULL DEFAULT 0,
        rank_position  integer NOT NULL,
        created_at     timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS retrieval_results_query_chunk_unique ON public.retrieval_results (query_id, chunk_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS retrieval_results_query_id_idx ON public.retrieval_results (query_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS retrieval_results_chunk_id_idx ON public.retrieval_results (chunk_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS retrieval_results_query_rank_idx ON public.retrieval_results (query_id, rank_position)`);
    console.log("  ✔ retrieval_results — table + 4 indexes (1 unique)");

    // ── 3. retrieval_query_metrics ────────────────────────────────────────────
    console.log("\n── Creating retrieval_query_metrics...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.retrieval_query_metrics (
        id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id      text NOT NULL,
        query_id       text NOT NULL,
        latency_ms     integer NOT NULL CHECK (latency_ms >= 0),
        vector_hits    integer NOT NULL DEFAULT 0,
        lexical_hits   integer NOT NULL DEFAULT 0,
        total_results  integer NOT NULL DEFAULT 0,
        created_at     timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS retrieval_query_metrics_query_id_unique ON public.retrieval_query_metrics (query_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS retrieval_query_metrics_tenant_id_idx ON public.retrieval_query_metrics (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS retrieval_query_metrics_query_id_idx ON public.retrieval_query_metrics (query_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS retrieval_query_metrics_latency_idx ON public.retrieval_query_metrics (latency_ms)`);
    await client.query(`CREATE INDEX IF NOT EXISTS retrieval_query_metrics_tenant_created_idx ON public.retrieval_query_metrics (tenant_id, created_at)`);
    console.log("  ✔ retrieval_query_metrics — table + 5 indexes (1 unique)");

    const mqCk = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.retrieval_query_metrics'::regclass AND contype='c'`);
    console.log(`  ✔ CHECKs (${mqCk.rows.length}): ${mqCk.rows.map((r) => r.conname).join(", ")}`);

    // ── 4. retrieval_feedback ─────────────────────────────────────────────────
    console.log("\n── Creating retrieval_feedback...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.retrieval_feedback (
        id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        query_id      text NOT NULL,
        chunk_id      text NOT NULL,
        feedback_type text NOT NULL
                      CHECK (feedback_type IN ('relevant','irrelevant','partial','thumbs_up','thumbs_down')),
        tenant_id     text NOT NULL,
        created_at    timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS retrieval_feedback_query_id_idx ON public.retrieval_feedback (query_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS retrieval_feedback_chunk_id_idx ON public.retrieval_feedback (chunk_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS retrieval_feedback_tenant_id_idx ON public.retrieval_feedback (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS retrieval_feedback_tenant_created_idx ON public.retrieval_feedback (tenant_id, created_at)`);
    console.log("  ✔ retrieval_feedback — table + 4 indexes");

    const rfCk = await client.query(`SELECT conname FROM pg_constraint WHERE conrelid='public.retrieval_feedback'::regclass AND contype='c'`);
    console.log(`  ✔ CHECKs (${rfCk.rows.length}): ${rfCk.rows.map((r) => r.conname).join(", ")}`);

    // ── 5. RLS ────────────────────────────────────────────────────────────────
    console.log("\n── Enabling RLS...");
    const RLS_MAP: Record<string, string> = {
      retrieval_queries: "tenant_id",
      retrieval_results: "query_id",      // results isolated via query ownership
      retrieval_query_metrics: "tenant_id",
      retrieval_feedback: "tenant_id",
    };

    for (const table of TABLES) {
      await client.query(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY`);
    }
    console.log("  ✔ RLS enabled on all 4 Phase 11 tables");

    // Tenant isolation policies
    for (const [table, col] of Object.entries(RLS_MAP)) {
      const pName = `${table.replace(/_/g, "")}_tenant_isolation`;
      const exists = await client.query(`SELECT 1 FROM pg_policies WHERE tablename = $1 AND policyname = $2`, [table, pName]);
      if (exists.rows.length === 0) {
        let policy: string;
        if (col === "query_id") {
          // retrieval_results — tenant isolation via JOIN to retrieval_queries
          policy = `
            CREATE POLICY "${pName}" ON public.${table}
            USING (
              current_setting('app.current_tenant_id', true) <> ''
              AND EXISTS (
                SELECT 1 FROM public.retrieval_queries rq
                WHERE rq.id = ${table}.query_id
                  AND rq.tenant_id::text = current_setting('app.current_tenant_id', true)
              )
            )`;
        } else {
          policy = `
            CREATE POLICY "${pName}" ON public.${table}
            USING (
              current_setting('app.current_tenant_id', true) <> ''
              AND ${col}::text = current_setting('app.current_tenant_id', true)
            )`;
        }
        await client.query(policy);
        console.log(`  ✔ ${table} RLS policy created`);
      } else {
        console.log(`  ✔ ${table} RLS policy already exists`);
      }
    }

    // ── 6. Verification ───────────────────────────────────────────────────────
    console.log("\n── Verification...");

    const tableR = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1) ORDER BY table_name`,
      [TABLES],
    );
    console.log(`✔ Tables verified (${tableR.rows.length}/4): ${tableR.rows.map((r) => r.table_name).join(", ")}`);

    const rlsR = await client.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity=true AND tablename = ANY($1)`,
      [TABLES],
    );
    console.log(`✔ RLS verified (${rlsR.rows.length}/4): ${rlsR.rows.map((r) => r.tablename).join(", ")}`);

    const totalRls = await client.query(`SELECT COUNT(*) as cnt FROM pg_tables WHERE schemaname='public' AND rowsecurity=true`);
    console.log(`✔ Total RLS tables: ${totalRls.rows[0].cnt}`);

    const idxR = await client.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename = ANY($1) ORDER BY indexname`,
      [TABLES],
    );
    console.log(`✔ Phase 11 indexes (${idxR.rows.length}): ${idxR.rows.map((r) => r.indexname).join(", ")}`);

    // Round-trip test
    const tid = `migrate-test-p11-${Date.now()}`;
    const qR = await client.query(`INSERT INTO public.retrieval_queries (tenant_id, query_text, retrieval_strategy, top_k) VALUES ($1, 'test query', 'hybrid', 5) RETURNING id`, [tid]);
    const qId = qR.rows[0].id;
    await client.query(`INSERT INTO public.retrieval_results (query_id, chunk_id, score_combined, rank_position) VALUES ($1, 'chunk-test', 0.75, 1)`, [qId]);
    await client.query(`INSERT INTO public.retrieval_query_metrics (tenant_id, query_id, latency_ms, vector_hits, lexical_hits, total_results) VALUES ($1, $2, 100, 3, 2, 5)`, [tid, qId]);
    await client.query(`INSERT INTO public.retrieval_feedback (query_id, chunk_id, feedback_type, tenant_id) VALUES ($1, 'chunk-test', 'relevant', $2)`, [qId, tid]);
    console.log(`✔ Round-trip: q=${qId.slice(0,8)}…`);

    // Cleanup
    await client.query(`DELETE FROM public.retrieval_feedback WHERE tenant_id = $1`, [tid]);
    await client.query(`DELETE FROM public.retrieval_query_metrics WHERE tenant_id = $1`, [tid]);
    await client.query(`DELETE FROM public.retrieval_results WHERE query_id = $1`, [qId]);
    await client.query(`DELETE FROM public.retrieval_queries WHERE tenant_id = $1`, [tid]);
    console.log("✔ Test rows cleaned up");

    // Verify Phase 5 + Phase 10 tables untouched
    const prevPhases = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('retrieval_metrics','knowledge_sources','ingestion_documents','ingestion_chunks','ingestion_embeddings','knowledge_index_entries') ORDER BY table_name`,
    );
    console.log(`✔ Phase 5/10 tables intact (${prevPhases.rows.length}): ${prevPhases.rows.map((r) => r.table_name).join(", ")}`);

    console.log("\n✔ Phase 11 migration complete");
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("Migration failed:", e.message); process.exit(1); });
