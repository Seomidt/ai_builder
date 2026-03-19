/**
 * Phase 16 — AI Cost Governance: Usage Snapshotter
 *
 * Aggregates raw AI usage data and writes periodic snapshots to
 * tenant_ai_usage_snapshots. Snapshots power budget-checker and
 * anomaly-detector without repeated full-table scans.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";
import type { PeriodType } from "./budget-checker";
import { currentPeriodBounds } from "./budget-checker";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ModelUsageEntry {
  tokens:       number;
  costUsdCents: number;
  requests:     number;
}

export interface UsageSnapshotData {
  organizationId:     string;
  periodType:         PeriodType;
  periodStart:        Date;
  periodEnd:          Date;
  totalTokens:        bigint;
  promptTokens:       bigint;
  completionTokens:   bigint;
  totalCostUsdCents:  bigint;
  requestCount:       number;
  failedRequestCount: number;
  modelBreakdown:     Record<string, ModelUsageEntry>;
}

export interface SnapshotResult {
  organizationId: string;
  snapshotId:     string;
  isNew:          boolean;
}

// ─── Aggregation helpers ──────────────────────────────────────────────────────

/**
 * Read aggregated AI usage from ai_usage / ai_billing_usage for a tenant+period.
 * Falls back to zeros if no usage table exists yet.
 */
async function aggregateUsage(
  organizationId: string,
  periodStart:    Date,
  periodEnd:      Date,
): Promise<Omit<UsageSnapshotData, "organizationId" | "periodType" | "periodStart" | "periodEnd">> {
  let totalTokens       = 0n;
  let promptTokens      = 0n;
  let completionTokens  = 0n;
  let totalCostUsdCents = 0n;
  let requestCount      = 0;
  let failedRequestCount = 0;
  const modelBreakdown: Record<string, ModelUsageEntry> = {};

  try {
    // Aggregate from ai_billing_usage if it exists
    const billingRows = await db.execute(sql`
      SELECT
        COALESCE(model_id, 'unknown')                AS model_id,
        COALESCE(SUM(input_tokens), 0)               AS prompt_tokens,
        COALESCE(SUM(output_tokens), 0)              AS completion_tokens,
        COALESCE(SUM(input_tokens + output_tokens), 0) AS total_tokens,
        COALESCE(SUM(cost_usd_micros / 10), 0)       AS cost_usd_cents,
        COUNT(*)                                     AS request_count
      FROM   ai_billing_usage
      WHERE  organization_id = ${organizationId}
        AND  billed_at      >= ${periodStart.toISOString()}
        AND  billed_at      <  ${periodEnd.toISOString()}
      GROUP  BY model_id
    `);

    for (const row of billingRows.rows) {
      const r = row as Record<string, string | number>;
      const modelId    = String(r.model_id ?? "unknown");
      const pt         = BigInt(r.prompt_tokens     ?? 0);
      const ct         = BigInt(r.completion_tokens ?? 0);
      const tt         = BigInt(r.total_tokens      ?? 0);
      const cost       = BigInt(r.cost_usd_cents    ?? 0);
      const reqs       = Number(r.request_count     ?? 0);

      promptTokens      += pt;
      completionTokens  += ct;
      totalTokens       += tt;
      totalCostUsdCents += cost;
      requestCount      += reqs;

      modelBreakdown[modelId] = {
        tokens:       Number(tt),
        costUsdCents: Number(cost),
        requests:     reqs,
      };
    }
  } catch {
    // ai_billing_usage may not exist in all environments — degrade gracefully
  }

  // Count failed requests from ai_runs if available
  try {
    const failedRows = await db.execute(sql`
      SELECT COUNT(*) AS cnt
      FROM   ai_runs
      WHERE  organization_id = ${organizationId}
        AND  status          = 'failed'
        AND  created_at     >= ${periodStart.toISOString()}
        AND  created_at     <  ${periodEnd.toISOString()}
    `);
    const fr = failedRows.rows[0] as { cnt: string | number } | undefined;
    if (fr) failedRequestCount = Number(fr.cnt);
  } catch {
    // ai_runs may not exist
  }

  return {
    totalTokens,
    promptTokens,
    completionTokens,
    totalCostUsdCents,
    requestCount,
    failedRequestCount,
    modelBreakdown,
  };
}

// ─── Core snapshot operations ─────────────────────────────────────────────────

/**
 * Take (or refresh) a usage snapshot for a single tenant + period.
 * If a snapshot already exists for the period, it is updated (upsert semantics).
 */
export async function snapshotTenantUsage(
  organizationId: string,
  periodType:     PeriodType = "monthly",
  overrideBounds?: { start: Date; end: Date },
): Promise<SnapshotResult> {
  if (!organizationId?.trim()) throw new Error("organizationId is required");

  const bounds     = overrideBounds ?? currentPeriodBounds(periodType);
  const { start, end } = bounds;

  const usage = await aggregateUsage(organizationId, start, end);

  // Upsert: if snapshot exists for (org, period_type, period_start) → update, else insert
  const existing = await db.execute(sql`
    SELECT id FROM tenant_ai_usage_snapshots
    WHERE  organization_id = ${organizationId}
      AND  period_type     = ${periodType}
      AND  period_start    = ${start.toISOString()}
    LIMIT  1
  `);

  const modelJson = JSON.stringify(usage.modelBreakdown);

  if (existing.rows.length > 0) {
    const existingId = (existing.rows[0] as { id: string }).id;
    await db.execute(sql`
      UPDATE tenant_ai_usage_snapshots SET
        period_end           = ${end.toISOString()},
        total_tokens         = ${usage.totalTokens.toString()},
        prompt_tokens        = ${usage.promptTokens.toString()},
        completion_tokens    = ${usage.completionTokens.toString()},
        total_cost_usd_cents = ${usage.totalCostUsdCents.toString()},
        request_count        = ${usage.requestCount},
        failed_request_count = ${usage.failedRequestCount},
        model_breakdown      = ${modelJson}::jsonb,
        snapshot_at          = NOW()
      WHERE id = ${existingId}
    `);
    return { organizationId, snapshotId: existingId, isNew: false };
  }

  const insertResult = await db.execute(sql`
    INSERT INTO tenant_ai_usage_snapshots
      (organization_id, period_type, period_start, period_end,
       total_tokens, prompt_tokens, completion_tokens,
       total_cost_usd_cents, request_count, failed_request_count, model_breakdown)
    VALUES
      (${organizationId}, ${periodType}, ${start.toISOString()}, ${end.toISOString()},
       ${usage.totalTokens.toString()}, ${usage.promptTokens.toString()},
       ${usage.completionTokens.toString()}, ${usage.totalCostUsdCents.toString()},
       ${usage.requestCount}, ${usage.failedRequestCount}, ${modelJson}::jsonb)
    RETURNING id
  `);

  const snapshotId = (insertResult.rows[0] as { id: string }).id;
  return { organizationId, snapshotId, isNew: true };
}

/**
 * Snapshot all tenants that have at least one active budget.
 */
export async function snapshotAllTenants(
  periodType: PeriodType = "monthly",
): Promise<{ results: SnapshotResult[]; errors: Array<{ organizationId: string; error: string }> }> {
  const orgRows = await db.execute(sql`
    SELECT DISTINCT organization_id
    FROM   tenant_ai_budgets
    WHERE  is_active = true
    ORDER  BY organization_id
  `);

  const results: SnapshotResult[]                                      = [];
  const errors:  Array<{ organizationId: string; error: string }>      = [];

  for (const row of orgRows.rows) {
    const orgId = (row as { organization_id: string }).organization_id;
    try {
      const result = await snapshotTenantUsage(orgId, periodType);
      results.push(result);
    } catch (err) {
      errors.push({
        organizationId: orgId,
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  return { results, errors };
}

/**
 * Get the most recent snapshot for a tenant.
 */
export async function getLatestSnapshot(
  organizationId: string,
  periodType: PeriodType = "monthly",
): Promise<UsageSnapshotData | null> {
  if (!organizationId?.trim()) return null;

  const rows = await db.execute(sql`
    SELECT *
    FROM   tenant_ai_usage_snapshots
    WHERE  organization_id = ${organizationId}
      AND  period_type     = ${periodType}
    ORDER  BY snapshot_at DESC
    LIMIT  1
  `);

  if (rows.rows.length === 0) return null;

  const r = rows.rows[0] as Record<string, unknown>;
  return {
    organizationId:     String(r.organization_id),
    periodType:         String(r.period_type) as PeriodType,
    periodStart:        new Date(String(r.period_start)),
    periodEnd:          new Date(String(r.period_end)),
    totalTokens:        BigInt(String(r.total_tokens ?? 0)),
    promptTokens:       BigInt(String(r.prompt_tokens ?? 0)),
    completionTokens:   BigInt(String(r.completion_tokens ?? 0)),
    totalCostUsdCents:  BigInt(String(r.total_cost_usd_cents ?? 0)),
    requestCount:       Number(r.request_count ?? 0),
    failedRequestCount: Number(r.failed_request_count ?? 0),
    modelBreakdown:     (r.model_breakdown as Record<string, ModelUsageEntry>) ?? {},
  };
}
