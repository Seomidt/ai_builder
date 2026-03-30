/**
 * Phase 8 — Audit Export Service
 * INV-AUD6: Exports must remain tenant-scoped and deterministic.
 * INV-AUD7: explainAuditExport is read-only — no writes.
 * INV-AUD5: No cross-tenant data may appear in any export.
 */

import pg from "pg";
import { listAuditEventsByTenant } from "./audit-log.ts";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ─── Export filter params ─────────────────────────────────────────────────────

export interface AuditExportFilters {
  action?: string;
  actorType?: string;
  resourceType?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
}

// ─── createAuditExportRun ─────────────────────────────────────────────────────

export async function createAuditExportRun(params: {
  tenantId: string;
  requestedBy: string | null;
  exportFormat: "json" | "csv";
  filters: AuditExportFilters;
  status: "started" | "completed" | "failed";
  rowCount?: number;
  errorMessage?: string;
}): Promise<{ runId: string }> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `INSERT INTO public.audit_export_runs
         (id, tenant_id, requested_by, export_format, filter_summary, row_count, export_status, error_message, completed_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        params.tenantId,
        params.requestedBy ?? null,
        params.exportFormat,
        JSON.stringify(params.filters),
        params.rowCount ?? null,
        params.status,
        params.errorMessage ?? null,
        params.status !== "started" ? new Date() : null,
      ],
    );
    return { runId: row.rows[0].id };
  } finally {
    await client.end();
  }
}

// ─── exportAuditEventsAsJson ──────────────────────────────────────────────────
// INV-AUD6: Tenant-scoped. INV-AUD5: No cross-tenant rows.

export async function exportAuditEventsAsJson(params: {
  tenantId: string;
  requestedBy: string | null;
  filters?: AuditExportFilters;
}): Promise<{
  runId: string;
  tenantId: string;
  format: "json";
  rowCount: number;
  events: Array<Record<string, unknown>>;
  exportedAt: Date;
  note: string;
}> {
  const { tenantId, requestedBy, filters = {} } = params;

  // Start run
  const { runId: startRunId } = await createAuditExportRun({
    tenantId, requestedBy, exportFormat: "json", filters, status: "started",
  });

  let events: Array<Record<string, unknown>> = [];
  try {
    events = await listAuditEventsByTenant({
      tenantId,
      action: filters.action,
      actorType: filters.actorType,
      resourceType: filters.resourceType,
      startDate: filters.startDate,
      endDate: filters.endDate,
      limit: filters.limit ?? 1000,
    });

    // Mark run completed
    const client = getClient();
    await client.connect();
    try {
      await client.query(
        `UPDATE public.audit_export_runs SET export_status = 'completed', row_count = $1, completed_at = NOW() WHERE id = $2`,
        [events.length, startRunId],
      );
    } finally { await client.end(); }

    return {
      runId: startRunId,
      tenantId,
      format: "json",
      rowCount: events.length,
      events,
      exportedAt: new Date(),
      note: "INV-AUD6: Export is tenant-scoped. INV-AUD5: No cross-tenant rows.",
    };
  } catch (err) {
    const client = getClient();
    await client.connect();
    try {
      await client.query(
        `UPDATE public.audit_export_runs SET export_status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
        [(err as Error).message, startRunId],
      );
    } finally { await client.end(); }
    throw err;
  }
}

// ─── exportAuditEventsAsCsv ───────────────────────────────────────────────────
// INV-AUD6: Tenant-scoped. Deterministic column order.

export async function exportAuditEventsAsCsv(params: {
  tenantId: string;
  requestedBy: string | null;
  filters?: AuditExportFilters;
}): Promise<{
  runId: string;
  tenantId: string;
  format: "csv";
  rowCount: number;
  csv: string;
  exportedAt: Date;
  note: string;
}> {
  const { tenantId, requestedBy, filters = {} } = params;

  const { runId: startRunId } = await createAuditExportRun({
    tenantId, requestedBy, exportFormat: "csv", filters, status: "started",
  });

  try {
    const events = await listAuditEventsByTenant({
      tenantId,
      action: filters.action,
      actorType: filters.actorType,
      resourceType: filters.resourceType,
      startDate: filters.startDate,
      endDate: filters.endDate,
      limit: filters.limit ?? 1000,
    });

    // INV-AUD6: Deterministic column order
    const columns = [
      "id", "tenant_id", "actor_id", "actor_type", "action",
      "resource_type", "resource_id", "request_id", "correlation_id",
      "ip_address", "user_agent", "audit_source", "event_status", "summary", "created_at",
    ];

    function escapeCsv(val: unknown): string {
      if (val === null || val === undefined) return "";
      const s = String(val);
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    }

    const header = columns.join(",");
    const rows = events.map((e) => columns.map((c) => escapeCsv(e[c])).join(","));
    const csv = [header, ...rows].join("\n");

    const client = getClient();
    await client.connect();
    try {
      await client.query(
        `UPDATE public.audit_export_runs SET export_status = 'completed', row_count = $1, completed_at = NOW() WHERE id = $2`,
        [events.length, startRunId],
      );
    } finally { await client.end(); }

    return {
      runId: startRunId,
      tenantId,
      format: "csv",
      rowCount: events.length,
      csv,
      exportedAt: new Date(),
      note: "INV-AUD6: CSV export is tenant-scoped with deterministic column order.",
    };
  } catch (err) {
    const client = getClient();
    await client.connect();
    try {
      await client.query(
        `UPDATE public.audit_export_runs SET export_status = 'failed', error_message = $1, completed_at = NOW() WHERE id = $2`,
        [(err as Error).message, startRunId],
      );
    } finally { await client.end(); }
    throw err;
  }
}

// ─── explainAuditExport ───────────────────────────────────────────────────────
// INV-AUD7: Read-only — no writes.

export function explainAuditExport(params: {
  tenantId: string;
  filters?: AuditExportFilters;
}): {
  tenantId: string;
  filters: AuditExportFilters;
  availableFormats: string[];
  tenantScopeEnforced: boolean;
  maxRowsPerExport: number;
  note: string;
} {
  return {
    tenantId: params.tenantId,
    filters: params.filters ?? {},
    availableFormats: ["json", "csv"],
    tenantScopeEnforced: true,
    maxRowsPerExport: 1000,
    note: "INV-AUD7: This is a read-only preview. No export run created. INV-AUD6: Exports are always tenant-scoped.",
  };
}

// ─── summarizeAuditExportRun ──────────────────────────────────────────────────

export async function summarizeAuditExportRun(runId: string): Promise<Record<string, unknown> | null> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, tenant_id, requested_by, export_format, filter_summary, row_count, export_status, error_message, created_at, completed_at
       FROM public.audit_export_runs WHERE id = $1`,
      [runId],
    );
    return row.rows[0] ?? null;
  } finally {
    await client.end();
  }
}

// ─── listExportRunsForTenant ──────────────────────────────────────────────────
// INV-AUD5/6: Tenant-scoped.

export async function listExportRunsForTenant(params: {
  tenantId: string;
  limit?: number;
}): Promise<Array<Record<string, unknown>>> {
  const { tenantId, limit = 20 } = params;
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.audit_export_runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [tenantId, Math.min(limit, 100)],
    );
    return row.rows;
  } finally {
    await client.end();
  }
}
