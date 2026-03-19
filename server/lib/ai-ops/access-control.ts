// ─── Phase 51: AI Ops Assistant — Access Control ──────────────────────────────
//
// Strict access model for the AI Ops Assistant.
// - Platform admins: platform-wide + tenant-scoped summaries
// - Tenant admins: tenant-scoped summaries ONLY, own org only
// - Regular users: NO access
// - No cross-tenant leakage in tenant mode
// ─────────────────────────────────────────────────────────────────────────────

import { type OpsIntentId, type OpsIntentAudience, INTENT_DEFINITIONS } from "./intents";

export type AiOpsRole = "platform_admin" | "tenant_admin" | "none";

export interface AiOpsUser {
  userId: string;
  role: AiOpsRole;
  organizationId?: string;
}

export interface AiOpsScope {
  mode: "platform" | "tenant";
  organizationId?: string;
  tenantId?: string;
  requestingUserId: string;
  role: AiOpsRole;
}

export interface AiOpsAccessContext {
  user: AiOpsUser;
  requestedIntent: OpsIntentId;
  requestedOrganizationId?: string;
}

export class AiOpsAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiOpsAccessError";
  }
}

export class AiOpsTenantScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiOpsTenantScopeError";
  }
}

const PLATFORM_ADMIN_ROLES: AiOpsRole[] = ["platform_admin"];
const TENANT_ADMIN_ROLES: AiOpsRole[] = ["tenant_admin"];
const ALL_ALLOWED_ROLES: AiOpsRole[] = ["platform_admin", "tenant_admin"];

function audienceToRoles(audience: OpsIntentAudience[]): AiOpsRole[] {
  const roles: AiOpsRole[] = [];
  for (const a of audience) {
    if (a === "platform_admin") roles.push("platform_admin");
    if (a === "tenant_admin") roles.push("tenant_admin");
    if (a === "ops_only") roles.push("platform_admin");
  }
  return [...new Set(roles)];
}

export function assertAiOpsAccess(ctx: AiOpsAccessContext): void {
  const { user, requestedIntent, requestedOrganizationId } = ctx;

  if (user.role === "none") {
    throw new AiOpsAccessError(
      `User ${user.userId} does not have AI Ops access. Role "none" is not permitted.`,
    );
  }

  const intentDef = INTENT_DEFINITIONS[requestedIntent];
  const allowedRoles = audienceToRoles(intentDef.allowedAudience);

  if (!allowedRoles.includes(user.role)) {
    throw new AiOpsAccessError(
      `Role "${user.role}" is not permitted for intent "${requestedIntent}". ` +
        `Allowed roles: ${allowedRoles.join(", ")}.`,
    );
  }

  if (intentDef.isPlatformWide && !intentDef.isTenantScoped) {
    if (!PLATFORM_ADMIN_ROLES.includes(user.role)) {
      throw new AiOpsAccessError(
        `Intent "${requestedIntent}" is platform-wide and requires platform_admin role. ` +
          `User role: "${user.role}".`,
      );
    }
  }

  if (user.role === "tenant_admin") {
    if (!intentDef.isTenantScoped) {
      throw new AiOpsAccessError(
        `Tenant admins cannot request platform-wide intent "${requestedIntent}".`,
      );
    }

    const effectiveOrgId = requestedOrganizationId ?? user.organizationId;
    if (effectiveOrgId && user.organizationId && effectiveOrgId !== user.organizationId) {
      throw new AiOpsTenantScopeError(
        `Tenant admin ${user.userId} cannot access data for org "${effectiveOrgId}". ` +
          `Only their own org "${user.organizationId}" is allowed.`,
      );
    }
  }
}

export function resolveAiOpsScope(ctx: AiOpsAccessContext): AiOpsScope {
  assertAiOpsAccess(ctx);

  const { user, requestedIntent, requestedOrganizationId } = ctx;
  const intentDef = INTENT_DEFINITIONS[requestedIntent];

  if (user.role === "tenant_admin") {
    const orgId = user.organizationId;
    return {
      mode: "tenant",
      organizationId: orgId,
      tenantId: orgId,
      requestingUserId: user.userId,
      role: user.role,
    };
  }

  if (requestedOrganizationId && intentDef.isTenantScoped) {
    return {
      mode: "tenant",
      organizationId: requestedOrganizationId,
      tenantId: requestedOrganizationId,
      requestingUserId: user.userId,
      role: user.role,
    };
  }

  return {
    mode: "platform",
    requestingUserId: user.userId,
    role: user.role,
  };
}

export function assertTenantScopeAllowed(
  scope: AiOpsScope,
  requestedOrganizationId: string,
): void {
  if (scope.mode === "tenant" && scope.organizationId !== requestedOrganizationId) {
    throw new AiOpsTenantScopeError(
      `Cross-tenant access denied. Scope is locked to org "${scope.organizationId}", ` +
        `but request targets "${requestedOrganizationId}".`,
    );
  }

  if (scope.role === "tenant_admin" && scope.mode === "platform") {
    throw new AiOpsTenantScopeError(
      `Tenant admin cannot operate in platform scope.`,
    );
  }
}

export function canAccessPlatformWide(user: AiOpsUser): boolean {
  return PLATFORM_ADMIN_ROLES.includes(user.role);
}

export function canAccessTenantScoped(user: AiOpsUser): boolean {
  return ALL_ALLOWED_ROLES.includes(user.role);
}

export function resolveUserFromRequest(req: {
  user?: {
    id?: string;
    role?: string;
    organizationId?: string;
  } | null;
}): AiOpsUser {
  if (!req.user?.id) {
    return { userId: "anonymous", role: "none" };
  }

  const rawRole = req.user.role ?? "";
  let role: AiOpsRole = "none";
  if (rawRole === "platform_admin" || rawRole === "admin" || rawRole === "ops") {
    role = "platform_admin";
  } else if (rawRole === "tenant_admin" || rawRole === "owner" || rawRole === "member") {
    role = "tenant_admin";
  }

  return {
    userId: req.user.id,
    role,
    organizationId: req.user.organizationId,
  };
}
