/**
 * Margin Anomaly Detection — Phase 4I
 *
 * SERVER-ONLY: Detection-only helpers for margin anomalies.
 *
 * DESIGN APPROACH:
 *   This module returns structured anomaly objects without a dedicated new DB table.
 *   Anomalies are detected ad-hoc from ai_billing_usage and returned to the caller.
 *   Rationale: In Phase 4I, anomalies are informational — not yet persisted or alerted.
 *   The billing_audit_findings table (Phase 4E) is the appropriate persistence target
 *   in a future phase that wires these detections into the audit system.
 *
 * DETECTION ONLY:
 *   - Does not mutate ai_billing_usage
 *   - Does not mutate pricing versions
 *   - Does not recompute values from current pricing configs
 *   - All values derive from canonical billing rows
 *
 * Anomaly types:
 *   'negative_margin_detected'      — margin_usd < 0 (cost exceeds revenue)
 *   'zero_revenue_nonzero_cost'     — customer_price_usd = 0, provider_cost_usd > 0
 *   'unusually_low_margin'          — margin_pct below configured threshold
 *   'unusually_high_margin'         — margin_pct above configured threshold
 *   'tenant_margin_drift'           — tenant margin shifted significantly vs reference
 *   'provider_model_margin_drift'   — provider+model margin shifted vs reference
 */

import { and, gte, lt, sql, eq } from "drizzle-orm";
import { db } from "../../db";
import { aiBillingUsage } from "@shared/schema";

// ─── Anomaly Types ────────────────────────────────────────────────────────────

export type MarginAnomalyType =
  | "negative_margin_detected"
  | "zero_revenue_nonzero_cost"
  | "unusually_low_margin"
  | "unusually_high_margin"
  | "tenant_margin_drift"
  | "provider_model_margin_drift";

export type MarginAnomalySeverity = "info" | "warning" | "critical";

export interface MarginAnomaly {
  type: MarginAnomalyType;
  severity: MarginAnomalySeverity;
  tenantId: string | null;
  provider: string | null;
  model: string | null;
  feature: string | null;
  billingUsageId?: string | null;
  detectedMarginUsd?: number | null;
  detectedMarginPct?: number | null;
  referencePct?: number | null;
  message: string;
  detectedAt: Date;
}

// ─── Thresholds ───────────────────────────────────────────────────────────────

/** Below this margin % — "unusually low margin" warning */
export const UNUSUALLY_LOW_MARGIN_PCT_THRESHOLD = 0.1; // 10%

/** Above this margin % — "unusually high margin" info */
export const UNUSUALLY_HIGH_MARGIN_PCT_THRESHOLD = 0.95; // 95%

/** Drift threshold vs reference margin (absolute percentage points) */
export const MARGIN_DRIFT_THRESHOLD_PCT = 0.2; // 20 percentage points

// ─── Request-Level Anomaly Detection ─────────────────────────────────────────

/**
 * Detect negative margin rows in ai_billing_usage for a given period.
 * Negative margin = provider cost exceeds customer price (revenue loss).
 */
export async function detectNegativeMarginRows(
  periodStart?: Date,
  periodEnd?: Date,
  tenantId?: string,
): Promise<MarginAnomaly[]> {
  const conditions: Parameters<typeof and>[0][] = [
    sql`margin_usd::numeric < 0`,
  ];
  if (periodStart) conditions.push(gte(aiBillingUsage.createdAt, periodStart));
  if (periodEnd) conditions.push(lt(aiBillingUsage.createdAt, periodEnd));
  if (tenantId) conditions.push(eq(aiBillingUsage.tenantId, tenantId));

  const rows = await db
    .select({
      id: aiBillingUsage.id,
      tenantId: aiBillingUsage.tenantId,
      provider: aiBillingUsage.provider,
      model: aiBillingUsage.model,
      feature: aiBillingUsage.feature,
      providerCostUsd: aiBillingUsage.providerCostUsd,
      customerPriceUsd: aiBillingUsage.customerPriceUsd,
      marginUsd: aiBillingUsage.marginUsd,
    })
    .from(aiBillingUsage)
    .where(and(...conditions))
    .limit(500);

  return rows.map((row) => {
    const margin = Number(row.marginUsd);
    const customerPrice = Number(row.customerPriceUsd);
    return {
      type: "negative_margin_detected" as MarginAnomalyType,
      severity: "critical" as MarginAnomalySeverity,
      tenantId: row.tenantId,
      provider: row.provider,
      model: row.model,
      feature: row.feature,
      billingUsageId: row.id,
      detectedMarginUsd: margin,
      detectedMarginPct: customerPrice > 0 ? margin / customerPrice : null,
      message: `Negative margin detected: margin_usd=${margin.toFixed(8)}, provider_cost=${Number(row.providerCostUsd).toFixed(8)}, customer_price=${customerPrice.toFixed(8)}`,
      detectedAt: new Date(),
    };
  });
}

/**
 * Detect zero-revenue rows with non-zero provider cost.
 * These represent cost leakage — provider is charged but no customer revenue.
 */
export async function detectZeroRevenueNonzeroCost(
  periodStart?: Date,
  periodEnd?: Date,
  tenantId?: string,
): Promise<MarginAnomaly[]> {
  const conditions: Parameters<typeof and>[0][] = [
    sql`customer_price_usd::numeric = 0`,
    sql`provider_cost_usd::numeric > 0`,
  ];
  if (periodStart) conditions.push(gte(aiBillingUsage.createdAt, periodStart));
  if (periodEnd) conditions.push(lt(aiBillingUsage.createdAt, periodEnd));
  if (tenantId) conditions.push(eq(aiBillingUsage.tenantId, tenantId));

  const rows = await db
    .select({
      id: aiBillingUsage.id,
      tenantId: aiBillingUsage.tenantId,
      provider: aiBillingUsage.provider,
      model: aiBillingUsage.model,
      feature: aiBillingUsage.feature,
      providerCostUsd: aiBillingUsage.providerCostUsd,
    })
    .from(aiBillingUsage)
    .where(and(...conditions))
    .limit(500);

  return rows.map((row) => ({
    type: "zero_revenue_nonzero_cost" as MarginAnomalyType,
    severity: "warning" as MarginAnomalySeverity,
    tenantId: row.tenantId,
    provider: row.provider,
    model: row.model,
    feature: row.feature,
    billingUsageId: row.id,
    detectedMarginUsd: -Number(row.providerCostUsd),
    detectedMarginPct: null,
    message: `Zero revenue with non-zero provider cost: provider_cost=${Number(row.providerCostUsd).toFixed(8)}`,
    detectedAt: new Date(),
  }));
}

// ─── Aggregate Anomaly Detection ──────────────────────────────────────────────

interface AggMarginRow {
  tenantId: string | null;
  provider: string | null;
  model: string | null;
  feature: string | null;
  totalProviderCost: string;
  totalCustomerPrice: string;
  totalMargin: string;
  rowCount: string;
}

/**
 * Detect unusually low or high margin percentage in aggregated billing groups.
 * Groups by (tenant, feature, provider, model).
 */
export async function detectUnusualMarginPct(
  periodStart?: Date,
  periodEnd?: Date,
): Promise<MarginAnomaly[]> {
  const conditions: Parameters<typeof and>[0][] = [];
  if (periodStart) conditions.push(gte(aiBillingUsage.createdAt, periodStart));
  if (periodEnd) conditions.push(lt(aiBillingUsage.createdAt, periodEnd));

  const rows = await db
    .select({
      tenantId: aiBillingUsage.tenantId,
      provider: aiBillingUsage.provider,
      model: aiBillingUsage.model,
      feature: aiBillingUsage.feature,
      totalProviderCost: sql<string>`COALESCE(SUM(provider_cost_usd::numeric), 0)`,
      totalCustomerPrice: sql<string>`COALESCE(SUM(customer_price_usd::numeric), 0)`,
      totalMargin: sql<string>`COALESCE(SUM(margin_usd::numeric), 0)`,
      rowCount: sql<string>`COUNT(*)`,
    })
    .from(aiBillingUsage)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .groupBy(
      aiBillingUsage.tenantId,
      aiBillingUsage.feature,
      aiBillingUsage.provider,
      aiBillingUsage.model,
    )
    .limit(1000) as AggMarginRow[];

  const anomalies: MarginAnomaly[] = [];
  for (const row of rows) {
    const customerPrice = Number(row.totalCustomerPrice);
    const margin = Number(row.totalMargin);
    if (customerPrice <= 0) continue;

    const marginPct = margin / customerPrice;

    if (marginPct < UNUSUALLY_LOW_MARGIN_PCT_THRESHOLD) {
      anomalies.push({
        type: "unusually_low_margin",
        severity: marginPct < 0 ? "critical" : "warning",
        tenantId: row.tenantId,
        provider: row.provider,
        model: row.model,
        feature: row.feature,
        detectedMarginPct: marginPct,
        message: `Unusually low margin: ${(marginPct * 100).toFixed(2)}% (threshold: ${(UNUSUALLY_LOW_MARGIN_PCT_THRESHOLD * 100).toFixed(0)}%) across ${row.rowCount} rows`,
        detectedAt: new Date(),
      });
    } else if (marginPct > UNUSUALLY_HIGH_MARGIN_PCT_THRESHOLD) {
      anomalies.push({
        type: "unusually_high_margin",
        severity: "info",
        tenantId: row.tenantId,
        provider: row.provider,
        model: row.model,
        feature: row.feature,
        detectedMarginPct: marginPct,
        message: `Unusually high margin: ${(marginPct * 100).toFixed(2)}% (threshold: ${(UNUSUALLY_HIGH_MARGIN_PCT_THRESHOLD * 100).toFixed(0)}%) across ${row.rowCount} rows`,
        detectedAt: new Date(),
      });
    }
  }
  return anomalies;
}

// ─── Drift Detection ──────────────────────────────────────────────────────────

/**
 * Detect tenant margin drift by comparing two time windows.
 * referenceStart/End = baseline period; compareStart/End = current period.
 */
export async function detectTenantMarginDrift(
  tenantId: string,
  referenceStart: Date,
  referenceEnd: Date,
  compareStart: Date,
  compareEnd: Date,
): Promise<MarginAnomaly[]> {
  const [refRow] = await db
    .select({
      totalCustomerPrice: sql<string>`COALESCE(SUM(customer_price_usd::numeric), 0)`,
      totalMargin: sql<string>`COALESCE(SUM(margin_usd::numeric), 0)`,
    })
    .from(aiBillingUsage)
    .where(
      and(
        eq(aiBillingUsage.tenantId, tenantId),
        gte(aiBillingUsage.createdAt, referenceStart),
        lt(aiBillingUsage.createdAt, referenceEnd),
      ),
    );

  const [cmpRow] = await db
    .select({
      totalCustomerPrice: sql<string>`COALESCE(SUM(customer_price_usd::numeric), 0)`,
      totalMargin: sql<string>`COALESCE(SUM(margin_usd::numeric), 0)`,
    })
    .from(aiBillingUsage)
    .where(
      and(
        eq(aiBillingUsage.tenantId, tenantId),
        gte(aiBillingUsage.createdAt, compareStart),
        lt(aiBillingUsage.createdAt, compareEnd),
      ),
    );

  const refPrice = Number(refRow?.totalCustomerPrice ?? 0);
  const cmpPrice = Number(cmpRow?.totalCustomerPrice ?? 0);
  if (refPrice <= 0 || cmpPrice <= 0) return [];

  const refPct = Number(refRow?.totalMargin ?? 0) / refPrice;
  const cmpPct = Number(cmpRow?.totalMargin ?? 0) / cmpPrice;
  const drift = Math.abs(cmpPct - refPct);

  if (drift < MARGIN_DRIFT_THRESHOLD_PCT) return [];

  return [
    {
      type: "tenant_margin_drift",
      severity: drift > MARGIN_DRIFT_THRESHOLD_PCT * 2 ? "critical" : "warning",
      tenantId,
      provider: null,
      model: null,
      feature: null,
      detectedMarginPct: cmpPct,
      referencePct: refPct,
      message: `Tenant margin drift detected: reference=${(refPct * 100).toFixed(2)}%, current=${(cmpPct * 100).toFixed(2)}%, drift=${(drift * 100).toFixed(2)}pp`,
      detectedAt: new Date(),
    },
  ];
}

/**
 * Detect provider+model margin drift by comparing two time windows.
 */
export async function detectProviderModelMarginDrift(
  provider: string,
  model: string,
  referenceStart: Date,
  referenceEnd: Date,
  compareStart: Date,
  compareEnd: Date,
): Promise<MarginAnomaly[]> {
  const [refRow] = await db
    .select({
      totalCustomerPrice: sql<string>`COALESCE(SUM(customer_price_usd::numeric), 0)`,
      totalMargin: sql<string>`COALESCE(SUM(margin_usd::numeric), 0)`,
    })
    .from(aiBillingUsage)
    .where(
      and(
        eq(aiBillingUsage.provider, provider),
        eq(aiBillingUsage.model, model),
        gte(aiBillingUsage.createdAt, referenceStart),
        lt(aiBillingUsage.createdAt, referenceEnd),
      ),
    );

  const [cmpRow] = await db
    .select({
      totalCustomerPrice: sql<string>`COALESCE(SUM(customer_price_usd::numeric), 0)`,
      totalMargin: sql<string>`COALESCE(SUM(margin_usd::numeric), 0)`,
    })
    .from(aiBillingUsage)
    .where(
      and(
        eq(aiBillingUsage.provider, provider),
        eq(aiBillingUsage.model, model),
        gte(aiBillingUsage.createdAt, compareStart),
        lt(aiBillingUsage.createdAt, compareEnd),
      ),
    );

  const refPrice = Number(refRow?.totalCustomerPrice ?? 0);
  const cmpPrice = Number(cmpRow?.totalCustomerPrice ?? 0);
  if (refPrice <= 0 || cmpPrice <= 0) return [];

  const refPct = Number(refRow?.totalMargin ?? 0) / refPrice;
  const cmpPct = Number(cmpRow?.totalMargin ?? 0) / cmpPrice;
  const drift = Math.abs(cmpPct - refPct);

  if (drift < MARGIN_DRIFT_THRESHOLD_PCT) return [];

  return [
    {
      type: "provider_model_margin_drift",
      severity: drift > MARGIN_DRIFT_THRESHOLD_PCT * 2 ? "critical" : "warning",
      tenantId: null,
      provider,
      model,
      feature: null,
      detectedMarginPct: cmpPct,
      referencePct: refPct,
      message: `Provider/model margin drift: provider=${provider} model=${model} reference=${(refPct * 100).toFixed(2)}%, current=${(cmpPct * 100).toFixed(2)}%, drift=${(drift * 100).toFixed(2)}pp`,
      detectedAt: new Date(),
    },
  ];
}

// ─── Combined Scan ────────────────────────────────────────────────────────────

export interface MarginAnomalyScanResult {
  negativeMargin: MarginAnomaly[];
  zeroRevenueCost: MarginAnomaly[];
  unusualMarginPct: MarginAnomaly[];
  totalAnomalies: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
}

/**
 * Run all request-level and aggregate anomaly detections for a period.
 * Returns a combined structured result.
 */
export async function runMarginAnomalyScan(
  periodStart?: Date,
  periodEnd?: Date,
  tenantId?: string,
): Promise<MarginAnomalyScanResult> {
  const [negativeMargin, zeroRevenueCost, unusualMarginPct] = await Promise.all([
    detectNegativeMarginRows(periodStart, periodEnd, tenantId),
    detectZeroRevenueNonzeroCost(periodStart, periodEnd, tenantId),
    detectUnusualMarginPct(periodStart, periodEnd),
  ]);

  const all = [...negativeMargin, ...zeroRevenueCost, ...unusualMarginPct];
  return {
    negativeMargin,
    zeroRevenueCost,
    unusualMarginPct,
    totalAnomalies: all.length,
    criticalCount: all.filter((a) => a.severity === "critical").length,
    warningCount: all.filter((a) => a.severity === "warning").length,
    infoCount: all.filter((a) => a.severity === "info").length,
  };
}
