/**
 * Phase 23 — Webhook Dispatcher
 * Dispatches platform events to all subscribed tenant endpoints.
 * Uses Phase 19 job queue pattern for async delivery.
 */

import { db } from "../../db";
import { sql as drizzleSql } from "drizzle-orm";
import { getSubscribedEndpoints } from "./webhook-registry";
import { createDelivery, attemptDelivery, markDelivered, markFailed, markRetrying, getPendingRetries } from "./webhook-delivery";
import { buildRetryDecision, DEFAULT_RETRY_POLICY, type RetryPolicy } from "./webhook-retries";

export interface PlatformEvent {
  eventType: string;
  tenantId: string;
  payload: {
    eventType: string;
    tenantId: string;
    timestamp: string;
    data: Record<string, unknown>;
  };
}

/**
 * Build a standardized platform event payload.
 */
export function buildEventPayload(params: {
  eventType: string;
  tenantId: string;
  data: Record<string, unknown>;
  eventId?: string;
}): PlatformEvent["payload"] {
  return {
    eventType: params.eventType,
    tenantId: params.tenantId,
    timestamp: new Date().toISOString(),
    data: params.data,
  };
}

/**
 * Dispatch a platform event to all subscribed endpoints for a tenant.
 * Creates delivery records and attempts immediate delivery.
 *
 * Returns: list of delivery IDs created
 */
export async function dispatchEvent(params: {
  eventType: string;
  tenantId: string;
  data: Record<string, unknown>;
  policy?: RetryPolicy;
}): Promise<{ deliveryIds: string[]; endpointCount: number }> {
  // Find all subscribed endpoints
  const endpoints = await getSubscribedEndpoints(params.tenantId, params.eventType);
  if (endpoints.length === 0) {
    return { deliveryIds: [], endpointCount: 0 };
  }

  const payload = buildEventPayload({
    eventType: params.eventType,
    tenantId: params.tenantId,
    data: params.data,
  });

  const deliveryIds: string[] = [];

  for (const endpoint of endpoints) {
    const { id: deliveryId } = await createDelivery({
      endpointId: endpoint.id as string,
      tenantId: params.tenantId,
      eventType: params.eventType,
      payload: payload as Record<string, unknown>,
      maxAttempts: (endpoint.max_retries as number) ?? 3,
    });
    deliveryIds.push(deliveryId);

    // Attempt immediate delivery
    await deliverWebhook({
      deliveryId,
      url: endpoint.url as string,
      secret: endpoint.secret as string,
      payload: payload as Record<string, unknown>,
      eventType: params.eventType,
      timeoutMs: (endpoint.timeout_ms as number) ?? 10000,
      maxAttempts: (endpoint.max_retries as number) ?? 3,
      policy: params.policy ?? DEFAULT_RETRY_POLICY,
    });
  }

  return { deliveryIds, endpointCount: endpoints.length };
}

/**
 * Attempt delivery for a single delivery record.
 * Handles success, failure, and retry scheduling.
 */
export async function deliverWebhook(params: {
  deliveryId: string;
  url: string;
  secret: string;
  payload: Record<string, unknown>;
  eventType: string;
  timeoutMs: number;
  maxAttempts: number;
  policy?: RetryPolicy;
}): Promise<{ success: boolean; status: string }> {
  const delivery = await import("./webhook-delivery").then((m) => m.getDelivery(params.deliveryId));
  const currentAttempts = Number(delivery?.attempts ?? 0) + 1;

  const result = await attemptDelivery({
    deliveryId: params.deliveryId,
    url: params.url,
    secret: params.secret,
    payload: params.payload,
    eventType: params.eventType,
    timeoutMs: params.timeoutMs,
  });

  if (result.success) {
    await markDelivered(params.deliveryId, {
      statusCode: result.statusCode!,
      latencyMs: result.latencyMs,
      attempts: currentAttempts,
    });
    return { success: true, status: "delivered" };
  }

  // Failed — determine retry
  const retryDecision = buildRetryDecision({
    attempts: currentAttempts,
    maxAttempts: params.maxAttempts,
    policy: params.policy ?? DEFAULT_RETRY_POLICY,
    statusCode: result.statusCode,
  });

  if (retryDecision.shouldRetry) {
    await markRetrying(params.deliveryId, {
      error: result.error ?? "Delivery failed",
      statusCode: result.statusCode,
      attempts: currentAttempts,
      nextRetryAt: retryDecision.nextRetryAt!,
    });
    return { success: false, status: "retrying" };
  }

  await markFailed(params.deliveryId, {
    error: result.error ?? "Delivery failed",
    statusCode: result.statusCode,
    attempts: currentAttempts,
  });
  return { success: false, status: "failed" };
}

/**
 * Process all pending retries (called by background job or cron).
 */
export async function processPendingRetries(params?: { limit?: number }): Promise<{
  processed: number;
  delivered: number;
  failed: number;
  requeued: number;
}> {
  const pending = await getPendingRetries(params?.limit ?? 50);
  let delivered = 0;
  let failed = 0;
  let requeued = 0;

  for (const delivery of pending) {
    const result = await deliverWebhook({
      deliveryId: delivery.id as string,
      url: delivery.url as string,
      secret: delivery.secret as string,
      payload: delivery.payload as Record<string, unknown>,
      eventType: delivery.event_type as string,
      timeoutMs: (delivery.timeout_ms as number) ?? 10000,
      maxAttempts: (delivery.max_attempts as number) ?? 3,
    });

    if (result.status === "delivered") delivered++;
    else if (result.status === "failed") failed++;
    else requeued++;
  }

  return { processed: pending.length, delivered, failed, requeued };
}

/**
 * Emit a tenant.created event.
 */
export async function emitTenantCreated(tenantId: string, data: Record<string, unknown>): Promise<{ deliveryIds: string[] }> {
  const result = await dispatchEvent({ eventType: "tenant.created", tenantId, data });
  return { deliveryIds: result.deliveryIds };
}

/**
 * Emit a subscription.updated event.
 */
export async function emitSubscriptionUpdated(tenantId: string, data: Record<string, unknown>): Promise<{ deliveryIds: string[] }> {
  const result = await dispatchEvent({ eventType: "subscription.updated", tenantId, data });
  return { deliveryIds: result.deliveryIds };
}

/**
 * Emit an invoice.paid event.
 */
export async function emitInvoicePaid(tenantId: string, data: Record<string, unknown>): Promise<{ deliveryIds: string[] }> {
  const result = await dispatchEvent({ eventType: "invoice.paid", tenantId, data });
  return { deliveryIds: result.deliveryIds };
}

/**
 * Emit an agent.run.completed event.
 */
export async function emitAgentRunCompleted(tenantId: string, data: Record<string, unknown>): Promise<{ deliveryIds: string[] }> {
  const result = await dispatchEvent({ eventType: "agent.run.completed", tenantId, data });
  return { deliveryIds: result.deliveryIds };
}

/**
 * Emit an evaluation.finished event.
 */
export async function emitEvaluationFinished(tenantId: string, data: Record<string, unknown>): Promise<{ deliveryIds: string[] }> {
  const result = await dispatchEvent({ eventType: "evaluation.finished", tenantId, data });
  return { deliveryIds: result.deliveryIds };
}

/**
 * Emit a feature.flag.updated event.
 */
export async function emitFeatureFlagUpdated(tenantId: string, data: Record<string, unknown>): Promise<{ deliveryIds: string[] }> {
  const result = await dispatchEvent({ eventType: "feature.flag.updated", tenantId, data });
  return { deliveryIds: result.deliveryIds };
}

/**
 * Get dispatcher observability stats.
 */
export async function getDispatcherStats(): Promise<{
  pendingRetries: number;
  totalEndpoints: number;
  totalSubscriptions: number;
}> {
  const retries = await db.execute(drizzleSql`
    SELECT COUNT(*) AS cnt FROM webhook_deliveries WHERE status = 'retrying' AND next_retry_at <= NOW()
  `);
  const endpoints = await db.execute(drizzleSql`
    SELECT COUNT(*) AS cnt FROM webhook_endpoints WHERE active = true
  `);
  const subscriptions = await db.execute(drizzleSql`
    SELECT COUNT(*) AS cnt FROM webhook_subscriptions WHERE active = true
  `);
  return {
    pendingRetries: Number((retries.rows[0] as Record<string, unknown>).cnt ?? 0),
    totalEndpoints: Number((endpoints.rows[0] as Record<string, unknown>).cnt ?? 0),
    totalSubscriptions: Number((subscriptions.rows[0] as Record<string, unknown>).cnt ?? 0),
  };
}
