/**
 * Phase 8 — Canonical Audit Action Taxonomy
 * INV-AUD8: Canonical action codes must be used instead of ad hoc strings.
 */

// ─── Audit Actor Types ────────────────────────────────────────────────────────

export type AuditActorType =
  | "user"
  | "service_account"
  | "api_key"
  | "system"
  | "job"
  | "webhook"
  | "unknown";

export const AUDIT_ACTOR_TYPES: AuditActorType[] = [
  "user", "service_account", "api_key", "system", "job", "webhook", "unknown",
];

// ─── Audit Sources ────────────────────────────────────────────────────────────

export type AuditSource =
  | "application"
  | "admin_route"
  | "system_process"
  | "security_middleware"
  | "migration"
  | "job_runtime";

export const AUDIT_SOURCES: AuditSource[] = [
  "application", "admin_route", "system_process",
  "security_middleware", "migration", "job_runtime",
];

// ─── Event Status ─────────────────────────────────────────────────────────────

export type AuditEventStatus = "committed" | "best_effort" | "partial_context";

// ─── Canonical Action Codes ────────────────────────────────────────────────────
// INV-AUD8: All audit events must use one of these codes.

export const AUDIT_ACTIONS = {
  // ─── Identity ─────────────────────────────────────────────────────────────
  IDENTITY_MEMBERSHIP_CREATED: "identity.membership.created",
  IDENTITY_MEMBERSHIP_SUSPENDED: "identity.membership.suspended",
  IDENTITY_MEMBERSHIP_REMOVED: "identity.membership.removed",
  IDENTITY_INVITATION_CREATED: "identity.invitation.created",
  IDENTITY_INVITATION_REVOKED: "identity.invitation.revoked",
  IDENTITY_ROLE_ASSIGNED: "identity.role.assigned",
  IDENTITY_ROLE_REMOVED: "identity.role.removed",
  IDENTITY_SERVICE_ACCOUNT_CREATED: "identity.service_account.created",
  IDENTITY_SERVICE_ACCOUNT_KEY_CREATED: "identity.service_account_key.created",
  IDENTITY_SERVICE_ACCOUNT_KEY_REVOKED: "identity.service_account_key.revoked",
  IDENTITY_API_KEY_CREATED: "identity.api_key.created",
  IDENTITY_API_KEY_REVOKED: "identity.api_key.revoked",
  IDENTITY_PROVIDER_CREATED: "identity.provider.created",
  IDENTITY_PROVIDER_STATUS_UPDATED: "identity.provider.status_updated",

  // ─── Security ─────────────────────────────────────────────────────────────
  SECURITY_MFA_ENABLED: "security.mfa.enabled",
  SECURITY_MFA_DISABLED: "security.mfa.disabled",
  SECURITY_SESSION_REVOKED: "security.session.revoked",
  SECURITY_SESSION_REVOKE_ALL: "security.session.revoke_all",
  SECURITY_IP_ALLOWLIST_ADDED: "security.ip_allowlist.added",
  SECURITY_IP_ALLOWLIST_REMOVED: "security.ip_allowlist.removed",
  SECURITY_RECOVERY_CODES_GENERATED: "security.recovery_codes.generated",

  // ─── Tenant / Admin ───────────────────────────────────────────────────────
  TENANT_CREATED: "tenant.created",
  TENANT_UPDATED: "tenant.updated",
  TENANT_SUSPENDED: "tenant.suspended",
  TENANT_DELETED: "tenant.deleted",
  ADMIN_CONFIG_UPDATED: "admin.config.updated",

  // ─── Knowledge ────────────────────────────────────────────────────────────
  KNOWLEDGE_ASSET_CREATED: "knowledge.asset.created",
  KNOWLEDGE_ASSET_UPDATED: "knowledge.asset.updated",
  KNOWLEDGE_ASSET_DELETED: "knowledge.asset.deleted",
  KNOWLEDGE_CHUNK_INDEXED: "knowledge.chunk.indexed",

  // ─── Billing / Admin ─────────────────────────────────────────────────────
  BILLING_INVOICE_CREATED: "billing.invoice.created",
  BILLING_INVOICE_VOIDED: "billing.invoice.voided",
  BILLING_SUBSCRIPTION_UPDATED: "billing.subscription.updated",

  // ─── Audit Platform ───────────────────────────────────────────────────────
  AUDIT_EXPORT_STARTED: "audit.export.started",
  AUDIT_EXPORT_COMPLETED: "audit.export.completed",
  AUDIT_EXPORT_FAILED: "audit.export.failed",
} as const;

export type AuditAction = typeof AUDIT_ACTIONS[keyof typeof AUDIT_ACTIONS];

// ─── ALL_AUDIT_ACTION_CODES — used for validation ────────────────────────────

export const ALL_AUDIT_ACTION_CODES: string[] = Object.values(AUDIT_ACTIONS);

// ─── Domain groupings ─────────────────────────────────────────────────────────

export const AUDIT_ACTION_DOMAINS: Record<string, string[]> = {
  identity: Object.values(AUDIT_ACTIONS).filter((a) => a.startsWith("identity.")),
  security: Object.values(AUDIT_ACTIONS).filter((a) => a.startsWith("security.")),
  tenant: Object.values(AUDIT_ACTIONS).filter((a) => a.startsWith("tenant.")),
  admin: Object.values(AUDIT_ACTIONS).filter((a) => a.startsWith("admin.")),
  knowledge: Object.values(AUDIT_ACTIONS).filter((a) => a.startsWith("knowledge.")),
  billing: Object.values(AUDIT_ACTIONS).filter((a) => a.startsWith("billing.")),
  audit: Object.values(AUDIT_ACTIONS).filter((a) => a.startsWith("audit.")),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function isKnownAuditAction(action: string): boolean {
  return ALL_AUDIT_ACTION_CODES.includes(action);
}

export function getActionDomain(action: string): string {
  return action.split(".")[0] ?? "unknown";
}

export function isKnownActorType(t: string): t is AuditActorType {
  return AUDIT_ACTOR_TYPES.includes(t as AuditActorType);
}

export function explainAuditTaxonomy(): {
  totalActions: number;
  domains: Record<string, number>;
  actorTypes: string[];
  sources: string[];
  note: string;
} {
  return {
    totalActions: ALL_AUDIT_ACTION_CODES.length,
    domains: Object.fromEntries(Object.entries(AUDIT_ACTION_DOMAINS).map(([k, v]) => [k, v.length])),
    actorTypes: AUDIT_ACTOR_TYPES,
    sources: AUDIT_SOURCES,
    note: "INV-AUD8: All audit events must use canonical action codes from this taxonomy.",
  };
}
