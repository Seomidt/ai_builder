/**
 * Phase 8 — Audit Observability / Metrics
 * INV-AUD12: Audit failure visibility must be operationally observable.
 * INV-AUD5: Tenant metrics must be tenant-isolated.
 */

import pg from "pg";
import { getAuditWriteFailures } from "./audit-log";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ─── getAuditMetricsByTenant ──────────────────────────────────────────────────
// INV-AUD5: Metrics are tenant-isolated.

export async function getAuditMetricsByTenant(tenantId: string): Promise<{
  tenantId: string;
  auditEventsTotal: number;
  auditEventsByAction: Array<{ action: string; count: number }>;
  auditEventsByActorType: Array<{ actorType: string; count: number }>;
  auditEventsBySource: Array<{ source: string; count: number }>;
  auditExportRunsTotal: number;
  auditExportFailuresTotal: number;
  note: string;
}> {
  const client = getClient();
  await client.connect();
  try {
    const totalRow = await client.query(
      `SELECT COUNT(*) as cnt FROM public.audit_events WHERE tenant_id = $1`,
      [tenantId],
    );

    const actionRow = await client.query(
      `SELECT action, COUNT(*) as cnt FROM public.audit_events WHERE tenant_id = $1
       GROUP BY action ORDER BY cnt DESC LIMIT 20`,
      [tenantId],
    );

    const actorRow = await client.query(
      `SELECT actor_type, COUNT(*) as cnt FROM public.audit_events WHERE tenant_id = $1
       GROUP BY actor_type ORDER BY cnt DESC`,
      [tenantId],
    );

    const sourceRow = await client.query(
      `SELECT audit_source, COUNT(*) as cnt FROM public.audit_events WHERE tenant_id = $1
       GROUP BY audit_source ORDER BY cnt DESC`,
      [tenantId],
    );

    const exportRow = await client.query(
      `SELECT COUNT(*) as total, SUM(CASE WHEN export_status = 'failed' THEN 1 ELSE 0 END) as failures
       FROM public.audit_export_runs WHERE tenant_id = $1`,
      [tenantId],
    );

    return {
      tenantId,
      auditEventsTotal: parseInt(totalRow.rows[0].cnt, 10),
      auditEventsByAction: actionRow.rows.map((r) => ({ action: r.action, count: parseInt(r.cnt, 10) })),
      auditEventsByActorType: actorRow.rows.map((r) => ({ actorType: r.actor_type, count: parseInt(r.cnt, 10) })),
      auditEventsBySource: sourceRow.rows.map((r) => ({ source: r.audit_source, count: parseInt(r.cnt, 10) })),
      auditExportRunsTotal: parseInt(exportRow.rows[0].total ?? "0", 10),
      auditExportFailuresTotal: parseInt(exportRow.rows[0].failures ?? "0", 10),
      note: "INV-AUD5: Metrics are tenant-isolated. INV-AUD12: Operational visibility.",
    };
  } finally {
    await client.end();
  }
}

// ─── summarizeAuditMetrics ────────────────────────────────────────────────────

export async function summarizeAuditMetrics(): Promise<{
  totalEvents: number;
  totalExportRuns: number;
  totalWriteFailures: number;
  tenantCount: number;
  eventsByStatus: Array<{ status: string; count: number }>;
  recentWriteFailures: Array<{ timestamp: Date; error: string; eventType: string; tenantId: string }>;
  note: string;
}> {
  const client = getClient();
  await client.connect();
  try {
    const totRow = await client.query(`SELECT COUNT(*) as cnt FROM public.audit_events`);
    const expRow = await client.query(`SELECT COUNT(*) as cnt FROM public.audit_export_runs`);
    const tenRow = await client.query(`SELECT COUNT(DISTINCT tenant_id) as cnt FROM public.audit_events`);
    const statusRow = await client.query(
      `SELECT event_status, COUNT(*) as cnt FROM public.audit_events GROUP BY event_status ORDER BY cnt DESC`,
    );

    const writeFailures = getAuditWriteFailures();

    return {
      totalEvents: parseInt(totRow.rows[0].cnt, 10),
      totalExportRuns: parseInt(expRow.rows[0].cnt, 10),
      totalWriteFailures: writeFailures.length,
      tenantCount: parseInt(tenRow.rows[0].cnt, 10),
      eventsByStatus: statusRow.rows.map((r) => ({ status: r.event_status, count: parseInt(r.cnt, 10) })),
      recentWriteFailures: writeFailures.slice(-10),
      note: "INV-AUD12: Operational failures visible. Tenant-wide metrics for admin/operator use.",
    };
  } finally {
    await client.end();
  }
}

// ─── listRecentAuditActions ───────────────────────────────────────────────────

export async function listRecentAuditActions(params: {
  tenantId?: string;
  limit?: number;
}): Promise<Array<{ action: string; actorType: string; tenantId: string; createdAt: Date }>> {
  const { tenantId, limit = 20 } = params;
  const client = getClient();
  await client.connect();
  try {
    let row;
    if (tenantId) {
      row = await client.query(
        `SELECT action, actor_type, tenant_id, created_at FROM public.audit_events
         WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [tenantId, Math.min(limit, 100)],
      );
    } else {
      row = await client.query(
        `SELECT action, actor_type, tenant_id, created_at FROM public.audit_events
         ORDER BY created_at DESC LIMIT $1`,
        [Math.min(limit, 100)],
      );
    }
    return row.rows.map((r) => ({
      action: r.action,
      actorType: r.actor_type,
      tenantId: r.tenant_id,
      createdAt: r.created_at,
    }));
  } finally {
    await client.end();
  }
}

// ─── listAuditWriteFailures ───────────────────────────────────────────────────
// INV-AUD12: Operational observability.

export function listAuditWriteFailures(): Array<{
  timestamp: Date;
  error: string;
  eventType: string;
  tenantId: string;
}> {
  return getAuditWriteFailures();
}

// ─── explainAuditOperationalState ────────────────────────────────────────────
// INV-AUD7: Read-only.

export async function explainAuditOperationalState(): Promise<{
  healthy: boolean;
  totalEvents: number;
  recentWriteFailures: number;
  tables: string[];
  note: string;
}> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(`SELECT COUNT(*) as cnt FROM public.audit_events`);
    const tables = ["audit_events", "audit_event_metadata", "audit_export_runs"];

    const tableCheck = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY($1)`,
      [tables],
    );

    const failures = getAuditWriteFailures();
    const recentFailures = failures.filter((f) => new Date().getTime() - f.timestamp.getTime() < 60 * 60 * 1000);

    return {
      healthy: tableCheck.rows.length === 3 && recentFailures.length === 0,
      totalEvents: parseInt(row.rows[0].cnt, 10),
      recentWriteFailures: recentFailures.length,
      tables: tableCheck.rows.map((r) => r.table_name),
      note: "INV-AUD7: Read-only operational health check. INV-AUD12: Write failure tracking active.",
    };
  } finally {
    await client.end();
  }
}
