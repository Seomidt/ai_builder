/**
 * Phase 9 — Tenant Lifecycle Service
 * INV-TEN1: Every canonical tenant must have explicit lifecycle_status.
 * INV-TEN2: Lifecycle transitions must be explicit and validated.
 * INV-TEN3: Invalid status transitions must be rejected deterministically.
 * INV-TEN8: Tenant lifecycle changes must be audited.
 */

import pg from "pg";
import { logAuditBestEffort, logAuditResourceChange } from "../audit/audit-log";
import { buildSystemAuditContext } from "../audit/audit-context";
import { TENANT_AUDIT_ACTIONS } from "./audit-actions-phase9";

// ─── Types ────────────────────────────────────────────────────────────────────

export type TenantLifecycleStatus =
  | "trial"
  | "active"
  | "suspended"
  | "delinquent"
  | "offboarding"
  | "deleted";

export type TenantType = "customer" | "internal" | "demo" | "test";

export interface TenantRecord {
  id: string;
  tenantCode: string | null;
  name: string;
  lifecycleStatus: TenantLifecycleStatus;
  tenantType: TenantType;
  primaryOwnerUserId: string | null;
  billingEmail: string | null;
  defaultRegion: string | null;
  suspendedAt: Date | null;
  offboardingStartedAt: Date | null;
  deletedAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Canonical transition table (INV-TEN2, INV-TEN3) ─────────────────────────
// Only listed transitions are allowed. All others are rejected.

const ALLOWED_TRANSITIONS: Record<TenantLifecycleStatus, TenantLifecycleStatus[]> = {
  trial: ["active"],
  active: ["suspended", "delinquent", "offboarding"],
  suspended: ["active"],
  delinquent: ["active", "suspended"],
  offboarding: ["deleted"],
  deleted: [],
};

export function isTransitionAllowed(from: TenantLifecycleStatus, to: TenantLifecycleStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false;
}

export function validateTransition(from: TenantLifecycleStatus, to: TenantLifecycleStatus): void {
  if (!isTransitionAllowed(from, to)) {
    throw new Error(
      `INV-TEN3: Lifecycle transition '${from}' → '${to}' is not allowed. Allowed from '${from}': [${(ALLOWED_TRANSITIONS[from] ?? []).join(", ") || "none"}]`,
    );
  }
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

function rowToTenant(r: Record<string, unknown>): TenantRecord {
  return {
    id: r["id"] as string,
    tenantCode: (r["tenant_code"] as string) ?? null,
    name: r["name"] as string,
    lifecycleStatus: r["lifecycle_status"] as TenantLifecycleStatus,
    tenantType: r["tenant_type"] as TenantType,
    primaryOwnerUserId: (r["primary_owner_user_id"] as string) ?? null,
    billingEmail: (r["billing_email"] as string) ?? null,
    defaultRegion: (r["default_region"] as string) ?? null,
    suspendedAt: r["suspended_at"] ? new Date(r["suspended_at"] as string) : null,
    offboardingStartedAt: r["offboarding_started_at"] ? new Date(r["offboarding_started_at"] as string) : null,
    deletedAt: r["deleted_at"] ? new Date(r["deleted_at"] as string) : null,
    metadata: (r["metadata"] as Record<string, unknown>) ?? null,
    createdAt: new Date(r["created_at"] as string),
    updatedAt: new Date(r["updated_at"] as string),
  };
}

// ─── createTenant ─────────────────────────────────────────────────────────────
// INV-TEN1: Always has explicit lifecycle_status.

export async function createTenant(params: {
  id?: string;
  name: string;
  tenantCode?: string;
  lifecycleStatus?: TenantLifecycleStatus;
  tenantType?: TenantType;
  primaryOwnerUserId?: string;
  billingEmail?: string;
  defaultRegion?: string;
  metadata?: Record<string, unknown>;
  changedBy?: string;
}): Promise<TenantRecord> {
  const {
    name, tenantCode, billingEmail, defaultRegion, primaryOwnerUserId,
    lifecycleStatus = "active", tenantType = "customer", metadata, changedBy,
  } = params;

  const client = getClient();
  await client.connect();
  try {
    const idClause = params.id ? `$1` : `gen_random_uuid()::text`;
    const values: unknown[] = params.id
      ? [params.id, name, lifecycleStatus, tenantType, tenantCode ?? null, primaryOwnerUserId ?? null, billingEmail ?? null, defaultRegion ?? null, metadata ? JSON.stringify(metadata) : null]
      : [name, lifecycleStatus, tenantType, tenantCode ?? null, primaryOwnerUserId ?? null, billingEmail ?? null, defaultRegion ?? null, metadata ? JSON.stringify(metadata) : null];

    const paramOffset = params.id ? 1 : 0;

    const row = await client.query(
      `INSERT INTO public.tenants (id, name, lifecycle_status, tenant_type, tenant_code, primary_owner_user_id, billing_email, default_region, metadata)
       VALUES (${idClause}, $${1 + paramOffset}, $${2 + paramOffset}, $${3 + paramOffset}, $${4 + paramOffset}, $${5 + paramOffset}, $${6 + paramOffset}, $${7 + paramOffset}, $${8 + paramOffset})
       RETURNING *`,
      values,
    );

    const tenant = rowToTenant(row.rows[0]);

    // Append-only status history
    await client.query(
      `INSERT INTO public.tenant_status_history (id, tenant_id, previous_status, new_status, changed_by, change_reason)
       VALUES (gen_random_uuid()::text, $1, NULL, $2, $3, 'Initial creation')`,
      [tenant.id, lifecycleStatus, changedBy ?? "system"],
    );

    // INV-TEN8: Audit
    await logAuditBestEffort({
      tenantId: tenant.id,
      action: TENANT_AUDIT_ACTIONS.TENANT_CREATED,
      resourceType: "tenant",
      resourceId: tenant.id,
      actorId: changedBy ?? "system",
      actorType: changedBy ? "user" : "system",
      summary: `Tenant '${name}' created with status '${lifecycleStatus}'`,
      metadata: { name, lifecycleStatus, tenantType },
    });

    return tenant;
  } finally {
    await client.end();
  }
}

// ─── getTenantById ────────────────────────────────────────────────────────────

export async function getTenantById(tenantId: string): Promise<TenantRecord | null> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(`SELECT * FROM public.tenants WHERE id = $1`, [tenantId]);
    if (row.rows.length === 0) return null;
    return rowToTenant(row.rows[0]);
  } finally {
    await client.end();
  }
}

// ─── listTenants ──────────────────────────────────────────────────────────────

export async function listTenants(params: {
  lifecycleStatus?: TenantLifecycleStatus;
  tenantType?: TenantType;
  limit?: number;
  offset?: number;
}): Promise<TenantRecord[]> {
  const { lifecycleStatus, tenantType, limit = 50, offset = 0 } = params;
  const client = getClient();
  await client.connect();
  try {
    const conds: string[] = [];
    const vals: unknown[] = [];
    if (lifecycleStatus) { conds.push(`lifecycle_status = $${vals.length + 1}`); vals.push(lifecycleStatus); }
    if (tenantType) { conds.push(`tenant_type = $${vals.length + 1}`); vals.push(tenantType); }
    vals.push(Math.min(limit, 200));
    vals.push(offset);
    const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
    const row = await client.query(
      `SELECT * FROM public.tenants ${where} ORDER BY created_at DESC LIMIT $${vals.length - 1} OFFSET $${vals.length}`,
      vals,
    );
    return row.rows.map(rowToTenant);
  } finally {
    await client.end();
  }
}

// ─── updateTenantStatus — internal transition engine ──────────────────────────
// INV-TEN2/3: All transitions go through here.

export async function updateTenantStatus(params: {
  tenantId: string;
  newStatus: TenantLifecycleStatus;
  changedBy?: string;
  reason?: string;
}): Promise<{ tenant: TenantRecord; previousStatus: TenantLifecycleStatus }> {
  const { tenantId, newStatus, changedBy = "system", reason } = params;

  const client = getClient();
  await client.connect();
  try {
    const current = await client.query(`SELECT lifecycle_status FROM public.tenants WHERE id = $1`, [tenantId]);
    if (current.rows.length === 0) throw new Error(`Tenant '${tenantId}' not found`);

    const previousStatus = current.rows[0].lifecycle_status as TenantLifecycleStatus;
    validateTransition(previousStatus, newStatus); // INV-TEN3: throws on invalid

    const extra: Record<string, string> = {};
    if (newStatus === "suspended") extra["suspended_at"] = "NOW()";
    if (newStatus === "offboarding") extra["offboarding_started_at"] = "NOW()";
    if (newStatus === "deleted") extra["deleted_at"] = "NOW()";
    if (newStatus === "active" && previousStatus === "suspended") extra["suspended_at"] = "NULL";

    const extraSql = Object.entries(extra).map(([k, v]) => `${k} = ${v}`).join(", ");
    const setClauses = [`lifecycle_status = $1`, `updated_at = NOW()`, ...(extraSql ? [extraSql] : [])].join(", ");

    const row = await client.query(
      `UPDATE public.tenants SET ${setClauses} WHERE id = $2 RETURNING *`,
      [newStatus, tenantId],
    );
    const tenant = rowToTenant(row.rows[0]);

    // Append-only history record
    await client.query(
      `INSERT INTO public.tenant_status_history (id, tenant_id, previous_status, new_status, changed_by, change_reason)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5)`,
      [tenantId, previousStatus, newStatus, changedBy, reason ?? null],
    );

    // INV-TEN8: Audit
    const ctx = buildSystemAuditContext({ tenantId, source: "system_process" });
    await logAuditResourceChange({
      ctx: { ...ctx, actorId: changedBy, actorType: changedBy === "system" ? "system" : "user" },
      action: TENANT_AUDIT_ACTIONS.TENANT_STATUS_CHANGED,
      resourceType: "tenant",
      resourceId: tenantId,
      beforeState: { lifecycleStatus: previousStatus },
      afterState: { lifecycleStatus: newStatus },
      changeFields: ["lifecycle_status"],
      summary: `Tenant status changed '${previousStatus}' → '${newStatus}'${reason ? `: ${reason}` : ""}`,
    });

    return { tenant, previousStatus };
  } finally {
    await client.end();
  }
}

// ─── suspendTenant ─────────────────────────────────────────────────────────────

export async function suspendTenant(params: {
  tenantId: string;
  changedBy?: string;
  reason?: string;
}): Promise<TenantRecord> {
  const { tenant } = await updateTenantStatus({ ...params, newStatus: "suspended" });
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: TENANT_AUDIT_ACTIONS.TENANT_SUSPENDED,
    resourceType: "tenant",
    resourceId: params.tenantId,
    actorId: params.changedBy ?? "system",
    actorType: params.changedBy ? "user" : "system",
    summary: `Tenant suspended${params.reason ? `: ${params.reason}` : ""}`,
    metadata: { reason: params.reason },
  });
  return tenant;
}

// ─── reactivateTenant ─────────────────────────────────────────────────────────

export async function reactivateTenant(params: {
  tenantId: string;
  changedBy?: string;
  reason?: string;
}): Promise<TenantRecord> {
  const { tenant } = await updateTenantStatus({ ...params, newStatus: "active" });
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: TENANT_AUDIT_ACTIONS.TENANT_REACTIVATED,
    resourceType: "tenant",
    resourceId: params.tenantId,
    actorId: params.changedBy ?? "system",
    actorType: params.changedBy ? "user" : "system",
    summary: `Tenant reactivated${params.reason ? `: ${params.reason}` : ""}`,
    metadata: { reason: params.reason },
  });
  return tenant;
}

// ─── startTenantOffboarding ───────────────────────────────────────────────────

export async function startTenantOffboarding(params: {
  tenantId: string;
  changedBy?: string;
  reason?: string;
}): Promise<TenantRecord> {
  const { tenant } = await updateTenantStatus({ ...params, newStatus: "offboarding" });
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: TENANT_AUDIT_ACTIONS.TENANT_OFFBOARDING_STARTED,
    resourceType: "tenant",
    resourceId: params.tenantId,
    actorId: params.changedBy ?? "system",
    actorType: params.changedBy ? "user" : "system",
    summary: `Tenant offboarding started${params.reason ? `: ${params.reason}` : ""}`,
    metadata: { reason: params.reason },
  });
  return tenant;
}

// ─── markTenantDeleted ────────────────────────────────────────────────────────

export async function markTenantDeleted(params: {
  tenantId: string;
  changedBy?: string;
  reason?: string;
}): Promise<TenantRecord> {
  const { tenant } = await updateTenantStatus({ ...params, newStatus: "deleted" });
  await logAuditBestEffort({
    tenantId: params.tenantId,
    action: TENANT_AUDIT_ACTIONS.TENANT_DELETED,
    resourceType: "tenant",
    resourceId: params.tenantId,
    actorId: params.changedBy ?? "system",
    actorType: params.changedBy ? "user" : "system",
    summary: `Tenant marked as deleted${params.reason ? `: ${params.reason}` : ""}`,
    metadata: { reason: params.reason },
  });
  return tenant;
}

// ─── explainTenantLifecycle ───────────────────────────────────────────────────
// INV-TEN9: Read-only — no writes.

export async function explainTenantLifecycle(tenantId: string): Promise<{
  found: boolean;
  tenant?: TenantRecord;
  allowedTransitions?: TenantLifecycleStatus[];
  statusHistory?: Array<Record<string, unknown>>;
  isOperational?: boolean;
  isSuspended?: boolean;
  isDeleted?: boolean;
  note: string;
}> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return { found: false, note: "INV-TEN9: Read-only — no writes performed. Tenant not found." };
  }

  const client = getClient();
  await client.connect();
  try {
    const histRow = await client.query(
      `SELECT * FROM public.tenant_status_history WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`,
      [tenantId],
    );

    return {
      found: true,
      tenant,
      allowedTransitions: ALLOWED_TRANSITIONS[tenant.lifecycleStatus] ?? [],
      statusHistory: histRow.rows,
      isOperational: tenant.lifecycleStatus === "active" || tenant.lifecycleStatus === "trial",
      isSuspended: tenant.lifecycleStatus === "suspended",
      isDeleted: tenant.lifecycleStatus === "deleted",
      note: "INV-TEN9: Read-only — no writes performed.",
    };
  } finally {
    await client.end();
  }
}

// ─── summarizeTenantState ─────────────────────────────────────────────────────
// INV-TEN9: Read-only.

export async function summarizeTenantState(tenantId: string): Promise<{
  tenantId: string;
  name: string | null;
  lifecycleStatus: TenantLifecycleStatus | null;
  tenantType: TenantType | null;
  hasSettings: boolean;
  hasDomains: boolean;
  hasActiveExportRequest: boolean;
  hasActiveDeletionRequest: boolean;
  note: string;
}> {
  const tenant = await getTenantById(tenantId);
  if (!tenant) {
    return {
      tenantId,
      name: null,
      lifecycleStatus: null,
      tenantType: null,
      hasSettings: false,
      hasDomains: false,
      hasActiveExportRequest: false,
      hasActiveDeletionRequest: false,
      note: "INV-TEN9: Read-only. Tenant not found.",
    };
  }

  const client = getClient();
  await client.connect();
  try {
    const [setR, domR, expR, delR] = await Promise.all([
      client.query(`SELECT 1 FROM public.tenant_settings WHERE tenant_id = $1 LIMIT 1`, [tenantId]),
      client.query(`SELECT 1 FROM public.tenant_domains WHERE tenant_id = $1 LIMIT 1`, [tenantId]),
      client.query(`SELECT 1 FROM public.tenant_export_requests WHERE tenant_id = $1 AND export_status IN ('requested','running') LIMIT 1`, [tenantId]),
      client.query(`SELECT 1 FROM public.tenant_deletion_requests WHERE tenant_id = $1 AND deletion_status IN ('requested','approved','running') LIMIT 1`, [tenantId]),
    ]);

    return {
      tenantId,
      name: tenant.name,
      lifecycleStatus: tenant.lifecycleStatus,
      tenantType: tenant.tenantType,
      hasSettings: setR.rows.length > 0,
      hasDomains: domR.rows.length > 0,
      hasActiveExportRequest: expR.rows.length > 0,
      hasActiveDeletionRequest: delR.rows.length > 0,
      note: "INV-TEN9: Read-only — no writes performed.",
    };
  } finally {
    await client.end();
  }
}

// ─── getTenantStatusHistory ───────────────────────────────────────────────────

export async function getTenantStatusHistory(tenantId: string): Promise<Array<Record<string, unknown>>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.tenant_status_history WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return row.rows;
  } finally {
    await client.end();
  }
}
