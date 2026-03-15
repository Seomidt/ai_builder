/**
 * Phase 6 — Permission Engine
 * INV-ID2: Permission checks must be permission-code based, not role-name based.
 * INV-ID3: Suspended/removed memberships must not grant permissions.
 * INV-ID4: Disabled/archived roles or permissions must not grant access.
 * INV-ID10: No cross-tenant permission leakage.
 */

import type { ResolvedActor } from "./actor-resolution";

// ─── Denial Reason Codes ──────────────────────────────────────────────────────

export type PermissionDenialCode =
  | "ACTOR_NOT_RESOLVED"
  | "TENANT_SCOPE_MISMATCH"
  | "MEMBERSHIP_NOT_ACTIVE"
  | "ROLE_DISABLED"
  | "PERMISSION_NOT_GRANTED"
  | "API_KEY_REVOKED"
  | "SERVICE_ACCOUNT_REVOKED"
  | "IDENTITY_PROVIDER_DISABLED"
  | "INTERNAL_ONLY_ROUTE";

export interface PermissionDecision {
  granted: boolean;
  requestedPermission: string;
  actorType: string;
  tenantId: string | null;
  sourceRoles: string[];
  denialReasonCode?: PermissionDenialCode;
  denialReason?: string;
  note: string;
}

// ─── getActorPermissions ──────────────────────────────────────────────────────

export function getActorPermissions(actor: ResolvedActor): string[] {
  return [...actor.permissionCodes];
}

// ─── actorHasPermission ───────────────────────────────────────────────────────
// INV-ID2: always checks by permission code, never by role name.

export function actorHasPermission(actor: ResolvedActor, permissionCode: string): boolean {
  return actor.permissionCodes.includes(permissionCode);
}

// ─── requirePermission ────────────────────────────────────────────────────────

export function requirePermission(actor: ResolvedActor | null, permissionCode: string): void {
  if (!actor) {
    throw Object.assign(new Error("Actor not resolved — permission denied"), {
      reasonCode: "ACTOR_NOT_RESOLVED" as PermissionDenialCode,
      permissionCode,
    });
  }
  if (!actorHasPermission(actor, permissionCode)) {
    throw Object.assign(
      new Error(`Permission denied: ${permissionCode}`),
      {
        reasonCode: "PERMISSION_NOT_GRANTED" as PermissionDenialCode,
        permissionCode,
        actorType: actor.actorType,
        tenantId: actor.tenantId,
      },
    );
  }
}

// ─── requireAnyPermission ─────────────────────────────────────────────────────

export function requireAnyPermission(actor: ResolvedActor | null, permissionCodes: string[]): void {
  if (!actor) {
    throw Object.assign(new Error("Actor not resolved — permission denied"), {
      reasonCode: "ACTOR_NOT_RESOLVED" as PermissionDenialCode,
    });
  }
  const hasAny = permissionCodes.some((code) => actorHasPermission(actor, code));
  if (!hasAny) {
    throw Object.assign(
      new Error(`Permission denied: requires any of [${permissionCodes.join(", ")}]`),
      {
        reasonCode: "PERMISSION_NOT_GRANTED" as PermissionDenialCode,
        permissionCodes,
        actorType: actor.actorType,
        tenantId: actor.tenantId,
      },
    );
  }
}

// ─── requireAllPermissions ────────────────────────────────────────────────────

export function requireAllPermissions(actor: ResolvedActor | null, permissionCodes: string[]): void {
  if (!actor) {
    throw Object.assign(new Error("Actor not resolved — permission denied"), {
      reasonCode: "ACTOR_NOT_RESOLVED" as PermissionDenialCode,
    });
  }
  const missing = permissionCodes.filter((code) => !actorHasPermission(actor, code));
  if (missing.length > 0) {
    throw Object.assign(
      new Error(`Permission denied: missing [${missing.join(", ")}]`),
      {
        reasonCode: "PERMISSION_NOT_GRANTED" as PermissionDenialCode,
        missingPermissions: missing,
        actorType: actor.actorType,
        tenantId: actor.tenantId,
      },
    );
  }
}

// ─── explainPermissionDecision ────────────────────────────────────────────────

export function explainPermissionDecision(
  actor: ResolvedActor | null,
  permissionCode: string,
  targetTenantId?: string,
): PermissionDecision {
  if (!actor) {
    return {
      granted: false,
      requestedPermission: permissionCode,
      actorType: "unresolved",
      tenantId: null,
      sourceRoles: [],
      denialReasonCode: "ACTOR_NOT_RESOLVED",
      denialReason: "Actor could not be resolved from request context",
      note: "INV-ID2: Permission check is code-based, never role-name based.",
    };
  }

  if (targetTenantId && !actor.isSystemActor && actor.tenantId !== targetTenantId) {
    return {
      granted: false,
      requestedPermission: permissionCode,
      actorType: actor.actorType,
      tenantId: actor.tenantId,
      sourceRoles: actor.roleCodes,
      denialReasonCode: "TENANT_SCOPE_MISMATCH",
      denialReason: `Actor belongs to tenant ${actor.tenantId}, requested ${targetTenantId}`,
      note: "INV-ID10: Cross-tenant permission leakage prevented.",
    };
  }

  const granted = actorHasPermission(actor, permissionCode);
  return {
    granted,
    requestedPermission: permissionCode,
    actorType: actor.actorType,
    tenantId: actor.tenantId,
    sourceRoles: actor.roleCodes,
    denialReasonCode: granted ? undefined : "PERMISSION_NOT_GRANTED",
    denialReason: granted ? undefined : `Permission ${permissionCode} not in actor's granted set`,
    note: "INV-ID2: Permission check is code-based, never role-name based.",
  };
}

// ─── listActorPermissions ─────────────────────────────────────────────────────

export function listActorPermissions(actor: ResolvedActor): {
  actorType: string;
  actorId: string;
  tenantId: string | null;
  permissionCodes: string[];
  roleCodes: string[];
  permissionCount: number;
  note: string;
} {
  return {
    actorType: actor.actorType,
    actorId: actor.actorId,
    tenantId: actor.tenantId,
    permissionCodes: [...actor.permissionCodes],
    roleCodes: [...actor.roleCodes],
    permissionCount: actor.permissionCodes.length,
    note: "INV-ID2: Permissions listed by code. INV-ID8: Read-only. no writes.",
  };
}
