/**
 * Phase 6 — Identity Bootstrap
 * Seeds canonical permissions and system roles idempotently.
 * INV-ID11: Bootstrap operations must be idempotent.
 */

import pg from "pg";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ─── Canonical Permissions ───────────────────────────────────────────────────

export const CANONICAL_PERMISSIONS: Array<{
  permissionCode: string;
  name: string;
  description: string;
  permissionDomain: string;
}> = [
  // Tenant / org
  { permissionCode: "tenant.read", name: "Read Tenant", description: "View tenant details", permissionDomain: "tenant" },
  { permissionCode: "tenant.update", name: "Update Tenant", description: "Modify tenant settings", permissionDomain: "tenant" },
  { permissionCode: "tenant.manage_members", name: "Manage Members", description: "Add, remove, suspend tenant members", permissionDomain: "tenant" },
  { permissionCode: "tenant.manage_roles", name: "Manage Roles", description: "Create and assign roles", permissionDomain: "tenant" },
  { permissionCode: "tenant.manage_identity_providers", name: "Manage Identity Providers", description: "Configure SSO/OIDC/SAML providers", permissionDomain: "tenant" },
  // Knowledge
  { permissionCode: "knowledge.read", name: "Read Knowledge", description: "Read knowledge bases and documents", permissionDomain: "knowledge" },
  { permissionCode: "knowledge.write", name: "Write Knowledge", description: "Create and update knowledge documents", permissionDomain: "knowledge" },
  { permissionCode: "knowledge.delete", name: "Delete Knowledge", description: "Delete knowledge documents", permissionDomain: "knowledge" },
  { permissionCode: "knowledge.admin", name: "Knowledge Admin", description: "Full knowledge base administration", permissionDomain: "knowledge" },
  { permissionCode: "knowledge.source.sync", name: "Sync Knowledge Sources", description: "Trigger ingestion and sync pipelines", permissionDomain: "knowledge" },
  // Retrieval
  { permissionCode: "retrieval.query", name: "Query Retrieval", description: "Execute retrieval and search queries", permissionDomain: "retrieval" },
  { permissionCode: "retrieval.admin", name: "Retrieval Admin", description: "Administer retrieval configurations", permissionDomain: "retrieval" },
  { permissionCode: "retrieval.operator_metrics", name: "Retrieval Operator Metrics", description: "Access retrieval quality and feedback metrics", permissionDomain: "retrieval" },
  // Billing
  { permissionCode: "billing.read", name: "Read Billing", description: "View billing and usage data", permissionDomain: "billing" },
  { permissionCode: "billing.manage", name: "Manage Billing", description: "Manage billing settings and invoices", permissionDomain: "billing" },
  { permissionCode: "billing.invoices.read", name: "Read Invoices", description: "View invoices", permissionDomain: "billing" },
  // AI / agents
  { permissionCode: "ai.run", name: "Run AI", description: "Execute AI runs and queries", permissionDomain: "ai" },
  { permissionCode: "ai.admin", name: "AI Admin", description: "Administer AI configurations and models", permissionDomain: "ai" },
  // Admin / internal
  { permissionCode: "admin.internal.read", name: "Internal Admin Read", description: "Read internal admin data", permissionDomain: "admin" },
  { permissionCode: "admin.internal.write", name: "Internal Admin Write", description: "Write internal admin data", permissionDomain: "admin" },
  // Service / API
  { permissionCode: "api.access", name: "API Access", description: "Access public/partner API", permissionDomain: "api" },
  { permissionCode: "api.admin", name: "API Admin", description: "Administer API keys and access", permissionDomain: "api" },
];

// ─── System Role Definitions ─────────────────────────────────────────────────

export const SYSTEM_ROLES: Array<{
  roleCode: string;
  name: string;
  description: string;
  permissionCodes: string[];
}> = [
  {
    roleCode: "owner",
    name: "Owner",
    description: "Broad tenant control. Cannot be silently removed if it would orphan governance.",
    permissionCodes: [
      "tenant.read", "tenant.update", "tenant.manage_members", "tenant.manage_roles", "tenant.manage_identity_providers",
      "knowledge.read", "knowledge.write", "knowledge.delete", "knowledge.admin", "knowledge.source.sync",
      "retrieval.query", "retrieval.admin", "retrieval.operator_metrics",
      "billing.read", "billing.manage", "billing.invoices.read",
      "ai.run", "ai.admin",
      "admin.internal.read", "admin.internal.write",
      "api.access", "api.admin",
    ],
  },
  {
    roleCode: "admin",
    name: "Admin",
    description: "Broad operational access. No billing unless explicitly assigned.",
    permissionCodes: [
      "tenant.read", "tenant.update", "tenant.manage_members", "tenant.manage_roles",
      "knowledge.read", "knowledge.write", "knowledge.delete", "knowledge.admin", "knowledge.source.sync",
      "retrieval.query", "retrieval.admin", "retrieval.operator_metrics",
      "ai.run", "ai.admin",
      "admin.internal.read", "admin.internal.write",
      "api.access", "api.admin",
    ],
  },
  {
    roleCode: "editor",
    name: "Editor",
    description: "Knowledge write access and retrieval usage.",
    permissionCodes: [
      "tenant.read",
      "knowledge.read", "knowledge.write", "knowledge.source.sync",
      "retrieval.query",
      "ai.run",
      "api.access",
    ],
  },
  {
    roleCode: "viewer",
    name: "Viewer",
    description: "Read and query access only.",
    permissionCodes: [
      "tenant.read",
      "knowledge.read",
      "retrieval.query",
      "api.access",
    ],
  },
  {
    roleCode: "billing_admin",
    name: "Billing Admin",
    description: "Billing read and manage. No broad knowledge delete.",
    permissionCodes: [
      "tenant.read",
      "billing.read", "billing.manage", "billing.invoices.read",
      "api.access",
    ],
  },
];

// ─── seedCanonicalPermissions ─────────────────────────────────────────────────

export async function seedCanonicalPermissions(client: pg.Client): Promise<{
  seeded: number;
  existing: number;
  permissionIds: Record<string, string>;
}> {
  let seeded = 0;
  let existing = 0;
  const permissionIds: Record<string, string> = {};

  for (const p of CANONICAL_PERMISSIONS) {
    const existing_row = await client.query(
      `SELECT id FROM public.permissions WHERE permission_code = $1`,
      [p.permissionCode],
    );
    if (existing_row.rows.length > 0) {
      permissionIds[p.permissionCode] = existing_row.rows[0].id;
      existing++;
    } else {
      const ins = await client.query(
        `INSERT INTO public.permissions (id, permission_code, name, description, permission_domain, lifecycle_state)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active') RETURNING id`,
        [p.permissionCode, p.name, p.description, p.permissionDomain],
      );
      permissionIds[p.permissionCode] = ins.rows[0].id;
      seeded++;
    }
  }

  return { seeded, existing, permissionIds };
}

// ─── seedSystemRolesForTenant ─────────────────────────────────────────────────
// Seeds system-scoped roles (tenant_id = NULL, role_scope = 'system').
// If tenantId is provided, also seeds tenant-scoped copies.

export async function seedSystemRolesForTenant(
  client: pg.Client,
  permissionIds: Record<string, string>,
  tenantId?: string,
): Promise<{
  rolesSeeded: number;
  rolesExisting: number;
  bindingsSeeded: number;
  roleIds: Record<string, string>;
}> {
  let rolesSeeded = 0;
  let rolesExisting = 0;
  let bindingsSeeded = 0;
  const roleIds: Record<string, string> = {};

  for (const roleDef of SYSTEM_ROLES) {
    const scope = "system";
    const tId = null;

    const existing_row = await client.query(
      `SELECT id FROM public.roles WHERE role_scope = $1 AND (tenant_id IS NULL) AND role_code = $2`,
      [scope, roleDef.roleCode],
    );

    let roleId: string;
    if (existing_row.rows.length > 0) {
      roleId = existing_row.rows[0].id;
      rolesExisting++;
    } else {
      const ins = await client.query(
        `INSERT INTO public.roles (id, tenant_id, role_code, name, description, is_system_role, role_scope, lifecycle_state)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, true, 'system', 'active') RETURNING id`,
        [tId, roleDef.roleCode, roleDef.name, roleDef.description],
      );
      roleId = ins.rows[0].id;
      rolesSeeded++;
    }
    roleIds[roleDef.roleCode] = roleId;

    for (const permCode of roleDef.permissionCodes) {
      const permId = permissionIds[permCode];
      if (!permId) continue;
      const existingBind = await client.query(
        `SELECT id FROM public.role_permissions WHERE role_id = $1 AND permission_id = $2`,
        [roleId, permId],
      );
      if (existingBind.rows.length === 0) {
        await client.query(
          `INSERT INTO public.role_permissions (id, role_id, permission_id) VALUES (gen_random_uuid(), $1, $2)`,
          [roleId, permId],
        );
        bindingsSeeded++;
      }
    }
  }

  return { rolesSeeded, rolesExisting, bindingsSeeded, roleIds };
}

// ─── seedDefaultRoleBindings ──────────────────────────────────────────────────
// Assigns a system role to a tenant membership.

export async function seedDefaultRoleBindings(
  client: pg.Client,
  membershipId: string,
  roleCodes: string[],
  assignedBy?: string,
): Promise<{ bound: string[]; alreadyBound: string[] }> {
  const bound: string[] = [];
  const alreadyBound: string[] = [];

  for (const code of roleCodes) {
    const roleRow = await client.query(
      `SELECT id FROM public.roles WHERE role_code = $1 AND lifecycle_state = 'active'`,
      [code],
    );
    if (roleRow.rows.length === 0) continue;
    const roleId = roleRow.rows[0].id;

    const existingBind = await client.query(
      `SELECT id FROM public.membership_roles WHERE tenant_membership_id = $1 AND role_id = $2`,
      [membershipId, roleId],
    );
    if (existingBind.rows.length > 0) {
      alreadyBound.push(code);
    } else {
      await client.query(
        `INSERT INTO public.membership_roles (id, tenant_membership_id, role_id, assigned_by)
         VALUES (gen_random_uuid(), $1, $2, $3)`,
        [membershipId, roleId, assignedBy ?? null],
      );
      bound.push(code);
    }
  }

  return { bound, alreadyBound };
}

// ─── explainBootstrapIdentityState ───────────────────────────────────────────

export async function explainBootstrapIdentityState(): Promise<{
  totalPermissions: number;
  activePermissions: number;
  totalSystemRoles: number;
  activeSystemRoles: number;
  totalRoleBindings: number;
  permissionsByDomain: Record<string, number>;
  systemRoleCodes: string[];
  note: string;
}> {
  const client = getClient();
  await client.connect();
  try {
    const [permR, sysRoleR, bindR, domainR] = await Promise.all([
      client.query(`SELECT COUNT(*) as total, SUM(CASE WHEN lifecycle_state='active' THEN 1 ELSE 0 END) as active FROM public.permissions`),
      client.query(`SELECT id, role_code, lifecycle_state FROM public.roles WHERE role_scope='system'`),
      client.query(`SELECT COUNT(*) as total FROM public.role_permissions`),
      client.query(`SELECT permission_domain, COUNT(*) as cnt FROM public.permissions GROUP BY permission_domain`),
    ]);

    const permsByDomain: Record<string, number> = {};
    for (const row of domainR.rows) permsByDomain[row.permission_domain] = parseInt(row.cnt, 10);

    return {
      totalPermissions: parseInt(permR.rows[0].total, 10),
      activePermissions: parseInt(permR.rows[0].active ?? "0", 10),
      totalSystemRoles: sysRoleR.rows.length,
      activeSystemRoles: sysRoleR.rows.filter((r) => r.lifecycle_state === "active").length,
      totalRoleBindings: parseInt(bindR.rows[0].total, 10),
      permissionsByDomain: permsByDomain,
      systemRoleCodes: sysRoleR.rows.map((r) => r.role_code),
      note: "INV-ID11: Bootstrap state — read-only explain. no writes.",
    };
  } finally {
    await client.end();
  }
}

// ─── Full bootstrap entrypoint ────────────────────────────────────────────────

export async function runIdentityBootstrap(tenantId?: string): Promise<{
  permissionsResult: Awaited<ReturnType<typeof seedCanonicalPermissions>>;
  rolesResult: Awaited<ReturnType<typeof seedSystemRolesForTenant>>;
  tenantId: string | null;
}> {
  const client = getClient();
  await client.connect();
  try {
    const permissionsResult = await seedCanonicalPermissions(client);
    const rolesResult = await seedSystemRolesForTenant(client, permissionsResult.permissionIds, tenantId);
    return { permissionsResult, rolesResult, tenantId: tenantId ?? null };
  } finally {
    await client.end();
  }
}
