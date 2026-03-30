/**
 * Phase 9 — Tenant Settings Service
 * INV-TEN5: One canonical settings row per tenant.
 * INV-TEN8: Settings updates must be audited.
 * INV-TEN9: explainTenantSettings is read-only.
 */

import pg from "pg";
import { logAuditBestEffort, logAuditResourceChange } from "../audit/audit-log.ts";
import { buildSystemAuditContext } from "../audit/audit-context.ts";
import { TENANT_AUDIT_ACTIONS } from "./audit-actions-phase9.ts";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

export interface TenantSettingsRecord {
  id: string;
  tenantId: string;
  allowLogin: boolean;
  allowApiAccess: boolean;
  allowAiRuntime: boolean;
  allowKnowledgeAccess: boolean;
  allowBillingAccess: boolean;
  tenantTimezone: string | null;
  locale: string | null;
  settingsStatus: "active" | "archived";
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

function rowToSettings(r: Record<string, unknown>): TenantSettingsRecord {
  return {
    id: r["id"] as string,
    tenantId: r["tenant_id"] as string,
    allowLogin: r["allow_login"] as boolean,
    allowApiAccess: r["allow_api_access"] as boolean,
    allowAiRuntime: r["allow_ai_runtime"] as boolean,
    allowKnowledgeAccess: r["allow_knowledge_access"] as boolean,
    allowBillingAccess: r["allow_billing_access"] as boolean,
    tenantTimezone: (r["tenant_timezone"] as string) ?? null,
    locale: (r["locale"] as string) ?? null,
    settingsStatus: r["settings_status"] as "active" | "archived",
    metadata: (r["metadata"] as Record<string, unknown>) ?? null,
    createdAt: new Date(r["created_at"] as string),
    updatedAt: new Date(r["updated_at"] as string),
  };
}

// ─── createTenantSettings ─────────────────────────────────────────────────────
// INV-TEN5: Enforces unique(tenant_id) via DB constraint.

export async function createTenantSettings(params: {
  tenantId: string;
  allowLogin?: boolean;
  allowApiAccess?: boolean;
  allowAiRuntime?: boolean;
  allowKnowledgeAccess?: boolean;
  allowBillingAccess?: boolean;
  tenantTimezone?: string;
  locale?: string;
  metadata?: Record<string, unknown>;
  changedBy?: string;
}): Promise<TenantSettingsRecord> {
  const {
    tenantId, allowLogin = true, allowApiAccess = true,
    allowAiRuntime = true, allowKnowledgeAccess = true, allowBillingAccess = true,
    tenantTimezone, locale, metadata, changedBy,
  } = params;

  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `INSERT INTO public.tenant_settings
         (id, tenant_id, allow_login, allow_api_access, allow_ai_runtime, allow_knowledge_access, allow_billing_access, tenant_timezone, locale, settings_status, metadata)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, $6, $7, $8, 'active', $9)
       RETURNING *`,
      [tenantId, allowLogin, allowApiAccess, allowAiRuntime, allowKnowledgeAccess, allowBillingAccess,
        tenantTimezone ?? null, locale ?? null, metadata ? JSON.stringify(metadata) : null],
    );
    const settings = rowToSettings(row.rows[0]);

    await logAuditBestEffort({
      tenantId,
      action: TENANT_AUDIT_ACTIONS.TENANT_SETTINGS_CREATED,
      resourceType: "tenant_settings",
      resourceId: settings.id,
      actorId: changedBy ?? "system",
      actorType: changedBy ? "user" : "system",
      summary: `Tenant settings created for tenant ${tenantId}`,
    });

    return settings;
  } finally {
    await client.end();
  }
}

// ─── getTenantSettings ────────────────────────────────────────────────────────

export async function getTenantSettings(tenantId: string): Promise<TenantSettingsRecord | null> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.tenant_settings WHERE tenant_id = $1 AND settings_status = 'active' LIMIT 1`,
      [tenantId],
    );
    if (row.rows.length === 0) return null;
    return rowToSettings(row.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── updateTenantSettings ─────────────────────────────────────────────────────
// INV-TEN5: Updates the one canonical settings row.
// INV-TEN8: Audited.

export async function updateTenantSettings(params: {
  tenantId: string;
  allowLogin?: boolean;
  allowApiAccess?: boolean;
  allowAiRuntime?: boolean;
  allowKnowledgeAccess?: boolean;
  allowBillingAccess?: boolean;
  tenantTimezone?: string | null;
  locale?: string | null;
  metadata?: Record<string, unknown>;
  changedBy?: string;
}): Promise<TenantSettingsRecord> {
  const { tenantId, changedBy } = params;

  const client = getClient();
  await client.connect();
  try {
    const current = await client.query(
      `SELECT * FROM public.tenant_settings WHERE tenant_id = $1 AND settings_status = 'active' LIMIT 1`,
      [tenantId],
    );
    if (current.rows.length === 0) throw new Error(`No active settings found for tenant '${tenantId}'`);

    const prev = rowToSettings(current.rows[0]);
    const updates: Record<string, unknown> = {};
    if (params.allowLogin !== undefined) updates["allow_login"] = params.allowLogin;
    if (params.allowApiAccess !== undefined) updates["allow_api_access"] = params.allowApiAccess;
    if (params.allowAiRuntime !== undefined) updates["allow_ai_runtime"] = params.allowAiRuntime;
    if (params.allowKnowledgeAccess !== undefined) updates["allow_knowledge_access"] = params.allowKnowledgeAccess;
    if (params.allowBillingAccess !== undefined) updates["allow_billing_access"] = params.allowBillingAccess;
    if (params.tenantTimezone !== undefined) updates["tenant_timezone"] = params.tenantTimezone;
    if (params.locale !== undefined) updates["locale"] = params.locale;
    if (params.metadata !== undefined) updates["metadata"] = JSON.stringify(params.metadata);

    const setClauses = Object.keys(updates).map((k, i) => `${k} = $${i + 2}`).join(", ");
    const values = [tenantId, ...Object.values(updates)];

    const row = await client.query(
      `UPDATE public.tenant_settings SET ${setClauses}, updated_at = NOW() WHERE tenant_id = $1 RETURNING *`,
      values,
    );
    const settings = rowToSettings(row.rows[0]);

    const ctx = buildSystemAuditContext({ tenantId, source: "admin_route" });
    await logAuditResourceChange({
      ctx: { ...ctx, actorId: changedBy ?? "system", actorType: changedBy ? "user" : "system" },
      action: TENANT_AUDIT_ACTIONS.TENANT_SETTINGS_UPDATED,
      resourceType: "tenant_settings",
      resourceId: settings.id,
      beforeState: { allowLogin: prev.allowLogin, allowApiAccess: prev.allowApiAccess, allowAiRuntime: prev.allowAiRuntime },
      afterState: { allowLogin: settings.allowLogin, allowApiAccess: settings.allowApiAccess, allowAiRuntime: settings.allowAiRuntime },
      changeFields: Object.keys(updates),
      summary: `Tenant settings updated for tenant ${tenantId}`,
    });

    return settings;
  } finally {
    await client.end();
  }
}

// ─── explainTenantSettings ────────────────────────────────────────────────────
// INV-TEN9: Read-only.

export function explainTenantSettings(settings: TenantSettingsRecord | null): {
  found: boolean;
  tenantId: string | null;
  canLogin: boolean;
  canUseApi: boolean;
  canUseAiRuntime: boolean;
  canAccessKnowledge: boolean;
  canAccessBilling: boolean;
  isFullyEnabled: boolean;
  disabledCapabilities: string[];
  note: string;
} {
  if (!settings) {
    return {
      found: false, tenantId: null, canLogin: false, canUseApi: false,
      canUseAiRuntime: false, canAccessKnowledge: false, canAccessBilling: false,
      isFullyEnabled: false, disabledCapabilities: ["all"],
      note: "INV-TEN9: Read-only — no writes performed. Settings not found.",
    };
  }

  const disabled: string[] = [];
  if (!settings.allowLogin) disabled.push("login");
  if (!settings.allowApiAccess) disabled.push("api_access");
  if (!settings.allowAiRuntime) disabled.push("ai_runtime");
  if (!settings.allowKnowledgeAccess) disabled.push("knowledge_access");
  if (!settings.allowBillingAccess) disabled.push("billing_access");

  return {
    found: true,
    tenantId: settings.tenantId,
    canLogin: settings.allowLogin,
    canUseApi: settings.allowApiAccess,
    canUseAiRuntime: settings.allowAiRuntime,
    canAccessKnowledge: settings.allowKnowledgeAccess,
    canAccessBilling: settings.allowBillingAccess,
    isFullyEnabled: disabled.length === 0,
    disabledCapabilities: disabled,
    note: "INV-TEN9: Read-only — no writes performed.",
  };
}

// ─── createOrGetTenantSettings ────────────────────────────────────────────────
// Idempotent: returns existing if present, creates default if not.
// INV-TEN7/INV-TEN5.

export async function createOrGetTenantSettings(tenantId: string, changedBy?: string): Promise<TenantSettingsRecord> {
  const existing = await getTenantSettings(tenantId);
  if (existing) return existing;
  return createTenantSettings({ tenantId, changedBy });
}
