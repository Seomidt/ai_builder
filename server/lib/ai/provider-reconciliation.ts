/**
 * Provider Cost Reconciliation Engine — Phase 4G
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * DETECTION ONLY — does not auto-correct any canonical billing rows.
 * Do not mutate: ai_usage, ai_billing_usage, tenant_credit_ledger,
 * or billing_period_tenant_snapshots.
 *
 * Flow:
 *   1. Create a reconciliation run record (status = 'running')
 *   2. Load provider_usage_snapshots for provider + period
 *   3. Aggregate ai_usage rows in the same period window
 *   4. Aggregate ai_billing_usage rows in the same period window
 *   5. Compare tokens and cost totals → detect drift
 *   6. Detect missing/duplicate billing rows at the usage row level
 *   7. Persist findings in provider_reconciliation_findings
 *   8. Update run record with summary totals + status = 'completed'
 *
 * Period window semantics:
 *   created_at >= period_start AND created_at < period_end  (exclusive end)
 *
 * Severity policy:
 *   'critical' — revenue loss or invoice integrity risk (cost/token mismatch, missing rows)
 *   'warning'  — anomaly worth investigating (duplicate billing, provider drift)
 *   'info'     — benign informational note
 */

import { eq, and, gte, lt } from "drizzle-orm";
import { db } from "../../db";
import {
  providerUsageSnapshots,
  providerReconciliationRuns,
  providerReconciliationFindings,
  aiUsage,
  aiBillingUsage,
} from "@shared/schema";

// ─── Run Lifecycle ────────────────────────────────────────────────────────────

/**
 * Insert a new reconciliation run record with status = 'running'.
 * Returns the run id.
 */
export async function createProviderReconciliationRun(
  provider: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<string> {
  const inserted = await db
    .insert(providerReconciliationRuns)
    .values({
      provider,
      periodStart,
      periodEnd,
      status: "running",
      totalUsageRows: 0,
      totalBillingRows: 0,
      tokenDiff: 0,
      costDiffUsd: "0",
    })
    .returning({ id: providerReconciliationRuns.id });

  return inserted[0].id;
}

export interface ReconciliationRunSummary {
  totalUsageRows: number;
  totalBillingRows: number;
  tokenDiff: number;
  costDiffUsd: number;
}

/**
 * Update a run record to status = 'completed' with aggregate diff totals.
 */
export async function markProviderReconciliationRunCompleted(
  runId: string,
  summary: ReconciliationRunSummary,
): Promise<void> {
  await db
    .update(providerReconciliationRuns)
    .set({
      status: "completed",
      totalUsageRows: summary.totalUsageRows,
      totalBillingRows: summary.totalBillingRows,
      tokenDiff: summary.tokenDiff,
      costDiffUsd: String(summary.costDiffUsd),
      completedAt: new Date(),
    })
    .where(eq(providerReconciliationRuns.id, runId));
}

/**
 * Update a run record to status = 'failed'.
 */
export async function markProviderReconciliationRunFailed(
  runId: string,
  notes?: string,
): Promise<void> {
  await db
    .update(providerReconciliationRuns)
    .set({
      status: "failed",
      completedAt: new Date(),
    })
    .where(eq(providerReconciliationRuns.id, runId));

  if (notes) {
    console.error("[ai/provider-reconciliation] Run failed:", runId, notes);
  }
}

// ─── Finding Write ────────────────────────────────────────────────────────────

export interface RecordProviderReconciliationFindingInput {
  reconciliationRunId: string;
  findingType:
    | "missing_billing_row"
    | "duplicate_billing_row"
    | "token_mismatch"
    | "cost_mismatch"
    | "provider_drift";
  severity: "info" | "warning" | "critical";
  usageId?: string | null;
  billingUsageId?: string | null;
  expectedTokens?: number | null;
  actualTokens?: number | null;
  expectedCostUsd?: number | null;
  actualCostUsd?: number | null;
  tenantId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Persist one reconciliation finding. Append-only — no updates after insert.
 */
export async function recordProviderReconciliationFinding(
  input: RecordProviderReconciliationFindingInput,
): Promise<string> {
  const inserted = await db
    .insert(providerReconciliationFindings)
    .values({
      reconciliationRunId: input.reconciliationRunId,
      findingType: input.findingType,
      severity: input.severity,
      usageId: input.usageId ?? null,
      billingUsageId: input.billingUsageId ?? null,
      expectedTokens: input.expectedTokens ?? null,
      actualTokens: input.actualTokens ?? null,
      expectedCostUsd: input.expectedCostUsd != null ? String(input.expectedCostUsd) : null,
      actualCostUsd: input.actualCostUsd != null ? String(input.actualCostUsd) : null,
      tenantId: input.tenantId ?? null,
      metadata: (input.metadata ?? null) as Record<string, unknown> | null,
    })
    .returning({ id: providerReconciliationFindings.id });

  return inserted[0].id;
}

// ─── Reconciliation Engine ────────────────────────────────────────────────────

export interface ProviderReconciliationResult {
  runId: string;
  provider: string;
  periodStart: Date;
  periodEnd: Date;
  status: "completed" | "failed";
  totalUsageRows: number;
  totalBillingRows: number;
  tokenDiff: number;
  costDiffUsd: number;
  findingCount: number;
}

/**
 * Run a full provider reconciliation for a given provider + period window.
 *
 * Steps:
 *   1. Create run record (status = 'running')
 *   2. Load provider_usage_snapshots for period
 *   3. Aggregate internal ai_usage totals (tokens) for period
 *   4. Aggregate internal ai_billing_usage totals (provider_cost_usd) for period
 *   5. Detect token_mismatch and cost_mismatch at aggregate level
 *   6. Detect missing_billing_row at usage row level
 *   7. Detect duplicate_billing_row at usage row level
 *   8. Mark run completed with summary
 *
 * All period comparisons use: created_at >= periodStart AND created_at < periodEnd
 * Detection only — does not mutate any canonical rows.
 */
export async function runProviderReconciliation(
  provider: string,
  periodStart: Date,
  periodEnd: Date,
): Promise<ProviderReconciliationResult> {
  const runId = await createProviderReconciliationRun(provider, periodStart, periodEnd);
  let findingCount = 0;

  try {
    // ── Step 1: Load provider snapshots ──────────────────────────────────────
    const snapshots = await db
      .select()
      .from(providerUsageSnapshots)
      .where(
        and(
          eq(providerUsageSnapshots.provider, provider),
          gte(providerUsageSnapshots.periodStart, periodStart),
          lt(providerUsageSnapshots.periodEnd, periodEnd),
        ),
      );

    const providerTotalTokens = snapshots.reduce(
      (acc, s) => acc + (s.providerTotalTokens ?? 0),
      0,
    );
    const providerTotalCostUsd = snapshots.reduce(
      (acc, s) => acc + Number(s.providerCostUsd ?? 0),
      0,
    );

    // ── Step 2: Aggregate internal ai_usage for period ───────────────────────
    const usageRows = await db
      .select({
        id: aiUsage.id,
        tenantId: aiUsage.tenantId,
        totalTokens: aiUsage.totalTokens,
        requestId: aiUsage.requestId,
      })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.provider, provider),
          gte(aiUsage.createdAt, periodStart),
          lt(aiUsage.createdAt, periodEnd),
          eq(aiUsage.status, "success"),
        ),
      );

    const internalTotalTokens = usageRows.reduce((acc, r) => acc + (r.totalTokens ?? 0), 0);
    const totalUsageRows = usageRows.length;

    // ── Step 3: Aggregate internal ai_billing_usage for period ───────────────
    const billingRows = await db
      .select({
        id: aiBillingUsage.id,
        usageId: aiBillingUsage.usageId,
        tenantId: aiBillingUsage.tenantId,
        providerCostUsd: aiBillingUsage.providerCostUsd,
      })
      .from(aiBillingUsage)
      .where(
        and(
          eq(aiBillingUsage.provider, provider),
          gte(aiBillingUsage.createdAt, periodStart),
          lt(aiBillingUsage.createdAt, periodEnd),
        ),
      );

    const internalTotalCostUsd = billingRows.reduce(
      (acc, r) => acc + Number(r.providerCostUsd ?? 0),
      0,
    );
    const totalBillingRows = billingRows.length;

    // ── Step 4: Token mismatch ────────────────────────────────────────────────
    const tokenDiff = providerTotalTokens - internalTotalTokens;

    if (snapshots.length > 0 && Math.abs(tokenDiff) > 0) {
      await recordProviderReconciliationFinding({
        reconciliationRunId: runId,
        findingType: "token_mismatch",
        severity: Math.abs(tokenDiff) > 10000 ? "critical" : "warning",
        expectedTokens: providerTotalTokens,
        actualTokens: internalTotalTokens,
        metadata: {
          tokenDiff,
          provider,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
          snapshotCount: snapshots.length,
        },
      });
      findingCount++;
    }

    // ── Step 5: Cost mismatch ─────────────────────────────────────────────────
    const costDiffUsd = providerTotalCostUsd - internalTotalCostUsd;
    const costDiffAbs = Math.abs(costDiffUsd);

    if (snapshots.length > 0 && costDiffAbs > 0.00001) {
      await recordProviderReconciliationFinding({
        reconciliationRunId: runId,
        findingType: "cost_mismatch",
        severity: costDiffAbs > 1.0 ? "critical" : "warning",
        expectedCostUsd: providerTotalCostUsd,
        actualCostUsd: internalTotalCostUsd,
        metadata: {
          costDiffUsd,
          provider,
          periodStart: periodStart.toISOString(),
          periodEnd: periodEnd.toISOString(),
        },
      });
      findingCount++;
    }

    // ── Step 6: Missing / duplicate billing rows ──────────────────────────────
    const billingByUsageId = new Map<string, number>();
    for (const br of billingRows) {
      billingByUsageId.set(br.usageId, (billingByUsageId.get(br.usageId) ?? 0) + 1);
    }

    for (const ur of usageRows) {
      const billingCount = billingByUsageId.get(ur.id) ?? 0;

      if (billingCount === 0) {
        await recordProviderReconciliationFinding({
          reconciliationRunId: runId,
          findingType: "missing_billing_row",
          severity: "critical",
          usageId: ur.id,
          tenantId: ur.tenantId ?? null,
          metadata: {
            requestId: ur.requestId ?? null,
            provider,
            internalTokens: ur.totalTokens ?? 0,
          },
        });
        findingCount++;
      } else if (billingCount > 1) {
        await recordProviderReconciliationFinding({
          reconciliationRunId: runId,
          findingType: "duplicate_billing_row",
          severity: "warning",
          usageId: ur.id,
          tenantId: ur.tenantId ?? null,
          metadata: {
            requestId: ur.requestId ?? null,
            provider,
            billingRowCount: billingCount,
          },
        });
        findingCount++;
      }
    }

    // ── Step 7: Mark completed ────────────────────────────────────────────────
    const finalCostDiff = snapshots.length > 0 ? costDiffUsd : 0;
    const finalTokenDiff = snapshots.length > 0 ? tokenDiff : 0;

    await markProviderReconciliationRunCompleted(runId, {
      totalUsageRows,
      totalBillingRows,
      tokenDiff: finalTokenDiff,
      costDiffUsd: finalCostDiff,
    });

    return {
      runId,
      provider,
      periodStart,
      periodEnd,
      status: "completed",
      totalUsageRows,
      totalBillingRows,
      tokenDiff: finalTokenDiff,
      costDiffUsd: finalCostDiff,
      findingCount,
    };
  } catch (err) {
    await markProviderReconciliationRunFailed(
      runId,
      err instanceof Error ? err.message : String(err),
    );
    console.error(
      "[ai/provider-reconciliation] Reconciliation run failed:",
      err instanceof Error ? err.message : err,
      "runId:", runId,
    );
    return {
      runId,
      provider,
      periodStart,
      periodEnd,
      status: "failed",
      totalUsageRows: 0,
      totalBillingRows: 0,
      tokenDiff: 0,
      costDiffUsd: 0,
      findingCount,
    };
  }
}
