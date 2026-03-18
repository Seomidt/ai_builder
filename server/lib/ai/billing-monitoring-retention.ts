/**
 * Billing Monitoring Retention Helpers — Phase 4Q
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides operational inspection helpers for monitoring data quality:
 *   - Retention policy explanation (read-only)
 *   - Stale failed snapshot detection
 *   - Open critical alert age inspection
 *   - Monitoring gaps detection
 *   - Tenant coverage gaps
 *
 * Design rules:
 *   A) No destructive cleanup in Phase 4Q
 *   B) days > 0 guard on all time-bounded helpers
 *   C) Read-only inspection only
 */

import { eq, and, lt, desc, inArray } from "drizzle-orm";
import { db } from "../../db";
import { billingMetricsSnapshots, billingAlerts, tenantSubscriptions } from "@shared/schema";
import type { BillingMetricsSnapshot, BillingAlert } from "@shared/schema";

// ─── Retention Policy ─────────────────────────────────────────────────────────

export interface BillingMonitoringRetentionPolicy {
  metricsSnapshots: string;
  billingAlerts: string;
  failedSnapshots: string;
  resolvedAlerts: string;
  note: string;
}

export function explainBillingMonitoringRetentionPolicy(): BillingMonitoringRetentionPolicy {
  return {
    metricsSnapshots: "Retained indefinitely. Snapshots are observability artifacts used for trend analysis. Failed snapshots are preserved for operational forensics.",
    billingAlerts: "Retained indefinitely. All alert history (open, resolved, suppressed) is preserved for audit and trend analysis.",
    failedSnapshots: "Failed snapshots should be reviewed within 24 hours. They indicate a monitoring gap for that window.",
    resolvedAlerts: "Resolved and suppressed alerts remain in historical state and are never deleted.",
    note: "Phase 4Q does not implement automated deletion. All helpers in this module are inspection-only.",
  };
}

// ─── Failed Snapshots Older Than N Days ──────────────────────────────────────

export async function previewFailedMetricsSnapshotsOlderThan(
  days: number,
): Promise<BillingMetricsSnapshot[]> {
  if (days <= 0) throw new Error("[billing-monitoring-retention] days must be > 0");

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  return db
    .select()
    .from(billingMetricsSnapshots)
    .where(
      and(
        eq(billingMetricsSnapshots.snapshotStatus, "failed"),
        lt(billingMetricsSnapshots.createdAt, cutoff),
      ),
    )
    .orderBy(desc(billingMetricsSnapshots.createdAt));
}

// ─── Open Critical Alerts Older Than N Days ───────────────────────────────────

export async function previewOpenCriticalAlertsOlderThan(
  days: number,
): Promise<BillingAlert[]> {
  if (days <= 0) throw new Error("[billing-monitoring-retention] days must be > 0");

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  return db
    .select()
    .from(billingAlerts)
    .where(
      and(
        inArray(billingAlerts.status, ["open", "acknowledged"]),
        eq(billingAlerts.severity, "critical"),
        lt(billingAlerts.createdAt, cutoff),
      ),
    )
    .orderBy(desc(billingAlerts.createdAt));
}

// ─── Monitoring Gaps ─────────────────────────────────────────────────────────

export interface MonitoringGap {
  windowStart: string;
  windowEnd: string;
  scopeType: string;
  expectedSnapshotCount: number;
  actualSnapshotCount: number;
  failedCount: number;
  gapExists: boolean;
}

export async function previewMonitoringGaps(
  windowStart: Date,
  windowEnd: Date,
): Promise<MonitoringGap[]> {
  const globalSnapshots = await db
    .select()
    .from(billingMetricsSnapshots)
    .where(
      and(
        eq(billingMetricsSnapshots.scopeType, "global"),
        eq(billingMetricsSnapshots.metricWindowStart, windowStart),
        eq(billingMetricsSnapshots.metricWindowEnd, windowEnd),
      ),
    );

  const tenantSnapshots = await db
    .select()
    .from(billingMetricsSnapshots)
    .where(
      and(
        eq(billingMetricsSnapshots.scopeType, "tenant"),
        eq(billingMetricsSnapshots.metricWindowStart, windowStart),
        eq(billingMetricsSnapshots.metricWindowEnd, windowEnd),
      ),
    );

  const activeTenantCount = await db
    .select({ tenantId: tenantSubscriptions.tenantId })
    .from(tenantSubscriptions)
    .where(inArray(tenantSubscriptions.status, ["active", "trialing"]));

  const globalFailed = globalSnapshots.filter((s) => s.snapshotStatus === "failed").length;
  const tenantFailed = tenantSnapshots.filter((s) => s.snapshotStatus === "failed").length;
  const uniqueActiveTenants = new Set(activeTenantCount.map((r) => r.tenantId)).size;

  const globalCompleted = globalSnapshots.filter((s) => s.snapshotStatus === "completed").length;
  const tenantCompleted = tenantSnapshots.filter((s) => s.snapshotStatus === "completed").length;

  return [
    {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      scopeType: "global",
      expectedSnapshotCount: 1,
      actualSnapshotCount: globalCompleted,
      failedCount: globalFailed,
      gapExists: globalCompleted === 0,
    },
    {
      windowStart: windowStart.toISOString(),
      windowEnd: windowEnd.toISOString(),
      scopeType: "tenant",
      expectedSnapshotCount: uniqueActiveTenants,
      actualSnapshotCount: tenantCompleted,
      failedCount: tenantFailed,
      gapExists: tenantCompleted < uniqueActiveTenants,
    },
  ];
}

// ─── Tenants Without Recent Snapshots ────────────────────────────────────────

export interface TenantWithoutRecentSnapshot {
  tenantId: string;
  lastSnapshotAt: string | null;
  daysSinceLastSnapshot: number | null;
  hasNoSnapshot: boolean;
}

export async function previewTenantsWithoutRecentMetricsSnapshots(
  days: number,
): Promise<TenantWithoutRecentSnapshot[]> {
  if (days <= 0) throw new Error("[billing-monitoring-retention] days must be > 0");

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const activeSubs = await db
    .select({ tenantId: tenantSubscriptions.tenantId })
    .from(tenantSubscriptions)
    .where(inArray(tenantSubscriptions.status, ["active", "trialing"]));

  const tenantIds = Array.from(new Set(activeSubs.map((s) => s.tenantId)));

  const result: TenantWithoutRecentSnapshot[] = [];

  for (const tenantId of tenantIds) {
    const latestSnapshot = await db
      .select({ createdAt: billingMetricsSnapshots.createdAt })
      .from(billingMetricsSnapshots)
      .where(
        and(
          eq(billingMetricsSnapshots.scopeType, "tenant"),
          eq(billingMetricsSnapshots.scopeId, tenantId),
          eq(billingMetricsSnapshots.snapshotStatus, "completed"),
        ),
      )
      .orderBy(desc(billingMetricsSnapshots.createdAt))
      .limit(1);

    if (latestSnapshot.length === 0) {
      result.push({
        tenantId,
        lastSnapshotAt: null,
        daysSinceLastSnapshot: null,
        hasNoSnapshot: true,
      });
    } else {
      const lastAt = new Date(latestSnapshot[0].createdAt);
      const daysSince = Math.floor((Date.now() - lastAt.getTime()) / 86400000);
      if (daysSince >= days) {
        result.push({
          tenantId,
          lastSnapshotAt: lastAt.toISOString(),
          daysSinceLastSnapshot: daysSince,
          hasNoSnapshot: false,
        });
      }
    }
  }

  return result;
}
