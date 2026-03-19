/**
 * Phase 9 — Tenant Export & Deletion Governance
 * INV-TEN6: Export/deletion requests must be staged and explainable.
 * INV-TEN8: All state changes must be audited.
 * INV-TEN9: explainTenantGovernanceState is read-only.
 */

import pg from "pg";
import { logAuditBestEffort } from "../audit/audit-log";
import { TENANT_AUDIT_ACTIONS } from "./audit-actions-phase9";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ─── Export Request Functions ──────────────────────────────────────────────────

export async function requestTenantExport(params: {
  tenantId: string;
  requestedBy: string | null;
  exportScope?: "full" | "metadata_only" | "audit_only";
  filterSummary?: Record<string, unknown>;
}): Promise<{ requestId: string; exportStatus: string }> {
  const { tenantId, requestedBy, exportScope = "full", filterSummary } = params;

  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `INSERT INTO public.tenant_export_requests (id, tenant_id, requested_by, export_status, export_scope, filter_summary)
       VALUES (gen_random_uuid()::text, $1, $2, 'requested', $3, $4) RETURNING id, export_status`,
      [tenantId, requestedBy, exportScope, filterSummary ? JSON.stringify(filterSummary) : null],
    );

    const requestId = row.rows[0].id;
    await logAuditBestEffort({
      tenantId,
      action: TENANT_AUDIT_ACTIONS.TENANT_EXPORT_REQUESTED,
      resourceType: "tenant_export_request",
      resourceId: requestId,
      actorId: requestedBy ?? "system",
      actorType: requestedBy ? "user" : "system",
      summary: `Tenant export requested with scope '${exportScope}'`,
      metadata: { exportScope, filterSummary },
    });

    return { requestId, exportStatus: "requested" };
  } finally {
    await client.end();
  }
}

export async function startTenantExport(requestId: string, changedBy?: string): Promise<Record<string, unknown>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `UPDATE public.tenant_export_requests SET export_status = 'running', started_at = NOW()
       WHERE id = $1 AND export_status = 'requested' RETURNING *`,
      [requestId],
    );
    if (row.rows.length === 0) throw new Error(`Export request '${requestId}' not in 'requested' state`);
    await logAuditBestEffort({
      tenantId: row.rows[0].tenant_id,
      action: TENANT_AUDIT_ACTIONS.TENANT_EXPORT_STARTED,
      resourceType: "tenant_export_request",
      resourceId: requestId,
      actorId: changedBy ?? "system",
      actorType: "system",
      summary: `Tenant export started`,
    });
    return row.rows[0];
  } finally {
    await client.end();
  }
}

export async function completeTenantExport(requestId: string, resultSummary?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `UPDATE public.tenant_export_requests SET export_status = 'completed', completed_at = NOW(), result_summary = $2
       WHERE id = $1 AND export_status = 'running' RETURNING *`,
      [requestId, resultSummary ? JSON.stringify(resultSummary) : null],
    );
    if (row.rows.length === 0) throw new Error(`Export request '${requestId}' not in 'running' state`);
    await logAuditBestEffort({
      tenantId: row.rows[0].tenant_id,
      action: TENANT_AUDIT_ACTIONS.TENANT_EXPORT_COMPLETED,
      resourceType: "tenant_export_request",
      resourceId: requestId,
      actorId: "system",
      actorType: "system",
      summary: `Tenant export completed`,
    });
    return row.rows[0];
  } finally {
    await client.end();
  }
}

export async function failTenantExport(requestId: string, errorMessage: string): Promise<Record<string, unknown>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `UPDATE public.tenant_export_requests SET export_status = 'failed', completed_at = NOW(), error_message = $2
       WHERE id = $1 AND export_status = 'running' RETURNING *`,
      [requestId, errorMessage],
    );
    if (row.rows.length === 0) throw new Error(`Export request '${requestId}' not in 'running' state`);
    await logAuditBestEffort({
      tenantId: row.rows[0].tenant_id,
      action: TENANT_AUDIT_ACTIONS.TENANT_EXPORT_FAILED,
      resourceType: "tenant_export_request",
      resourceId: requestId,
      actorId: "system",
      actorType: "system",
      summary: `Tenant export failed: ${errorMessage}`,
      metadata: { errorMessage },
    });
    return row.rows[0];
  } finally {
    await client.end();
  }
}

export async function listTenantExportRequests(tenantId: string): Promise<Array<Record<string, unknown>>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.tenant_export_requests WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return row.rows;
  } finally {
    await client.end();
  }
}

// ─── Deletion Request Functions ────────────────────────────────────────────────

export async function requestTenantDeletion(params: {
  tenantId: string;
  requestedBy: string | null;
  retentionUntil?: Date;
}): Promise<{ requestId: string; deletionStatus: string }> {
  const { tenantId, requestedBy, retentionUntil } = params;

  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `INSERT INTO public.tenant_deletion_requests (id, tenant_id, requested_by, deletion_status, retention_until)
       VALUES (gen_random_uuid()::text, $1, $2, 'requested', $3) RETURNING id, deletion_status`,
      [tenantId, requestedBy, retentionUntil ?? null],
    );

    const requestId = row.rows[0].id;
    await logAuditBestEffort({
      tenantId,
      action: TENANT_AUDIT_ACTIONS.TENANT_DELETION_REQUESTED,
      resourceType: "tenant_deletion_request",
      resourceId: requestId,
      actorId: requestedBy ?? "system",
      actorType: requestedBy ? "user" : "system",
      summary: `Tenant deletion requested${retentionUntil ? ` (retain until ${retentionUntil.toISOString()})` : ""}`,
      metadata: { retentionUntil: retentionUntil?.toISOString() },
    });

    return { requestId, deletionStatus: "requested" };
  } finally {
    await client.end();
  }
}

export async function approveTenantDeletion(requestId: string, approvedBy: string): Promise<Record<string, unknown>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `UPDATE public.tenant_deletion_requests SET deletion_status = 'approved', approved_at = NOW()
       WHERE id = $1 AND deletion_status = 'requested' RETURNING *`,
      [requestId],
    );
    if (row.rows.length === 0) throw new Error(`Deletion request '${requestId}' not in 'requested' state`);
    await logAuditBestEffort({
      tenantId: row.rows[0].tenant_id,
      action: TENANT_AUDIT_ACTIONS.TENANT_DELETION_APPROVED,
      resourceType: "tenant_deletion_request",
      resourceId: requestId,
      actorId: approvedBy,
      actorType: "user",
      summary: `Tenant deletion approved by ${approvedBy}`,
    });
    return row.rows[0];
  } finally {
    await client.end();
  }
}

export async function blockTenantDeletion(requestId: string, blockReason: string, blockedBy: string): Promise<Record<string, unknown>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `UPDATE public.tenant_deletion_requests SET deletion_status = 'blocked', block_reason = $2
       WHERE id = $1 AND deletion_status IN ('requested', 'approved') RETURNING *`,
      [requestId, blockReason],
    );
    if (row.rows.length === 0) throw new Error(`Deletion request '${requestId}' cannot be blocked in its current state`);
    await logAuditBestEffort({
      tenantId: row.rows[0].tenant_id,
      action: TENANT_AUDIT_ACTIONS.TENANT_DELETION_BLOCKED,
      resourceType: "tenant_deletion_request",
      resourceId: requestId,
      actorId: blockedBy,
      actorType: "user",
      summary: `Tenant deletion blocked: ${blockReason}`,
      metadata: { blockReason },
    });
    return row.rows[0];
  } finally {
    await client.end();
  }
}

export async function startTenantDeletion(requestId: string): Promise<Record<string, unknown>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `UPDATE public.tenant_deletion_requests SET deletion_status = 'running', started_at = NOW()
       WHERE id = $1 AND deletion_status = 'approved' RETURNING *`,
      [requestId],
    );
    if (row.rows.length === 0) throw new Error(`Deletion request '${requestId}' not in 'approved' state`);
    await logAuditBestEffort({
      tenantId: row.rows[0].tenant_id,
      action: TENANT_AUDIT_ACTIONS.TENANT_DELETION_STARTED,
      resourceType: "tenant_deletion_request",
      resourceId: requestId,
      actorId: "system",
      actorType: "system",
      summary: `Tenant deletion process started`,
    });
    return row.rows[0];
  } finally {
    await client.end();
  }
}

export async function completeTenantDeletion(requestId: string, resultSummary?: Record<string, unknown>): Promise<Record<string, unknown>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `UPDATE public.tenant_deletion_requests SET deletion_status = 'completed', completed_at = NOW(), result_summary = $2
       WHERE id = $1 AND deletion_status = 'running' RETURNING *`,
      [requestId, resultSummary ? JSON.stringify(resultSummary) : null],
    );
    if (row.rows.length === 0) throw new Error(`Deletion request '${requestId}' not in 'running' state`);
    await logAuditBestEffort({
      tenantId: row.rows[0].tenant_id,
      action: TENANT_AUDIT_ACTIONS.TENANT_DELETION_COMPLETED,
      resourceType: "tenant_deletion_request",
      resourceId: requestId,
      actorId: "system",
      actorType: "system",
      summary: `Tenant deletion completed`,
    });
    return row.rows[0];
  } finally {
    await client.end();
  }
}

export async function failTenantDeletion(requestId: string, errorMessage: string): Promise<Record<string, unknown>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `UPDATE public.tenant_deletion_requests SET deletion_status = 'failed', completed_at = NOW(), error_message = $2
       WHERE id = $1 AND deletion_status = 'running' RETURNING *`,
      [requestId, errorMessage],
    );
    if (row.rows.length === 0) throw new Error(`Deletion request '${requestId}' not in 'running' state`);
    await logAuditBestEffort({
      tenantId: row.rows[0].tenant_id,
      action: TENANT_AUDIT_ACTIONS.TENANT_DELETION_FAILED,
      resourceType: "tenant_deletion_request",
      resourceId: requestId,
      actorId: "system",
      actorType: "system",
      summary: `Tenant deletion failed: ${errorMessage}`,
      metadata: { errorMessage },
    });
    return row.rows[0];
  } finally {
    await client.end();
  }
}

export async function listTenantDeletionRequests(tenantId: string): Promise<Array<Record<string, unknown>>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.tenant_deletion_requests WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return row.rows;
  } finally {
    await client.end();
  }
}

// ─── explainTenantGovernanceState ─────────────────────────────────────────────
// INV-TEN9: Read-only — no writes.

export async function explainTenantGovernanceState(tenantId: string): Promise<{
  tenantId: string;
  hasActiveExport: boolean;
  hasActiveDeletion: boolean;
  exportRequests: Array<Record<string, unknown>>;
  deletionRequests: Array<Record<string, unknown>>;
  governanceNote: string;
  note: string;
}> {
  const client = getClient();
  await client.connect();
  try {
    const [expRow, delRow] = await Promise.all([
      client.query(`SELECT * FROM public.tenant_export_requests WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`, [tenantId]),
      client.query(`SELECT * FROM public.tenant_deletion_requests WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`, [tenantId]),
    ]);

    const activeExport = expRow.rows.find((r) => ["requested", "running"].includes(r.export_status));
    const activeDeletion = delRow.rows.find((r) => ["requested", "approved", "running"].includes(r.deletion_status));

    return {
      tenantId,
      hasActiveExport: !!activeExport,
      hasActiveDeletion: !!activeDeletion,
      exportRequests: expRow.rows,
      deletionRequests: delRow.rows,
      governanceNote: "INV-TEN6: Export and deletion are staged and explainable. Physical deletion is not guaranteed without explicit completion.",
      note: "INV-TEN9: Read-only — no writes performed.",
    };
  } finally {
    await client.end();
  }
}

// ─── Tenant Domain Functions ───────────────────────────────────────────────────

export async function addTenantDomain(params: {
  tenantId: string;
  domain: string;
  addedBy?: string;
}): Promise<Record<string, unknown>> {
  const { tenantId, domain, addedBy } = params;
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `INSERT INTO public.tenant_domains (id, tenant_id, domain, domain_status)
       VALUES (gen_random_uuid()::text, $1, $2, 'pending') RETURNING *`,
      [tenantId, domain],
    );
    await logAuditBestEffort({
      tenantId,
      action: TENANT_AUDIT_ACTIONS.TENANT_DOMAIN_ADDED,
      resourceType: "tenant_domain",
      resourceId: row.rows[0].id,
      actorId: addedBy ?? "system",
      actorType: addedBy ? "user" : "system",
      summary: `Domain '${domain}' added (pending verification)`,
    });
    return row.rows[0];
  } finally {
    await client.end();
  }
}

export async function listTenantDomains(tenantId: string): Promise<Array<Record<string, unknown>>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.tenant_domains WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return row.rows;
  } finally {
    await client.end();
  }
}

export async function updateDomainStatus(domainId: string, newStatus: "verified" | "disabled", changedBy?: string): Promise<Record<string, unknown>> {
  const client = getClient();
  await client.connect();
  try {
    const verifiedAt = newStatus === "verified" ? "NOW()" : "verified_at";
    const row = await client.query(
      `UPDATE public.tenant_domains SET domain_status = $1, verified_at = ${verifiedAt} WHERE id = $2 RETURNING *`,
      [newStatus, domainId],
    );
    if (row.rows.length === 0) throw new Error(`Domain '${domainId}' not found`);
    await logAuditBestEffort({
      tenantId: row.rows[0].tenant_id,
      action: TENANT_AUDIT_ACTIONS.TENANT_DOMAIN_STATUS_UPDATED,
      resourceType: "tenant_domain",
      resourceId: domainId,
      actorId: changedBy ?? "system",
      actorType: changedBy ? "user" : "system",
      summary: `Domain status updated to '${newStatus}'`,
    });
    return row.rows[0];
  } finally {
    await client.end();
  }
}
