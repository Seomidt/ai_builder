/**
 * Phase 6 — Canonical Actor Resolution
 * INV-ID1: Every resolved actor has explicit actor_type and tenant scope semantics.
 * INV-ID10: Cross-tenant actor leakage impossible.
 */

import pg from "pg";
import crypto from "crypto";
import { extractKeyPrefix, verifyKeyHash } from "./key-management";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ─── Canonical Actor Shape ────────────────────────────────────────────────────

export type ActorType = "human" | "service_account" | "api_key" | "system" | "unresolved";

export interface ResolvedActor {
  actorType: ActorType;
  actorId: string;
  tenantId: string | null;
  subjectId: string | null;
  membershipId: string | null;
  serviceAccountId: string | null;
  apiKeyId: string | null;
  permissionCodes: string[];
  roleCodes: string[];
  authSource: "supabase_jwt" | "api_key" | "service_account_key" | "system" | "demo" | "unresolved";
  isMachineActor: boolean;
  isSystemActor: boolean;
}

export interface ActorResolutionFailure {
  resolved: false;
  reason: string;
  reasonCode: string;
}

export interface ActorResolutionSuccess {
  resolved: true;
  actor: ResolvedActor;
}

export type ActorResolutionResult = ActorResolutionSuccess | ActorResolutionFailure;

// ─── resolveHumanActor ────────────────────────────────────────────────────────

export async function resolveHumanActor(params: {
  userId: string;
  tenantId: string;
}): Promise<ActorResolutionResult> {
  const { userId, tenantId } = params;
  const client = getClient();
  await client.connect();
  try {
    const profileRow = await client.query(
      `SELECT id, status FROM public.app_user_profiles WHERE id = $1`,
      [userId],
    );
    if (profileRow.rows.length === 0) {
      return { resolved: false, reason: "User profile not found", reasonCode: "ACTOR_NOT_RESOLVED" };
    }
    if (profileRow.rows[0].status !== "active") {
      return { resolved: false, reason: `User profile status is ${profileRow.rows[0].status}`, reasonCode: "MEMBERSHIP_NOT_ACTIVE" };
    }

    const memberRow = await client.query(
      `SELECT id, membership_status FROM public.tenant_memberships WHERE user_id = $1 AND tenant_id = $2`,
      [userId, tenantId],
    );
    if (memberRow.rows.length === 0) {
      return { resolved: false, reason: "No membership found for tenant", reasonCode: "TENANT_SCOPE_MISMATCH" };
    }
    const membership = memberRow.rows[0];
    if (membership.membership_status !== "active") {
      return { resolved: false, reason: `Membership status is ${membership.membership_status}`, reasonCode: "MEMBERSHIP_NOT_ACTIVE" };
    }
    const membershipId = membership.id;

    const { permissionCodes, roleCodes } = await resolvePermissionsForMembership(client, membershipId);

    const actor: ResolvedActor = {
      actorType: "human",
      actorId: userId,
      tenantId,
      subjectId: userId,
      membershipId,
      serviceAccountId: null,
      apiKeyId: null,
      permissionCodes,
      roleCodes,
      authSource: "supabase_jwt",
      isMachineActor: false,
      isSystemActor: false,
    };
    return { resolved: true, actor };
  } finally {
    await client.end();
  }
}

// ─── resolveServiceAccountActor ──────────────────────────────────────────────

export async function resolveServiceAccountActor(params: {
  presentedKey: string;
  tenantId: string;
}): Promise<ActorResolutionResult> {
  const { presentedKey, tenantId } = params;
  // Phase 42: lookup by key_prefix (not by hash) — supports argon2id (non-deterministic).
  const keyPrefix = extractKeyPrefix(presentedKey);
  if (!keyPrefix) {
    return { resolved: false, reason: "Service account key has invalid format", reasonCode: "ACTOR_NOT_RESOLVED" };
  }
  const client = getClient();
  await client.connect();
  try {
    const keyRow = await client.query(
      `SELECT sak.id, sak.service_account_id, sak.key_status, sak.expires_at, sak.key_hash,
              sa.tenant_id, sa.service_account_status
       FROM public.service_account_keys sak
       JOIN public.service_accounts sa ON sa.id = sak.service_account_id
       WHERE sak.key_prefix = $1`,
      [keyPrefix],
    );
    if (keyRow.rows.length === 0) {
      return { resolved: false, reason: "Service account key not found", reasonCode: "ACTOR_NOT_RESOLVED" };
    }
    // Verify hash in code — handles argon2id (new) and SHA-256 (legacy) transparently
    let k: typeof keyRow.rows[0] | null = null;
    for (const candidate of keyRow.rows) {
      if (await verifyKeyHash(presentedKey, candidate.key_hash)) { k = candidate; break; }
    }
    if (!k) {
      return { resolved: false, reason: "Service account key not found", reasonCode: "ACTOR_NOT_RESOLVED" };
    }

    if (k.tenant_id !== tenantId) {
      return { resolved: false, reason: "Key tenant mismatch", reasonCode: "TENANT_SCOPE_MISMATCH" };
    }
    if (k.key_status !== "active") {
      return { resolved: false, reason: `Key status is ${k.key_status}`, reasonCode: "API_KEY_REVOKED" };
    }
    if (k.expires_at && new Date(k.expires_at) < new Date()) {
      return { resolved: false, reason: "Key is expired", reasonCode: "API_KEY_REVOKED" };
    }
    if (k.service_account_status !== "active") {
      return { resolved: false, reason: "Service account is not active", reasonCode: "SERVICE_ACCOUNT_REVOKED" };
    }

    await client.query(
      `UPDATE public.service_account_keys SET last_used_at = NOW() WHERE id = $1`,
      [k.id],
    );

    const actor: ResolvedActor = {
      actorType: "service_account",
      actorId: k.service_account_id,
      tenantId,
      subjectId: k.service_account_id,
      membershipId: null,
      serviceAccountId: k.service_account_id,
      apiKeyId: null,
      permissionCodes: [],
      roleCodes: [],
      authSource: "service_account_key",
      isMachineActor: true,
      isSystemActor: false,
    };
    return { resolved: true, actor };
  } finally {
    await client.end();
  }
}

// ─── resolveApiKeyActor ───────────────────────────────────────────────────────

export async function resolveApiKeyActor(params: {
  presentedKey: string;
  tenantId: string;
}): Promise<ActorResolutionResult> {
  const { presentedKey, tenantId } = params;
  // Phase 42: lookup by key_prefix (not by hash) — supports argon2id (non-deterministic).
  const keyPrefix = extractKeyPrefix(presentedKey);
  if (!keyPrefix) {
    return { resolved: false, reason: "API key has invalid format", reasonCode: "ACTOR_NOT_RESOLVED" };
  }
  const client = getClient();
  await client.connect();
  try {
    const keyRow = await client.query(
      `SELECT ak.id, ak.tenant_id, ak.api_key_status, ak.expires_at, ak.key_hash
       FROM public.api_keys ak
       WHERE ak.key_prefix = $1`,
      [keyPrefix],
    );
    if (keyRow.rows.length === 0) {
      return { resolved: false, reason: "API key not found", reasonCode: "ACTOR_NOT_RESOLVED" };
    }
    // Verify hash in code — handles argon2id (new) and SHA-256 (legacy) transparently
    let k: typeof keyRow.rows[0] | null = null;
    for (const candidate of keyRow.rows) {
      if (await verifyKeyHash(presentedKey, candidate.key_hash)) { k = candidate; break; }
    }
    if (!k) {
      return { resolved: false, reason: "API key not found", reasonCode: "ACTOR_NOT_RESOLVED" };
    }

    if (k.tenant_id !== tenantId) {
      return { resolved: false, reason: "API key tenant mismatch", reasonCode: "TENANT_SCOPE_MISMATCH" };
    }
    if (k.api_key_status !== "active") {
      return { resolved: false, reason: `API key status is ${k.api_key_status}`, reasonCode: "API_KEY_REVOKED" };
    }
    if (k.expires_at && new Date(k.expires_at) < new Date()) {
      return { resolved: false, reason: "API key is expired", reasonCode: "API_KEY_REVOKED" };
    }

    await client.query(
      `UPDATE public.api_keys SET last_used_at = NOW() WHERE id = $1`,
      [k.id],
    );

    const scopeRow = await client.query(
      `SELECT p.permission_code FROM public.api_key_scopes aks
       JOIN public.permissions p ON p.id = aks.permission_id
       WHERE aks.api_key_id = $1 AND p.lifecycle_state = 'active'`,
      [k.id],
    );
    const permissionCodes = scopeRow.rows.map((r) => r.permission_code);

    const actor: ResolvedActor = {
      actorType: "api_key",
      actorId: k.id,
      tenantId,
      subjectId: k.id,
      membershipId: null,
      serviceAccountId: null,
      apiKeyId: k.id,
      permissionCodes,
      roleCodes: [],
      authSource: "api_key",
      isMachineActor: true,
      isSystemActor: false,
    };
    return { resolved: true, actor };
  } finally {
    await client.end();
  }
}

// ─── resolveRequestActor ──────────────────────────────────────────────────────
// Resolves actor from Express request context.
// INV-ID9: Backward-compatible — falls back to system actor for legacy internal calls.

export function resolveRequestActor(req: {
  user?: { id: string; organizationId: string; role: string };
  resolvedActor?: ResolvedActor;
}): ActorResolutionResult {
  if (req.resolvedActor) {
    return { resolved: true, actor: req.resolvedActor };
  }
  if (req.user) {
    const u = req.user;
    const isDemo = u.id === "demo-user";
    const actor: ResolvedActor = {
      actorType: isDemo ? "system" : "human",
      actorId: u.id,
      tenantId: u.organizationId,
      subjectId: u.id,
      membershipId: null,
      serviceAccountId: null,
      apiKeyId: null,
      permissionCodes: isDemo ? getAllPermissionCodes() : [],
      roleCodes: [u.role],
      authSource: isDemo ? "demo" : "supabase_jwt",
      isMachineActor: false,
      isSystemActor: isDemo,
    };
    return { resolved: true, actor };
  }
  return { resolved: false, reason: "No user context on request", reasonCode: "ACTOR_NOT_RESOLVED" };
}

// ─── explainResolvedActor ─────────────────────────────────────────────────────

export function explainResolvedActor(result: ActorResolutionResult): {
  resolved: boolean;
  actorType?: string;
  actorId?: string;
  tenantId?: string | null;
  authSource?: string;
  isMachineActor?: boolean;
  isSystemActor?: boolean;
  permissionCount?: number;
  roleCount?: number;
  failureReason?: string;
  failureCode?: string;
  note: string;
} {
  if (!result.resolved) {
    return {
      resolved: false,
      failureReason: result.reason,
      failureCode: result.reasonCode,
      note: "INV-ID1: Actor resolution failed — structured safe failure.",
    };
  }
  const a = result.actor;
  return {
    resolved: true,
    actorType: a.actorType,
    actorId: a.actorId,
    tenantId: a.tenantId,
    authSource: a.authSource,
    isMachineActor: a.isMachineActor,
    isSystemActor: a.isSystemActor,
    permissionCount: a.permissionCodes.length,
    roleCount: a.roleCodes.length,
    note: "INV-ID1: Canonical actor resolved with explicit type and tenant scope.",
  };
}

// ─── isActorTenantScoped ──────────────────────────────────────────────────────

export function isActorTenantScoped(actor: ResolvedActor): boolean {
  return actor.tenantId !== null && !actor.isSystemActor;
}

// ─── assertActorTenantScope ───────────────────────────────────────────────────

export function assertActorTenantScope(actor: ResolvedActor, expectedTenantId: string): void {
  if (actor.isSystemActor) return;
  if (actor.tenantId !== expectedTenantId) {
    throw Object.assign(new Error("Actor tenant scope mismatch"), {
      reasonCode: "TENANT_SCOPE_MISMATCH",
      actorTenantId: actor.tenantId,
      expectedTenantId,
    });
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function resolvePermissionsForMembership(
  client: pg.Client,
  membershipId: string,
): Promise<{ permissionCodes: string[]; roleCodes: string[] }> {
  const roleRows = await client.query(
    `SELECT r.id, r.role_code, r.lifecycle_state
     FROM public.membership_roles mr
     JOIN public.roles r ON r.id = mr.role_id
     WHERE mr.tenant_membership_id = $1`,
    [membershipId],
  );

  const activeRoles = roleRows.rows.filter((r) => r.lifecycle_state === "active");
  const roleCodes = activeRoles.map((r) => r.role_code);
  const roleIds = activeRoles.map((r) => r.id);

  if (roleIds.length === 0) return { permissionCodes: [], roleCodes };

  const permRows = await client.query(
    `SELECT DISTINCT p.permission_code
     FROM public.role_permissions rp
     JOIN public.permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = ANY($1) AND p.lifecycle_state = 'active'`,
    [roleIds],
  );

  return {
    permissionCodes: permRows.rows.map((r) => r.permission_code),
    roleCodes,
  };
}

function getAllPermissionCodes(): string[] {
  return [
    "tenant.read", "tenant.update", "tenant.manage_members", "tenant.manage_roles", "tenant.manage_identity_providers",
    "knowledge.read", "knowledge.write", "knowledge.delete", "knowledge.admin", "knowledge.source.sync",
    "retrieval.query", "retrieval.admin", "retrieval.operator_metrics",
    "billing.read", "billing.manage", "billing.invoices.read",
    "ai.run", "ai.admin",
    "admin.internal.read", "admin.internal.write",
    "api.access", "api.admin",
  ];
}
