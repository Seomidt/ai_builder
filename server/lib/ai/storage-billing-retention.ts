/**
 * Storage Billing Retention & Reconciliation — Phase 4K
 *
 * SERVER-ONLY: Retention policy, gap detection, and lifecycle helpers.
 *
 * RETENTION POLICY:
 *   storage_usage rows are permanent records of measured consumption.
 *   storage_billing_usage rows are permanent financial records.
 *   Neither should be deleted in production.
 *
 *   The relationship between usage and billing should be 1:1 (UNIQUE constraint).
 *   Gaps (usage without billing) indicate unbilled consumption — a revenue risk.
 *   Billing without a usage record indicates a data integrity issue.
 *
 * RECONCILIATION APPROACH (Phase 4K):
 *   Detection-only — identify gaps, do not auto-fix.
 *   Future phases may wire gap detection into billing_audit_findings.
 *
 * DATA MODEL RELATIONSHIPS:
 *   storage_usage         → raw usage (append-only)
 *   storage_billing_usage → derived billing (UNIQUE on storage_usage_id)
 *   billing_period_tenant_snapshots → closed period totals (storage_customer_price_usd etc.)
 *   invoice_line_items    → storage_usage line items in finalized invoices
 */

import { and, eq, isNull, sql, gte, lt } from "drizzle-orm";
import { db } from "../../db";
import { storageUsage, storageBillingUsage, billingPeriods, billingPeriodTenantSnapshots } from "@shared/schema";

// ─── Policy ───────────────────────────────────────────────────────────────────

export interface StorageBillingRetentionPolicy {
  storageUsageRows: string;
  storageBillingUsageRows: string;
  minimumRetentionDays: number;
  destructiveOpsAllowed: boolean;
  unbilledUsageRisk: string;
  relationshipModel: string;
}

/**
 * Canonical storage billing retention policy for this platform.
 */
export function explainStorageBillingRetentionPolicy(): StorageBillingRetentionPolicy {
  return {
    storageUsageRows:
      "Permanent. storage_usage rows are canonical usage measurements. Deleting them would break historical billing consistency and audit trails.",
    storageBillingUsageRows:
      "Permanent. storage_billing_usage rows are canonical financial records derived from usage. One row per usage row (UNIQUE constraint). Historical amounts are immutable.",
    minimumRetentionDays: 365,
    destructiveOpsAllowed: false,
    unbilledUsageRisk:
      "storage_usage rows without a corresponding storage_billing_usage row represent unbilled consumption. These are revenue gaps and must be resolved by running createStorageBillingUsage() for the affected rows.",
    relationshipModel:
      "storage_usage (1) → (0 or 1) storage_billing_usage. A billing row missing means the usage was never priced. A billing row without a usage row means a data integrity issue. Closed period snapshots capture final storage billing totals from storage_billing_usage.created_at within the period window.",
  };
}

// ─── Gap Detection ────────────────────────────────────────────────────────────

export interface UnbilledStorageUsage {
  storageUsageId: string;
  tenantId: string;
  storageProvider: string;
  storageProduct: string;
  metricType: string;
  usageAmount: string;
  usageUnit: string;
  usagePeriodStart: Date;
  usagePeriodEnd: Date;
  createdAt: Date;
  risk: string;
}

/**
 * Preview storage_usage rows that have no corresponding storage_billing_usage row.
 * These are unbilled and represent revenue gaps. Detection-only — no auto-fix.
 */
export async function previewUnbilledStorageUsage(): Promise<UnbilledStorageUsage[]> {
  // Find storage_usage rows where no billing row exists (LEFT JOIN + IS NULL pattern)
  const rows = await db
    .select({
      id: storageUsage.id,
      tenantId: storageUsage.tenantId,
      storageProvider: storageUsage.storageProvider,
      storageProduct: storageUsage.storageProduct,
      metricType: storageUsage.metricType,
      usageAmount: storageUsage.usageAmount,
      usageUnit: storageUsage.usageUnit,
      usagePeriodStart: storageUsage.usagePeriodStart,
      usagePeriodEnd: storageUsage.usagePeriodEnd,
      createdAt: storageUsage.createdAt,
      billingId: storageBillingUsage.id,
    })
    .from(storageUsage)
    .leftJoin(
      storageBillingUsage,
      eq(storageUsage.id, storageBillingUsage.storageUsageId),
    )
    .where(isNull(storageBillingUsage.id))
    .orderBy(storageUsage.createdAt)
    .limit(500);

  return rows.map((r) => ({
    storageUsageId: r.id,
    tenantId: r.tenantId,
    storageProvider: r.storageProvider,
    storageProduct: r.storageProduct,
    metricType: r.metricType,
    usageAmount: String(r.usageAmount),
    usageUnit: r.usageUnit,
    usagePeriodStart: r.usagePeriodStart,
    usagePeriodEnd: r.usagePeriodEnd,
    createdAt: r.createdAt,
    risk: "Unbilled storage consumption — revenue gap. Run createStorageBillingUsage() to resolve.",
  }));
}

export interface StorageUsageWithoutBillingPreview {
  storageUsageId: string;
  tenantId: string;
  metricType: string;
  usageAmount: string;
  usagePeriodStart: Date;
  daysSinceCreation: number;
}

/**
 * Preview storage_usage rows without billing, grouped with age information.
 * Older unbilled rows are higher priority for billing resolution.
 */
export async function previewStorageUsageWithoutBilling(): Promise<
  StorageUsageWithoutBillingPreview[]
> {
  const rows = await db
    .select({
      id: storageUsage.id,
      tenantId: storageUsage.tenantId,
      metricType: storageUsage.metricType,
      usageAmount: storageUsage.usageAmount,
      usagePeriodStart: storageUsage.usagePeriodStart,
      createdAt: storageUsage.createdAt,
      billingId: storageBillingUsage.id,
    })
    .from(storageUsage)
    .leftJoin(
      storageBillingUsage,
      eq(storageUsage.id, storageBillingUsage.storageUsageId),
    )
    .where(isNull(storageBillingUsage.id))
    .orderBy(storageUsage.createdAt)
    .limit(500);

  const now = Date.now();
  return rows.map((r) => ({
    storageUsageId: r.id,
    tenantId: r.tenantId,
    metricType: r.metricType,
    usageAmount: String(r.usageAmount),
    usagePeriodStart: r.usagePeriodStart,
    daysSinceCreation: Math.floor((now - r.createdAt.getTime()) / (1000 * 60 * 60 * 24)),
  }));
}

export interface StorageBillingWithoutSnapshotPreview {
  billingId: string;
  tenantId: string;
  storageProvider: string;
  metricType: string;
  customerPriceUsd: string;
  createdAt: Date;
  issue: string;
}

/**
 * Preview storage_billing_usage rows whose created_at falls within a closed period,
 * but the corresponding billing_period_tenant_snapshot has zero storage totals.
 * Indicates storage totals were not captured during period close.
 */
export async function previewStorageBillingWithoutSnapshot(
  periodId?: string,
): Promise<StorageBillingWithoutSnapshotPreview[]> {
  // Get closed periods to check
  const closedPeriods = await db
    .select()
    .from(billingPeriods)
    .where(
      and(
        eq(billingPeriods.status, "closed"),
        ...(periodId ? [eq(billingPeriods.id, periodId)] : []),
      ),
    )
    .limit(20);

  const results: StorageBillingWithoutSnapshotPreview[] = [];

  for (const period of closedPeriods) {
    // Find storage billing rows in this period window
    const billingInPeriod = await db
      .select()
      .from(storageBillingUsage)
      .where(
        and(
          gte(storageBillingUsage.createdAt, period.periodStart),
          lt(storageBillingUsage.createdAt, period.periodEnd),
        ),
      )
      .limit(100);

    if (billingInPeriod.length === 0) continue;

    // Group by tenant and check snapshot storage totals
    const tenantIds = Array.from(new Set(billingInPeriod.map((r) => r.tenantId)));

    for (const tid of tenantIds) {
      const snapshots = await db
        .select()
        .from(billingPeriodTenantSnapshots)
        .where(
          and(
            eq(billingPeriodTenantSnapshots.billingPeriodId, period.id),
            eq(billingPeriodTenantSnapshots.tenantId, tid),
          ),
        )
        .limit(1);

      const snap = snapshots[0];
      if (!snap || Number(snap.storageCustomerPriceUsd ?? 0) === 0) {
        const tenantBilling = billingInPeriod.filter((r) => r.tenantId === tid);
        for (const b of tenantBilling) {
          results.push({
            billingId: b.id,
            tenantId: tid,
            storageProvider: b.storageProvider,
            metricType: b.metricType,
            customerPriceUsd: String(b.customerPriceUsd),
            createdAt: b.createdAt,
            issue: `Storage billing row in period ${period.id} but snapshot.storage_customer_price_usd=0 — storage not captured during period close.`,
          });
        }
      }
    }
  }

  return results;
}
