/**
 * R2 Authorization Guards — Task 2
 * Enforces object-level access control based on actor role and key ownership.
 *
 * Rules:
 *  - Tenant actors may only access keys under tenants/{their-tenantId}/
 *  - Platform admins may access platform/* and all tenant/* keys
 *  - No actor may access keys not matching either namespace
 */

import {
  assertTenantScopedKey,
  isPlatformKey,
  isTenantKey,
  safeKeyForLog,
  TENANT_ROOT,
  PLATFORM_ROOT,
} from "./key-builder";

type ActorLike = { organizationId: string; role?: string; id?: string };

export class R2AccessDeniedError extends Error {
  readonly status = 403;
  constructor(message: string) { super(message); this.name = "R2AccessDeniedError"; }
}

// ── Role helpers ──────────────────────────────────────────────────────────────

function isPlatformAdmin(actor: ActorLike): boolean {
  return actor.role === "platform_admin" || actor.role === "owner";
}

// ── Core guard ────────────────────────────────────────────────────────────────

export function canAccessObjectKey(actor: ActorLike, key: string): boolean {
  // Platform admin can access everything
  if (isPlatformAdmin(actor)) return true;

  // Tenant actor: only their own prefix
  if (isTenantKey(key, actor.organizationId)) return true;

  return false;
}

function assertAccess(actor: ActorLike, key: string, operation: string): void {
  if (!canAccessObjectKey(actor, key)) {
    throw new R2AccessDeniedError(
      `Access denied: actor (org: ${actor.organizationId}, role: ${actor.role ?? "unknown"}) ` +
      `cannot ${operation} object key "${safeKeyForLog(key)}"`,
    );
  }
}

export function assertCanReadObject(actor: ActorLike, key: string): void {
  assertAccess(actor, key, "read");
}

export function assertCanWriteObject(actor: ActorLike, key: string): void {
  assertAccess(actor, key, "write");
}

export function assertCanDeleteObject(actor: ActorLike, key: string): void {
  assertAccess(actor, key, "delete");

  // Extra protection: platform/backups/ requires platform admin even for admins
  if (key.startsWith(`${PLATFORM_ROOT}/backups/`) && !isPlatformAdmin(actor)) {
    throw new R2AccessDeniedError(
      `Deleting platform backup objects requires platform admin role.`,
    );
  }
}

/** Returns the validated actor tenantId for use in key construction */
export function getActorTenantId(actor: ActorLike): string {
  const tid = actor.organizationId;
  if (!tid) throw new R2AccessDeniedError("Actor has no organizationId");
  return tid;
}

/** Whether the actor is allowed to list/admin platform-level usage stats */
export function canViewPlatformUsage(actor: ActorLike): boolean {
  return isPlatformAdmin(actor);
}
