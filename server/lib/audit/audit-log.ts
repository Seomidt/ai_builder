/**
 * Phase 8 — Canonical Audit Service Layer
 * INV-AUD1: Every audit event must have tenant scope semantics.
 * INV-AUD2: Audit records are append-only and immutable after creation.
 * INV-AUD3: Actor identity or unknown must always be recorded.
 * INV-AUD4: Audit failures must not corrupt or block primary business flow.
 * INV-AUD12: Audit write failures must be operationally observable.
 */

import pg from "pg";
import type { AuditContext } from "./audit-context.ts";
import type { AuditActorType, AuditSource, AuditEventStatus } from "./audit-actions.ts";
import { isKnownAuditAction } from "./audit-actions.ts";

// ─── Write failure tracking (INV-AUD12) ──────────────────────────────────────

const writeFailures: Array<{
  timestamp: Date;
  error: string;
  eventType: string;
  tenantId: string;
}> = [];

function trackWriteFailure(err: Error, eventType: string, tenantId: string): void {
  writeFailures.push({ timestamp: new Date(), error: err.message, eventType, tenantId });
  if (writeFailures.length > 1000) writeFailures.shift();
  console.error(`[AUDIT-WRITE-FAILURE] tenant=${tenantId} action=${eventType} err=${err.message}`);
}

export function getAuditWriteFailures(): typeof writeFailures {
  return [...writeFailures];
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ─── logAuditEvent ────────────────────────────────────────────────────────────
// INV-AUD2: Append-only — no UPDATE or DELETE.
// INV-AUD4: Returns error info on failure rather than throwing into caller.

export async function logAuditEvent(params: {
  ctx: AuditContext;
  action: string;
  resourceType: string;
  resourceId?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ eventId: string | null; success: boolean; error?: string }> {
  const { ctx, action, resourceType, resourceId, summary, metadata } = params;

  const client = getClient();
  try {
    await client.connect();
    const row = await client.query(
      `INSERT INTO public.audit_events
         (id, tenant_id, actor_id, actor_type, action, resource_type, resource_id,
          request_id, correlation_id, ip_address, user_agent, audit_source, event_status, summary, metadata)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        ctx.tenantId,
        ctx.actorId ?? null,
        ctx.actorType,
        action,
        resourceType,
        resourceId ?? null,
        ctx.requestId ?? null,
        ctx.correlationId ?? null,
        ctx.ipAddress ?? null,
        ctx.userAgent ?? null,
        ctx.auditSource,
        ctx.eventStatus,
        summary ?? null,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
    return { eventId: row.rows[0].id, success: true };
  } catch (err) {
    trackWriteFailure(err as Error, action, ctx.tenantId);
    return { eventId: null, success: false, error: (err as Error).message };
  } finally {
    try { await client.end(); } catch { /**/ }
  }
}

// ─── logAuditResourceChange ───────────────────────────────────────────────────
// INV-AUD11: Before/after state structured and explainable.

export async function logAuditResourceChange(params: {
  ctx: AuditContext;
  action: string;
  resourceType: string;
  resourceId?: string;
  beforeState?: Record<string, unknown>;
  afterState?: Record<string, unknown>;
  changeFields?: string[];
  summary?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ eventId: string | null; metadataId: string | null; success: boolean; error?: string }> {
  const { ctx, action, resourceType, resourceId, beforeState, afterState, changeFields, summary, metadata } = params;

  const eventResult = await logAuditEvent({ ctx, action, resourceType, resourceId, summary, metadata });
  if (!eventResult.success || !eventResult.eventId) {
    return { eventId: null, metadataId: null, success: false, error: eventResult.error };
  }

  // Only write metadata row if there is before/after/changeFields
  const hasChange = beforeState || afterState || changeFields;
  if (!hasChange) {
    return { eventId: eventResult.eventId, metadataId: null, success: true };
  }

  const client = getClient();
  try {
    await client.connect();
    const mRow = await client.query(
      `INSERT INTO public.audit_event_metadata
         (id, audit_event_id, before_state, after_state, change_fields, metadata)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id`,
      [
        eventResult.eventId,
        beforeState ? JSON.stringify(beforeState) : null,
        afterState ? JSON.stringify(afterState) : null,
        changeFields ? JSON.stringify(changeFields) : null,
        null,
      ],
    );
    return { eventId: eventResult.eventId, metadataId: mRow.rows[0].id, success: true };
  } catch (err) {
    trackWriteFailure(err as Error, action + ".metadata", ctx.tenantId);
    return { eventId: eventResult.eventId, metadataId: null, success: false, error: (err as Error).message };
  } finally {
    try { await client.end(); } catch { /**/ }
  }
}

// ─── logAuditBestEffort ───────────────────────────────────────────────────────
// INV-AUD4: Guaranteed non-blocking — always catches errors.

export async function logAuditBestEffort(params: {
  tenantId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  actorId?: string;
  actorType?: AuditActorType;
  ipAddress?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const { tenantId, action, resourceType, resourceId, actorId, actorType, ipAddress, summary, metadata } = params;
  const ctx: AuditContext = {
    tenantId,
    actorId: actorId ?? null,
    actorType: actorType ?? "unknown",
    requestId: null,
    correlationId: null,
    ipAddress: ipAddress ?? null,
    userAgent: null,
    auditSource: "application",
    eventStatus: "best_effort",
  };
  await logAuditEvent({ ctx, action, resourceType, resourceId, summary, metadata }).catch((err) => {
    trackWriteFailure(err, action, tenantId);
  });
}

// ─── getAuditEventById ────────────────────────────────────────────────────────

export async function getAuditEventById(eventId: string): Promise<{
  event: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
}> {
  const client = getClient();
  await client.connect();
  try {
    const evRow = await client.query(
      `SELECT * FROM public.audit_events WHERE id = $1`,
      [eventId],
    );
    if (evRow.rows.length === 0) return { event: null, metadata: null };

    const metaRow = await client.query(
      `SELECT * FROM public.audit_event_metadata WHERE audit_event_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [eventId],
    );

    return {
      event: evRow.rows[0],
      metadata: metaRow.rows[0] ?? null,
    };
  } finally {
    await client.end();
  }
}

// ─── listAuditEventsByTenant ──────────────────────────────────────────────────
// INV-AUD5: Always filtered by tenant_id.

export async function listAuditEventsByTenant(params: {
  tenantId: string;
  action?: string;
  actorType?: string;
  resourceType?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}): Promise<Array<Record<string, unknown>>> {
  const { tenantId, action, actorType, resourceType, startDate, endDate, limit = 50, offset = 0 } = params;

  const client = getClient();
  await client.connect();
  try {
    const conditions: string[] = ["tenant_id = $1"];
    const values: unknown[] = [tenantId];

    if (action) { conditions.push(`action = $${values.length + 1}`); values.push(action); }
    if (actorType) { conditions.push(`actor_type = $${values.length + 1}`); values.push(actorType); }
    if (resourceType) { conditions.push(`resource_type = $${values.length + 1}`); values.push(resourceType); }
    if (startDate) { conditions.push(`created_at >= $${values.length + 1}`); values.push(startDate); }
    if (endDate) { conditions.push(`created_at <= $${values.length + 1}`); values.push(endDate); }

    values.push(Math.min(limit, 500));
    values.push(offset);

    const row = await client.query(
      `SELECT * FROM public.audit_events WHERE ${conditions.join(" AND ")}
       ORDER BY created_at DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return row.rows;
  } finally {
    await client.end();
  }
}

// ─── listAuditEventsByActor ───────────────────────────────────────────────────
// INV-AUD5: Must also enforce tenant scope.

export async function listAuditEventsByActor(params: {
  tenantId: string;
  actorId: string;
  limit?: number;
}): Promise<Array<Record<string, unknown>>> {
  const { tenantId, actorId, limit = 50 } = params;
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.audit_events WHERE tenant_id = $1 AND actor_id = $2
       ORDER BY created_at DESC LIMIT $3`,
      [tenantId, actorId, Math.min(limit, 500)],
    );
    return row.rows;
  } finally {
    await client.end();
  }
}

// ─── listAuditEventsByResource ────────────────────────────────────────────────
// INV-AUD5: Tenant-scoped.

export async function listAuditEventsByResource(params: {
  tenantId: string;
  resourceType: string;
  resourceId: string;
  limit?: number;
}): Promise<Array<Record<string, unknown>>> {
  const { tenantId, resourceType, resourceId, limit = 50 } = params;
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT * FROM public.audit_events WHERE tenant_id = $1 AND resource_type = $2 AND resource_id = $3
       ORDER BY created_at DESC LIMIT $4`,
      [tenantId, resourceType, resourceId, Math.min(limit, 500)],
    );
    return row.rows;
  } finally {
    await client.end();
  }
}

// ─── explainAuditEvent ────────────────────────────────────────────────────────
// INV-AUD7: Read-only.

export async function explainAuditEvent(eventId: string): Promise<{
  found: boolean;
  event?: Record<string, unknown>;
  changeMetadata?: Record<string, unknown> | null;
  humanSummary?: string;
  immutable: boolean;
  note: string;
}> {
  const { event, metadata } = await getAuditEventById(eventId);
  if (!event) return { found: false, immutable: true, note: "INV-AUD7: Read-only — no writes." };

  const humanSummary = [
    `Actor '${event["actor_id"] ?? "unknown"}' (${event["actor_type"]})`,
    `performed '${event["action"]}'`,
    `on ${event["resource_type"]}${event["resource_id"] ? `:${event["resource_id"]}` : ""}`,
    `at ${new Date(event["created_at"] as string).toISOString()}`,
    `for tenant ${event["tenant_id"]}`,
  ].join(" ");

  return {
    found: true,
    event,
    changeMetadata: metadata,
    humanSummary,
    immutable: true,
    note: "INV-AUD7: Read-only — no writes performed. INV-AUD2: Audit rows are immutable.",
  };
}

// ─── summarizeAuditEvent ──────────────────────────────────────────────────────
// INV-AUD7: Read-only.

export async function summarizeAuditEvent(eventId: string): Promise<{
  eventId: string;
  action: string | null;
  actorType: string | null;
  resourceType: string | null;
  tenantId: string | null;
  createdAt: Date | null;
  hasChangeMetadata: boolean;
  note: string;
}> {
  const { event, metadata } = await getAuditEventById(eventId);
  return {
    eventId,
    action: event ? String(event["action"]) : null,
    actorType: event ? String(event["actor_type"]) : null,
    resourceType: event ? String(event["resource_type"]) : null,
    tenantId: event ? String(event["tenant_id"]) : null,
    createdAt: event ? new Date(event["created_at"] as string) : null,
    hasChangeMetadata: !!metadata,
    note: "INV-AUD7: Read-only. INV-AUD2: Immutable.",
  };
}
