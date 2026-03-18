/**
 * Billing Anomaly Detection — Phase 4Q
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Detects anomalies in billing data and emits billing_alerts rows via upsertBillingAlert.
 * All detectors are read-only over canonical billing tables.
 *
 * Detectors:
 *   1. Revenue drop (current window vs prior window, same duration)
 *   2. Margin drop (effective margin % from current window < threshold)
 *   3. Failed payment spike (failed payments > threshold % of total)
 *   4. Invoice-payment mismatch (finalized invoice with no paid payment > N days)
 *   5. Critical reconciliation gap (unresolved critical findings)
 *   6. Allowance overage spike (overage spike > threshold vs prior window)
 *
 * Design rules:
 *   A) Each detector calls upsertBillingAlert — deduplication is via alert_key
 *   B) Anomaly scan is idempotent — safe to re-run over same window
 *   C) No destructive operations — detection only
 *   D) Thresholds are hardcoded constants (externalize in Phase 4R+)
 */

import { eq, and, gte, lt, sql, inArray, isNull } from "drizzle-orm";
import { db } from "../../db";
import {
  aiBillingUsage,
  storageBillingUsage,
  invoices,
  invoicePayments,
  providerReconciliationFindings,
} from "@shared/schema";
import { upsertBillingAlert } from "./billing-alerts";

// ─── Thresholds ───────────────────────────────────────────────────────────────

const REVENUE_DROP_THRESHOLD_PCT = 0.2;
const MARGIN_DROP_CRITICAL_PCT = 0.05;
const MARGIN_DROP_WARNING_PCT = 0.1;
const FAILED_PAYMENT_SPIKE_THRESHOLD_PCT = 0.1;
const FAILED_PAYMENT_ABSOLUTE_THRESHOLD = 5;
const INVOICE_PAYMENT_GAP_DAYS = 7;
const OVERAGE_SPIKE_THRESHOLD_PCT = 0.5;

// ─── 1. Revenue Drop ─────────────────────────────────────────────────────────

export async function detectRevenueDropAnomalies(
  windowStart: Date,
  windowEnd: Date,
): Promise<void> {
  const durationMs = windowEnd.getTime() - windowStart.getTime();
  const priorStart = new Date(windowStart.getTime() - durationMs);
  const priorEnd = new Date(windowEnd.getTime() - durationMs);

  const queryRevenue = async (start: Date, end: Date): Promise<number> => {
    const rows = await db
      .select({ total: sql<string>`coalesce(sum(customer_price_usd), 0)` })
      .from(aiBillingUsage)
      .where(and(gte(aiBillingUsage.createdAt, start), lt(aiBillingUsage.createdAt, end)));
    const storageRows = await db
      .select({ total: sql<string>`coalesce(sum(customer_price_usd), 0)` })
      .from(storageBillingUsage)
      .where(and(gte(storageBillingUsage.createdAt, start), lt(storageBillingUsage.createdAt, end)));
    return parseFloat(rows[0]?.total ?? "0") + parseFloat(storageRows[0]?.total ?? "0");
  };

  const [currentRevenue, priorRevenue] = await Promise.all([
    queryRevenue(windowStart, windowEnd),
    queryRevenue(priorStart, priorEnd),
  ]);

  if (priorRevenue === 0) return;

  const dropPct = (priorRevenue - currentRevenue) / priorRevenue;
  if (dropPct >= REVENUE_DROP_THRESHOLD_PCT) {
    await upsertBillingAlert({
      alertType: "revenue_drop",
      severity: dropPct >= 0.4 ? "critical" : "warning",
      scopeType: "global",
      scopeId: null,
      alertKey: `revenue_drop:global:${windowStart.toISOString()}:${windowEnd.toISOString()}`,
      alertMessage: `Revenue dropped ${(dropPct * 100).toFixed(1)}% vs prior window (current: $${currentRevenue.toFixed(4)}, prior: $${priorRevenue.toFixed(4)})`,
      details: { currentRevenue, priorRevenue, dropPct, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() },
    });
  }
}

// ─── 2. Margin Drop ───────────────────────────────────────────────────────────

export async function detectMarginDropAnomalies(
  windowStart: Date,
  windowEnd: Date,
): Promise<void> {
  const rows = await db
    .select({
      totalCustomerPriceUsd: sql<string>`coalesce(sum(customer_price_usd), 0)`,
      totalProviderCostUsd: sql<string>`coalesce(sum(provider_cost_usd), 0)`,
    })
    .from(aiBillingUsage)
    .where(and(gte(aiBillingUsage.createdAt, windowStart), lt(aiBillingUsage.createdAt, windowEnd)));

  const customerPrice = parseFloat(rows[0]?.totalCustomerPriceUsd ?? "0");
  const providerCost = parseFloat(rows[0]?.totalProviderCostUsd ?? "0");

  if (customerPrice === 0) return;

  const marginPct = (customerPrice - providerCost) / customerPrice;

  if (marginPct < MARGIN_DROP_CRITICAL_PCT) {
    await upsertBillingAlert({
      alertType: "margin_drop",
      severity: "critical",
      scopeType: "global",
      scopeId: null,
      alertKey: `margin_drop:global:${windowStart.toISOString()}:${windowEnd.toISOString()}`,
      alertMessage: `AI margin critically low: ${(marginPct * 100).toFixed(2)}% (threshold: ${(MARGIN_DROP_CRITICAL_PCT * 100).toFixed(0)}%)`,
      details: { marginPct, customerPrice, providerCost, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() },
    });
  } else if (marginPct < MARGIN_DROP_WARNING_PCT) {
    await upsertBillingAlert({
      alertType: "margin_drop",
      severity: "warning",
      scopeType: "global",
      scopeId: null,
      alertKey: `margin_drop:global:${windowStart.toISOString()}:${windowEnd.toISOString()}`,
      alertMessage: `AI margin below warning threshold: ${(marginPct * 100).toFixed(2)}% (threshold: ${(MARGIN_DROP_WARNING_PCT * 100).toFixed(0)}%)`,
      details: { marginPct, customerPrice, providerCost, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() },
    });
  }
}

// ─── 3. Failed Payment Spike ──────────────────────────────────────────────────

export async function detectFailedPaymentSpikeAnomalies(
  windowStart: Date,
  windowEnd: Date,
): Promise<void> {
  const rows = await db
    .select({
      totalCount: sql<number>`count(*)::int`,
      failedCount: sql<number>`count(*) filter (where payment_status = 'failed')::int`,
      failedAmountUsd: sql<string>`coalesce(sum(amount_usd) filter (where payment_status = 'failed'), 0)`,
    })
    .from(invoicePayments)
    .where(
      and(gte(invoicePayments.createdAt, windowStart), lt(invoicePayments.createdAt, windowEnd)),
    );

  const r = rows[0];
  const totalCount = r?.totalCount ?? 0;
  const failedCount = r?.failedCount ?? 0;
  const failedAmountUsd = parseFloat(r?.failedAmountUsd ?? "0");

  if (totalCount === 0) return;

  const failedPct = failedCount / totalCount;

  if (
    failedCount >= FAILED_PAYMENT_ABSOLUTE_THRESHOLD ||
    failedPct >= FAILED_PAYMENT_SPIKE_THRESHOLD_PCT
  ) {
    await upsertBillingAlert({
      alertType: "failed_payment_spike",
      severity: failedCount >= 10 || failedPct >= 0.25 ? "critical" : "warning",
      scopeType: "global",
      scopeId: null,
      alertKey: `failed_payment_spike:global:${windowStart.toISOString()}:${windowEnd.toISOString()}`,
      alertMessage: `Failed payment spike: ${failedCount} failed of ${totalCount} total (${(failedPct * 100).toFixed(1)}%) — $${failedAmountUsd.toFixed(4)} at risk`,
      details: { failedCount, totalCount, failedPct, failedAmountUsd, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() },
    });
  }
}

// ─── 4. Invoice-Payment Mismatch ──────────────────────────────────────────────

export async function detectInvoicePaymentMismatchAnomalies(
  windowStart: Date,
  windowEnd: Date,
): Promise<void> {
  const gapCutoff = new Date(Date.now() - INVOICE_PAYMENT_GAP_DAYS * 86400000);

  const finalizedInvoices = await db
    .select({ id: invoices.id, tenantId: invoices.tenantId, totalUsd: invoices.totalUsd, finalizedAt: invoices.finalizedAt })
    .from(invoices)
    .where(
      and(
        eq(invoices.status, "finalized"),
        gte(invoices.createdAt, windowStart),
        lt(invoices.createdAt, windowEnd),
        lt(invoices.finalizedAt, gapCutoff),
      ),
    );

  for (const inv of finalizedInvoices) {
    const payments = await db
      .select({ paymentStatus: invoicePayments.paymentStatus })
      .from(invoicePayments)
      .where(
        and(
          eq(invoicePayments.invoiceId, inv.id),
          inArray(invoicePayments.paymentStatus, ["paid"]),
        ),
      )
      .limit(1);

    if (payments.length === 0) {
      await upsertBillingAlert({
        alertType: "invoice_payment_mismatch",
        severity: "warning",
        scopeType: "invoice",
        scopeId: inv.id,
        alertKey: `invoice_payment_mismatch:invoice:${inv.id}`,
        alertMessage: `Finalized invoice ${inv.id} (tenant: ${inv.tenantId}) has no paid payment after ${INVOICE_PAYMENT_GAP_DAYS} days — $${parseFloat(String(inv.totalUsd)).toFixed(4)} outstanding`,
        details: { invoiceId: inv.id, tenantId: inv.tenantId, totalUsd: inv.totalUsd, finalizedAt: inv.finalizedAt?.toISOString() ?? null },
      });
    }
  }
}

// ─── 5. Critical Reconciliation Gap ──────────────────────────────────────────

export async function detectReconciliationGapAnomalies(
  windowStart: Date,
  windowEnd: Date,
): Promise<void> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(providerReconciliationFindings)
    .where(
      and(
        eq(providerReconciliationFindings.severity, "critical"),
        gte(providerReconciliationFindings.createdAt, windowStart),
        lt(providerReconciliationFindings.createdAt, windowEnd),
      ),
    );

  const criticalCount = rows[0]?.count ?? 0;
  if (criticalCount === 0) return;

  await upsertBillingAlert({
    alertType: "reconciliation_gap",
    severity: "critical",
    scopeType: "global",
    scopeId: null,
    alertKey: `reconciliation_gap:global:${windowStart.toISOString()}:${windowEnd.toISOString()}`,
    alertMessage: `${criticalCount} critical provider reconciliation finding(s) detected — provider token/cost drift requires immediate review`,
    details: { criticalCount, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() },
  });
}

// ─── 6. Allowance Overage Spike ──────────────────────────────────────────────

export async function detectAllowanceOverageSpikeAnomalies(
  windowStart: Date,
  windowEnd: Date,
): Promise<void> {
  const durationMs = windowEnd.getTime() - windowStart.getTime();
  const priorStart = new Date(windowStart.getTime() - durationMs);
  const priorEnd = new Date(windowEnd.getTime() - durationMs);

  const queryOverage = async (start: Date, end: Date): Promise<number> => {
    const aiRows = await db
      .select({ total: sql<string>`coalesce(sum(overage_amount_usd), 0)` })
      .from(aiBillingUsage)
      .where(and(gte(aiBillingUsage.createdAt, start), lt(aiBillingUsage.createdAt, end)));
    const stRows = await db
      .select({ total: sql<string>`coalesce(sum(overage_amount_usd), 0)` })
      .from(storageBillingUsage)
      .where(and(gte(storageBillingUsage.createdAt, start), lt(storageBillingUsage.createdAt, end)));
    return parseFloat(aiRows[0]?.total ?? "0") + parseFloat(stRows[0]?.total ?? "0");
  };

  const [currentOverage, priorOverage] = await Promise.all([
    queryOverage(windowStart, windowEnd),
    queryOverage(priorStart, priorEnd),
  ]);

  if (priorOverage === 0 && currentOverage === 0) return;

  let spikePct = 0;
  if (priorOverage > 0) {
    spikePct = (currentOverage - priorOverage) / priorOverage;
  } else if (currentOverage > 0) {
    spikePct = 1;
  }

  if (spikePct >= OVERAGE_SPIKE_THRESHOLD_PCT && currentOverage > 0) {
    await upsertBillingAlert({
      alertType: "overage_spike",
      severity: spikePct >= 1.0 ? "critical" : "warning",
      scopeType: "global",
      scopeId: null,
      alertKey: `overage_spike:global:${windowStart.toISOString()}:${windowEnd.toISOString()}`,
      alertMessage: `Allowance overage spike: +${(spikePct * 100).toFixed(1)}% vs prior window (current: $${currentOverage.toFixed(4)}, prior: $${priorOverage.toFixed(4)})`,
      details: { currentOverage, priorOverage, spikePct, windowStart: windowStart.toISOString(), windowEnd: windowEnd.toISOString() },
    });
  }
}

// ─── Full Anomaly Scan ────────────────────────────────────────────────────────

export interface BillingAnomalyScanResult {
  windowStart: string;
  windowEnd: string;
  detectorsRun: number;
  errors: Array<{ detector: string; error: string }>;
  completedAt: string;
}

export async function runBillingAnomalyScan(
  windowStart: Date,
  windowEnd: Date,
): Promise<BillingAnomalyScanResult> {
  const detectors: Array<{ name: string; fn: () => Promise<void> }> = [
    { name: "revenue_drop", fn: () => detectRevenueDropAnomalies(windowStart, windowEnd) },
    { name: "margin_drop", fn: () => detectMarginDropAnomalies(windowStart, windowEnd) },
    { name: "failed_payment_spike", fn: () => detectFailedPaymentSpikeAnomalies(windowStart, windowEnd) },
    { name: "invoice_payment_mismatch", fn: () => detectInvoicePaymentMismatchAnomalies(windowStart, windowEnd) },
    { name: "reconciliation_gap", fn: () => detectReconciliationGapAnomalies(windowStart, windowEnd) },
    { name: "overage_spike", fn: () => detectAllowanceOverageSpikeAnomalies(windowStart, windowEnd) },
  ];

  const errors: Array<{ detector: string; error: string }> = [];

  await Promise.all(
    detectors.map(async ({ name, fn }) => {
      try {
        await fn();
      } catch (err) {
        errors.push({ detector: name, error: err instanceof Error ? err.message : String(err) });
      }
    }),
  );

  return {
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    detectorsRun: detectors.length,
    errors,
    completedAt: new Date().toISOString(),
  };
}
