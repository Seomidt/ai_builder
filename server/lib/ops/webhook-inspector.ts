/**
 * Phase 27 — Webhook Delivery Inspector
 * Delivery success rates, failure history, endpoint reliability, retry counts.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EndpointReliabilityScore {
  endpointId:     string;
  tenantId:       string;
  url:            string;
  active:         boolean;
  totalDeliveries: number;
  successCount:   number;
  failedCount:    number;
  retryingCount:  number;
  successRate:    number; // 0–1
  reliabilityScore: number; // 0–100, weighted
  avgLatencyMs:   number | null;
  lastDeliveryAt: string | null;
  lastFailureAt:  string | null;
}

export interface DeliveryFailureEntry {
  id:              string;
  endpointId:      string;
  tenantId:        string;
  eventType:       string;
  attempts:        number;
  maxAttempts:     number;
  lastError:       string | null;
  httpStatusCode:  number | null;
  lastAttemptAt:   string | null;
  nextRetryAt:     string | null;
  createdAt:       string;
}

export interface WebhookHealthSummary {
  totalEndpoints:      number;
  activeEndpoints:     number;
  deliveriesLast24h:   number;
  successLast24h:      number;
  failedLast24h:       number;
  retryingNow:         number;
  overallSuccessRate:  number;
  avgRetryCount:       number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeNum(v: unknown): number { const n = Number(v); return isNaN(n) ? 0 : n; }

// ── Endpoint Reliability ──────────────────────────────────────────────────────

export async function getEndpointReliabilityScores(
  tenantId?: string,
  limit = 50,
): Promise<EndpointReliabilityScore[]> {
  const filter = tenantId ? `WHERE e.tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";

  const r = await db.execute(sql.raw(`
    SELECT
      e.id              AS endpoint_id,
      e.tenant_id,
      e.url,
      e.active,
      COUNT(d.id)                                                       AS total,
      COUNT(d.id) FILTER (WHERE d.status = 'delivered')                AS success,
      COUNT(d.id) FILTER (WHERE d.status = 'failed')                   AS failed,
      COUNT(d.id) FILTER (WHERE d.status = 'retrying')                 AS retrying,
      AVG(d.delivery_latency_ms) FILTER (WHERE d.status = 'delivered') AS avg_latency,
      MAX(d.delivered_at)                                               AS last_delivery,
      MAX(d.last_attempt_at) FILTER (WHERE d.status='failed')          AS last_failure
    FROM webhook_endpoints e
    LEFT JOIN webhook_deliveries d ON d.endpoint_id = e.id
    ${filter}
    GROUP BY e.id, e.tenant_id, e.url, e.active
    ORDER BY total DESC
    LIMIT ${limit}
  `));

  return (r.rows as any[]).map(row => {
    const total   = safeNum(row.total);
    const success = safeNum(row.success);
    const failed  = safeNum(row.failed);
    const retrying= safeNum(row.retrying);
    const successRate = total > 0 ? success / total : 1;
    // Reliability score: weighted by recency — base success rate + penalty for retrying
    const reliabilityScore = Math.round(successRate * 90 + (total > 0 && row.last_delivery ? 10 : 0));

    return {
      endpointId:       row.endpoint_id,
      tenantId:         row.tenant_id,
      url:              row.url,
      active:           row.active,
      totalDeliveries:  total,
      successCount:     success,
      failedCount:      failed,
      retryingCount:    retrying,
      successRate,
      reliabilityScore: Math.min(100, Math.max(0, reliabilityScore)),
      avgLatencyMs:     row.avg_latency != null ? safeNum(row.avg_latency) : null,
      lastDeliveryAt:   row.last_delivery ? new Date(row.last_delivery).toISOString() : null,
      lastFailureAt:    row.last_failure  ? new Date(row.last_failure).toISOString()  : null,
    };
  });
}

// ── Failure History ───────────────────────────────────────────────────────────

export async function getDeliveryFailureHistory(
  options: {
    tenantId?: string;
    endpointId?: string;
    limit?: number;
  } = {},
): Promise<DeliveryFailureEntry[]> {
  const { tenantId, endpointId, limit = 50 } = options;
  const filters: string[] = ["d.status IN ('failed','retrying')"];
  if (tenantId)   filters.push(`d.tenant_id  = '${tenantId.replace(/'/g, "''")}'`);
  if (endpointId) filters.push(`d.endpoint_id = '${endpointId.replace(/'/g, "''")}'`);
  const where = "WHERE " + filters.join(" AND ");

  const r = await db.execute(sql.raw(`
    SELECT d.id, d.endpoint_id, d.tenant_id, d.event_type,
           d.attempts, d.max_attempts, d.last_error, d.http_status_code,
           d.last_attempt_at, d.next_retry_at, d.created_at
    FROM webhook_deliveries d
    ${where}
    ORDER BY d.last_attempt_at DESC NULLS LAST
    LIMIT ${limit}
  `));

  return (r.rows as any[]).map(row => ({
    id:             row.id,
    endpointId:     row.endpoint_id,
    tenantId:       row.tenant_id,
    eventType:      row.event_type,
    attempts:       safeNum(row.attempts),
    maxAttempts:    safeNum(row.max_attempts),
    lastError:      row.last_error ?? null,
    httpStatusCode: row.http_status_code != null ? safeNum(row.http_status_code) : null,
    lastAttemptAt:  row.last_attempt_at ? new Date(row.last_attempt_at).toISOString() : null,
    nextRetryAt:    row.next_retry_at   ? new Date(row.next_retry_at).toISOString()   : null,
    createdAt:      new Date(row.created_at).toISOString(),
  }));
}

// ── Health Summary ────────────────────────────────────────────────────────────

export async function getWebhookHealthSummary(tenantId?: string): Promise<WebhookHealthSummary> {
  const yesterday = new Date(Date.now() - 86_400_000).toISOString();
  const tFilter   = tenantId ? `AND e.tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";
  const dFilter   = tenantId ? `AND d.tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";

  const [endpointRow, deliveryRow, retryRow] = await Promise.all([
    db.execute(sql.raw(`
      SELECT
        COUNT(*)                         AS total,
        COUNT(*) FILTER (WHERE active)   AS active
      FROM webhook_endpoints e WHERE 1=1 ${tFilter}
    `)),
    db.execute(sql.raw(`
      SELECT
        COUNT(*)                                          AS total_24h,
        COUNT(*) FILTER (WHERE status='delivered')        AS success_24h,
        COUNT(*) FILTER (WHERE status='failed')           AS failed_24h
      FROM webhook_deliveries d
      WHERE created_at >= '${yesterday}' ${dFilter}
    `)),
    db.execute(sql.raw(`
      SELECT
        COUNT(*) FILTER (WHERE status='retrying')          AS retrying_now,
        AVG(attempts) FILTER (WHERE attempts > 1)          AS avg_retries
      FROM webhook_deliveries d WHERE 1=1 ${dFilter}
    `)),
  ]);

  const e  = (endpointRow.rows[0]  as any) ?? {};
  const d  = (deliveryRow.rows[0]  as any) ?? {};
  const rt = (retryRow.rows[0]     as any) ?? {};

  const total24h   = safeNum(d.total_24h);
  const success24h = safeNum(d.success_24h);

  return {
    totalEndpoints:     safeNum(e.total),
    activeEndpoints:    safeNum(e.active),
    deliveriesLast24h:  total24h,
    successLast24h:     success24h,
    failedLast24h:      safeNum(d.failed_24h),
    retryingNow:        safeNum(rt.retrying_now),
    overallSuccessRate: total24h > 0 ? success24h / total24h : 1,
    avgRetryCount:      rt.avg_retries != null ? safeNum(rt.avg_retries) : 0,
  };
}

// ── Retry Counts per Endpoint ─────────────────────────────────────────────────

export interface EndpointRetryCounts {
  endpointId:      string;
  tenantId:        string;
  pendingRetries:  number;
  exhaustedCount:  number;
  maxRetryLatencyMs: number | null;
}

export async function getEndpointRetryCounts(tenantId?: string): Promise<EndpointRetryCounts[]> {
  const filter = tenantId ? `WHERE d.tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";
  const r = await db.execute(sql.raw(`
    SELECT
      d.endpoint_id,
      d.tenant_id,
      COUNT(*) FILTER (WHERE d.status='retrying')                        AS pending_retries,
      COUNT(*) FILTER (WHERE d.status='failed' AND d.attempts>=d.max_attempts) AS exhausted,
      MAX(d.delivery_latency_ms) FILTER (WHERE d.status='retrying')      AS max_latency
    FROM webhook_deliveries d
    ${filter}
    GROUP BY d.endpoint_id, d.tenant_id
    ORDER BY pending_retries DESC
    LIMIT 100
  `));
  return (r.rows as any[]).map(row => ({
    endpointId:         row.endpoint_id,
    tenantId:           row.tenant_id,
    pendingRetries:     safeNum(row.pending_retries),
    exhaustedCount:     safeNum(row.exhausted),
    maxRetryLatencyMs:  row.max_latency != null ? safeNum(row.max_latency) : null,
  }));
}
