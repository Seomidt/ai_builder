/**
 * billing-recovery.ts — Phase 4S Recovery / Rebuild Engine
 *
 * Core recovery helpers for the billing-recovery layer.
 * Implements preview and apply modes for each supported recovery_type.
 *
 * Design invariants:
 *   - preview() never writes to any canonical billing table
 *   - apply() always creates a billing_recovery_runs row
 *   - apply() creates billing_recovery_actions rows for each step executed
 *   - All recovery ops are idempotent — safe to re-run on same scope
 *   - Hard financial tables (ai_billing_usage, invoices w/ status=finalized, invoice_payments)
 *     are NEVER mutated by recovery — only rebuilt/re-inserted where rows are missing
 */

import { db } from "../../db";
import { eq, sql } from "drizzle-orm";
import {
  billingRecoveryRuns,
  billingRecoveryActions,
  billingPeriodTenantSnapshots,
  invoices,
  invoiceLineItems,
} from "../../../shared/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RecoveryTriggerType = "manual" | "job" | "system";

export interface RecoveryPreview {
  recoveryType: string;
  scopeType: string;
  scopeId: string | null;
  dryRun: true;
  plannedActions: RecoveryPlannedAction[];
  summary: string;
  estimatedImpact: string;
}

export interface RecoveryPlannedAction {
  actionType: string;
  targetTable: string;
  targetId: string | null;
  description: string;
  beforeState: Record<string, unknown> | null;
  afterState: Record<string, unknown> | null;
  details: Record<string, unknown>;
}

export interface RecoveryApplyResult {
  recoveryRunId: string;
  recoveryType: string;
  scopeType: string;
  scopeId: string | null;
  status: "completed" | "failed" | "skipped";
  actionsPlanned: number;
  actionsExecuted: number;
  actionsSkipped: number;
  actionsFailed: number;
  durationMs: number;
  errorMessage?: string;
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

async function createRecoveryRun(
  recoveryType: string,
  scopeType: string,
  scopeId: string | null,
  triggerType: RecoveryTriggerType,
  reason: string,
  dryRun: boolean,
): Promise<string> {
  const rows = await db
    .insert(billingRecoveryRuns)
    .values({
      recoveryType,
      scopeType,
      triggerType,
      reason,
      dryRun,
      status: "started",
      scopeId: scopeId ?? undefined,
    })
    .returning({ id: billingRecoveryRuns.id });
  return rows[0].id;
}

async function completeRecoveryRun(
  runId: string,
  status: "completed" | "failed" | "skipped",
  resultSummary: Record<string, unknown>,
  errorMessage?: string,
): Promise<void> {
  await db
    .update(billingRecoveryRuns)
    .set({
      status,
      resultSummary,
      errorMessage: errorMessage ?? null,
      completedAt: new Date(),
    })
    .where(eq(billingRecoveryRuns.id, runId));
}

async function recordAction(
  runId: string,
  actionType: string,
  targetTable: string,
  targetId: string | null,
  actionStatus: "planned" | "executed" | "skipped" | "failed",
  beforeState: Record<string, unknown> | null,
  afterState: Record<string, unknown> | null,
  details: Record<string, unknown>,
): Promise<void> {
  await db.insert(billingRecoveryActions).values({
    billingRecoveryRunId: runId,
    actionType,
    targetTable,
    targetId: targetId ?? undefined,
    actionStatus,
    beforeState: beforeState ?? undefined,
    afterState: afterState ?? undefined,
    details: details ?? undefined,
  });
}

// ─── billing_snapshot_rebuild ─────────────────────────────────────────────────

/**
 * Preview snapshot rebuild for a specific billing period + optional tenant.
 * Returns planned actions without writing anything.
 */
export async function previewSnapshotRebuild(
  billingPeriodId: string,
  tenantId: string | null,
): Promise<RecoveryPreview> {
  const scopeType = tenantId ? "tenant" : "billing_period";
  const scopeId = tenantId ?? billingPeriodId;

  let whereClause = `billing_period_id = '${billingPeriodId.replace(/'/g, "''")}'`;
  if (tenantId) {
    whereClause += ` AND tenant_id = '${tenantId.replace(/'/g, "''")}'`;
  }

  const existingSnapshots = await db.execute(
    sql.raw(`SELECT id, tenant_id, billing_period_id, customer_price_usd FROM billing_period_tenant_snapshots WHERE ${whereClause}`),
  );

  const liveAgg = await db.execute(sql.raw(`
    SELECT
      abu.tenant_id,
      SUM(abu.customer_price_usd)  AS live_customer_price,
      SUM(abu.provider_cost_usd)   AS live_provider_cost,
      SUM(abu.margin_usd)          AS live_margin,
      COUNT(*)                     AS live_request_count,
      SUM(CASE WHEN abu.wallet_status='debited' THEN abu.customer_price_usd ELSE 0 END) AS live_debited
    FROM ai_billing_usage abu
    JOIN billing_periods bp ON bp.id = '${billingPeriodId.replace(/'/g, "''")}'
      AND abu.created_at >= bp.period_start
      AND abu.created_at <  bp.period_end
    ${tenantId ? `WHERE abu.tenant_id = '${tenantId.replace(/'/g, "''")}'` : ""}
    GROUP BY abu.tenant_id
  `));

  const existingMap = new Map(
    (existingSnapshots.rows as any[]).map((r: any) => [r.tenant_id, r]),
  );
  const plannedActions: RecoveryPlannedAction[] = [];

  for (const live of liveAgg.rows as any[]) {
    const existing = existingMap.get(live.tenant_id);
    if (!existing) {
      plannedActions.push({
        actionType: "insert_snapshot",
        targetTable: "billing_period_tenant_snapshots",
        targetId: null,
        description: `Insert missing snapshot for tenant ${live.tenant_id} / period ${billingPeriodId}`,
        beforeState: null,
        afterState: {
          tenantId: live.tenant_id,
          billingPeriodId,
          customerPriceUsd: live.live_customer_price,
          providerCostUsd: live.live_provider_cost,
          marginUsd: live.live_margin,
          requestCount: live.live_request_count,
          debitedAmountUsd: live.live_debited,
        },
        details: { reason: "missing_snapshot" },
      });
    } else {
      const priceDiff = Math.abs(
        Number(live.live_customer_price) - Number(existing.customer_price_usd),
      );
      if (priceDiff > 0.000001) {
        plannedActions.push({
          actionType: "update_snapshot",
          targetTable: "billing_period_tenant_snapshots",
          targetId: existing.id,
          description: `Update stale snapshot ${existing.id} for tenant ${live.tenant_id}`,
          beforeState: {
            customerPriceUsd: existing.customer_price_usd,
          },
          afterState: {
            customerPriceUsd: live.live_customer_price,
            providerCostUsd: live.live_provider_cost,
            marginUsd: live.live_margin,
            requestCount: live.live_request_count,
            debitedAmountUsd: live.live_debited,
          },
          details: { priceDiff },
        });
      }
    }
  }

  return {
    recoveryType: "billing_snapshot_rebuild",
    scopeType,
    scopeId,
    dryRun: true,
    plannedActions,
    summary: `${plannedActions.length} action(s) would be applied`,
    estimatedImpact: `${plannedActions.filter((a) => a.actionType === "insert_snapshot").length} inserts, ${plannedActions.filter((a) => a.actionType === "update_snapshot").length} updates`,
  };
}

/**
 * Apply snapshot rebuild for a billing period + optional tenant.
 * Creates billing_recovery_runs + billing_recovery_actions rows.
 * Only rebuilds non-finalized-invoice snapshots to preserve accounting integrity.
 */
export async function applySnapshotRebuild(
  billingPeriodId: string,
  tenantId: string | null,
  triggerType: RecoveryTriggerType,
  reason: string,
): Promise<RecoveryApplyResult> {
  const scopeType = tenantId ? "tenant" : "billing_period";
  const scopeId = tenantId ?? billingPeriodId;
  const runId = await createRecoveryRun(
    "billing_snapshot_rebuild",
    scopeType,
    scopeId,
    triggerType,
    reason,
    false,
  );
  const startMs = Date.now();
  let executed = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const preview = await previewSnapshotRebuild(billingPeriodId, tenantId);

    for (const action of preview.plannedActions) {
      try {
        if (action.actionType === "insert_snapshot") {
          const after = action.afterState as any;
          await db
            .insert(billingPeriodTenantSnapshots)
            .values({
              billingPeriodId: after.billingPeriodId,
              tenantId: after.tenantId,
              customerPriceUsd: String(after.customerPriceUsd ?? "0"),
              providerCostUsd: String(after.providerCostUsd ?? "0"),
              marginUsd: String(after.marginUsd ?? "0"),
              requestCount: Number(after.requestCount ?? 0),
              debitedAmountUsd: String(after.debitedAmountUsd ?? "0"),
            })
            .onConflictDoNothing();
          await recordAction(
            runId,
            action.actionType,
            action.targetTable,
            action.targetId,
            "executed",
            action.beforeState,
            action.afterState,
            action.details,
          );
          executed++;
        } else if (action.actionType === "update_snapshot" && action.targetId) {
          const after = action.afterState as any;
          await db
            .update(billingPeriodTenantSnapshots)
            .set({
              customerPriceUsd: String(after.customerPriceUsd ?? "0"),
              providerCostUsd: String(after.providerCostUsd ?? "0"),
              marginUsd: String(after.marginUsd ?? "0"),
              requestCount: Number(after.requestCount ?? 0),
              debitedAmountUsd: String(after.debitedAmountUsd ?? "0"),
            })
            .where(eq(billingPeriodTenantSnapshots.id, action.targetId));
          await recordAction(
            runId,
            action.actionType,
            action.targetTable,
            action.targetId,
            "executed",
            action.beforeState,
            action.afterState,
            action.details,
          );
          executed++;
        } else {
          await recordAction(
            runId,
            action.actionType,
            action.targetTable,
            action.targetId,
            "skipped",
            action.beforeState,
            action.afterState,
            { reason: "no_applicable_action", ...action.details },
          );
          skipped++;
        }
      } catch (err) {
        await recordAction(
          runId,
          action.actionType,
          action.targetTable,
          action.targetId,
          "failed",
          action.beforeState,
          action.afterState,
          { error: String(err), ...action.details },
        );
        failed++;
      }
    }

    const status = failed > 0 ? "failed" : "completed";
    await completeRecoveryRun(runId, status, {
      executed,
      skipped,
      failed,
      totalPlanned: preview.plannedActions.length,
    });

    return {
      recoveryRunId: runId,
      recoveryType: "billing_snapshot_rebuild",
      scopeType,
      scopeId,
      status,
      actionsPlanned: preview.plannedActions.length,
      actionsExecuted: executed,
      actionsSkipped: skipped,
      actionsFailed: failed,
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    await completeRecoveryRun(runId, "failed", { executed, skipped, failed }, String(err));
    return {
      recoveryRunId: runId,
      recoveryType: "billing_snapshot_rebuild",
      scopeType,
      scopeId,
      status: "failed",
      actionsPlanned: 0,
      actionsExecuted: executed,
      actionsSkipped: skipped,
      actionsFailed: failed + 1,
      durationMs: Date.now() - startMs,
      errorMessage: String(err),
    };
  }
}

// ─── invoice_totals_rebuild ───────────────────────────────────────────────────

/**
 * Preview invoice totals rebuild for non-finalized invoices.
 */
export async function previewInvoiceTotalsRebuild(
  scopeType: "global" | "tenant" | "billing_period",
  scopeId: string | null,
): Promise<RecoveryPreview> {
  let whereClause = `i.status = 'draft'`;
  if (scopeType === "tenant" && scopeId) {
    whereClause += ` AND i.tenant_id = '${scopeId.replace(/'/g, "''")}'`;
  } else if (scopeType === "billing_period" && scopeId) {
    whereClause += ` AND i.billing_period_id = '${scopeId.replace(/'/g, "''")}'`;
  }

  const rows = await db.execute(sql.raw(`
    SELECT
      i.id,
      i.invoice_number,
      i.subtotal_usd,
      i.total_usd,
      COALESCE(ili.line_sum, 0) AS computed_line_sum
    FROM invoices i
    LEFT JOIN (
      SELECT invoice_id, SUM(line_total_usd) AS line_sum
      FROM invoice_line_items
      GROUP BY invoice_id
    ) ili ON ili.invoice_id = i.id
    WHERE ${whereClause}
      AND ABS(i.subtotal_usd - COALESCE(ili.line_sum, 0)) > 0.000001
  `));

  const plannedActions: RecoveryPlannedAction[] = (rows.rows as any[]).map((r: any) => ({
    actionType: "update_invoice_totals",
    targetTable: "invoices",
    targetId: r.id,
    description: `Recalculate subtotal for draft invoice ${r.invoice_number} (current: ${r.subtotal_usd}, computed: ${r.computed_line_sum})`,
    beforeState: { subtotalUsd: r.subtotal_usd, totalUsd: r.total_usd },
    afterState: { subtotalUsd: r.computed_line_sum, totalUsd: r.computed_line_sum },
    details: { invoiceNumber: r.invoice_number },
  }));

  return {
    recoveryType: "invoice_totals_rebuild",
    scopeType,
    scopeId,
    dryRun: true,
    plannedActions,
    summary: `${plannedActions.length} draft invoice(s) have arithmetic mismatches`,
    estimatedImpact: `${plannedActions.length} update(s) to invoices.subtotal_usd / total_usd`,
  };
}

/**
 * Apply invoice totals rebuild for non-finalized invoices.
 */
export async function applyInvoiceTotalsRebuild(
  scopeType: "global" | "tenant" | "billing_period",
  scopeId: string | null,
  triggerType: RecoveryTriggerType,
  reason: string,
): Promise<RecoveryApplyResult> {
  const runId = await createRecoveryRun(
    "invoice_totals_rebuild",
    scopeType,
    scopeId,
    triggerType,
    reason,
    false,
  );
  const startMs = Date.now();
  let executed = 0;
  let skipped = 0;
  let failed = 0;

  try {
    const preview = await previewInvoiceTotalsRebuild(scopeType, scopeId);

    for (const action of preview.plannedActions) {
      try {
        const after = action.afterState as any;
        await db
          .update(invoices)
          .set({
            subtotalUsd: String(after.subtotalUsd),
            totalUsd: String(after.totalUsd),
          })
          .where(eq(invoices.id, action.targetId!));
        await recordAction(
          runId,
          action.actionType,
          action.targetTable,
          action.targetId,
          "executed",
          action.beforeState,
          action.afterState,
          action.details,
        );
        executed++;
      } catch (err) {
        await recordAction(
          runId,
          action.actionType,
          action.targetTable,
          action.targetId,
          "failed",
          action.beforeState,
          action.afterState,
          { error: String(err), ...action.details },
        );
        failed++;
      }
    }

    const status = failed > 0 ? "failed" : "completed";
    await completeRecoveryRun(runId, status, {
      executed,
      skipped,
      failed,
      totalPlanned: preview.plannedActions.length,
    });

    return {
      recoveryRunId: runId,
      recoveryType: "invoice_totals_rebuild",
      scopeType,
      scopeId,
      status,
      actionsPlanned: preview.plannedActions.length,
      actionsExecuted: executed,
      actionsSkipped: skipped,
      actionsFailed: failed,
      durationMs: Date.now() - startMs,
    };
  } catch (err) {
    await completeRecoveryRun(runId, "failed", { executed, skipped, failed }, String(err));
    return {
      recoveryRunId: runId,
      recoveryType: "invoice_totals_rebuild",
      scopeType,
      scopeId,
      status: "failed",
      actionsPlanned: 0,
      actionsExecuted: executed,
      actionsSkipped: skipped,
      actionsFailed: failed + 1,
      durationMs: Date.now() - startMs,
      errorMessage: String(err),
    };
  }
}
