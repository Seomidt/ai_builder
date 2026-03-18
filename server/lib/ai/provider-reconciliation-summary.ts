/**
 * Provider Reconciliation Summary — Phase 4G
 *
 * SERVER-ONLY: Read helpers for provider_reconciliation_runs
 * and provider_reconciliation_findings tables.
 *
 * Backend-only — no UI. Used for admin visibility and forensic debugging.
 */

import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "../../db";
import { providerReconciliationRuns, providerReconciliationFindings } from "@shared/schema";
import type { ProviderReconciliationRun, ProviderReconciliationFinding } from "@shared/schema";

// ─── List Runs ────────────────────────────────────────────────────────────────

/**
 * Return reconciliation runs for a provider, newest first.
 * Limit defaults to 50.
 */
export async function getProviderReconciliationRuns(
  provider: string,
  limit = 50,
): Promise<ProviderReconciliationRun[]> {
  return db
    .select()
    .from(providerReconciliationRuns)
    .where(eq(providerReconciliationRuns.provider, provider))
    .orderBy(desc(providerReconciliationRuns.createdAt))
    .limit(limit);
}

// ─── List Findings ────────────────────────────────────────────────────────────

/**
 * Return all findings for a specific reconciliation run.
 * Ordered by severity descending (critical first), then created_at.
 */
export async function getProviderReconciliationFindings(
  runId: string,
  limit = 200,
): Promise<ProviderReconciliationFinding[]> {
  return db
    .select()
    .from(providerReconciliationFindings)
    .where(eq(providerReconciliationFindings.reconciliationRunId, runId))
    .orderBy(desc(providerReconciliationFindings.severity), providerReconciliationFindings.createdAt)
    .limit(limit);
}

// ─── Latest Run Summary ───────────────────────────────────────────────────────

export interface LatestProviderReconciliationSummary {
  runId: string;
  provider: string;
  status: string;
  periodStart: Date;
  periodEnd: Date;
  totalUsageRows: number;
  totalBillingRows: number;
  tokenDiff: number;
  costDiffUsd: number;
  findingCount: number;
  criticalCount: number;
  warningCount: number;
  infoCount: number;
  findingsByType: Record<string, number>;
  createdAt: Date;
  completedAt: Date | null;
}

/**
 * Return a structured summary for the latest completed reconciliation run
 * for a given provider. Returns null if no runs exist.
 *
 * Includes:
 *   - run status and aggregate diff totals
 *   - finding counts by severity
 *   - finding counts by type
 */
export async function getLatestProviderReconciliationSummary(
  provider: string,
): Promise<LatestProviderReconciliationSummary | null> {
  const runs = await db
    .select()
    .from(providerReconciliationRuns)
    .where(
      and(
        eq(providerReconciliationRuns.provider, provider),
        eq(providerReconciliationRuns.status, "completed"),
      ),
    )
    .orderBy(desc(providerReconciliationRuns.createdAt))
    .limit(1);

  if (runs.length === 0) return null;
  const run = runs[0];

  // Aggregate findings for this run
  const [agg] = await db
    .select({
      totalCount: sql<string>`COUNT(*)`,
      criticalCount: sql<string>`COUNT(*) FILTER (WHERE severity = 'critical')`,
      warningCount: sql<string>`COUNT(*) FILTER (WHERE severity = 'warning')`,
      infoCount: sql<string>`COUNT(*) FILTER (WHERE severity = 'info')`,
    })
    .from(providerReconciliationFindings)
    .where(eq(providerReconciliationFindings.reconciliationRunId, run.id));

  // Counts by finding_type
  const byType = await db
    .select({
      findingType: providerReconciliationFindings.findingType,
      cnt: sql<string>`COUNT(*)`,
    })
    .from(providerReconciliationFindings)
    .where(eq(providerReconciliationFindings.reconciliationRunId, run.id))
    .groupBy(providerReconciliationFindings.findingType);

  const findingsByType: Record<string, number> = {};
  for (const row of byType) {
    findingsByType[row.findingType] = Number(row.cnt);
  }

  return {
    runId: run.id,
    provider: run.provider,
    status: run.status,
    periodStart: run.periodStart,
    periodEnd: run.periodEnd,
    totalUsageRows: run.totalUsageRows,
    totalBillingRows: run.totalBillingRows,
    tokenDiff: run.tokenDiff,
    costDiffUsd: Number(run.costDiffUsd),
    findingCount: Number(agg?.totalCount ?? 0),
    criticalCount: Number(agg?.criticalCount ?? 0),
    warningCount: Number(agg?.warningCount ?? 0),
    infoCount: Number(agg?.infoCount ?? 0),
    findingsByType,
    createdAt: run.createdAt,
    completedAt: run.completedAt ?? null,
  };
}
