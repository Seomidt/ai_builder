/**
 * Phase 6 Migration — Identity, RBAC & Actor Governance Foundation
 * 12 new tables + RLS policies + indexes + constraints.
 * Idempotent: each step inspects first, applies only if missing.
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
    // ── 1. app_user_profiles ──────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.app_user_profiles (
        id           text PRIMARY KEY,
        email        text,
        display_name text,
        avatar_url   text,
        status       text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','suspended','disabled')),
        metadata     jsonb,
        last_seen_at timestamp,
        created_at   timestamp NOT NULL DEFAULT now(),
        updated_at   timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ app_user_profiles table");

    await client.query(`CREATE INDEX IF NOT EXISTS aup_status_created_idx ON public.app_user_profiles (status, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aup_email_idx ON public.app_user_profiles (email)`);
    console.log("  ✔ app_user_profiles indexes");

    // ── 2. tenant_memberships ─────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.tenant_memberships (
        id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id         text NOT NULL,
        user_id           text NOT NULL REFERENCES public.app_user_profiles(id),
        membership_status text NOT NULL DEFAULT 'active'
                          CHECK (membership_status IN ('invited','active','suspended','removed')),
        joined_at         timestamp,
        invited_at        timestamp,
        invited_by        text REFERENCES public.app_user_profiles(id),
        suspended_at      timestamp,
        removed_at        timestamp,
        metadata          jsonb,
        created_at        timestamp NOT NULL DEFAULT now(),
        updated_at        timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ tenant_memberships table");
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS tm_tenant_user_idx ON public.tenant_memberships (tenant_id, user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS tm_tenant_status_created_idx ON public.tenant_memberships (tenant_id, membership_status, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS tm_user_status_created_idx ON public.tenant_memberships (user_id, membership_status, created_at)`);
    console.log("  ✔ tenant_memberships indexes");

    // ── 3. roles ──────────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.roles (
        id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id       text,
        role_code       text NOT NULL,
        name            text NOT NULL,
        description     text,
        is_system_role  boolean NOT NULL DEFAULT false,
        role_scope      text NOT NULL DEFAULT 'tenant'
                        CHECK (role_scope IN ('system','tenant')),
        lifecycle_state text NOT NULL DEFAULT 'active'
                        CHECK (lifecycle_state IN ('active','archived','disabled')),
        metadata        jsonb,
        created_by      text REFERENCES public.app_user_profiles(id),
        created_at      timestamp NOT NULL DEFAULT now(),
        updated_at      timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ roles table");
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS roles_scope_tenant_code_idx ON public.roles (role_scope, COALESCE(tenant_id, ''), role_code)`);
    await client.query(`CREATE INDEX IF NOT EXISTS roles_tenant_lifecycle_created_idx ON public.roles (tenant_id, lifecycle_state, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS roles_scope_code_idx ON public.roles (role_scope, role_code)`);
    console.log("  ✔ roles indexes");

    // ── 4. permissions ────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.permissions (
        id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        permission_code   text NOT NULL,
        name              text NOT NULL,
        description       text,
        permission_domain text NOT NULL,
        lifecycle_state   text NOT NULL DEFAULT 'active'
                          CHECK (lifecycle_state IN ('active','archived')),
        metadata          jsonb,
        created_at        timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ permissions table");
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS permissions_code_idx ON public.permissions (permission_code)`);
    await client.query(`CREATE INDEX IF NOT EXISTS permissions_domain_created_idx ON public.permissions (permission_domain, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS permissions_lifecycle_created_idx ON public.permissions (lifecycle_state, created_at)`);
    console.log("  ✔ permissions indexes");

    // ── 5. role_permissions ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.role_permissions (
        id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        role_id       text NOT NULL REFERENCES public.roles(id),
        permission_id text NOT NULL REFERENCES public.permissions(id),
        created_at    timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ role_permissions table");
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS rp_role_perm_idx ON public.role_permissions (role_id, permission_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS rp_role_created_idx ON public.role_permissions (role_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS rp_perm_created_idx ON public.role_permissions (permission_id, created_at)`);
    console.log("  ✔ role_permissions indexes");

    // ── 6. membership_roles ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.membership_roles (
        id                   text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_membership_id text NOT NULL REFERENCES public.tenant_memberships(id),
        role_id              text NOT NULL REFERENCES public.roles(id),
        assigned_by          text REFERENCES public.app_user_profiles(id),
        assigned_at          timestamp NOT NULL DEFAULT now(),
        metadata             jsonb
      )
    `);
    console.log("  ✔ membership_roles table");
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS mr_membership_role_idx ON public.membership_roles (tenant_membership_id, role_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS mr_membership_assigned_idx ON public.membership_roles (tenant_membership_id, assigned_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS mr_role_assigned_idx ON public.membership_roles (role_id, assigned_at)`);
    console.log("  ✔ membership_roles indexes");

    // ── 7. service_accounts ───────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.service_accounts (
        id                     text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id              text NOT NULL,
        name                   text NOT NULL,
        description            text,
        service_account_status text NOT NULL DEFAULT 'active'
                               CHECK (service_account_status IN ('active','revoked','disabled')),
        created_by             text REFERENCES public.app_user_profiles(id),
        revoked_at             timestamp,
        metadata               jsonb,
        created_at             timestamp NOT NULL DEFAULT now(),
        updated_at             timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ service_accounts table");
    await client.query(`CREATE INDEX IF NOT EXISTS sa_tenant_status_created_idx ON public.service_accounts (tenant_id, service_account_status, created_at)`);
    console.log("  ✔ service_accounts indexes");

    // ── 8. service_account_keys ───────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.service_account_keys (
        id                 text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        service_account_id text NOT NULL REFERENCES public.service_accounts(id),
        key_prefix         text NOT NULL,
        key_hash           text NOT NULL,
        key_status         text NOT NULL DEFAULT 'active'
                           CHECK (key_status IN ('active','revoked','expired')),
        last_used_at       timestamp,
        expires_at         timestamp,
        created_by         text REFERENCES public.app_user_profiles(id),
        revoked_at         timestamp,
        metadata           jsonb,
        created_at         timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ service_account_keys table");
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS sak_prefix_idx ON public.service_account_keys (key_prefix)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS sak_hash_idx ON public.service_account_keys (key_hash)`);
    await client.query(`CREATE INDEX IF NOT EXISTS sak_sa_status_created_idx ON public.service_account_keys (service_account_id, key_status, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS sak_expires_idx ON public.service_account_keys (expires_at)`);
    console.log("  ✔ service_account_keys indexes");

    // ── 9. api_keys ───────────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.api_keys (
        id             text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id      text NOT NULL,
        name           text NOT NULL,
        key_prefix     text NOT NULL,
        key_hash       text NOT NULL,
        api_key_status text NOT NULL DEFAULT 'active'
                       CHECK (api_key_status IN ('active','revoked','expired')),
        created_by     text REFERENCES public.app_user_profiles(id),
        last_used_at   timestamp,
        expires_at     timestamp,
        revoked_at     timestamp,
        metadata       jsonb,
        created_at     timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ api_keys table");
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ak_prefix_idx ON public.api_keys (key_prefix)`);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ak_hash_idx ON public.api_keys (key_hash)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ak_tenant_status_created_idx ON public.api_keys (tenant_id, api_key_status, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ak_expires_idx ON public.api_keys (expires_at)`);
    console.log("  ✔ api_keys indexes");

    // ── 10. api_key_scopes ────────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.api_key_scopes (
        id            text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        api_key_id    text NOT NULL REFERENCES public.api_keys(id),
        permission_id text NOT NULL REFERENCES public.permissions(id),
        created_at    timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ api_key_scopes table");
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS aks_key_perm_idx ON public.api_key_scopes (api_key_id, permission_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aks_key_created_idx ON public.api_key_scopes (api_key_id, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS aks_perm_created_idx ON public.api_key_scopes (permission_id, created_at)`);
    console.log("  ✔ api_key_scopes indexes");

    // ── 11. identity_providers ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.identity_providers (
        id              text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id       text NOT NULL,
        provider_type   text NOT NULL
                        CHECK (provider_type IN ('oidc','saml','google_workspace','azure_ad')),
        provider_status text NOT NULL DEFAULT 'draft'
                        CHECK (provider_status IN ('draft','active','disabled')),
        display_name    text NOT NULL,
        issuer          text,
        audience        text,
        metadata        jsonb,
        created_by      text REFERENCES public.app_user_profiles(id),
        created_at      timestamp NOT NULL DEFAULT now(),
        updated_at      timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ identity_providers table");
    await client.query(`CREATE INDEX IF NOT EXISTS idp_tenant_status_created_idx ON public.identity_providers (tenant_id, provider_status, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idp_tenant_type_created_idx ON public.identity_providers (tenant_id, provider_type, created_at)`);
    console.log("  ✔ identity_providers indexes");

    // ── 12. tenant_invitations ────────────────────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.tenant_invitations (
        id                text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        tenant_id         text NOT NULL,
        email             text NOT NULL,
        invitation_status text NOT NULL DEFAULT 'pending'
                          CHECK (invitation_status IN ('pending','accepted','expired','revoked')),
        invited_by        text REFERENCES public.app_user_profiles(id),
        token_hash        text NOT NULL,
        expires_at        timestamp NOT NULL,
        accepted_at       timestamp,
        metadata          jsonb,
        created_at        timestamp NOT NULL DEFAULT now()
      )
    `);
    console.log("  ✔ tenant_invitations table");
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS ti_token_hash_idx ON public.tenant_invitations (token_hash)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ti_tenant_status_created_idx ON public.tenant_invitations (tenant_id, invitation_status, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ti_email_created_idx ON public.tenant_invitations (email, created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS ti_expires_idx ON public.tenant_invitations (expires_at)`);
    console.log("  ✔ tenant_invitations indexes");

    // ── RLS ───────────────────────────────────────────────────────────────────
    const tenantTables = [
      "tenant_memberships",
      "membership_roles",
      "service_accounts",
      "service_account_keys",
      "api_keys",
      "api_key_scopes",
      "identity_providers",
      "tenant_invitations",
    ];
    const systemTables = ["app_user_profiles", "roles", "permissions", "role_permissions"];

    for (const t of [...tenantTables, ...systemTables]) {
      await client.query(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    }
    console.log("  ✔ RLS enabled on all 12 new tables");

    const tenantPoliciesMap: Record<string, string> = {
      tenant_memberships: "tenant_id",
      service_accounts: "tenant_id",
      api_keys: "tenant_id",
      identity_providers: "tenant_id",
      tenant_invitations: "tenant_id",
    };

    for (const [table, col] of Object.entries(tenantPoliciesMap)) {
      const policyName = `${table.replace(/_/g, "")}_tenant_isolation`;
      const existsRow = await client.query(
        `SELECT 1 FROM pg_policies WHERE tablename=$1 AND policyname=$2`,
        [table, policyName],
      );
      if (existsRow.rows.length === 0) {
        await client.query(`
          CREATE POLICY "${policyName}" ON public.${table}
          USING (
            current_setting('app.current_tenant_id', true) <> ''
            AND ${col}::text = current_setting('app.current_tenant_id', true)
          )
        `);
      }
    }
    console.log("  ✔ Tenant isolation RLS policies created");

    // ── Verification ─────────────────────────────────────────────────────────
    const tableCheck = await client.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN (
        'app_user_profiles','tenant_memberships','roles','permissions',
        'role_permissions','membership_roles','service_accounts','service_account_keys',
        'api_keys','api_key_scopes','identity_providers','tenant_invitations'
      )
      ORDER BY table_name
    `);
    console.log(`\n✔ Tables verified (${tableCheck.rows.length}/12):`);
    for (const r of tableCheck.rows) console.log(`  - ${r.table_name}`);

    const rlsCheck = await client.query(`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
      AND tablename IN (
        'app_user_profiles','tenant_memberships','roles','permissions',
        'role_permissions','membership_roles','service_accounts','service_account_keys',
        'api_keys','api_key_scopes','identity_providers','tenant_invitations'
      )
      AND rowsecurity = true
      ORDER BY tablename
    `);
    console.log(`✔ RLS enabled (${rlsCheck.rows.length}/12 tables)`);

    const totalRlsTables = await client.query(
      `SELECT COUNT(*) as cnt FROM pg_tables WHERE schemaname='public' AND rowsecurity=true`
    );
    console.log(`✔ Total RLS tables in schema: ${totalRlsTables.rows[0].cnt}`);

    console.log("\n✔ Phase 6 migration complete");
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error("Migration failed:", e.message);
  process.exit(1);
});
