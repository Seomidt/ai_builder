/**
 * Phase 6 — Identity Backward Compatibility Layer
 * INV-ID9: Backward compatibility with current internal/admin flows must remain intact.
 */

import type { ResolvedActor } from "./actor-resolution";

// ─── explainCurrentAuthCompatibilityState ─────────────────────────────────────

export function explainCurrentAuthCompatibilityState(): {
  legacyAuthModel: string;
  canonicalModel: string;
  coexistenceStrategy: string;
  migratedRoutes: string[];
  legacyRoutes: string[];
  breakingChanges: string[];
  note: string;
} {
  return {
    legacyAuthModel: "Supabase JWT → req.user {id, email, organizationId, role} — demo fallback to demo-user/demo-org/owner",
    canonicalModel: "Phase 6 canonical actor: resolveRequestActor() → ResolvedActor with permissionCodes + roleCodes + actorType",
    coexistenceStrategy:
      "Legacy req.user remains untouched. resolveRequestActor() reads req.resolvedActor first, falls back to req.user for backward compatibility. " +
      "Admin routes that use requireInternalAdminPermission() use canonical actor. All old routes continue to work without modification.",
    migratedRoutes: ["/api/admin/identity/*"],
    legacyRoutes: [
      "/api/admin/knowledge/*",
      "/api/admin/retrieval/*",
      "/api/admin/billing/*",
      "/api/admin/db-security/*",
      "/api/admin/asset-processing/*",
    ],
    breakingChanges: [],
    note: "INV-ID9: No breaking changes. Canonical layer is additive only.",
  };
}

// ─── previewIdentityMigrationImpact ──────────────────────────────────────────

export function previewIdentityMigrationImpact(routePattern: string): {
  routePattern: string;
  currentProtection: string;
  recommendedProtection: string;
  migrationRisk: "low" | "medium" | "high";
  migrationSteps: string[];
  note: string;
} {
  const isAdmin = routePattern.includes("/api/admin");
  const isIdentity = routePattern.includes("/api/admin/identity");

  return {
    routePattern,
    currentProtection: isAdmin ? "Internal only (no JWT required in admin.ts)" : "authMiddleware + req.user",
    recommendedProtection: isIdentity
      ? "requireInternalAdminPermission('admin.internal.write') or requireInternalAdminPermission('admin.internal.read')"
      : "requireRequestPermission(actor, 'permission.code')",
    migrationRisk: isAdmin ? "low" : "medium",
    migrationSteps: [
      "1. Attach actor via attachResolvedActorToRequest(req)",
      "2. Replace direct req.user checks with resolveRequestActor(req)",
      "3. Replace role string checks with requirePermission(actor, 'code')",
      "4. Add explainRequestAccess for observability",
    ],
    note: "INV-ID8: Preview only. no writes. INV-ID9: Migration is incremental.",
  };
}

// ─── explainLegacyAccessAssumptions ──────────────────────────────────────────

export function explainLegacyAccessAssumptions(): {
  assumptions: Array<{ name: string; currentValue: string; riskIfUnchanged: string }>;
  note: string;
} {
  return {
    assumptions: [
      {
        name: "demo-user fallback",
        currentValue: "All unauthenticated requests get demo-user/demo-org/owner role",
        riskIfUnchanged: "Dev-only acceptable. Production must enforce JWT validation.",
      },
      {
        name: "req.user.role is a string",
        currentValue: "Role stored as string: 'owner', 'member', 'admin'",
        riskIfUnchanged: "Not permission-code based. Cannot enforce fine-grained permissions without migration.",
      },
      {
        name: "organizationId as tenantId",
        currentValue: "organizationId used as tenant scope everywhere",
        riskIfUnchanged: "Compatible with Phase 6 tenantId. No collision.",
      },
      {
        name: "Admin routes unprotected at middleware level",
        currentValue: "Admin routes rely on internal-only assumption (no public exposure)",
        riskIfUnchanged: "Acceptable while platform is internal-only. Future: add permission guards.",
      },
    ],
    note: "INV-ID9: Legacy assumptions documented for incremental migration. no writes.",
  };
}

// ─── mapCurrentUserToCanonicalActor ──────────────────────────────────────────

export function mapCurrentUserToCanonicalActor(reqUser: {
  id: string;
  email?: string;
  organizationId: string;
  role: string;
}): ResolvedActor {
  const ALL_PERMISSIONS = [
    "tenant.read", "tenant.update", "tenant.manage_members", "tenant.manage_roles", "tenant.manage_identity_providers",
    "knowledge.read", "knowledge.write", "knowledge.delete", "knowledge.admin", "knowledge.source.sync",
    "retrieval.query", "retrieval.admin", "retrieval.operator_metrics",
    "billing.read", "billing.manage", "billing.invoices.read",
    "ai.run", "ai.admin",
    "admin.internal.read", "admin.internal.write",
    "api.access", "api.admin",
  ];

  const ROLE_PERMISSIONS: Record<string, string[]> = {
    owner: ALL_PERMISSIONS,
    admin: ALL_PERMISSIONS.filter((p) => !p.startsWith("billing.")),
    member: ["tenant.read", "knowledge.read", "retrieval.query", "ai.run"],
    viewer: ["tenant.read", "knowledge.read"],
  };

  const isDemo = reqUser.id === "demo-user";
  const permissionCodes = ROLE_PERMISSIONS[reqUser.role] ?? ROLE_PERMISSIONS["member"] ?? [];

  return {
    actorType: isDemo ? "system" : "human",
    actorId: reqUser.id,
    tenantId: reqUser.organizationId,
    subjectId: reqUser.id,
    membershipId: null,
    serviceAccountId: null,
    apiKeyId: null,
    permissionCodes: isDemo ? ALL_PERMISSIONS : permissionCodes,
    roleCodes: [reqUser.role],
    authSource: isDemo ? "demo" : "supabase_jwt",
    isMachineActor: false,
    isSystemActor: isDemo,
  };
}
