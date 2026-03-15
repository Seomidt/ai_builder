/**
 * Phase 23 — Webhook Delivery
 * Creates delivery records and performs actual HTTP delivery of webhook events.
 */

import { db } from "../../db";
import { webhookDeliveries } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";
import { buildWebhookHeaders } from "./webhook-signature";

/**
 * Create a pending delivery record.
 */
export async function createDelivery(params: {
  endpointId: string;
  tenantId: string;
  eventType: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
}): Promise<{ id: string }> {
  const rows = await db.insert(webhookDeliveries).values({
    endpointId: params.endpointId,
    tenantId: params.tenantId,
    eventType: params.eventType,
    payload: params.payload,
    status: "pending",
    attempts: 0,
    maxAttempts: params.maxAttempts ?? 3,
  }).returning({ id: webhookDeliveries.id });
  return { id: rows[0].id };
}

/**
 * Get a delivery record by ID.
 */
export async function getDelivery(deliveryId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM webhook_deliveries WHERE id = ${deliveryId} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

/**
 * List deliveries for a tenant.
 */
export async function listDeliveries(tenantId: string, params?: {
  status?: string;
  eventType?: string;
  endpointId?: string;
  limit?: number;
  offset?: number;
}): Promise<Array<Record<string, unknown>>> {
  const limit = params?.limit ?? 50;
  const offset = params?.offset ?? 0;
  const statusClause = params?.status ? drizzleSql`AND status = ${params.status}` : drizzleSql``;
  const typeClause = params?.eventType ? drizzleSql`AND event_type = ${params.eventType}` : drizzleSql``;
  const epClause = params?.endpointId ? drizzleSql`AND endpoint_id = ${params.endpointId}` : drizzleSql``;

  const rows = await db.execute(drizzleSql`
    SELECT * FROM webhook_deliveries
    WHERE tenant_id = ${tenantId} ${statusClause} ${typeClause} ${epClause}
    ORDER BY created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * Attempt to deliver a webhook to the target URL.
 * Records the result (success or failure) in the delivery record.
 *
 * Returns: { success, statusCode, latencyMs, error? }
 */
export async function attemptDelivery(params: {
  deliveryId: string;
  url: string;
  secret: string;
  payload: Record<string, unknown>;
  eventType: string;
  timeoutMs?: number;
}): Promise<{ success: boolean; statusCode?: number; latencyMs: number; error?: string }> {
  const start = Date.now();
  const payloadStr = JSON.stringify(params.payload);
  const headers = buildWebhookHeaders({
    secret: params.secret,
    payload: payloadStr,
    eventType: params.eventType,
    deliveryId: params.deliveryId,
  });

  let statusCode: number | undefined;
  let error: string | undefined;
  let success = false;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs ?? 10000);
    try {
      const resp = await fetch(params.url, {
        method: "POST",
        headers,
        body: payloadStr,
        signal: controller.signal,
      });
      statusCode = resp.status;
      success = resp.status >= 200 && resp.status < 300;
      if (!success) error = `HTTP ${resp.status}`;
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (err) {
    error = (err as Error).message ?? "Unknown delivery error";
    if (error.includes("abort") || error.includes("timeout")) {
      error = `Timeout after ${params.timeoutMs ?? 10000}ms`;
    }
  }

  const latencyMs = Date.now() - start;
  return { success, statusCode, latencyMs, error };
}

/**
 * Mark a delivery as successfully delivered.
 */
export async function markDelivered(deliveryId: string, params: {
  statusCode: number;
  latencyMs: number;
  attempts: number;
}): Promise<void> {
  await db.execute(drizzleSql`
    UPDATE webhook_deliveries SET
      status = 'delivered',
      attempts = ${params.attempts},
      http_status_code = ${params.statusCode},
      delivery_latency_ms = ${params.latencyMs},
      delivered_at = NOW(),
      last_attempt_at = NOW(),
      updated_at = NOW()
    WHERE id = ${deliveryId}
  `);
}

/**
 * Mark a delivery as failed (no more retries).
 */
export async function markFailed(deliveryId: string, params: {
  error: string;
  statusCode?: number;
  attempts: number;
}): Promise<void> {
  await db.execute(drizzleSql`
    UPDATE webhook_deliveries SET
      status = 'failed',
      attempts = ${params.attempts},
      http_status_code = ${params.statusCode ?? null},
      last_error = ${params.error},
      last_attempt_at = NOW(),
      updated_at = NOW()
    WHERE id = ${deliveryId}
  `);
}

/**
 * Mark a delivery as retrying with exponential backoff.
 */
export async function markRetrying(deliveryId: string, params: {
  error: string;
  statusCode?: number;
  attempts: number;
  nextRetryAt: Date;
}): Promise<void> {
  await db.execute(drizzleSql`
    UPDATE webhook_deliveries SET
      status = 'retrying',
      attempts = ${params.attempts},
      http_status_code = ${params.statusCode ?? null},
      last_error = ${params.error},
      last_attempt_at = NOW(),
      next_retry_at = ${params.nextRetryAt},
      updated_at = NOW()
    WHERE id = ${deliveryId}
  `);
}

/**
 * Get deliveries that are due for retry.
 */
export async function getPendingRetries(limit: number = 50): Promise<Array<Record<string, unknown>>> {
  const rows = await db.execute(drizzleSql`
    SELECT wd.*, we.url, we.secret, we.timeout_ms, we.max_retries
    FROM webhook_deliveries wd
    JOIN webhook_endpoints we ON we.id = wd.endpoint_id
    WHERE wd.status = 'retrying'
      AND wd.next_retry_at <= NOW()
      AND wd.attempts < wd.max_attempts
      AND we.active = true
    ORDER BY wd.next_retry_at ASC
    LIMIT ${limit}
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * Get delivery observability stats for a tenant.
 */
export async function getDeliveryStats(tenantId?: string): Promise<{
  totalDeliveries: number;
  totalDelivered: number;
  totalFailed: number;
  totalRetrying: number;
  totalPending: number;
  avgLatencyMs: number;
  failureRate: number;
}> {
  const tenantClause = tenantId ? drizzleSql`WHERE tenant_id = ${tenantId}` : drizzleSql``;
  const rows = await db.execute(drizzleSql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
      COUNT(*) FILTER (WHERE status = 'failed') AS failed,
      COUNT(*) FILTER (WHERE status = 'retrying') AS retrying,
      COUNT(*) FILTER (WHERE status = 'pending') AS pending,
      COALESCE(AVG(delivery_latency_ms) FILTER (WHERE status = 'delivered'), 0) AS avg_latency
    FROM webhook_deliveries ${tenantClause}
  `);
  const r = rows.rows[0] as Record<string, unknown>;
  const total = Number(r.total ?? 0);
  const failed = Number(r.failed ?? 0);
  return {
    totalDeliveries: total,
    totalDelivered: Number(r.delivered ?? 0),
    totalFailed: failed,
    totalRetrying: Number(r.retrying ?? 0),
    totalPending: Number(r.pending ?? 0),
    avgLatencyMs: Math.round(Number(r.avg_latency ?? 0)),
    failureRate: total > 0 ? parseFloat((failed / total * 100).toFixed(2)) : 0,
  };
}

/**
 * Get per-endpoint reliability stats.
 */
export async function getEndpointReliabilityStats(endpointId: string): Promise<{
  totalDeliveries: number;
  successRate: number;
  avgLatencyMs: number;
  avgRetries: number;
}> {
  const rows = await db.execute(drizzleSql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
      COALESCE(AVG(delivery_latency_ms) FILTER (WHERE status = 'delivered'), 0) AS avg_latency,
      COALESCE(AVG(attempts), 0) AS avg_attempts
    FROM webhook_deliveries WHERE endpoint_id = ${endpointId}
  `);
  const r = rows.rows[0] as Record<string, unknown>;
  const total = Number(r.total ?? 0);
  const delivered = Number(r.delivered ?? 0);
  return {
    totalDeliveries: total,
    successRate: total > 0 ? parseFloat((delivered / total * 100).toFixed(2)) : 0,
    avgLatencyMs: Math.round(Number(r.avg_latency ?? 0)),
    avgRetries: parseFloat(Number(r.avg_attempts ?? 0).toFixed(2)),
  };
}
