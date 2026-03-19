/**
 * R2 Delete Policy — Task 6
 * Enforces delete safety rules and provides risk assessment for deletions.
 *
 * Risk levels:
 *   low      — regular tenant uploads/exports
 *   medium   — invoices, logs, reports
 *   high     — platform files, audit exports
 *   critical — platform/backups/
 */

import { PLATFORM_ROOT, TENANT_ROOT } from "./key-builder";
import { R2AccessDeniedError } from "./r2-auth";

type ActorLike = { organizationId: string; role?: string; id?: string };

export type DeleteRiskLevel = "low" | "medium" | "high" | "critical";

export interface DeleteDecision {
  allowed:       boolean;
  riskLevel:     DeleteRiskLevel;
  reason:        string;
  requiresAdmin: boolean;
  key:           string;
}

// ── Risk assessment ───────────────────────────────────────────────────────────

export function getDeleteRiskLevel(key: string): DeleteRiskLevel {
  if (key.startsWith(`${PLATFORM_ROOT}/backups/`))        return "critical";
  if (key.startsWith(`${PLATFORM_ROOT}/`))                return "high";
  if (key.includes("/invoices/"))                          return "medium";
  if (key.includes("/logs/"))                              return "medium";
  if (key.includes("/audit-exports/"))                     return "high";
  return "low";
}

export function explainDeleteDecision(actor: ActorLike, key: string): DeleteDecision {
  const risk = getDeleteRiskLevel(key);
  const isPlatformAdmin = actor.role === "platform_admin" || actor.role === "owner";
  const isTenantKey = key.startsWith(`${TENANT_ROOT}/${actor.organizationId}/`);
  const isPlatformKey = key.startsWith(`${PLATFORM_ROOT}/`);

  // Critical: platform/backups/ — only platform admin
  if (key.startsWith(`${PLATFORM_ROOT}/backups/`)) {
    const allowed = isPlatformAdmin;
    return {
      allowed,
      riskLevel:     "critical",
      requiresAdmin: true,
      key,
      reason: allowed
        ? "Platform admin may delete backup objects."
        : "Deletion of platform backup objects is restricted to platform admins.",
    };
  }

  // Platform files: require platform admin
  if (isPlatformKey) {
    const allowed = isPlatformAdmin;
    return {
      allowed,
      riskLevel:     "high",
      requiresAdmin: true,
      key,
      reason: allowed
        ? "Platform admin may delete platform-level objects."
        : "Platform-level objects may only be deleted by platform admins.",
    };
  }

  // Tenant file: actor must own the prefix
  if (isTenantKey) {
    return {
      allowed:       true,
      riskLevel:     risk,
      requiresAdmin: false,
      key,
      reason: `Tenant owns this object. Risk level: ${risk}.`,
    };
  }

  // Platform admin can delete anything
  if (isPlatformAdmin) {
    return {
      allowed:       true,
      riskLevel:     risk,
      requiresAdmin: true,
      key,
      reason: "Platform admin has delete rights over all objects.",
    };
  }

  return {
    allowed:       false,
    riskLevel:     risk,
    requiresAdmin: false,
    key,
    reason: "Key does not belong to actor's tenant and actor is not a platform admin.",
  };
}

export function assertDeleteAllowed(actor: ActorLike, key: string): void {
  const decision = explainDeleteDecision(actor, key);
  if (!decision.allowed) {
    throw new R2AccessDeniedError(`Delete denied (${decision.riskLevel}): ${decision.reason}`);
  }
}
