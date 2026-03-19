/**
 * Phase 23 — Webhook Registry
 * CRUD for webhook endpoints and subscriptions.
 */

import { db } from "../../db";
import { webhookEndpoints, webhookSubscriptions } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";
import { generateWebhookSecret } from "./webhook-signature";
import { clampTimeoutMs } from "../ai/timeout-sanitizer";

// ── Supported platform event types ────────────────────────────────────────────

export const PLATFORM_EVENT_TYPES = [
  "tenant.created",
  "tenant.updated",
  "tenant.suspended",
  "subscription.created",
  "subscription.updated",
  "subscription.canceled",
  "invoice.paid",
  "invoice.payment_failed",
  "agent.run.completed",
  "agent.run.failed",
  "evaluation.finished",
  "evaluation.failed",
  "feature.flag.updated",
  "feature.flag.created",
  "budget.threshold.exceeded",
  "quota.exceeded",
  "job.completed",
  "job.failed",
] as const;

export type PlatformEventType = typeof PLATFORM_EVENT_TYPES[number];

export function isValidEventType(eventType: string): boolean {
  return PLATFORM_EVENT_TYPES.includes(eventType as PlatformEventType);
}

// ── Endpoint CRUD ─────────────────────────────────────────────────────────────

/**
 * Register a new webhook endpoint.
 */
export async function registerWebhookEndpoint(params: {
  tenantId: string;
  url: string;
  secret?: string;
  description?: string;
  maxRetries?: number;
  timeoutMs?: number;
}): Promise<{ id: string; secret: string; tenantId: string }> {
  if (!params.tenantId?.trim()) throw new Error("tenantId is required");
  if (!params.url?.trim()) throw new Error("url is required");

  // Validate URL format
  try { new URL(params.url); } catch { throw new Error(`Invalid URL: ${params.url}`); }

  const secret = params.secret ?? generateWebhookSecret();

  const rows = await db.insert(webhookEndpoints).values({
    tenantId: params.tenantId,
    url: params.url.trim(),
    secret,
    description: params.description ?? null,
    active: true,
    maxRetries: Math.max(0, Math.min(params.maxRetries ?? 3, 10)),
    // Phase 42: use formal sanitizer instead of inline clamp — enforces platform SLA bounds
    timeoutMs: clampTimeoutMs(params.timeoutMs ?? 10000, 1000, 60000),
  }).returning({ id: webhookEndpoints.id });

  return { id: rows[0].id, secret, tenantId: params.tenantId };
}

/**
 * Get a webhook endpoint by ID.
 */
export async function getWebhookEndpoint(endpointId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM webhook_endpoints WHERE id = ${endpointId} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

/**
 * List all webhook endpoints for a tenant.
 */
export async function listWebhookEndpoints(tenantId: string, params?: {
  active?: boolean;
  limit?: number;
}): Promise<Array<Record<string, unknown>>> {
  const activeClause = params?.active !== undefined
    ? drizzleSql`AND active = ${params.active}`
    : drizzleSql``;
  const limit = params?.limit ?? 100;
  const rows = await db.execute(drizzleSql`
    SELECT id, tenant_id, url, description, active, max_retries, timeout_ms, created_at, updated_at
    FROM webhook_endpoints
    WHERE tenant_id = ${tenantId} ${activeClause}
    ORDER BY created_at DESC LIMIT ${limit}
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * Update a webhook endpoint.
 */
export async function updateWebhookEndpoint(endpointId: string, params: {
  url?: string;
  description?: string;
  active?: boolean;
  maxRetries?: number;
  timeoutMs?: number;
}): Promise<{ updated: boolean }> {
  const existing = await getWebhookEndpoint(endpointId);
  if (!existing) return { updated: false };

  await db.execute(drizzleSql`
    UPDATE webhook_endpoints SET
      url = ${params.url ?? (existing.url as string)},
      description = ${params.description ?? (existing.description as string | null)},
      active = ${params.active ?? (existing.active as boolean)},
      max_retries = ${params.maxRetries ?? (existing.max_retries as number)},
      timeout_ms = ${clampTimeoutMs(params.timeoutMs ?? (existing.timeout_ms as number), 1000, 60000)},
      updated_at = NOW()
    WHERE id = ${endpointId}
  `);
  return { updated: true };
}

/**
 * Rotate the signing secret for an endpoint.
 */
export async function rotateWebhookSecret(endpointId: string): Promise<{ newSecret: string }> {
  const newSecret = generateWebhookSecret();
  await db.execute(drizzleSql`
    UPDATE webhook_endpoints SET secret = ${newSecret}, updated_at = NOW()
    WHERE id = ${endpointId}
  `);
  return { newSecret };
}

/**
 * Deactivate a webhook endpoint (soft delete).
 */
export async function deactivateWebhookEndpoint(endpointId: string): Promise<{ deactivated: boolean }> {
  await db.execute(drizzleSql`
    UPDATE webhook_endpoints SET active = false, updated_at = NOW() WHERE id = ${endpointId}
  `);
  return { deactivated: true };
}

/**
 * Delete a webhook endpoint and all its subscriptions.
 */
export async function deleteWebhookEndpoint(endpointId: string): Promise<{ deleted: boolean }> {
  await db.execute(drizzleSql`DELETE FROM webhook_subscriptions WHERE endpoint_id = ${endpointId}`);
  await db.execute(drizzleSql`DELETE FROM webhook_endpoints WHERE id = ${endpointId}`);
  return { deleted: true };
}

// ── Subscription CRUD ─────────────────────────────────────────────────────────

/**
 * Subscribe an endpoint to an event type.
 */
export async function subscribeEndpoint(params: {
  endpointId: string;
  tenantId: string;
  eventType: string;
}): Promise<{ id: string; eventType: string }> {
  if (!isValidEventType(params.eventType)) {
    throw new Error(`Unknown event type: ${params.eventType}. Valid types: ${PLATFORM_EVENT_TYPES.join(", ")}`);
  }

  // Check endpoint exists and belongs to tenant
  const ep = await getWebhookEndpoint(params.endpointId);
  if (!ep) throw new Error(`Endpoint ${params.endpointId} not found`);
  if (ep.tenant_id !== params.tenantId) throw new Error("Endpoint does not belong to this tenant");

  // Idempotent: check existing
  const existing = await db.execute(drizzleSql`
    SELECT id FROM webhook_subscriptions
    WHERE endpoint_id = ${params.endpointId} AND event_type = ${params.eventType} LIMIT 1
  `);
  if (existing.rows.length > 0) {
    return { id: (existing.rows[0] as Record<string, unknown>).id as string, eventType: params.eventType };
  }

  const rows = await db.insert(webhookSubscriptions).values({
    endpointId: params.endpointId,
    tenantId: params.tenantId,
    eventType: params.eventType,
    active: true,
  }).returning({ id: webhookSubscriptions.id });

  return { id: rows[0].id, eventType: params.eventType };
}

/**
 * Unsubscribe an endpoint from an event type.
 */
export async function unsubscribeEndpoint(endpointId: string, eventType: string): Promise<{ removed: boolean }> {
  await db.execute(drizzleSql`
    DELETE FROM webhook_subscriptions
    WHERE endpoint_id = ${endpointId} AND event_type = ${eventType}
  `);
  return { removed: true };
}

/**
 * List subscriptions for an endpoint.
 */
export async function listEndpointSubscriptions(endpointId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM webhook_subscriptions WHERE endpoint_id = ${endpointId} AND active = true
    ORDER BY created_at ASC
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * Get all active endpoints subscribed to a given event type for a tenant.
 */
export async function getSubscribedEndpoints(tenantId: string, eventType: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.execute(drizzleSql`
    SELECT we.* FROM webhook_endpoints we
    INNER JOIN webhook_subscriptions ws ON ws.endpoint_id = we.id
    WHERE we.tenant_id = ${tenantId}
      AND we.active = true
      AND ws.event_type = ${eventType}
      AND ws.active = true
    ORDER BY we.created_at ASC
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * Get all active subscriptions for a tenant (all event types).
 */
export async function listTenantSubscriptions(tenantId: string): Promise<Array<Record<string, unknown>>> {
  const rows = await db.execute(drizzleSql`
    SELECT ws.*, we.url, we.active as endpoint_active FROM webhook_subscriptions ws
    JOIN webhook_endpoints we ON we.id = ws.endpoint_id
    WHERE ws.tenant_id = ${tenantId} AND ws.active = true
    ORDER BY ws.created_at DESC
  `);
  return rows.rows as Record<string, unknown>[];
}
