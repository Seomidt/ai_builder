/**
 * Billing Job Catalog & Executors — Phase 4R
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Registers all 10 predefined automated monetization job definitions
 * and their executor functions. Job definitions are seeded into the DB
 * on first call to ensureBillingJobDefinitions().
 *
 * Design rules:
 *   A) Each job definition is seeded with a stable job_key (idempotent)
 *   B) Each executor delegates to existing safe engines — no direct billing truth mutations
 *   C) Executors return a structured result_summary JSON
 *   D) Jobs are idempotent — safe to re-run over same window
 *   E) No speculative job catalog bloat — only jobs with real existing engines
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { billingJobDefinitions } from "@shared/schema";
import type { BillingJobDefinition, BillingJobRun } from "@shared/schema";
import { registerJobExecutor } from "./billing-operations";

// Existing safe engines
import {
  createGlobalBillingMetricsSnapshot,
  createTenantBillingMetricsSnapshot,
  createBillingPeriodMetricsSnapshot,
} from "./billing-observability";
import { runBillingAnomalyScan } from "./billing-anomalies";
import { runGlobalMarginTracking } from "./margin-tracking";
import { runFullBillingAudit } from "./billing-audit";
import { runProviderReconciliation } from "./provider-reconciliation";
import {
  previewPendingPaymentsOlderThan,
  previewFailedPaymentsOlderThan,
} from "./payment-retention";
import {
  previewWebhookEventsWithoutProcessedState,
  previewPaymentsWithoutWebhookConfirmation,
} from "./stripe-webhook-retention";
import {
  previewPendingAdminChangesOlderThan,
  previewFailedAdminChangesOlderThan,
} from "./admin-change-retention";

// ─── Job Definitions ─────────────────────────────────────────────────────────

export interface BillingJobSeed {
  jobKey: string;
  jobName: string;
  jobCategory: "snapshot" | "monitoring" | "anomaly" | "reconciliation" | "audit" | "payment" | "maintenance";
  scheduleType: "manual" | "interval" | "cron";
  scheduleExpression: string | null;
  singletonMode: boolean;
  retryLimit: number;
  timeoutSeconds: number;
}

const PREDEFINED_JOBS: BillingJobSeed[] = [
  {
    jobKey: "global_billing_metrics_snapshot",
    jobName: "Global Billing Metrics Snapshot",
    jobCategory: "snapshot",
    scheduleType: "interval",
    scheduleExpression: "3600",
    singletonMode: true,
    retryLimit: 2,
    timeoutSeconds: 120,
  },
  {
    jobKey: "tenant_billing_metrics_snapshot",
    jobName: "Tenant Billing Metrics Snapshot",
    jobCategory: "snapshot",
    scheduleType: "interval",
    scheduleExpression: "7200",
    singletonMode: false,
    retryLimit: 2,
    timeoutSeconds: 180,
  },
  {
    jobKey: "billing_period_metrics_snapshot",
    jobName: "Billing Period Metrics Snapshot",
    jobCategory: "snapshot",
    scheduleType: "manual",
    scheduleExpression: null,
    singletonMode: false,
    retryLimit: 2,
    timeoutSeconds: 120,
  },
  {
    jobKey: "billing_anomaly_scan",
    jobName: "Billing Anomaly Scan",
    jobCategory: "anomaly",
    scheduleType: "interval",
    scheduleExpression: "3600",
    singletonMode: true,
    retryLimit: 1,
    timeoutSeconds: 120,
  },
  {
    jobKey: "provider_reconciliation_scan",
    jobName: "Provider Reconciliation Scan",
    jobCategory: "reconciliation",
    scheduleType: "interval",
    scheduleExpression: "86400",
    singletonMode: true,
    retryLimit: 2,
    timeoutSeconds: 600,
  },
  {
    jobKey: "billing_audit_scan",
    jobName: "Billing Audit Scan",
    jobCategory: "audit",
    scheduleType: "interval",
    scheduleExpression: "86400",
    singletonMode: true,
    retryLimit: 1,
    timeoutSeconds: 600,
  },
  {
    jobKey: "margin_tracking_scan",
    jobName: "Global Margin Tracking Scan",
    jobCategory: "monitoring",
    scheduleType: "interval",
    scheduleExpression: "3600",
    singletonMode: true,
    retryLimit: 2,
    timeoutSeconds: 300,
  },
  {
    jobKey: "pending_payment_health_scan",
    jobName: "Pending Payment Health Scan",
    jobCategory: "payment",
    scheduleType: "interval",
    scheduleExpression: "3600",
    singletonMode: true,
    retryLimit: 1,
    timeoutSeconds: 60,
  },
  {
    jobKey: "stale_webhook_health_scan",
    jobName: "Stale Webhook Health Scan",
    jobCategory: "maintenance",
    scheduleType: "interval",
    scheduleExpression: "3600",
    singletonMode: true,
    retryLimit: 1,
    timeoutSeconds: 60,
  },
  {
    jobKey: "stale_admin_change_health_scan",
    jobName: "Stale Admin Change Health Scan",
    jobCategory: "maintenance",
    scheduleType: "interval",
    scheduleExpression: "3600",
    singletonMode: true,
    retryLimit: 1,
    timeoutSeconds: 60,
  },
];

// ─── Seed Job Definitions ─────────────────────────────────────────────────────

/**
 * Ensure all predefined job definitions exist in the DB.
 * Idempotent — safe to call on every startup.
 * Does not update existing definitions (to preserve manual overrides).
 */
export async function ensureBillingJobDefinitions(): Promise<{
  created: number;
  existing: number;
  definitions: BillingJobDefinition[];
}> {
  let created = 0;
  let existing = 0;
  const definitions: BillingJobDefinition[] = [];

  for (const seed of PREDEFINED_JOBS) {
    const existingDef = await db
      .select()
      .from(billingJobDefinitions)
      .where(eq(billingJobDefinitions.jobKey, seed.jobKey))
      .limit(1);

    if (existingDef.length > 0) {
      existing++;
      definitions.push(existingDef[0]);
    } else {
      const [inserted] = await db
        .insert(billingJobDefinitions)
        .values({
          jobKey: seed.jobKey,
          jobName: seed.jobName,
          jobCategory: seed.jobCategory,
          status: "active",
          scheduleType: seed.scheduleType,
          scheduleExpression: seed.scheduleExpression,
          singletonMode: seed.singletonMode,
          retryLimit: seed.retryLimit,
          timeoutSeconds: seed.timeoutSeconds,
        })
        .returning();
      created++;
      definitions.push(inserted);
    }
  }

  return { created, existing, definitions };
}

// ─── Job Executors ────────────────────────────────────────────────────────────

function getDefaultWindow(): { windowStart: Date; windowEnd: Date } {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
  return { windowStart, windowEnd };
}

registerJobExecutor("global_billing_metrics_snapshot", async (run, _def) => {
  const { windowStart, windowEnd } = getDefaultWindow();
  const snapshot = await createGlobalBillingMetricsSnapshot(windowStart, windowEnd);
  return {
    snapshotId: snapshot.id,
    snapshotStatus: snapshot.snapshotStatus,
    scopeType: snapshot.scopeType,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  };
});

registerJobExecutor("tenant_billing_metrics_snapshot", async (run, _def) => {
  const tenantId = run.scopeId;
  if (!tenantId) {
    throw new Error("tenant_billing_metrics_snapshot requires scopeId=tenantId");
  }
  const { windowStart, windowEnd } = getDefaultWindow();
  const snapshot = await createTenantBillingMetricsSnapshot(tenantId, windowStart, windowEnd);
  return {
    snapshotId: snapshot.id,
    snapshotStatus: snapshot.snapshotStatus,
    tenantId,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  };
});

registerJobExecutor("billing_period_metrics_snapshot", async (run, _def) => {
  const billingPeriodId = run.scopeId;
  if (!billingPeriodId) {
    throw new Error("billing_period_metrics_snapshot requires scopeId=billingPeriodId");
  }
  const { windowStart, windowEnd } = getDefaultWindow();
  const snapshot = await createBillingPeriodMetricsSnapshot(
    billingPeriodId,
    windowStart,
    windowEnd,
  );
  return {
    snapshotId: snapshot.id,
    snapshotStatus: snapshot.snapshotStatus,
    billingPeriodId,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  };
});

registerJobExecutor("billing_anomaly_scan", async (_run, _def) => {
  const { windowStart, windowEnd } = getDefaultWindow();
  const result = await runBillingAnomalyScan(windowStart, windowEnd);
  return {
    detectorsRun: result.detectorsRun,
    errorCount: result.errors.length,
    errors: result.errors,
    windowStart: result.windowStart,
    windowEnd: result.windowEnd,
    completedAt: result.completedAt,
  };
});

registerJobExecutor("provider_reconciliation_scan", async (_run, _def) => {
  const { windowStart, windowEnd } = getDefaultWindow();
  const result = await runProviderReconciliation("openai", windowStart, windowEnd);
  return {
    reconciliationRunId: result.runId,
    provider: "openai",
    findingCount: result.findingCount,
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
  };
});

registerJobExecutor("billing_audit_scan", async (_run, _def) => {
  const summary = await runFullBillingAudit();
  return {
    auditRunId: summary.runId,
    subRuns: summary.subRuns,
    totalFindings: summary.totalFindings,
    completedAt: new Date().toISOString(),
  };
});

registerJobExecutor("margin_tracking_scan", async (_run, _def) => {
  const runId = await runGlobalMarginTracking();
  return {
    marginTrackingRunId: runId,
    scopeType: "global",
    completedAt: new Date().toISOString(),
  };
});

registerJobExecutor("pending_payment_health_scan", async (_run, _def) => {
  const pendingOld = await previewPendingPaymentsOlderThan(2);
  const failedOld = await previewFailedPaymentsOlderThan(7);
  return {
    pendingPaymentsOlderThan2Days: pendingOld.length,
    failedPaymentsOlderThan7Days: failedOld.length,
    scanCompletedAt: new Date().toISOString(),
  };
});

registerJobExecutor("stale_webhook_health_scan", async (_run, _def) => {
  const unprocessed = await previewWebhookEventsWithoutProcessedState();
  const paymentsWithoutWebhook = await previewPaymentsWithoutWebhookConfirmation();
  return {
    webhookEventsWithoutProcessedState: unprocessed.length,
    paymentsWithoutWebhookConfirmation: paymentsWithoutWebhook.length,
    scanCompletedAt: new Date().toISOString(),
  };
});

registerJobExecutor("stale_admin_change_health_scan", async (_run, _def) => {
  const pendingOld = await previewPendingAdminChangesOlderThan(7);
  const failedOld = await previewFailedAdminChangesOlderThan(30);
  return {
    pendingAdminChangesOlderThan7Days: pendingOld.length,
    failedAdminChangesOlderThan30Days: failedOld.length,
    scanCompletedAt: new Date().toISOString(),
  };
});

// ─── Job Key List ─────────────────────────────────────────────────────────────

export function listPredefinedJobKeys(): string[] {
  return PREDEFINED_JOBS.map((j) => j.jobKey);
}

export function getPredefinedJobSeed(jobKey: string): BillingJobSeed | undefined {
  return PREDEFINED_JOBS.find((j) => j.jobKey === jobKey);
}
