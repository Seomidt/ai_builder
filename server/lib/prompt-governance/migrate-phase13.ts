/**
 * Phase 13 Migration — Prompt Governance & AI Safety Platform
 * 6 new tables: prompt_policies, prompt_reviews, prompt_approvals,
 *               prompt_redteam_tests, prompt_policy_violations, prompt_change_log
 * Idempotent — safe to re-run. Does NOT alter Phase 5–12 tables.
 */

import pg from "pg";

const TABLES = [
  "prompt_policies", "prompt_reviews", "prompt_approvals",
  "prompt_redteam_tests", "prompt_policy_violations", "prompt_change_log",
];

async function main() {
  const client = new pg.Client({ connectionString: process.env.SUPABASE_DB_POOL_URL, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  try {
    const existing = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`, [TABLES]);
    console.log(`\nExisting Phase 13 tables: ${existing.rows.map((r) => r.table_name).join(", ") || "none"}`);

    // ── 1. prompt_policies ────────────────────────────────────────────────────
    console.log("\n── Creating prompt_policies...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.prompt_policies (
        id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id   text NOT NULL,
        policy_name text NOT NULL,
        policy_type text NOT NULL CHECK (policy_type IN ('content_safety','injection_prevention','topic_restriction','output_format','approval_required','rate_limit')),
        policy_rules jsonb NOT NULL DEFAULT '{}'::jsonb,
        is_active   boolean NOT NULL DEFAULT true,
        created_at  timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS prompt_policies_tenant_name_unique ON public.prompt_policies (tenant_id, policy_name)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_policies_tenant_id_idx ON public.prompt_policies (tenant_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_policies_type_idx ON public.prompt_policies (policy_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_policies_is_active_idx ON public.prompt_policies (is_active)`);
    console.log("  ✔ prompt_policies — table + 4 indexes");

    // ── 2. prompt_reviews ─────────────────────────────────────────────────────
    console.log("\n── Creating prompt_reviews...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.prompt_reviews (
        id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        prompt_version_id text NOT NULL,
        reviewer_id       text NOT NULL,
        review_status     text NOT NULL DEFAULT 'pending'
                          CHECK (review_status IN ('pending','approved','rejected','changes_requested')),
        review_notes      text,
        created_at        timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_reviews_version_id_idx ON public.prompt_reviews (prompt_version_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_reviews_reviewer_id_idx ON public.prompt_reviews (reviewer_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_reviews_status_idx ON public.prompt_reviews (review_status)`);
    console.log("  ✔ prompt_reviews — table + 3 indexes");

    // ── 3. prompt_approvals ───────────────────────────────────────────────────
    console.log("\n── Creating prompt_approvals...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.prompt_approvals (
        id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        prompt_version_id text NOT NULL,
        approved_by       text NOT NULL,
        approval_status   text NOT NULL DEFAULT 'pending'
                          CHECK (approval_status IN ('pending','approved','rejected','revoked')),
        approved_at       timestamp
      )
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS prompt_approvals_version_unique ON public.prompt_approvals (prompt_version_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_approvals_version_id_idx ON public.prompt_approvals (prompt_version_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_approvals_status_idx ON public.prompt_approvals (approval_status)`);
    console.log("  ✔ prompt_approvals — table + 3 indexes (1 unique)");

    // ── 4. prompt_redteam_tests ───────────────────────────────────────────────
    console.log("\n── Creating prompt_redteam_tests...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.prompt_redteam_tests (
        id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        prompt_version_id text NOT NULL,
        test_input        text NOT NULL,
        expected_behavior text NOT NULL,
        test_result       text CHECK (test_result IS NULL OR test_result IN ('passed','failed','skipped')),
        created_at        timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_redteam_tests_version_id_idx ON public.prompt_redteam_tests (prompt_version_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_redteam_tests_result_idx ON public.prompt_redteam_tests (test_result)`);
    console.log("  ✔ prompt_redteam_tests — table + 2 indexes");

    // ── 5. prompt_policy_violations ───────────────────────────────────────────
    console.log("\n── Creating prompt_policy_violations...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.prompt_policy_violations (
        id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        request_id     text NOT NULL,
        policy_id      text NOT NULL,
        violation_type text NOT NULL
                       CHECK (violation_type IN ('injection_attempt','topic_violation','output_violation','approval_bypass','rate_limit_exceeded','content_safety')),
        created_at     timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_policy_violations_request_id_idx ON public.prompt_policy_violations (request_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_policy_violations_policy_id_idx ON public.prompt_policy_violations (policy_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_policy_violations_type_idx ON public.prompt_policy_violations (violation_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_policy_violations_created_at_idx ON public.prompt_policy_violations (created_at)`);
    console.log("  ✔ prompt_policy_violations — table + 4 indexes");

    // ── 6. prompt_change_log ──────────────────────────────────────────────────
    console.log("\n── Creating prompt_change_log...");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.prompt_change_log (
        id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        prompt_version_id text NOT NULL,
        change_type       text NOT NULL
                          CHECK (change_type IN ('created','reviewed','approved','rejected','revoked','redteam_tested','policy_applied','executed')),
        changed_by        text NOT NULL,
        change_description text NOT NULL,
        created_at        timestamp NOT NULL DEFAULT now()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_change_log_version_id_idx ON public.prompt_change_log (prompt_version_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_change_log_changed_by_idx ON public.prompt_change_log (changed_by)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_change_log_created_at_idx ON public.prompt_change_log (created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS prompt_change_log_type_idx ON public.prompt_change_log (change_type)`);
    console.log("  ✔ prompt_change_log — table + 4 indexes");

    // ── 7. RLS ────────────────────────────────────────────────────────────────
    console.log("\n── Enabling RLS...");
    for (const t of TABLES) await client.query(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    console.log("  ✔ RLS enabled on all 6 Phase 13 tables");

    const RLS: Record<string, string> = {
      prompt_policies: `current_setting('app.current_tenant_id', true) <> '' AND tenant_id::text = current_setting('app.current_tenant_id', true)`,
      prompt_reviews: `EXISTS (SELECT 1 FROM public.ai_prompt_versions apv JOIN public.ai_prompts ap ON ap.id=apv.prompt_id WHERE apv.id=prompt_reviews.prompt_version_id AND ap.tenant_id::text=current_setting('app.current_tenant_id',true))`,
      prompt_approvals: `EXISTS (SELECT 1 FROM public.ai_prompt_versions apv JOIN public.ai_prompts ap ON ap.id=apv.prompt_id WHERE apv.id=prompt_approvals.prompt_version_id AND ap.tenant_id::text=current_setting('app.current_tenant_id',true))`,
      prompt_redteam_tests: `EXISTS (SELECT 1 FROM public.ai_prompt_versions apv JOIN public.ai_prompts ap ON ap.id=apv.prompt_id WHERE apv.id=prompt_redteam_tests.prompt_version_id AND ap.tenant_id::text=current_setting('app.current_tenant_id',true))`,
      prompt_policy_violations: `EXISTS (SELECT 1 FROM public.prompt_policies pp WHERE pp.id=prompt_policy_violations.policy_id AND pp.tenant_id::text=current_setting('app.current_tenant_id',true))`,
      prompt_change_log: `EXISTS (SELECT 1 FROM public.ai_prompt_versions apv JOIN public.ai_prompts ap ON ap.id=apv.prompt_id WHERE apv.id=prompt_change_log.prompt_version_id AND ap.tenant_id::text=current_setting('app.current_tenant_id',true))`,
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
    const tableR = await client.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1) ORDER BY table_name`, [TABLES]);
    console.log(`✔ Tables verified (${tableR.rows.length}/6): ${tableR.rows.map((r) => r.table_name).join(", ")}`);

    const rlsR = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity=true AND tablename = ANY($1)`, [TABLES]);
    console.log(`✔ RLS verified (${rlsR.rows.length}/6)`);

    const totalRls = await client.query(`SELECT COUNT(*) as cnt FROM pg_tables WHERE schemaname='public' AND rowsecurity=true`);
    console.log(`✔ Total RLS tables: ${totalRls.rows[0].cnt}`);

    const idxR = await client.query(`SELECT COUNT(*) as cnt FROM pg_indexes WHERE schemaname='public' AND tablename = ANY($1)`, [TABLES]);
    console.log(`✔ Phase 13 indexes: ${idxR.rows[0].cnt}`);

    // Round-trip test
    const tid = `p13-test-${Date.now()}`;
    const polR = await client.query(`INSERT INTO public.prompt_policies (tenant_id,policy_name,policy_type) VALUES ($1,'test-policy','content_safety') RETURNING id`, [tid]);
    const polId = polR.rows[0].id;
    const vio = await client.query(`INSERT INTO public.prompt_policy_violations (request_id,policy_id,violation_type) VALUES ('req-test',$1,'content_safety') RETURNING id`, [polId]);
    const chg = await client.query(`INSERT INTO public.prompt_change_log (prompt_version_id,change_type,changed_by,change_description) VALUES ('ver-test','created','system','Round-trip test') RETURNING id`);
    console.log(`✔ Round-trip: policy=${polId.slice(0,8)}… vio=${vio.rows[0].id.slice(0,8)}… log=${chg.rows[0].id.slice(0,8)}…`);
    await client.query(`DELETE FROM public.prompt_policy_violations WHERE policy_id=$1`, [polId]);
    await client.query(`DELETE FROM public.prompt_policies WHERE tenant_id=$1`, [tid]);
    await client.query(`DELETE FROM public.prompt_change_log WHERE id=$1`, [chg.rows[0].id]);
    console.log("✔ Test rows cleaned up");

    const prev = await client.query(`SELECT COUNT(*) as cnt FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('ai_models','retrieval_queries','knowledge_sources','ingestion_chunks')`);
    console.log(`✔ Phase 5–12 tables intact: ${prev.rows[0].cnt} spot-checked`);
    console.log("\n✔ Phase 13 migration complete");
  } finally {
    await client.end();
  }
}

main().catch((e) => { console.error("Migration failed:", e.message); process.exit(1); });
