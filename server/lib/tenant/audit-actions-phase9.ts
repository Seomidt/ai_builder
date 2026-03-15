/**
 * Phase 9 — Tenant Lifecycle Audit Action Codes
 * Extends the Phase 8 canonical audit taxonomy.
 * INV-TEN8: All lifecycle changes must use these canonical codes.
 */

export const TENANT_AUDIT_ACTIONS = {
  // ─── Tenant lifecycle ──────────────────────────────────────────────────────
  TENANT_CREATED: "tenant.created",
  TENANT_UPDATED: "tenant.updated",
  TENANT_STATUS_CHANGED: "tenant.status.changed",
  TENANT_SUSPENDED: "tenant.suspended",
  TENANT_REACTIVATED: "tenant.reactivated",
  TENANT_OFFBOARDING_STARTED: "tenant.offboarding.started",
  TENANT_DELETED: "tenant.deleted",

  // ─── Settings ──────────────────────────────────────────────────────────────
  TENANT_SETTINGS_CREATED: "tenant.settings.created",
  TENANT_SETTINGS_UPDATED: "tenant.settings.updated",

  // ─── Domains ───────────────────────────────────────────────────────────────
  TENANT_DOMAIN_ADDED: "tenant.domain.added",
  TENANT_DOMAIN_STATUS_UPDATED: "tenant.domain.status_updated",

  // ─── Export orchestration ──────────────────────────────────────────────────
  TENANT_EXPORT_REQUESTED: "tenant.export.requested",
  TENANT_EXPORT_STARTED: "tenant.export.started",
  TENANT_EXPORT_COMPLETED: "tenant.export.completed",
  TENANT_EXPORT_FAILED: "tenant.export.failed",

  // ─── Deletion orchestration ────────────────────────────────────────────────
  TENANT_DELETION_REQUESTED: "tenant.deletion.requested",
  TENANT_DELETION_APPROVED: "tenant.deletion.approved",
  TENANT_DELETION_BLOCKED: "tenant.deletion.blocked",
  TENANT_DELETION_STARTED: "tenant.deletion.started",
  TENANT_DELETION_COMPLETED: "tenant.deletion.completed",
  TENANT_DELETION_FAILED: "tenant.deletion.failed",
} as const;

export type TenantAuditAction = typeof TENANT_AUDIT_ACTIONS[keyof typeof TENANT_AUDIT_ACTIONS];

export const ALL_TENANT_AUDIT_ACTION_CODES: string[] = Object.values(TENANT_AUDIT_ACTIONS);

export function isKnownTenantAuditAction(action: string): boolean {
  return ALL_TENANT_AUDIT_ACTION_CODES.includes(action);
}
