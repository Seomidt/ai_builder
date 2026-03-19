/**
 * Phase 7 Migration — Platform Security & Session Management
 * 7 new tables, RLS, indexes. Idempotent.
 */

import pg from "pg";

async function main() {
  const client = new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  console.log("✔ Connected to Supabase Postgres");

  try {
    // ── 1. user_mfa_methods ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.user_mfa_methods (
        id               text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id          text NOT NULL,
        method_type      text NOT NULL CHECK (method_type IN ('totp','backup_code')),
        secret_encrypted text,
        enabled          boolean NOT NULL DEFAULT false,
        created_at       timestamp NOT NULL DEFAULT now(),
        updated_at       timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ user_mfa_methods");
    await client.query(`CREATE INDEX IF NOT EXISTS umm_user_type_idx ON public.user_mfa_methods (user_id, method_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS umm_user_enabled_idx ON public.user_mfa_methods (user_id, enabled)`);

    // ── 2. mfa_recovery_codes ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.mfa_recovery_codes (
        id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id    text NOT NULL,
        code_hash  text NOT NULL,
        used       boolean NOT NULL DEFAULT false,
        used_at    timestamp,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ mfa_recovery_codes");
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS mrc_code_hash_idx ON public.mfa_recovery_codes (code_hash)`);
    await client.query(`CREATE INDEX IF NOT EXISTS mrc_user_used_idx ON public.mfa_recovery_codes (user_id, used)`);

    // ── 3. user_sessions ──────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.user_sessions (
        id                 text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        user_id            text NOT NULL,
        session_token_hash text NOT NULL,
        device_name        text,
        ip_address         text,
        user_agent         text,
        created_at         timestamp NOT NULL DEFAULT now(),
        expires_at         timestamp NOT NULL,
        revoked_at         timestamp
      )
    `);
    console.log("  ✔ user_sessions");
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS us_token_hash_idx ON public.user_sessions (session_token_hash)`);
    await client.query(`CREATE INDEX IF NOT EXISTS us_user_created_idx ON public.user_sessions (user_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS us_user_revoked_idx ON public.user_sessions (user_id, revoked_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS us_expires_idx ON public.user_sessions (expires_at)`);

    // ── 4. session_tokens ─────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.session_tokens (
        id                 text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        session_id         text NOT NULL REFERENCES public.user_sessions(id),
        refresh_token_hash text NOT NULL,
        created_at         timestamp NOT NULL DEFAULT now(),
        expires_at         timestamp NOT NULL
      )
    `);
    console.log("  ✔ session_tokens");
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS st_refresh_hash_idx ON public.session_tokens (refresh_token_hash)`);
    await client.query(`CREATE INDEX IF NOT EXISTS st_session_created_idx ON public.session_tokens (session_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS st_expires_idx ON public.session_tokens (expires_at)`);

    // ── 5. session_revocations ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.session_revocations (
        id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        session_id  text NOT NULL REFERENCES public.user_sessions(id),
        revoked_by  text,
        revoked_at  timestamp NOT NULL DEFAULT now(),
        reason      text
      )
    `);
    console.log("  ✔ session_revocations");
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS sr_session_idx ON public.session_revocations (session_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS sr_revoked_at_idx ON public.session_revocations (revoked_at)`);

    // ── 6. tenant_ip_allowlists ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.tenant_ip_allowlists (
        id          text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id   text NOT NULL,
        ip_range    text NOT NULL,
        description text,
        created_at  timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ tenant_ip_allowlists");
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS tia_tenant_range_idx ON public.tenant_ip_allowlists (tenant_id, ip_range)`);
    await client.query(`CREATE INDEX IF NOT EXISTS tia_tenant_created_idx ON public.tenant_ip_allowlists (tenant_id, created_at)`);

    // ── 7. security_events ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.security_events (
        id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id  text,
        user_id    text,
        event_type text NOT NULL CHECK (event_type IN (
          'login_success','login_failed','mfa_enabled','mfa_disabled',
          'session_revoked','session_created','suspicious_login',
          'ip_blocked','rate_limited','upload_rejected'
        )),
        ip_address text,
        metadata   jsonb,
        created_at timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ security_events");
    await client.query(`CREATE INDEX IF NOT EXISTS se_tenant_type_created_idx ON public.security_events (tenant_id, event_type, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS se_user_type_created_idx ON public.security_events (user_id, event_type, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS se_type_created_idx ON public.security_events (event_type, created_at)`);

    // ── RLS ───────────────────────────────────────────────────────────────────
    const tables = [
      "user_mfa_methods", "mfa_recovery_codes", "user_sessions",
      "session_tokens", "session_revocations", "tenant_ip_allowlists", "security_events",
    ];
    for (const t of tables) {
      await client.query(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    }
    console.log("  ✔ RLS enabled on all 7 new tables");

    // Tenant isolation RLS for tenant_ip_allowlists
    const policyCheck = await client.query(
      `SELECT 1 FROM pg_policies WHERE tablename='tenant_ip_allowlists' AND policyname='tia_tenant_isolation'`,
    );
    if (policyCheck.rows.length === 0) {
      await client.query(`
        CREATE POLICY "tia_tenant_isolation" ON public.tenant_ip_allowlists
        USING (
          current_setting('app.current_tenant_id', true) <> ''
          AND tenant_id::text = current_setting('app.current_tenant_id', true)
        )
      `);
    }

    const seCheck = await client.query(
      `SELECT 1 FROM pg_policies WHERE tablename='security_events' AND policyname='se_tenant_isolation'`,
    );
    if (seCheck.rows.length === 0) {
      await client.query(`
        CREATE POLICY "se_tenant_isolation" ON public.security_events
        USING (
          tenant_id IS NULL OR
          current_setting('app.current_tenant_id', true) <> '' AND
          tenant_id::text = current_setting('app.current_tenant_id', true)
        )
      `);
    }
    console.log("  ✔ RLS policies created");

    // ── Verification ──────────────────────────────────────────────────────────
    const tableCheck = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)
      ORDER BY table_name
    `, [tables]);
    console.log(`\n✔ Tables verified (${tableCheck.rows.length}/7):`);
    for (const r of tableCheck.rows) console.log(`  - ${r.table_name}`);

    const totalRls = await client.query(
      `SELECT COUNT(*) as cnt FROM pg_tables WHERE schemaname='public' AND rowsecurity=true`,
    );
    console.log(`✔ Total RLS tables: ${totalRls.rows[0].cnt}`);
    console.log("\n✔ Phase 7 migration complete");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
