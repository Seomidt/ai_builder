/**
 * Provider Reconciliation Summary
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Backend-only summary helpers for reconciliation health monitoring.
 * Used for admin visibility into discrepancy patterns and reconciliation coverage.
 *
 * Phase 4C: foundation only. No public API, no UI.
 */

import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { db } from "../../db";
import { aiProviderReconciliationRuns, aiProviderReconciliationDeltas } from "@shared/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReconciliationRunSummary {
  runId: string;
  provider: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  totalDeltas: number;
  criticalDeltas: number;
  warningDeltas: number;
  infoDeltas: number;
  createdAt: string;
  completedAt: string | null;
}

export interface ReconciliationHealthSummary {
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  startedRuns: number;
  totalDeltas: number;
  criticalDeltas: number;
  warningDeltas: number;
  latestRunAt: string | null;
  latestCriticalDeltaAt: string | null;
}

// ─── Run Summary ──────────────────────────────────────────────────────────────

/**
 * Return a summary for a single reconciliation run with delta counts by severity.
 * Throws on DB error.
 */
export async function getReconciliationRunSummary(
  runId: string,
): Promise<ReconciliationRunSummary | null> {
  const runs = await db
    .select()
    .from(aiProviderReconciliationRuns)
    .where(eq(aiProviderReconciliationRuns.id, runId))
    .limit(1);

  if (runs.length === 0) return null;
  const run = runs[0];

  const [deltas] = await db
    .select({
      totalDeltas: sql<string>`COUNT(*)`,
      criticalDeltas: sql<string>`COUNT(*) FILTER (WHERE severity = 'critical')`,
      warningDeltas: sql<string>`COUNT(*) FILTER (WHERE severity = 'warning')`,
      infoDeltas: sql<string>`COUNT(*) FILTER (WHERE severity = 'info')`,
    })
    .from(aiProviderReconciliationDeltas)
    .where(eq(aiProviderReconciliationDeltas.runId, runId));

  return {
    runId: run.id,
    provider: run.provider,
    periodStart: run.periodStart.toISOString(),
    periodEnd: run.periodEnd.toISOString(),
    status: run.status,
    totalDeltas: Number(deltas?.totalDeltas ?? 0),
    criticalDeltas: Number(deltas?.criticalDeltas ?? 0),
    warningDeltas: Number(deltas?.warningDeltas ?? 0),
    infoDeltas: Number(deltas?.infoDeltas ?? 0),
    createdAt: run.createdAt.toISOString(),
    completedAt: run.completedAt?.toISOString() ?? null,
  };
}

// ─── Global Health Summary ────────────────────────────────────────────────────

/**
 * Return a global reconciliation health summary across all providers and runs.
 * Throws on DB error.
 */
export async function getReconciliationHealthSummary(): Promise<ReconciliationHealthSummary> {
  const [runsAgg] = await db
    .select({
      totalRuns: sql<string>`COUNT(*)`,
      completedRuns: sql<string>`COUNT(*) FILTER (WHERE status = 'completed')`,
      failedRuns: sql<string>`COUNT(*) FILTER (WHERE status = 'failed')`,
      startedRuns: sql<string>`COUNT(*) FILTER (WHERE status = 'started')`,
    })
    .from(aiProviderReconciliationRuns);

  const [deltasAgg] = await db
    .select({
      totalDeltas: sql<string>`COUNT(*)`,
      criticalDeltas: sql<string>`COUNT(*) FILTER (WHERE severity = 'critical')`,
      warningDeltas: sql<string>`COUNT(*) FILTER (WHERE severity = 'warning')`,
    })
    .from(aiProviderReconciliationDeltas);

  const latestRun = await db
    .select({ createdAt: aiProviderReconciliationRuns.createdAt })
    .from(aiProviderReconciliationRuns)
    .orderBy(desc(aiProviderReconciliationRuns.createdAt))
    .limit(1);

  const latestCritical = await db
    .select({ createdAt: aiProviderReconciliationDeltas.createdAt })
    .from(aiProviderReconciliationDeltas)
    .where(eq(aiProviderReconciliationDeltas.severity, "critical"))
    .orderBy(desc(aiProviderReconciliationDeltas.createdAt))
    .limit(1);

  return {
    totalRuns: Number(runsAgg?.totalRuns ?? 0),
    completedRuns: Number(runsAgg?.completedRuns ?? 0),
    failedRuns: Number(runsAgg?.failedRuns ?? 0),
    startedRuns: Number(runsAgg?.startedRuns ?? 0),
    totalDeltas: Number(deltasAgg?.totalDeltas ?? 0),
    criticalDeltas: Number(deltasAgg?.criticalDeltas ?? 0),
    warningDeltas: Number(deltasAgg?.warningDeltas ?? 0),
    latestRunAt: latestRun[0]?.createdAt?.toISOString() ?? null,
    latestCriticalDeltaAt: latestCritical[0]?.createdAt?.toISOString() ?? null,
  };
}
