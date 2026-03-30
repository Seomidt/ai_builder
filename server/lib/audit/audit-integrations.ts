/**
 * Phase 8 — Audit Service Integration Hooks
 * Pre-built hooks for integrating audit into existing identity/security services.
 * INV-AUD4: All hooks are non-blocking — errors are observed, not thrown.
 * INV-AUD8: Uses canonical action codes from audit-actions.ts.
 * INV-AUD9: Does NOT replace security_events — both may fire for same operation.
 */

import { logAuditBestEffort, logAuditResourceChange, logAuditEvent } from "./audit-log.ts";
import { buildBestEffortAuditContext, buildSystemAuditContext } from "./audit-context.ts";
import { AUDIT_ACTIONS } from "./audit-actions.ts";

// ─── Identity Integration Hooks ───────────────────────────────────────────────

export async function auditMembershipCreated(params: {
  tenantId: string;
  actorId?: string;
  userId: string;
  role: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.IDENTITY_MEMBERSHIP_CREATED,
    resourceType: "membership",
    resourceId: params.userId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `Membership created for user ${params.userId} with role ${params.role}`,
    metadata: { userId: params.userId, role: params.role },
  });
}

export async function auditMembershipSuspended(params: {
  tenantId: string;
  actorId?: string;
  membershipId: string;
  userId: string;
  reason?: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.IDENTITY_MEMBERSHIP_SUSPENDED,
    resourceType: "membership",
    resourceId: params.membershipId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `Membership ${params.membershipId} suspended for user ${params.userId}`,
    metadata: { membershipId: params.membershipId, userId: params.userId, reason: params.reason },
  });
}

export async function auditMembershipRemoved(params: {
  tenantId: string;
  actorId?: string;
  membershipId: string;
  userId: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.IDENTITY_MEMBERSHIP_REMOVED,
    resourceType: "membership",
    resourceId: params.membershipId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `Membership ${params.membershipId} removed for user ${params.userId}`,
    metadata: { membershipId: params.membershipId, userId: params.userId },
  });
}

export async function auditInvitationCreated(params: {
  tenantId: string;
  actorId?: string;
  invitationId: string;
  inviteeEmail: string;
  role: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.IDENTITY_INVITATION_CREATED,
    resourceType: "invitation",
    resourceId: params.invitationId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `Invitation created for ${params.inviteeEmail} with role ${params.role}`,
    metadata: { invitationId: params.invitationId, inviteeEmail: params.inviteeEmail, role: params.role },
  });
}

export async function auditInvitationRevoked(params: {
  tenantId: string;
  actorId?: string;
  invitationId: string;
  reason?: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.IDENTITY_INVITATION_REVOKED,
    resourceType: "invitation",
    resourceId: params.invitationId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `Invitation ${params.invitationId} revoked`,
    metadata: { invitationId: params.invitationId, reason: params.reason },
  });
}

export async function auditRoleAssigned(params: {
  tenantId: string;
  actorId?: string;
  membershipId: string;
  roleCode: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.IDENTITY_ROLE_ASSIGNED,
    resourceType: "membership_role",
    resourceId: params.membershipId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `Role '${params.roleCode}' assigned to membership ${params.membershipId}`,
    metadata: { membershipId: params.membershipId, roleCode: params.roleCode },
  });
}

export async function auditRoleRemoved(params: {
  tenantId: string;
  actorId?: string;
  membershipId: string;
  roleCode: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.IDENTITY_ROLE_REMOVED,
    resourceType: "membership_role",
    resourceId: params.membershipId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `Role '${params.roleCode}' removed from membership ${params.membershipId}`,
    metadata: { membershipId: params.membershipId, roleCode: params.roleCode },
  });
}

export async function auditServiceAccountCreated(params: {
  tenantId: string;
  actorId?: string;
  serviceAccountId: string;
  name: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.IDENTITY_SERVICE_ACCOUNT_CREATED,
    resourceType: "service_account",
    resourceId: params.serviceAccountId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `Service account '${params.name}' created`,
    metadata: { serviceAccountId: params.serviceAccountId, name: params.name },
  });
}

export async function auditServiceAccountKeyCreated(params: {
  tenantId: string;
  actorId?: string;
  serviceAccountId: string;
  keyId: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.IDENTITY_SERVICE_ACCOUNT_KEY_CREATED,
    resourceType: "service_account_key",
    resourceId: params.keyId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `Service account key created for SA ${params.serviceAccountId}`,
    metadata: { serviceAccountId: params.serviceAccountId, keyId: params.keyId },
  });
}

export async function auditServiceAccountKeyRevoked(params: {
  tenantId: string;
  actorId?: string;
  keyId: string;
  reason?: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.IDENTITY_SERVICE_ACCOUNT_KEY_REVOKED,
    resourceType: "service_account_key",
    resourceId: params.keyId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `Service account key ${params.keyId} revoked`,
    metadata: { keyId: params.keyId, reason: params.reason },
  });
}

export async function auditApiKeyCreated(params: {
  tenantId: string;
  actorId?: string;
  apiKeyId: string;
  name: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.IDENTITY_API_KEY_CREATED,
    resourceType: "api_key",
    resourceId: params.apiKeyId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `API key '${params.name}' created`,
    metadata: { apiKeyId: params.apiKeyId, name: params.name },
  });
}

export async function auditApiKeyRevoked(params: {
  tenantId: string;
  actorId?: string;
  apiKeyId: string;
  reason?: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.IDENTITY_API_KEY_REVOKED,
    resourceType: "api_key",
    resourceId: params.apiKeyId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `API key ${params.apiKeyId} revoked`,
    metadata: { apiKeyId: params.apiKeyId, reason: params.reason },
  });
}

export async function auditIdentityProviderCreated(params: {
  tenantId: string;
  actorId?: string;
  providerId: string;
  providerType: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.IDENTITY_PROVIDER_CREATED,
    resourceType: "identity_provider",
    resourceId: params.providerId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `Identity provider '${params.providerType}' created`,
    metadata: { providerId: params.providerId, providerType: params.providerType },
  });
}

export async function auditIdentityProviderStatusUpdated(params: {
  tenantId: string;
  actorId?: string;
  providerId: string;
  newStatus: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.IDENTITY_PROVIDER_STATUS_UPDATED,
    resourceType: "identity_provider",
    resourceId: params.providerId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `Identity provider ${params.providerId} status updated to ${params.newStatus}`,
    metadata: { providerId: params.providerId, newStatus: params.newStatus },
  });
}

// ─── Security Integration Hooks ───────────────────────────────────────────────

export async function auditMfaEnabled(params: {
  tenantId: string;
  actorId: string;
  methodType: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.SECURITY_MFA_ENABLED,
    resourceType: "mfa_method",
    resourceId: params.actorId,
    actorId: params.actorId,
    actorType: "user",
    ipAddress: params.ipAddress,
    summary: `MFA ${params.methodType} enabled for user ${params.actorId}`,
    metadata: { methodType: params.methodType },
  });
}

export async function auditMfaDisabled(params: {
  tenantId: string;
  actorId: string;
  methodType?: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.SECURITY_MFA_DISABLED,
    resourceType: "mfa_method",
    resourceId: params.actorId,
    actorId: params.actorId,
    actorType: "user",
    ipAddress: params.ipAddress,
    summary: `MFA ${params.methodType ?? "all"} disabled for user ${params.actorId}`,
    metadata: { methodType: params.methodType ?? "all" },
  });
}

export async function auditSessionRevoked(params: {
  tenantId: string;
  actorId?: string;
  sessionId: string;
  reason?: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.SECURITY_SESSION_REVOKED,
    resourceType: "session",
    resourceId: params.sessionId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `Session ${params.sessionId} revoked`,
    metadata: { sessionId: params.sessionId, reason: params.reason },
  });
}

export async function auditSessionRevokeAll(params: {
  tenantId: string;
  actorId?: string;
  targetUserId: string;
  revokedCount: number;
  reason?: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.SECURITY_SESSION_REVOKE_ALL,
    resourceType: "session",
    resourceId: params.targetUserId,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `All sessions (${params.revokedCount}) revoked for user ${params.targetUserId}`,
    metadata: { targetUserId: params.targetUserId, revokedCount: params.revokedCount, reason: params.reason },
  });
}

export async function auditIpAllowlistAdded(params: {
  tenantId: string;
  actorId?: string;
  ipRange: string;
  description?: string;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.SECURITY_IP_ALLOWLIST_ADDED,
    resourceType: "ip_allowlist",
    resourceId: params.ipRange,
    actorId: params.actorId,
    actorType: params.actorId ? "user" : "system",
    ipAddress: params.ipAddress,
    summary: `IP range ${params.ipRange} added to allowlist`,
    metadata: { ipRange: params.ipRange, description: params.description },
  });
}

export async function auditRecoveryCodesGenerated(params: {
  tenantId: string;
  actorId: string;
  count: number;
  ipAddress?: string;
}): Promise<void> {
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: AUDIT_ACTIONS.SECURITY_RECOVERY_CODES_GENERATED,
    resourceType: "mfa_recovery_codes",
    resourceId: params.actorId,
    actorId: params.actorId,
    actorType: "user",
    ipAddress: params.ipAddress,
    summary: `${params.count} MFA recovery codes generated for user ${params.actorId}`,
    metadata: { count: params.count },
  });
}
