/**
 * Phase 29 — Webhook Replay
 * Replay failed webhook deliveries safely with idempotency guards.
 */

import { Client } from "pg";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface FailedDelivery {
  id:             string;
  endpointId:     string;
  tenantId:       string;
  eventType:      string;
  attempts:       number;
  maxAttempts:    number;
  lastAttemptAt:  string | null;
  lastError:      string | null;
  httpStatusCode: number | null;
  createdAt:      string;
}

export interface ReplayResult {
  deliveryId:  string;
  action:      "queued_for_replay" | "skipped" | "exhausted" | "not_found";
  success:     boolean;
  reason:      string;
}

export interface ReplayBatchResult {
  totalFailed:   number;
  replayed:      number;
  skipped:       number;
  exhausted:     number;
  results:       ReplayResult[];
  checkedAt:     string;
}

export interface WebhookEventHistoryEntry {
  id:            string;
  endpointId:    string;
  tenantId:      string;
  eventType:     string;
  status:        string;
  attempts:      number;
  deliveredAt:   string | null;
  createdAt:     string;
}

// ── DB helper ─────────────────────────────────────────────────────────────────

function getClient(): Client {
  return new Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ── List failed deliveries ────────────────────────────────────────────────────

export async function listFailedDeliveries(
  tenantId?: string,
  limit = 100,
): Promise<FailedDelivery[]> {
  const client  = getClient();
  await client.connect();
  const tFilter = tenantId ? `AND tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";

  try {
    const res = await client.query<any>(`
      SELECT
        id,
        endpoint_id,
        tenant_id,
        event_type,
        attempts,
        max_attempts,
        last_attempt_at::text  AS last_attempt_at,
        last_error,
        http_status_code,
        created_at::text       AS created_at
      FROM webhook_deliveries
      WHERE status IN ('failed', 'retrying')
        ${tFilter}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);

    return res.rows.map((r: any) => ({
      id:             r.id,
      endpointId:     r.endpoint_id,
      tenantId:       r.tenant_id,
      eventType:      r.event_type,
      attempts:       parseInt(r.attempts, 10),
      maxAttempts:    parseInt(r.max_attempts, 10),
      lastAttemptAt:  r.last_attempt_at ?? null,
      lastError:      r.last_error ?? null,
      httpStatusCode: r.http_status_code != null ? parseInt(r.http_status_code, 10) : null,
      createdAt:      r.created_at,
    }));
  } finally {
    await client.end();
  }
}

// ── Replay a single delivery ──────────────────────────────────────────────────

export async function replayDelivery(
  deliveryId: string,
  dryRun = false,
): Promise<ReplayResult> {
  const client = getClient();
  await client.connect();

  try {
    const r = await client.query<any>(
      `SELECT id, status, attempts, max_attempts FROM webhook_deliveries WHERE id = $1`,
      [deliveryId],
    );

    if (!r.rows[0]) {
      return { deliveryId, action: "not_found", success: false, reason: "Delivery not found" };
    }

    const { status, attempts, max_attempts } = r.rows[0];

    // Already delivered — skip
    if (status === "delivered") {
      return { deliveryId, action: "skipped", success: false, reason: "Already delivered" };
    }

    // Exhausted — bump max_attempts by 3 to allow retry
    if (parseInt(attempts, 10) >= parseInt(max_attempts, 10)) {
      if (!dryRun) {
        await client.query(
          `UPDATE webhook_deliveries
           SET status = 'retrying',
               max_attempts = attempts + 3,
               next_retry_at = NOW()
           WHERE id = $1`,
          [deliveryId],
        );
      }
      return { deliveryId, action: "queued_for_replay", success: true, reason: "Max attempts extended — queued for replay" };
    }

    // Normal retry
    if (!dryRun) {
      await client.query(
        `UPDATE webhook_deliveries
         SET status = 'retrying', next_retry_at = NOW()
         WHERE id = $1`,
        [deliveryId],
      );
    }

    return { deliveryId, action: "queued_for_replay", success: true, reason: `Queued for replay (attempt ${attempts}/${max_attempts})` };
  } finally {
    await client.end();
  }
}

// ── Bulk replay ───────────────────────────────────────────────────────────────

export async function replayFailedDeliveries(
  tenantId?: string,
  limit = 50,
  dryRun = false,
): Promise<ReplayBatchResult> {
  const failed  = await listFailedDeliveries(tenantId, limit);
  const results: ReplayResult[] = [];

  for (const d of failed) {
    const r = await replayDelivery(d.id, dryRun);
    results.push(r);
  }

  return {
    totalFailed: failed.length,
    replayed:    results.filter(r => r.action === "queued_for_replay").length,
    skipped:     results.filter(r => r.action === "skipped").length,
    exhausted:   results.filter(r => r.action === "exhausted").length,
    results,
    checkedAt:   new Date().toISOString(),
  };
}

// ── Event history ─────────────────────────────────────────────────────────────

export async function getWebhookEventHistory(
  tenantId?: string,
  windowHours = 24,
  limit = 200,
): Promise<WebhookEventHistoryEntry[]> {
  const client  = getClient();
  await client.connect();
  const cutoff  = new Date(Date.now() - windowHours * 3_600_000).toISOString();
  const tFilter = tenantId ? `AND tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";

  try {
    const res = await client.query<any>(`
      SELECT
        id,
        endpoint_id,
        tenant_id,
        event_type,
        status,
        attempts,
        delivered_at::text AS delivered_at,
        created_at::text   AS created_at
      FROM webhook_deliveries
      WHERE created_at >= '${cutoff}' ${tFilter}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `);

    return res.rows.map((r: any) => ({
      id:          r.id,
      endpointId:  r.endpoint_id,
      tenantId:    r.tenant_id,
      eventType:   r.event_type,
      status:      r.status,
      attempts:    parseInt(r.attempts, 10),
      deliveredAt: r.delivered_at ?? null,
      createdAt:   r.created_at,
    }));
  } finally {
    await client.end();
  }
}

// ── Replay health summary ─────────────────────────────────────────────────────

export async function getWebhookReplayHealth(): Promise<{
  totalFailed:    number;
  replayEligible: number;
  exhausted:      number;
  checkedAt:      string;
}> {
  const client = getClient();
  await client.connect();

  try {
    const r = await client.query<any>(`
      SELECT
        COUNT(*)                                                      AS total_failed,
        COUNT(*) FILTER (WHERE attempts < max_attempts)              AS replay_eligible,
        COUNT(*) FILTER (WHERE attempts >= max_attempts)             AS exhausted
      FROM webhook_deliveries
      WHERE status IN ('failed','retrying')
    `);

    const row = r.rows[0] as any ?? {};
    return {
      totalFailed:    parseInt(row.total_failed   ?? "0", 10),
      replayEligible: parseInt(row.replay_eligible ?? "0", 10),
      exhausted:      parseInt(row.exhausted       ?? "0", 10),
      checkedAt:      new Date().toISOString(),
    };
  } finally {
    await client.end();
  }
}
