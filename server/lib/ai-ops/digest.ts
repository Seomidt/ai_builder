// ─── Phase 51: AI Ops Assistant — Weekly Digest ───────────────────────────────
//
// Pre-computes weekly ops digest from rollups and governance data.
// Does NOT recompute from raw events on every request.
// Relies on analytics_daily_rollups and governance tables only.
// ─────────────────────────────────────────────────────────────────────────────

import {
  buildPlatformHealthContext,
  buildAiCostContext,
  buildBillingHealthContext,
  buildRetentionContext,
  buildSecurityContext,
} from "./context-assembler";

export interface WeeklyDigestData {
  weekStart: string;
  weekEnd: string;
  generatedAt: string;
  platformHealth: {
    systemStatus: string;
    recentAnomalyCount: number;
    activeAlertCount: number;
    totalEventsLast7d: number;
  };
  aiCost: {
    totalSnapshotCostUsd: number;
    recentAlertCount: number;
    recentAnomalyCount: number;
  };
  billing: {
    activeSubscriptions: number;
    pastDueSubscriptions: number;
    overdueInvoices: number;
  };
  retention: {
    retentionEvents: number;
    productEvents: number;
    uniqueFamilies: string[];
  };
  security: {
    totalEvents: number;
    criticalCount: number;
    topEventTypes: string[];
  };
  highlights: string[];
  riskSignals: string[];
}

let cachedDigest: WeeklyDigestData | null = null;
let cachedAt: Date | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function generateWeeklyDigest(forceRefresh = false): Promise<WeeklyDigestData> {
  if (!forceRefresh && cachedDigest && cachedAt && Date.now() - cachedAt.getTime() < CACHE_TTL_MS) {
    return cachedDigest;
  }

  const now = new Date();
  const weekEnd = now.toISOString().split("T")[0];
  const weekStart = new Date(now.getTime() - 7 * 86400_000).toISOString().split("T")[0];

  const [health, cost, billing, retention, security] = await Promise.allSettled([
    buildPlatformHealthContext(),
    buildAiCostContext(),
    buildBillingHealthContext(),
    buildRetentionContext(),
    buildSecurityContext(),
  ]);

  const healthData = health.status === "fulfilled" ? health.value : null;
  const costData = cost.status === "fulfilled" ? cost.value : null;
  const billingData = billing.status === "fulfilled" ? billing.value : null;
  const retentionData = retention.status === "fulfilled" ? retention.value : null;
  const securityData = security.status === "fulfilled" ? security.value : null;

  const highlights: string[] = [];
  const riskSignals: string[] = [];

  if (healthData) {
    if (healthData.recentAnomalyCount > 0) {
      highlights.push(`${healthData.recentAnomalyCount} governance anomalies detected in past 7 days`);
      if (healthData.recentAnomalyCount > 5) riskSignals.push("High anomaly frequency — investigate runaway agents");
    }
    if (healthData.analyticsRollupSummary.totalEventsLast7d > 0) {
      highlights.push(`${healthData.analyticsRollupSummary.totalEventsLast7d.toLocaleString()} platform events tracked this week`);
    }
  }

  if (costData && costData.totalSnapshotCostUsd > 0) {
    highlights.push(`AI cost snapshots total: $${costData.totalSnapshotCostUsd.toFixed(2)}`);
    if (costData.recentAlerts.length > 0) {
      riskSignals.push(`${costData.recentAlerts.length} AI budget alerts active`);
    }
  }

  if (billingData) {
    const pastDue = billingData.subscriptionStatusCounts["past_due"] ?? 0;
    if (pastDue > 0) riskSignals.push(`${pastDue} subscriptions past due`);
    if (billingData.overdueCount > 0) riskSignals.push(`${billingData.overdueCount} overdue invoices`);
  }

  if (securityData && securityData.criticalCount > 0) {
    riskSignals.push(`${securityData.criticalCount} critical security events this period`);
  }

  const digest: WeeklyDigestData = {
    weekStart,
    weekEnd,
    generatedAt: now.toISOString(),
    platformHealth: {
      systemStatus: healthData?.systemStatus ?? "unknown",
      recentAnomalyCount: healthData?.recentAnomalyCount ?? 0,
      activeAlertCount: healthData?.activeAlertCount ?? 0,
      totalEventsLast7d: healthData?.analyticsRollupSummary.totalEventsLast7d ?? 0,
    },
    aiCost: {
      totalSnapshotCostUsd: costData?.totalSnapshotCostUsd ?? 0,
      recentAlertCount: costData?.recentAlerts.length ?? 0,
      recentAnomalyCount: costData?.recentAnomalies.length ?? 0,
    },
    billing: {
      activeSubscriptions: billingData?.subscriptionStatusCounts["active"] ?? 0,
      pastDueSubscriptions: billingData?.subscriptionStatusCounts["past_due"] ?? 0,
      overdueInvoices: billingData?.overdueCount ?? 0,
    },
    retention: {
      retentionEvents: retentionData?.retentionEvents ?? 0,
      productEvents: retentionData?.productEvents ?? 0,
      uniqueFamilies: Object.keys(retentionData?.rollupsByFamily ?? {}),
    },
    security: {
      totalEvents: securityData?.totalEvents ?? 0,
      criticalCount: securityData?.criticalCount ?? 0,
      topEventTypes: Object.keys(securityData?.eventTypeCounts ?? {}).slice(0, 5),
    },
    highlights,
    riskSignals,
  };

  cachedDigest = digest;
  cachedAt = now;

  return digest;
}

export function getCachedDigest(): WeeklyDigestData | null {
  return cachedDigest;
}

export function clearDigestCache(): void {
  cachedDigest = null;
  cachedAt = null;
}

export const DIGEST_CONFIG = {
  cacheTtlMs: CACHE_TTL_MS,
  weekLookbackDays: 7,
  version: "phase51",
};
