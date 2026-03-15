/**
 * Phase 6 — Membership & Role Management Service
 * INV-ID3: Suspended/removed memberships must not grant permissions.
 * INV-ID6: Role bindings must be tenant-safe.
 * INV-ID10: Cross-tenant leakage impossible.
 */

import pg from "pg";
import crypto from "crypto";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ─── createTenantMembership ───────────────────────────────────────────────────

export async function createTenantMembership(params: {
  tenantId: string;
  userId: string;
  invitedBy?: string;
  status?: "active" | "invited";
}): Promise<{ membershipId: string; tenantId: string; userId: string; status: string }> {
  const { tenantId, userId, invitedBy, status = "active" } = params;
  const client = getClient();
  await client.connect();
  try {
    const existing = await client.query(
      `SELECT id FROM public.tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [tenantId, userId],
    );
    if (existing.rows.length > 0) {
      throw Object.assign(new Error("Membership already exists for this tenant+user"), {
        code: "DUPLICATE_MEMBERSHIP",
        membershipId: existing.rows[0].id,
      });
    }
    const row = await client.query(
      `INSERT INTO public.tenant_memberships
         (id, tenant_id, user_id, membership_status, joined_at, invited_at, invited_by)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
       RETURNING id, membership_status`,
      [
        tenantId, userId, status,
        status === "active" ? new Date() : null,
        status === "invited" ? new Date() : null,
        invitedBy ?? null,
      ],
    );
    return { membershipId: row.rows[0].id, tenantId, userId, status: row.rows[0].membership_status };
  } finally {
    await client.end();
  }
}

// ─── suspendTenantMembership ──────────────────────────────────────────────────

export async function suspendTenantMembership(membershipId: string): Promise<{ suspended: boolean; previous: string }> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, membership_status FROM public.tenant_memberships WHERE id = $1`,
      [membershipId],
    );
    if (row.rows.length === 0) throw new Error("Membership not found");
    const previous = row.rows[0].membership_status;
    await client.query(
      `UPDATE public.tenant_memberships SET membership_status = 'suspended', suspended_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [membershipId],
    );
    return { suspended: true, previous };
  } finally {
    await client.end();
  }
}

// ─── removeTenantMembership ───────────────────────────────────────────────────

export async function removeTenantMembership(membershipId: string): Promise<{ removed: boolean; previous: string }> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, membership_status FROM public.tenant_memberships WHERE id = $1`,
      [membershipId],
    );
    if (row.rows.length === 0) throw new Error("Membership not found");
    const previous = row.rows[0].membership_status;
    await client.query(
      `UPDATE public.tenant_memberships SET membership_status = 'removed', removed_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [membershipId],
    );
    return { removed: true, previous };
  } finally {
    await client.end();
  }
}

// ─── assignRoleToMembership ───────────────────────────────────────────────────
// INV-ID6: Cross-tenant role binding prevented.

export async function assignRoleToMembership(params: {
  membershipId: string;
  roleId: string;
  assignedBy?: string;
}): Promise<{ assigned: boolean; membershipRoleId: string }> {
  const { membershipId, roleId, assignedBy } = params;
  const client = getClient();
  await client.connect();
  try {
    const memberRow = await client.query(
      `SELECT tenant_id FROM public.tenant_memberships WHERE id = $1`,
      [membershipId],
    );
    if (memberRow.rows.length === 0) throw new Error("Membership not found");
    const memberTenantId = memberRow.rows[0].tenant_id;

    const roleRow = await client.query(
      `SELECT id, tenant_id, role_scope, lifecycle_state FROM public.roles WHERE id = $1`,
      [roleId],
    );
    if (roleRow.rows.length === 0) throw new Error("Role not found");
    const role = roleRow.rows[0];

    if (role.lifecycle_state !== "active") {
      throw Object.assign(new Error("Role is not active"), { reasonCode: "ROLE_DISABLED" });
    }

    // INV-ID6: tenant-scoped roles must belong to same tenant
    if (role.role_scope === "tenant" && role.tenant_id !== null && role.tenant_id !== memberTenantId) {
      throw Object.assign(new Error("Cross-tenant role binding rejected"), { reasonCode: "TENANT_SCOPE_MISMATCH" });
    }

    const existing = await client.query(
      `SELECT id FROM public.membership_roles WHERE tenant_membership_id = $1 AND role_id = $2`,
      [membershipId, roleId],
    );
    if (existing.rows.length > 0) {
      return { assigned: false, membershipRoleId: existing.rows[0].id };
    }

    const ins = await client.query(
      `INSERT INTO public.membership_roles (id, tenant_membership_id, role_id, assigned_by)
       VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
      [membershipId, roleId, assignedBy ?? null],
    );
    return { assigned: true, membershipRoleId: ins.rows[0].id };
  } finally {
    await client.end();
  }
}

// ─── removeRoleFromMembership ─────────────────────────────────────────────────

export async function removeRoleFromMembership(params: {
  membershipId: string;
  roleId: string;
}): Promise<{ removed: boolean }> {
  const { membershipId, roleId } = params;
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `DELETE FROM public.membership_roles WHERE tenant_membership_id = $1 AND role_id = $2 RETURNING id`,
      [membershipId, roleId],
    );
    return { removed: row.rows.length > 0 };
  } finally {
    await client.end();
  }
}

// ─── listTenantMemberships ────────────────────────────────────────────────────

export async function listTenantMemberships(tenantId: string): Promise<Array<{
  id: string;
  userId: string;
  membershipStatus: string;
  joinedAt: Date | null;
  createdAt: Date;
}>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, user_id, membership_status, joined_at, created_at
       FROM public.tenant_memberships WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return row.rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      membershipStatus: r.membership_status,
      joinedAt: r.joined_at,
      createdAt: r.created_at,
    }));
  } finally {
    await client.end();
  }
}

// ─── listMembershipRoles ──────────────────────────────────────────────────────

export async function listMembershipRoles(membershipId: string): Promise<Array<{
  membershipRoleId: string;
  roleId: string;
  roleCode: string;
  roleName: string;
  roleScope: string;
  lifecycleState: string;
}>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT mr.id, r.id as role_id, r.role_code, r.name, r.role_scope, r.lifecycle_state
       FROM public.membership_roles mr
       JOIN public.roles r ON r.id = mr.role_id
       WHERE mr.tenant_membership_id = $1`,
      [membershipId],
    );
    return row.rows.map((r) => ({
      membershipRoleId: r.id,
      roleId: r.role_id,
      roleCode: r.role_code,
      roleName: r.name,
      roleScope: r.role_scope,
      lifecycleState: r.lifecycle_state,
    }));
  } finally {
    await client.end();
  }
}

// ─── createTenantInvitation ───────────────────────────────────────────────────
// INV-ID5: Plaintext token not stored — only hash.

export async function createTenantInvitation(params: {
  tenantId: string;
  email: string;
  invitedBy?: string;
  expiresInHours?: number;
}): Promise<{ invitationId: string; plaintextToken: string; expiresAt: Date; note: string }> {
  const { tenantId, email, invitedBy, expiresInHours = 72 } = params;
  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const expiresAt = new Date(Date.now() + expiresInHours * 3600 * 1000);

  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `INSERT INTO public.tenant_invitations
         (id, tenant_id, email, invitation_status, invited_by, token_hash, expires_at)
       VALUES (gen_random_uuid(), $1, $2, 'pending', $3, $4, $5) RETURNING id`,
      [tenantId, email, invitedBy ?? null, tokenHash, expiresAt],
    );
    return {
      invitationId: row.rows[0].id,
      plaintextToken: token,
      expiresAt,
      note: "INV-ID5: Token hash stored only. Plaintext returned once.",
    };
  } finally {
    await client.end();
  }
}

// ─── acceptTenantInvitation ───────────────────────────────────────────────────

export async function acceptTenantInvitation(params: {
  plaintextToken: string;
  userId: string;
}): Promise<{ membershipId: string; tenantId: string }> {
  const { plaintextToken, userId } = params;
  const tokenHash = crypto.createHash("sha256").update(plaintextToken).digest("hex");

  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, tenant_id, email, invitation_status, expires_at
       FROM public.tenant_invitations WHERE token_hash = $1`,
      [tokenHash],
    );
    if (row.rows.length === 0) throw new Error("Invitation not found");
    const inv = row.rows[0];

    if (inv.invitation_status !== "pending") {
      throw Object.assign(new Error(`Invitation is ${inv.invitation_status}`), { code: "INVITATION_INVALID" });
    }
    if (new Date(inv.expires_at) < new Date()) {
      throw Object.assign(new Error("Invitation has expired"), { code: "INVITATION_EXPIRED" });
    }

    const existing = await client.query(
      `SELECT id FROM public.tenant_memberships WHERE tenant_id = $1 AND user_id = $2`,
      [inv.tenant_id, userId],
    );
    let membershipId: string;
    if (existing.rows.length > 0) {
      membershipId = existing.rows[0].id;
    } else {
      const ins = await client.query(
        `INSERT INTO public.tenant_memberships
           (id, tenant_id, user_id, membership_status, joined_at)
         VALUES (gen_random_uuid(), $1, $2, 'active', NOW()) RETURNING id`,
        [inv.tenant_id, userId],
      );
      membershipId = ins.rows[0].id;
    }

    await client.query(
      `UPDATE public.tenant_invitations SET invitation_status = 'accepted', accepted_at = NOW() WHERE id = $1`,
      [inv.id],
    );

    return { membershipId, tenantId: inv.tenant_id };
  } finally {
    await client.end();
  }
}

// ─── revokeTenantInvitation ───────────────────────────────────────────────────

export async function revokeTenantInvitation(invitationId: string): Promise<{ revoked: boolean; idempotent: boolean }> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, invitation_status FROM public.tenant_invitations WHERE id = $1`,
      [invitationId],
    );
    if (row.rows.length === 0) return { revoked: false, idempotent: false };
    if (row.rows[0].invitation_status === "revoked") return { revoked: true, idempotent: true };
    await client.query(
      `UPDATE public.tenant_invitations SET invitation_status = 'revoked' WHERE id = $1`,
      [invitationId],
    );
    return { revoked: true, idempotent: false };
  } finally {
    await client.end();
  }
}

// ─── explainMembershipAccess ──────────────────────────────────────────────────

export async function explainMembershipAccess(membershipId: string): Promise<{
  membershipId: string;
  membershipStatus: string;
  tenantId: string;
  userId: string;
  roles: Array<{ roleCode: string; lifecycleState: string }>;
  effectivePermissions: string[];
  accessGranted: boolean;
  note: string;
}> {
  const client = getClient();
  await client.connect();
  try {
    const memRow = await client.query(
      `SELECT id, membership_status, tenant_id, user_id FROM public.tenant_memberships WHERE id = $1`,
      [membershipId],
    );
    if (memRow.rows.length === 0) throw new Error("Membership not found");
    const mem = memRow.rows[0];

    const roleRows = await client.query(
      `SELECT r.role_code, r.lifecycle_state FROM public.membership_roles mr
       JOIN public.roles r ON r.id = mr.role_id WHERE mr.tenant_membership_id = $1`,
      [membershipId],
    );

    const activeRoleIds = await client.query(
      `SELECT mr.role_id FROM public.membership_roles mr
       JOIN public.roles r ON r.id = mr.role_id
       WHERE mr.tenant_membership_id = $1 AND r.lifecycle_state = 'active'`,
      [membershipId],
    );
    const roleIds = activeRoleIds.rows.map((r) => r.role_id);

    let effectivePermissions: string[] = [];
    if (roleIds.length > 0 && mem.membership_status === "active") {
      const permRows = await client.query(
        `SELECT DISTINCT p.permission_code FROM public.role_permissions rp
         JOIN public.permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = ANY($1) AND p.lifecycle_state = 'active'`,
        [roleIds],
      );
      effectivePermissions = permRows.rows.map((r) => r.permission_code);
    }

    return {
      membershipId,
      membershipStatus: mem.membership_status,
      tenantId: mem.tenant_id,
      userId: mem.user_id,
      roles: roleRows.rows.map((r) => ({ roleCode: r.role_code, lifecycleState: r.lifecycle_state })),
      effectivePermissions,
      accessGranted: mem.membership_status === "active",
      note: "INV-ID3: Suspended/removed memberships grant no permissions. INV-ID8: Read-only.",
    };
  } finally {
    await client.end();
  }
}
