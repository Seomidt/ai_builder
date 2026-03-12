/**
 * Provider Reconciliation Foundation
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides backend helpers to record and query provider reconciliation runs
 * and their associated delta entries.
 *
 * Design principles:
 *   - Detection only — this module NEVER auto-corrects billing rows
 *   - ai_billing_usage is immutable — reconciliation deltas are observations only
 *   - Manual/admin initiated — no automatic fetching of provider invoices
 *   - Future: wire to OpenAI Usage API or provider invoice endpoints
 *
 * Phase 4C: foundation only. Tables and helpers exist; no provider API calls.
 *
 * Reconciliation flow (future):
 *   1. Create a run record (status='started')
 *   2. Fetch provider usage data for the period externally
 *   3. Compare against internal ai_billing_usage rows
 *   4. Insert delta rows for any discrepancies
 *   5. Update run status to 'completed' or 'failed'
 *   6. Review deltas manually or via admin dashboard
 */

import { eq, and, desc, inArray } from "drizzle-orm";
import { db } from "../../db";
import { aiProviderReconciliationRuns, aiProviderReconciliationDeltas } from "@shared/schema";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReconciliationStatus = "started" | "completed" | "failed";
export type MetricType =
  | "provider_cost_delta"
  | "request_count_delta"
  | "input_tokens_delta"
  | "output_tokens_delta"
  | "total_tokens_delta";
export type DeltaSeverity = "info" | "warning" | "critical";

export interface CreateRunInput {
  provider: string;
  periodStart: Date;
  periodEnd: Date;
  notes?: string | null;
}

export interface CreateDeltaInput {
  runId: string;
  tenantId?: string | null;
  provider: string;
  model?: string | null;
  metricType: MetricType;
  internalValue?: number | null;
  externalValue?: number | null;
  deltaValue?: number | null;
  severity: DeltaSeverity;
  notes?: string | null;
}

// ─── Run Management ───────────────────────────────────────────────────────────

/**
 * Start a new reconciliation run.
 * Returns the new run id.
 */
export async function startReconciliationRun(input: CreateRunInput): Promise<string> {
  const inserted = await db
    .insert(aiProviderReconciliationRuns)
    .values({
      provider: input.provider,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      status: "started",
      notes: input.notes ?? null,
    })
    .returning({ id: aiProviderReconciliationRuns.id });

  return inserted[0].id;
}

/**
 * Complete a reconciliation run (status → 'completed', completedAt set).
 */
export async function completeReconciliationRun(runId: string, notes?: string): Promise<void> {
  await db
    .update(aiProviderReconciliationRuns)
    .set({ status: "completed", completedAt: new Date(), notes: notes ?? null })
    .where(eq(aiProviderReconciliationRuns.id, runId));
}

/**
 * Fail a reconciliation run (status → 'failed').
 */
export async function failReconciliationRun(runId: string, reason?: string): Promise<void> {
  await db
    .update(aiProviderReconciliationRuns)
    .set({ status: "failed", completedAt: new Date(), notes: reason ?? null })
    .where(eq(aiProviderReconciliationRuns.id, runId));
}

// ─── Delta Management ─────────────────────────────────────────────────────────

/**
 * Insert one reconciliation delta row.
 *
 * Detection only — this does NOT modify billing rows.
 * Returns the new delta id.
 */
export async function insertReconciliationDelta(input: CreateDeltaInput): Promise<string> {
  const inserted = await db
    .insert(aiProviderReconciliationDeltas)
    .values({
      runId: input.runId,
      tenantId: input.tenantId ?? null,
      provider: input.provider,
      model: input.model ?? null,
      metricType: input.metricType,
      internalValue: input.internalValue != null ? String(input.internalValue) : null,
      externalValue: input.externalValue != null ? String(input.externalValue) : null,
      deltaValue: input.deltaValue != null ? String(input.deltaValue) : null,
      severity: input.severity,
      notes: input.notes ?? null,
    })
    .returning({ id: aiProviderReconciliationDeltas.id });

  return inserted[0].id;
}

/**
 * Insert multiple delta rows for a run in one DB call.
 * Returns the count of inserted rows.
 */
export async function insertReconciliationDeltas(inputs: CreateDeltaInput[]): Promise<number> {
  if (inputs.length === 0) return 0;

  const inserted = await db
    .insert(aiProviderReconciliationDeltas)
    .values(
      inputs.map((input) => ({
        runId: input.runId,
        tenantId: input.tenantId ?? null,
        provider: input.provider,
        model: input.model ?? null,
        metricType: input.metricType,
        internalValue: input.internalValue != null ? String(input.internalValue) : null,
        externalValue: input.externalValue != null ? String(input.externalValue) : null,
        deltaValue: input.deltaValue != null ? String(input.deltaValue) : null,
        severity: input.severity,
        notes: input.notes ?? null,
      })),
    )
    .returning({ id: aiProviderReconciliationDeltas.id });

  return inserted.length;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * Get all runs for a provider, ordered newest first.
 */
export async function getReconciliationRunsForProvider(
  provider: string,
  limit = 50,
) {
  return db
    .select()
    .from(aiProviderReconciliationRuns)
    .where(eq(aiProviderReconciliationRuns.provider, provider))
    .orderBy(desc(aiProviderReconciliationRuns.createdAt))
    .limit(limit);
}

/**
 * Get all deltas for a run.
 */
export async function getReconciliationDeltasForRun(runId: string) {
  return db
    .select()
    .from(aiProviderReconciliationDeltas)
    .where(eq(aiProviderReconciliationDeltas.runId, runId))
    .orderBy(desc(aiProviderReconciliationDeltas.severity));
}

/**
 * Get all critical or warning deltas for a run (for alerting).
 */
export async function getSignificantDeltasForRun(runId: string) {
  return db
    .select()
    .from(aiProviderReconciliationDeltas)
    .where(
      and(
        eq(aiProviderReconciliationDeltas.runId, runId),
        inArray(aiProviderReconciliationDeltas.severity, ["warning", "critical"]),
      ),
    )
    .orderBy(desc(aiProviderReconciliationDeltas.severity));
}
