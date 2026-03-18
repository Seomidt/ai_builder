/**
 * billing-integrity.ts — Phase 4S Integrity Scan Engine
 *
 * Read-only scan engine that detects inconsistencies across billing canonical data.
 * Never writes to any table. Returns structured findings for display or recovery input.
 *
 * Checks implemented:
 *   1. ai_usage → ai_billing_usage gap scan (unbilled AI calls)
 *   2. storage_usage → storage_billing_usage gap scan (unbilled storage)
 *   3. billing_period_tenant_snapshots vs live aggregates (stale snapshots)
 *   4. invoice total vs line items sum (invoice arithmetic mismatch)
 *   5. ai_billing_usage wallet_status='pending' older than threshold (stuck wallet debits)
 *   6. billing_recovery_runs repeated failure scan (jobs that fail repeatedly)
 *   7. billing_period_tenant_snapshots rebuild health scan (missing or stale snapshots)
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

// ─── Types ────────────────────────────────────────────────────────────────────

export type IntegritySeverity = "critical" | "high" | "medium" | "low" | "info";

export interface IntegrityFinding {
  checkName: string;
  severity: IntegritySeverity;
  description: string;
  affectedCount: number;
  sampleIds: string[];
  metadata: Record<string, unknown>;
}

export interface IntegrityScanResult {
  scanId: string;
  scannedAt: string;
  scopeType: "global" | "tenant" | "billing_period";
  scopeId: string | null;
  totalChecks: number;
  totalFindings: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  findings: IntegrityFinding[];
  durationMs: number;
}

export interface IntegrityScanOptions {
  scopeType?: "global" | "tenant" | "billing_period";
  scopeId?: string | null;
  checks?: Array<
    | "ai_usage_gaps"
    | "storage_usage_gaps"
    | "snapshot_drift"
    | "invoice_arithmetic"
    | "stuck_wallet_debits"
  >;
  stuckWalletThresholdHours?: number;
  snapshotDriftThresholdPct?: number;
  limit?: number;
}

// ─── Individual checks ────────────────────────────────────────────────────────

/**
 * Check 1: Find ai_usage rows that have no corresponding ai_billing_usage row.
 * Excludes failed ai_usage rows (status != 'success') — they are not billed.
 */
async function checkAiUsageBillingGaps(
  scopeType: string,
  scopeId: string | null,
  limit: number,
): Promise<IntegrityFinding> {
  let whereClause = `au.status = 'success' AND au.tenant_id IS NOT NULL`;
  if (scopeType === "tenant" && scopeId) {
    whereClause += ` AND au.tenant_id = '${scopeId.replace(/'/g, "''")}'`;
  }

  const rows = await db.execute(sql.raw(`
    SELECT au.id, au.tenant_id, au.created_at
    FROM ai_usage au
    LEFT JOIN ai_billing_usage abu ON abu.usage_id = au.id
    WHERE ${whereClause}
      AND abu.id IS NULL
    ORDER BY au.created_at DESC
    LIMIT ${limit}
  `));

  const countRow = await db.execute(sql.raw(`
    SELECT COUNT(*) AS cnt
    FROM ai_usage au
    LEFT JOIN ai_billing_usage abu ON abu.usage_id = au.id
    WHERE ${whereClause}
      AND abu.id IS NULL
  `));

  const count = Number((countRow.rows[0] as any)?.cnt ?? 0);
  const sampleIds = rows.rows.slice(0, 10).map((r: any) => r.id as string);

  return {
    checkName: "ai_usage_gaps",
    severity: count > 100 ? "critical" : count > 10 ? "high" : count > 0 ? "medium" : "info",
    description:
      count === 0
        ? "All billed ai_usage rows have corresponding ai_billing_usage rows"
        : `${count} successful ai_usage row(s) found without corresponding ai_billing_usage row`,
    affectedCount: count,
    sampleIds,
    metadata: { scopeType, scopeId, limit },
  };
}

/**
 * Check 2: Find storage_usage rows that have no corresponding storage_billing_usage row.
 */
async function checkStorageUsageBillingGaps(
  scopeType: string,
  scopeId: string | null,
  limit: number,
): Promise<IntegrityFinding> {
  let whereClause = `su.tenant_id IS NOT NULL`;
  if (scopeType === "tenant" && scopeId) {
    whereClause += ` AND su.tenant_id = '${scopeId.replace(/'/g, "''")}'`;
  }

  const rows = await db.execute(sql.raw(`
    SELECT su.id, su.tenant_id, su.created_at
    FROM storage_usage su
    LEFT JOIN storage_billing_usage sbu ON sbu.storage_usage_id = su.id
    WHERE ${whereClause}
      AND sbu.id IS NULL
    ORDER BY su.created_at DESC
    LIMIT ${limit}
  `));

  const countRow = await db.execute(sql.raw(`
    SELECT COUNT(*) AS cnt
    FROM storage_usage su
    LEFT JOIN storage_billing_usage sbu ON sbu.storage_usage_id = su.id
    WHERE ${whereClause}
      AND sbu.id IS NULL
  `));

  const count = Number((countRow.rows[0] as any)?.cnt ?? 0);
  const sampleIds = rows.rows.slice(0, 10).map((r: any) => r.id as string);

  return {
    checkName: "storage_usage_gaps",
    severity: count > 50 ? "critical" : count > 5 ? "high" : count > 0 ? "medium" : "info",
    description:
      count === 0
        ? "All storage_usage rows have corresponding storage_billing_usage rows"
        : `${count} storage_usage row(s) found without corresponding storage_billing_usage row`,
    affectedCount: count,
    sampleIds,
    metadata: { scopeType, scopeId, limit },
  };
}

/**
 * Check 3: Find billing_period_tenant_snapshots where stored totals deviate significantly
 * from live aggregates recomputed on the fly.
 *
 * Note: ai_billing_usage has no billing_period_id FK — the live aggregation is done by
 * joining billing_periods on its period_start/period_end date range.
 */
async function checkSnapshotDrift(
  scopeType: string,
  scopeId: string | null,
  limit: number,
  thresholdPct: number,
): Promise<IntegrityFinding> {
  let snapshotWhere = `1=1`;
  if (scopeType === "tenant" && scopeId) {
    snapshotWhere = `bpts.tenant_id = '${scopeId.replace(/'/g, "''")}'`;
  } else if (scopeType === "billing_period" && scopeId) {
    snapshotWhere = `bpts.billing_period_id = '${scopeId.replace(/'/g, "''")}'`;
  }

  const rows = await db.execute(sql.raw(`
    SELECT
      bpts.id,
      bpts.tenant_id,
      bpts.billing_period_id,
      bpts.customer_price_usd          AS snap_customer_price,
      bpts.request_count               AS snap_request_count,
      COALESCE(live.live_customer_price, 0) AS live_customer_price,
      COALESCE(live.live_request_count, 0)  AS live_request_count,
      ABS(
        COALESCE(live.live_customer_price, 0) - bpts.customer_price_usd
      ) AS price_abs_diff,
      CASE WHEN bpts.customer_price_usd = 0 THEN 0
           ELSE ABS(
             COALESCE(live.live_customer_price, 0) - bpts.customer_price_usd
           ) / bpts.customer_price_usd * 100
      END AS price_diff_pct
    FROM billing_period_tenant_snapshots bpts
    JOIN billing_periods bp ON bp.id = bpts.billing_period_id
    LEFT JOIN (
      SELECT
        abu.tenant_id,
        bp2.id AS billing_period_id,
        SUM(abu.customer_price_usd) AS live_customer_price,
        COUNT(*)                    AS live_request_count
      FROM ai_billing_usage abu
      JOIN billing_periods bp2
        ON abu.created_at >= bp2.period_start
       AND abu.created_at <  bp2.period_end
      GROUP BY abu.tenant_id, bp2.id
    ) live ON live.tenant_id = bpts.tenant_id AND live.billing_period_id = bpts.billing_period_id
    WHERE ${snapshotWhere}
      AND (
        ABS(COALESCE(live.live_customer_price, 0) - bpts.customer_price_usd) > 0.000001
        OR ABS(COALESCE(live.live_request_count, 0) - bpts.request_count) > 0
      )
      AND (
        bpts.customer_price_usd = 0
        OR ABS(
          COALESCE(live.live_customer_price, 0) - bpts.customer_price_usd
        ) / bpts.customer_price_usd * 100 >= ${thresholdPct}
        OR ABS(COALESCE(live.live_request_count, 0) - bpts.request_count) > 0
      )
    ORDER BY price_abs_diff DESC
    LIMIT ${limit}
  `));

  const driftingRows = rows.rows as any[];
  const count = driftingRows.length;
  const sampleIds = driftingRows.slice(0, 10).map((r: any) => r.id as string);

  return {
    checkName: "snapshot_drift",
    severity: count > 10 ? "high" : count > 0 ? "medium" : "info",
    description:
      count === 0
        ? `No billing_period_tenant_snapshots deviate from live aggregates (threshold ${thresholdPct}%)`
        : `${count} snapshot(s) deviate from live ai_billing_usage aggregates by >= ${thresholdPct}%`,
    affectedCount: count,
    sampleIds,
    metadata: {
      scopeType,
      scopeId,
      thresholdPct,
      limit,
      samples: driftingRows.slice(0, 3).map((r: any) => ({
        snapshotId: r.id,
        tenantId: r.tenant_id,
        snapCustomerPrice: r.snap_customer_price,
        liveCustomerPrice: r.live_customer_price,
        priceDiffPct: r.price_diff_pct,
      })),
    },
  };
}

/**
 * Check 4: Validate invoice subtotal and total match sum of line items.
 */
async function checkInvoiceArithmetic(
  scopeType: string,
  scopeId: string | null,
  limit: number,
): Promise<IntegrityFinding> {
  let whereClause = `i.status != 'void'`;
  if (scopeType === "tenant" && scopeId) {
    whereClause += ` AND i.tenant_id = '${scopeId.replace(/'/g, "''")}'`;
  } else if (scopeType === "billing_period" && scopeId) {
    whereClause += ` AND i.billing_period_id = '${scopeId.replace(/'/g, "''")}'`;
  }

  const rows = await db.execute(sql.raw(`
    SELECT
      i.id,
      i.tenant_id,
      i.invoice_number,
      i.status,
      i.subtotal_usd,
      i.total_usd,
      COALESCE(ili_agg.line_sum, 0) AS computed_line_sum,
      ABS(i.subtotal_usd - COALESCE(ili_agg.line_sum, 0)) AS subtotal_diff
    FROM invoices i
    LEFT JOIN (
      SELECT invoice_id, SUM(line_total_usd) AS line_sum
      FROM invoice_line_items
      GROUP BY invoice_id
    ) ili_agg ON ili_agg.invoice_id = i.id
    WHERE ${whereClause}
      AND ABS(i.subtotal_usd - COALESCE(ili_agg.line_sum, 0)) > 0.000001
    ORDER BY subtotal_diff DESC
    LIMIT ${limit}
  `));

  const mismatchedRows = rows.rows as any[];
  const count = mismatchedRows.length;
  const sampleIds = mismatchedRows.slice(0, 10).map((r: any) => r.id as string);

  return {
    checkName: "invoice_arithmetic",
    severity: count > 5 ? "critical" : count > 0 ? "high" : "info",
    description:
      count === 0
        ? "All invoice subtotals match their line item sums"
        : `${count} invoice(s) have subtotal_usd that does not match sum of line items`,
    affectedCount: count,
    sampleIds,
    metadata: {
      scopeType,
      scopeId,
      limit,
      samples: mismatchedRows.slice(0, 3).map((r: any) => ({
        invoiceId: r.id,
        invoiceNumber: r.invoice_number,
        status: r.status,
        subtotalUsd: r.subtotal_usd,
        computedLineSum: r.computed_line_sum,
        diff: r.subtotal_diff,
      })),
    },
  };
}

/**
 * Check 5: Find ai_billing_usage rows stuck in wallet_status='pending' older than threshold.
 */
async function checkStuckWalletDebits(
  scopeType: string,
  scopeId: string | null,
  limit: number,
  thresholdHours: number,
): Promise<IntegrityFinding> {
  let whereClause = `abu.wallet_status = 'pending'`;
  if (scopeType === "tenant" && scopeId) {
    whereClause += ` AND abu.tenant_id = '${scopeId.replace(/'/g, "''")}'`;
  }

  const rows = await db.execute(sql.raw(`
    SELECT abu.id, abu.tenant_id, abu.created_at, abu.customer_price_usd
    FROM ai_billing_usage abu
    WHERE ${whereClause}
      AND abu.created_at < NOW() - INTERVAL '${thresholdHours} hours'
    ORDER BY abu.created_at ASC
    LIMIT ${limit}
  `));

  const countRow = await db.execute(sql.raw(`
    SELECT COUNT(*) AS cnt, COALESCE(SUM(customer_price_usd), 0) AS total_usd
    FROM ai_billing_usage abu
    WHERE ${whereClause}
      AND created_at < NOW() - INTERVAL '${thresholdHours} hours'
  `));

  const count = Number((countRow.rows[0] as any)?.cnt ?? 0);
  const totalUsd = (countRow.rows[0] as any)?.total_usd ?? "0";
  const sampleIds = rows.rows.slice(0, 10).map((r: any) => r.id as string);

  return {
    checkName: "stuck_wallet_debits",
    severity: count > 50 ? "critical" : count > 5 ? "high" : count > 0 ? "medium" : "info",
    description:
      count === 0
        ? `No ai_billing_usage rows stuck as 'pending' wallet_status beyond ${thresholdHours}h threshold`
        : `${count} ai_billing_usage row(s) stuck in wallet_status='pending' for > ${thresholdHours}h (total $${Number(totalUsd).toFixed(6)})`,
    affectedCount: count,
    sampleIds,
    metadata: { scopeType, scopeId, thresholdHours, stuckTotalUsd: totalUsd, limit },
  };
}

// ─── Main scan function ───────────────────────────────────────────────────────

/**
 * runBillingIntegrityScan — run all (or a subset of) integrity checks.
 * Returns a structured scan result. Always read-only.
 */
export async function runBillingIntegrityScan(
  options: IntegrityScanOptions = {},
): Promise<IntegrityScanResult> {
  const {
    scopeType = "global",
    scopeId = null,
    checks = ["ai_usage_gaps", "storage_usage_gaps", "snapshot_drift", "invoice_arithmetic", "stuck_wallet_debits"],
    stuckWalletThresholdHours = 24,
    snapshotDriftThresholdPct = 1.0,
    limit = 100,
  } = options;

  const startMs = Date.now();
  const findings: IntegrityFinding[] = [];

  if (checks.includes("ai_usage_gaps")) {
    findings.push(await checkAiUsageBillingGaps(scopeType, scopeId, limit));
  }
  if (checks.includes("storage_usage_gaps")) {
    findings.push(await checkStorageUsageBillingGaps(scopeType, scopeId, limit));
  }
  if (checks.includes("snapshot_drift")) {
    findings.push(await checkSnapshotDrift(scopeType, scopeId, limit, snapshotDriftThresholdPct));
  }
  if (checks.includes("invoice_arithmetic")) {
    findings.push(await checkInvoiceArithmetic(scopeType, scopeId, limit));
  }
  if (checks.includes("stuck_wallet_debits")) {
    findings.push(await checkStuckWalletDebits(scopeType, scopeId, limit, stuckWalletThresholdHours));
  }

  const durationMs = Date.now() - startMs;
  const totalFindings = findings.filter((f) => f.severity !== "info").length;

  return {
    scanId: crypto.randomUUID(),
    scannedAt: new Date().toISOString(),
    scopeType,
    scopeId,
    totalChecks: findings.length,
    totalFindings,
    criticalCount: findings.filter((f) => f.severity === "critical").length,
    highCount: findings.filter((f) => f.severity === "high").length,
    mediumCount: findings.filter((f) => f.severity === "medium").length,
    lowCount: findings.filter((f) => f.severity === "low").length,
    findings,
    durationMs,
  };
}

// ─── Predefined job scan functions ───────────────────────────────────────────

/**
 * runRepeatRecoveryFailureScan — scan billing_recovery_runs for tenants/types
 * that have failed repeatedly. Detect systemic issues, not isolated failures.
 * Scan/detect only — never repairs.
 */
export async function runRepeatRecoveryFailureScan(
  minFailureCount = 3,
  windowHours = 72,
  limit = 50,
): Promise<{
  totalProblematic: number;
  findings: Array<{
    recoveryType: string;
    scopeType: string;
    scopeId: string | null;
    failureCount: number;
    lastFailedAt: string;
    sampleRunIds: string[];
  }>;
  scannedAt: string;
  durationMs: number;
}> {
  const startMs = Date.now();

  const rows = await db.execute(sql.raw(`
    SELECT
      recovery_type,
      scope_type,
      scope_id,
      COUNT(*) AS failure_count,
      MAX(started_at) AS last_failed_at,
      ARRAY_AGG(id ORDER BY started_at DESC) AS run_ids
    FROM billing_recovery_runs
    WHERE status = 'failed'
      AND started_at >= NOW() - INTERVAL '${windowHours} hours'
    GROUP BY recovery_type, scope_type, scope_id
    HAVING COUNT(*) >= ${minFailureCount}
    ORDER BY failure_count DESC
    LIMIT ${limit}
  `));

  const findings = (rows.rows as any[]).map((r: any) => ({
    recoveryType: r.recovery_type,
    scopeType: r.scope_type,
    scopeId: r.scope_id ?? null,
    failureCount: Number(r.failure_count),
    lastFailedAt: r.last_failed_at?.toISOString?.() ?? String(r.last_failed_at),
    sampleRunIds: (r.run_ids ?? []).slice(0, 5),
  }));

  return {
    totalProblematic: findings.length,
    findings,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
  };
}

/**
 * runSnapshotRebuildHealthScan — scan billing_period_tenant_snapshots for stale or missing
 * snapshot rows relative to closed billing periods. Scan/detect only — never repairs.
 */
export async function runSnapshotRebuildHealthScan(
  limit = 100,
): Promise<{
  missingSnapshotsCount: number;
  staleSnapshotsCount: number;
  missingSnapshots: Array<{ tenantId: string; billingPeriodId: string; periodStatus: string }>;
  staleSnapshots: Array<{
    snapshotId: string;
    tenantId: string;
    billingPeriodId: string;
    snapshotAge: string;
  }>;
  scannedAt: string;
  durationMs: number;
}> {
  const startMs = Date.now();

  const missingRows = await db.execute(sql.raw(`
    SELECT DISTINCT
      abu.tenant_id,
      bp.id AS billing_period_id,
      bp.status AS period_status
    FROM ai_billing_usage abu
    JOIN billing_periods bp
      ON abu.created_at >= bp.period_start
     AND abu.created_at <  bp.period_end
    LEFT JOIN billing_period_tenant_snapshots bpts
      ON bpts.tenant_id = abu.tenant_id AND bpts.billing_period_id = bp.id
    WHERE bp.status IN ('closed','closing')
      AND bpts.id IS NULL
    ORDER BY bp.id DESC
    LIMIT ${limit}
  `));

  const staleRows = await db.execute(sql.raw(`
    SELECT
      bpts.id,
      bpts.tenant_id,
      bpts.billing_period_id,
      bpts.created_at,
      NOW() - bpts.created_at AS snapshot_age
    FROM billing_period_tenant_snapshots bpts
    JOIN billing_periods bp ON bp.id = bpts.billing_period_id
    WHERE bp.status = 'open'
      AND bpts.created_at < NOW() - INTERVAL '25 hours'
    ORDER BY bpts.created_at ASC
    LIMIT ${limit}
  `));

  const missingSnapshots = (missingRows.rows as any[]).map((r: any) => ({
    tenantId: r.tenant_id,
    billingPeriodId: r.billing_period_id,
    periodStatus: r.period_status,
  }));

  const staleSnapshots = (staleRows.rows as any[]).map((r: any) => ({
    snapshotId: r.id,
    tenantId: r.tenant_id,
    billingPeriodId: r.billing_period_id,
    snapshotAge: String(r.snapshot_age),
  }));

  return {
    missingSnapshotsCount: missingSnapshots.length,
    staleSnapshotsCount: staleSnapshots.length,
    missingSnapshots,
    staleSnapshots,
    scannedAt: new Date().toISOString(),
    durationMs: Date.now() - startMs,
  };
}
