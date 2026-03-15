/**
 * Phase 9 — Tenant Access Enforcement
 * INV-TEN4: Suspended/offboarding/deleted tenants must not be treated as operationally active.
 * INV-TEN9: explainTenantAccessState is read-only.
 * INV-TEN12: Current healthy flows for active tenants must remain intact.
 */

import pg from "pg";
import type { TenantLifecycleStatus } from "./tenant-lifecycle";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ─── TenantAccessResult ───────────────────────────────────────────────────────

export interface TenantAccessResult {
  allowed: boolean;
  reason: string;
  lifecycleStatus: TenantLifecycleStatus | null;
  settingFlag: boolean | null;
}

// ─── resolveAccessState ───────────────────────────────────────────────────────
// Internal: loads tenant and settings in one pass.

async function resolveAccessState(tenantId: string): Promise<{
  lifecycleStatus: TenantLifecycleStatus | null;
  allowLogin: boolean;
  allowApiAccess: boolean;
  allowAiRuntime: boolean;
  allowKnowledgeAccess: boolean;
  allowBillingAccess: boolean;
  tenantFound: boolean;
  settingsFound: boolean;
}> {
  const client = getClient();
  await client.connect();
  try {
    const tenantRow = await client.query(
      `SELECT lifecycle_status FROM public.tenants WHERE id = $1`,
      [tenantId],
    );
    if (tenantRow.rows.length === 0) {
      return {
        lifecycleStatus: null,
        allowLogin: false, allowApiAccess: false, allowAiRuntime: false,
        allowKnowledgeAccess: false, allowBillingAccess: false,
        tenantFound: false, settingsFound: false,
      };
    }

    const ls = tenantRow.rows[0].lifecycle_status as TenantLifecycleStatus;

    const settingsRow = await client.query(
      `SELECT allow_login, allow_api_access, allow_ai_runtime, allow_knowledge_access, allow_billing_access
       FROM public.tenant_settings WHERE tenant_id = $1 AND settings_status = 'active' LIMIT 1`,
      [tenantId],
    );

    if (settingsRow.rows.length === 0) {
      return {
        lifecycleStatus: ls,
        allowLogin: ls === "active" || ls === "trial",
        allowApiAccess: ls === "active" || ls === "trial",
        allowAiRuntime: ls === "active" || ls === "trial",
        allowKnowledgeAccess: ls === "active" || ls === "trial",
        allowBillingAccess: ls === "active" || ls === "trial",
        tenantFound: true, settingsFound: false,
      };
    }

    const s = settingsRow.rows[0];
    return {
      lifecycleStatus: ls,
      allowLogin: s.allow_login,
      allowApiAccess: s.allow_api_access,
      allowAiRuntime: s.allow_ai_runtime,
      allowKnowledgeAccess: s.allow_knowledge_access,
      allowBillingAccess: s.allow_billing_access,
      tenantFound: true, settingsFound: true,
    };
  } finally {
    await client.end();
  }
}

// ─── lifecycleAllowsAccess ────────────────────────────────────────────────────
// Pure lifecycle check — does not consult settings.

function lifecycleAllowsAccess(status: TenantLifecycleStatus | null): boolean {
  if (!status) return false;
  return status === "active" || status === "trial";
}

function lifecycleDenyReason(status: TenantLifecycleStatus | null): string {
  if (!status) return "Tenant not found";
  if (status === "suspended") return "Tenant is suspended";
  if (status === "delinquent") return "Tenant is delinquent";
  if (status === "offboarding") return "Tenant is offboarding";
  if (status === "deleted") return "Tenant is deleted";
  return "Access allowed";
}

// ─── assertTenantIsOperational ────────────────────────────────────────────────
// INV-TEN4: Throws if tenant cannot proceed.

export async function assertTenantIsOperational(tenantId: string): Promise<void> {
  const state = await resolveAccessState(tenantId);
  if (!lifecycleAllowsAccess(state.lifecycleStatus)) {
    throw new Error(`INV-TEN4: Tenant '${tenantId}' is not operational. Reason: ${lifecycleDenyReason(state.lifecycleStatus)}`);
  }
}

// ─── canTenantLogin ────────────────────────────────────────────────────────────

export async function canTenantLogin(tenantId: string): Promise<TenantAccessResult> {
  const state = await resolveAccessState(tenantId);
  if (!state.tenantFound) return { allowed: false, reason: "Tenant not found", lifecycleStatus: null, settingFlag: null };
  if (!lifecycleAllowsAccess(state.lifecycleStatus)) {
    return { allowed: false, reason: lifecycleDenyReason(state.lifecycleStatus), lifecycleStatus: state.lifecycleStatus, settingFlag: null };
  }
  if (!state.allowLogin) {
    return { allowed: false, reason: "Login disabled by tenant settings", lifecycleStatus: state.lifecycleStatus, settingFlag: false };
  }
  return { allowed: true, reason: "Access allowed", lifecycleStatus: state.lifecycleStatus, settingFlag: state.allowLogin };
}

// ─── canTenantUseApi ──────────────────────────────────────────────────────────

export async function canTenantUseApi(tenantId: string): Promise<TenantAccessResult> {
  const state = await resolveAccessState(tenantId);
  if (!state.tenantFound) return { allowed: false, reason: "Tenant not found", lifecycleStatus: null, settingFlag: null };
  if (!lifecycleAllowsAccess(state.lifecycleStatus)) {
    return { allowed: false, reason: lifecycleDenyReason(state.lifecycleStatus), lifecycleStatus: state.lifecycleStatus, settingFlag: null };
  }
  if (!state.allowApiAccess) {
    return { allowed: false, reason: "API access disabled by tenant settings", lifecycleStatus: state.lifecycleStatus, settingFlag: false };
  }
  return { allowed: true, reason: "Access allowed", lifecycleStatus: state.lifecycleStatus, settingFlag: state.allowApiAccess };
}

// ─── canTenantUseAiRuntime ────────────────────────────────────────────────────

export async function canTenantUseAiRuntime(tenantId: string): Promise<TenantAccessResult> {
  const state = await resolveAccessState(tenantId);
  if (!state.tenantFound) return { allowed: false, reason: "Tenant not found", lifecycleStatus: null, settingFlag: null };
  if (!lifecycleAllowsAccess(state.lifecycleStatus)) {
    return { allowed: false, reason: lifecycleDenyReason(state.lifecycleStatus), lifecycleStatus: state.lifecycleStatus, settingFlag: null };
  }
  if (!state.allowAiRuntime) {
    return { allowed: false, reason: "AI runtime disabled by tenant settings", lifecycleStatus: state.lifecycleStatus, settingFlag: false };
  }
  return { allowed: true, reason: "Access allowed", lifecycleStatus: state.lifecycleStatus, settingFlag: state.allowAiRuntime };
}

// ─── canTenantAccessKnowledge ─────────────────────────────────────────────────

export async function canTenantAccessKnowledge(tenantId: string): Promise<TenantAccessResult> {
  const state = await resolveAccessState(tenantId);
  if (!state.tenantFound) return { allowed: false, reason: "Tenant not found", lifecycleStatus: null, settingFlag: null };
  if (!lifecycleAllowsAccess(state.lifecycleStatus)) {
    return { allowed: false, reason: lifecycleDenyReason(state.lifecycleStatus), lifecycleStatus: state.lifecycleStatus, settingFlag: null };
  }
  if (!state.allowKnowledgeAccess) {
    return { allowed: false, reason: "Knowledge access disabled by tenant settings", lifecycleStatus: state.lifecycleStatus, settingFlag: false };
  }
  return { allowed: true, reason: "Access allowed", lifecycleStatus: state.lifecycleStatus, settingFlag: state.allowKnowledgeAccess };
}

// ─── canTenantAccessBilling ───────────────────────────────────────────────────

export async function canTenantAccessBilling(tenantId: string): Promise<TenantAccessResult> {
  const state = await resolveAccessState(tenantId);
  if (!state.tenantFound) return { allowed: false, reason: "Tenant not found", lifecycleStatus: null, settingFlag: null };
  if (!lifecycleAllowsAccess(state.lifecycleStatus)) {
    return { allowed: false, reason: lifecycleDenyReason(state.lifecycleStatus), lifecycleStatus: state.lifecycleStatus, settingFlag: null };
  }
  if (!state.allowBillingAccess) {
    return { allowed: false, reason: "Billing access disabled by tenant settings", lifecycleStatus: state.lifecycleStatus, settingFlag: false };
  }
  return { allowed: true, reason: "Access allowed", lifecycleStatus: state.lifecycleStatus, settingFlag: state.allowBillingAccess };
}

// ─── explainTenantAccessState ─────────────────────────────────────────────────
// INV-TEN9: Read-only — no writes.

export async function explainTenantAccessState(tenantId: string): Promise<{
  tenantId: string;
  lifecycleStatus: TenantLifecycleStatus | null;
  tenantFound: boolean;
  settingsFound: boolean;
  canLogin: boolean;
  canUseApi: boolean;
  canUseAiRuntime: boolean;
  canAccessKnowledge: boolean;
  canAccessBilling: boolean;
  isOperational: boolean;
  blockedCapabilities: string[];
  note: string;
}> {
  const state = await resolveAccessState(tenantId);
  const lifecycleOk = lifecycleAllowsAccess(state.lifecycleStatus);

  const blocked: string[] = [];
  if (!lifecycleOk) {
    blocked.push("login", "api_access", "ai_runtime", "knowledge_access", "billing_access");
  } else {
    if (!state.allowLogin) blocked.push("login");
    if (!state.allowApiAccess) blocked.push("api_access");
    if (!state.allowAiRuntime) blocked.push("ai_runtime");
    if (!state.allowKnowledgeAccess) blocked.push("knowledge_access");
    if (!state.allowBillingAccess) blocked.push("billing_access");
  }

  return {
    tenantId,
    lifecycleStatus: state.lifecycleStatus,
    tenantFound: state.tenantFound,
    settingsFound: state.settingsFound,
    canLogin: lifecycleOk && state.allowLogin,
    canUseApi: lifecycleOk && state.allowApiAccess,
    canUseAiRuntime: lifecycleOk && state.allowAiRuntime,
    canAccessKnowledge: lifecycleOk && state.allowKnowledgeAccess,
    canAccessBilling: lifecycleOk && state.allowBillingAccess,
    isOperational: lifecycleOk && state.allowLogin && state.allowApiAccess,
    blockedCapabilities: blocked,
    note: "INV-TEN9: Read-only — no writes performed. INV-TEN4: Suspended/offboarding/deleted tenants are not operationally active.",
  };
}
