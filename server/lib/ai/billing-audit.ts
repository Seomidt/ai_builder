/**
 * Billing Audit & Reconciliation Engine
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides deterministic billing consistency checks across all layers:
 *   - ai_usage ↔ ai_billing_usage (usage/billing consistency)
 *   - ai_billing_usage ↔ tenant_credit_ledger (billing/wallet consistency)
 *   - billing_period_tenant_snapshots ↔ live ai_billing_usage aggregation (period integrity)
 *
 * Design rules:
 *   - Detection only — never mutates financial rows, wallet rows, or snapshots
 *   - Findings are stored as immutable audit records in billing_audit_findings
 *   - All checks are multi-tenant safe — findings always carry tenant_id
 *   - No blocking logic inserted into the provider runtime path
 *
 * Phase 4E: internal audit foundation only.
 * No scheduler, no admin UI, no external metrics in this phase.
 *
 * Severity policy (AUDIT_SEVERITY_POLICY):
 *   critical:
 *     - missing_billing_row         (revenue leak — usage billed but not recorded)
 *     - orphan_billing_row          (phantom billing — billed without usage)
 *     - missing_wallet_debit        (billing says debited but no ledger row)
 *     - duplicate_wallet_debit      (double-charging)
 *     - period_total_mismatch       (invoice integrity — snapshot != live)
 *     - snapshot_total_mismatch     (customer_price or provider_cost disagrees)
 *   warning:
 *     - wallet_amount_mismatch      (debit amount differs from expected)
 *     - request_count_mismatch      (snapshot request count off)
 *     - negative_margin_detected    (selling below cost)
 *     - orphan_wallet_debit         (ledger debit for missing billing row)
 *     - missing_snapshot_row        (tenant active in period but no snapshot)
 *   info:
 *     - orphan_snapshot_row         (snapshot exists but zero live activity)
 *     - invalid_pricing_result      (arithmetic inconsistency in pricing columns)
 *     - tenant_mismatch             (metadata disagreement, not financial)
 */

import { eq, and, isNull, isNotNull, sql, not } from "drizzle-orm";
import { db } from "../../db";
import {
  billingAuditRuns,
  billingAuditFindings,
  aiUsage,
  aiBillingUsage,
  tenantCreditLedger,
  billingPeriods,
  billingPeriodTenantSnapshots,
} from "@shared/schema";
import type {
  BillingAuditRun,
  BillingAuditFinding,
  InsertBillingAuditFinding,
} from "@shared/schema";

// ─── Severity Policy (explicit — do not leave ad hoc) ─────────────────────────

export const AUDIT_SEVERITY_POLICY: Record<string, "critical" | "warning" | "info"> = {
  missing_billing_row: "critical",
  orphan_billing_row: "critical",
  missing_wallet_debit: "critical",
  duplicate_wallet_debit: "critical",
  period_total_mismatch: "critical",
  snapshot_total_mismatch: "critical",
  wallet_amount_mismatch: "warning",
  request_count_mismatch: "warning",
  negative_margin_detected: "warning",
  orphan_wallet_debit: "warning",
  missing_snapshot_row: "warning",
  orphan_snapshot_row: "info",
  invalid_pricing_result: "info",
  tenant_mismatch: "info",
};

function severity(findingType: string): "critical" | "warning" | "info" {
  return AUDIT_SEVERITY_POLICY[findingType] ?? "info";
}

// ─── Audit Run Lifecycle ───────────────────────────────────────────────────────

/**
 * Create a new billing audit run record and return its ID.
 */
export async function createBillingAuditRun(
  auditType: string,
  options?: { periodId?: string; notes?: string },
): Promise<string> {
  const rows = await db
    .insert(billingAuditRuns)
    .values({
      auditType,
      status: "started",
      periodId: options?.periodId ?? null,
      notes: options?.notes ?? null,
      startedAt: new Date(),
    })
    .returning({ id: billingAuditRuns.id });

  const id = rows[0]?.id;
  if (!id) throw new Error(`[billing-audit] Failed to create audit run for type=${auditType}`);
  console.info(`[billing-audit] Audit run started: ${id} type=${auditType}`);
  return id;
}

/**
 * Mark an audit run as completed with optional notes.
 */
export async function markBillingAuditRunCompleted(runId: string, notes?: string): Promise<void> {
  await db
    .update(billingAuditRuns)
    .set({ status: "completed", completedAt: new Date(), notes: notes ?? null })
    .where(eq(billingAuditRuns.id, runId));
  console.info(`[billing-audit] Audit run completed: ${runId}`);
}

/**
 * Mark an audit run as failed with optional notes.
 * Called when the audit infrastructure itself fails (not when findings are detected).
 */
export async function markBillingAuditRunFailed(runId: string, notes?: string): Promise<void> {
  await db
    .update(billingAuditRuns)
    .set({ status: "failed", completedAt: new Date(), notes: notes ?? null })
    .where(eq(billingAuditRuns.id, runId));
  console.warn(`[billing-audit] Audit run failed: ${runId} notes=${notes}`);
}

// ─── Finding Recording ─────────────────────────────────────────────────────────

/**
 * Record a single audit finding.
 * Findings are immutable — no update/delete API exposed.
 */
export async function recordBillingAuditFinding(
  finding: Omit<InsertBillingAuditFinding, "severity"> & { findingType: string },
): Promise<string> {
  const rows = await db
    .insert(billingAuditFindings)
    .values({
      ...finding,
      severity: severity(finding.findingType),
    })
    .returning({ id: billingAuditFindings.id });

  const id = rows[0]?.id;
  if (!id) throw new Error(`[billing-audit] Failed to record finding type=${finding.findingType}`);
  return id;
}

// ─── Task 4: ai_usage ↔ ai_billing_usage Consistency ─────────────────────────

/**
 * Run a deterministic consistency audit between ai_usage and ai_billing_usage.
 *
 * Checks:
 *   1. ai_usage rows with status='success' missing a billing row → missing_billing_row (critical)
 *   2. ai_billing_usage rows with no matching ai_usage row → orphan_billing_row (critical)
 *   3. Tenant mismatch between usage and billing row → tenant_mismatch (info)
 *   4. negative_margin_detected → warning
 *   5. invalid_pricing_result (arithmetic inconsistency) → info
 *
 * Options:
 *   tenantId — scope to single tenant
 *   limit    — max rows to scan per check (default 500 for safety)
 */
export async function runUsageBillingConsistencyAudit(options?: {
  tenantId?: string;
  limit?: number;
}): Promise<{ runId: string; findingsCount: number }> {
  const limit = options?.limit ?? 500;
  const runId = await createBillingAuditRun("usage_billing_consistency", {
    notes: options?.tenantId ? `tenant_id=${options.tenantId}` : undefined,
  });

  let findingsCount = 0;
  try {
    // ── Check 1: Successful ai_usage with no billing row ──────────────────
    const missingBillingRows = await db.execute<{
      usage_id: string;
      tenant_id: string;
      request_id: string | null;
      feature: string | null;
      provider: string | null;
      model: string | null;
      estimated_cost_usd: string | null;
      created_at: Date;
    }>(sql`
      SELECT u.id AS usage_id, u.tenant_id, u.request_id, u.feature, u.provider, u.model,
             u.estimated_cost_usd, u.created_at
      FROM ai_usage u
      LEFT JOIN ai_billing_usage b ON b.usage_id = u.id
      WHERE u.status = 'success'
        AND b.id IS NULL
        ${options?.tenantId ? sql`AND u.tenant_id = ${options.tenantId}` : sql``}
      ORDER BY u.created_at DESC
      LIMIT ${sql.raw(String(limit))}
    `);

    for (const row of missingBillingRows.rows) {
      await recordBillingAuditFinding({
        runId,
        tenantId: row.tenant_id,
        findingType: "missing_billing_row",
        entityType: "ai_usage",
        entityId: row.usage_id,
        details: {
          usage_id: row.usage_id,
          tenant_id: row.tenant_id,
          request_id: row.request_id,
          feature: row.feature,
          provider: row.provider,
          model: row.model,
          estimated_cost_usd: row.estimated_cost_usd,
          created_at: row.created_at,
          note: "Successful ai_usage row has no corresponding ai_billing_usage row",
        },
      });
      findingsCount++;
    }

    // ── Check 2: ai_billing_usage with no matching ai_usage row ───────────
    const orphanBillingRows = await db.execute<{
      billing_id: string;
      usage_id: string;
      tenant_id: string;
      customer_price_usd: string;
      provider_cost_usd: string;
      created_at: Date;
    }>(sql`
      SELECT b.id AS billing_id, b.usage_id, b.tenant_id,
             b.customer_price_usd, b.provider_cost_usd, b.created_at
      FROM ai_billing_usage b
      LEFT JOIN ai_usage u ON u.id = b.usage_id
      WHERE u.id IS NULL
        ${options?.tenantId ? sql`AND b.tenant_id = ${options.tenantId}` : sql``}
      ORDER BY b.created_at DESC
      LIMIT ${sql.raw(String(limit))}
    `);

    for (const row of orphanBillingRows.rows) {
      await recordBillingAuditFinding({
        runId,
        tenantId: row.tenant_id,
        findingType: "orphan_billing_row",
        entityType: "ai_billing_usage",
        entityId: row.billing_id,
        details: {
          billing_id: row.billing_id,
          usage_id: row.usage_id,
          tenant_id: row.tenant_id,
          customer_price_usd: row.customer_price_usd,
          provider_cost_usd: row.provider_cost_usd,
          created_at: row.created_at,
          note: "ai_billing_usage row references a non-existent ai_usage row",
        },
      });
      findingsCount++;
    }

    // ── Check 3: Tenant mismatch between usage and billing rows ───────────
    const tenantMismatches = await db.execute<{
      billing_id: string;
      usage_id: string;
      billing_tenant: string;
      usage_tenant: string;
    }>(sql`
      SELECT b.id AS billing_id, b.usage_id, b.tenant_id AS billing_tenant, u.tenant_id AS usage_tenant
      FROM ai_billing_usage b
      JOIN ai_usage u ON u.id = b.usage_id
      WHERE b.tenant_id != u.tenant_id
        ${options?.tenantId ? sql`AND b.tenant_id = ${options.tenantId}` : sql``}
      LIMIT ${sql.raw(String(limit))}
    `);

    for (const row of tenantMismatches.rows) {
      await recordBillingAuditFinding({
        runId,
        tenantId: row.billing_tenant,
        findingType: "tenant_mismatch",
        entityType: "ai_billing_usage",
        entityId: row.billing_id,
        details: {
          billing_id: row.billing_id,
          usage_id: row.usage_id,
          billing_tenant_id: row.billing_tenant,
          usage_tenant_id: row.usage_tenant,
          note: "tenant_id on ai_billing_usage does not match ai_usage.tenant_id",
        },
      });
      findingsCount++;
    }

    // ── Check 4: Negative margin detection ────────────────────────────────
    const negativeMargin = await db.execute<{
      billing_id: string;
      tenant_id: string;
      provider_cost_usd: string;
      customer_price_usd: string;
      margin_usd: string;
      feature: string | null;
      provider: string | null;
      model: string | null;
      created_at: Date;
    }>(sql`
      SELECT b.id AS billing_id, b.tenant_id, b.provider_cost_usd,
             b.customer_price_usd, b.margin_usd, b.feature, b.provider, b.model, b.created_at
      FROM ai_billing_usage b
      WHERE b.margin_usd < 0
        ${options?.tenantId ? sql`AND b.tenant_id = ${options.tenantId}` : sql``}
      ORDER BY b.margin_usd ASC
      LIMIT ${sql.raw(String(limit))}
    `);

    for (const row of negativeMargin.rows) {
      await recordBillingAuditFinding({
        runId,
        tenantId: row.tenant_id,
        findingType: "negative_margin_detected",
        entityType: "ai_billing_usage",
        entityId: row.billing_id,
        actualValue: row.margin_usd,
        expectedValue: "0",
        deltaValue: row.margin_usd,
        details: {
          billing_id: row.billing_id,
          tenant_id: row.tenant_id,
          provider_cost_usd: row.provider_cost_usd,
          customer_price_usd: row.customer_price_usd,
          margin_usd: row.margin_usd,
          feature: row.feature,
          provider: row.provider,
          model: row.model,
          created_at: row.created_at,
          note: "margin_usd < 0: selling below provider cost",
        },
      });
      findingsCount++;
    }

    // ── Check 5: Arithmetic inconsistency in pricing columns ──────────────
    const pricingArithmeticErrors = await db.execute<{
      billing_id: string;
      tenant_id: string;
      provider_cost_usd: string;
      customer_price_usd: string;
      margin_usd: string;
      expected_margin: string;
      created_at: Date;
    }>(sql`
      SELECT b.id AS billing_id, b.tenant_id, b.provider_cost_usd,
             b.customer_price_usd, b.margin_usd,
             ROUND(b.customer_price_usd - b.provider_cost_usd, 8) AS expected_margin,
             b.created_at
      FROM ai_billing_usage b
      WHERE ABS(b.margin_usd - (b.customer_price_usd - b.provider_cost_usd)) > 0.00000001
        ${options?.tenantId ? sql`AND b.tenant_id = ${options.tenantId}` : sql``}
      ORDER BY b.created_at DESC
      LIMIT ${sql.raw(String(limit))}
    `);

    for (const row of pricingArithmeticErrors.rows) {
      await recordBillingAuditFinding({
        runId,
        tenantId: row.tenant_id,
        findingType: "invalid_pricing_result",
        entityType: "ai_billing_usage",
        entityId: row.billing_id,
        expectedValue: row.expected_margin,
        actualValue: row.margin_usd,
        deltaValue: String(Number(row.margin_usd) - Number(row.expected_margin)),
        details: {
          billing_id: row.billing_id,
          tenant_id: row.tenant_id,
          provider_cost_usd: row.provider_cost_usd,
          customer_price_usd: row.customer_price_usd,
          margin_usd: row.margin_usd,
          expected_margin: row.expected_margin,
          created_at: row.created_at,
          note: "margin_usd != customer_price_usd - provider_cost_usd (arithmetic inconsistency)",
        },
      });
      findingsCount++;
    }

    await markBillingAuditRunCompleted(runId, `findings=${findingsCount}`);
  } catch (err) {
    await markBillingAuditRunFailed(runId, err instanceof Error ? err.message : String(err));
    throw err;
  }

  return { runId, findingsCount };
}

// ─── Task 5: ai_billing_usage ↔ tenant_credit_ledger Consistency ──────────────

/**
 * Run a deterministic wallet reconciliation audit.
 *
 * Checks:
 *   1. Billing row with wallet_status='debited' but no ledger debit → missing_wallet_debit (critical)
 *   2. Ledger debit row referencing nonexistent billing_usage_id → orphan_wallet_debit (warning)
 *   3. Ledger debit amount != customer_price_usd → wallet_amount_mismatch (warning)
 *   4. Duplicate effective wallet debits for same billing_usage_id → duplicate_wallet_debit (critical)
 */
export async function runBillingWalletConsistencyAudit(options?: {
  tenantId?: string;
  limit?: number;
}): Promise<{ runId: string; findingsCount: number }> {
  const limit = options?.limit ?? 500;
  const runId = await createBillingAuditRun("billing_wallet_consistency", {
    notes: options?.tenantId ? `tenant_id=${options.tenantId}` : undefined,
  });

  let findingsCount = 0;
  try {
    // ── Check 1: debited billing row with no ledger debit ──────────────────
    const missingDebits = await db.execute<{
      billing_id: string;
      tenant_id: string;
      customer_price_usd: string;
      wallet_debited_at: Date | null;
      feature: string | null;
      model: string | null;
      created_at: Date;
    }>(sql`
      SELECT b.id AS billing_id, b.tenant_id, b.customer_price_usd,
             b.wallet_debited_at, b.feature, b.model, b.created_at
      FROM ai_billing_usage b
      LEFT JOIN tenant_credit_ledger l
        ON l.billing_usage_id = b.id
        AND l.entry_type = 'credit_debit'
      WHERE b.wallet_status = 'debited'
        AND l.id IS NULL
        ${options?.tenantId ? sql`AND b.tenant_id = ${options.tenantId}` : sql``}
      ORDER BY b.created_at DESC
      LIMIT ${sql.raw(String(limit))}
    `);

    for (const row of missingDebits.rows) {
      await recordBillingAuditFinding({
        runId,
        tenantId: row.tenant_id,
        findingType: "missing_wallet_debit",
        entityType: "ai_billing_usage",
        entityId: row.billing_id,
        expectedValue: row.customer_price_usd,
        actualValue: "0",
        deltaValue: String(-Number(row.customer_price_usd)),
        details: {
          billing_id: row.billing_id,
          tenant_id: row.tenant_id,
          customer_price_usd: row.customer_price_usd,
          wallet_debited_at: row.wallet_debited_at,
          feature: row.feature,
          model: row.model,
          created_at: row.created_at,
          note: "billing wallet_status=debited but no credit_debit row exists in tenant_credit_ledger",
        },
      });
      findingsCount++;
    }

    // ── Check 2: Orphan ledger debits ──────────────────────────────────────
    const orphanDebits = await db.execute<{
      ledger_id: string;
      billing_usage_id: string | null;
      tenant_id: string;
      amount_usd: string;
      created_at: Date;
    }>(sql`
      SELECT l.id AS ledger_id, l.billing_usage_id, l.tenant_id, l.amount_usd, l.created_at
      FROM tenant_credit_ledger l
      LEFT JOIN ai_billing_usage b ON b.id = l.billing_usage_id
      WHERE l.entry_type = 'credit_debit'
        AND l.billing_usage_id IS NOT NULL
        AND b.id IS NULL
        ${options?.tenantId ? sql`AND l.tenant_id = ${options.tenantId}` : sql``}
      ORDER BY l.created_at DESC
      LIMIT ${sql.raw(String(limit))}
    `);

    for (const row of orphanDebits.rows) {
      await recordBillingAuditFinding({
        runId,
        tenantId: row.tenant_id,
        findingType: "orphan_wallet_debit",
        entityType: "tenant_credit_ledger",
        entityId: row.ledger_id,
        details: {
          ledger_id: row.ledger_id,
          billing_usage_id: row.billing_usage_id,
          tenant_id: row.tenant_id,
          amount_usd: row.amount_usd,
          created_at: row.created_at,
          note: "tenant_credit_ledger credit_debit row references a non-existent ai_billing_usage row",
        },
      });
      findingsCount++;
    }

    // ── Check 3: Wallet debit amount mismatch ──────────────────────────────
    const amountMismatches = await db.execute<{
      billing_id: string;
      ledger_id: string;
      tenant_id: string;
      customer_price_usd: string;
      ledger_amount: string;
      delta: string;
      created_at: Date;
    }>(sql`
      SELECT b.id AS billing_id, l.id AS ledger_id, b.tenant_id,
             b.customer_price_usd, l.amount_usd AS ledger_amount,
             ROUND(l.amount_usd - b.customer_price_usd, 8) AS delta,
             b.created_at
      FROM ai_billing_usage b
      JOIN tenant_credit_ledger l
        ON l.billing_usage_id = b.id
        AND l.entry_type = 'credit_debit'
      WHERE ABS(l.amount_usd - b.customer_price_usd) > 0.00000001
        ${options?.tenantId ? sql`AND b.tenant_id = ${options.tenantId}` : sql``}
      ORDER BY ABS(l.amount_usd - b.customer_price_usd) DESC
      LIMIT ${sql.raw(String(limit))}
    `);

    for (const row of amountMismatches.rows) {
      await recordBillingAuditFinding({
        runId,
        tenantId: row.tenant_id,
        findingType: "wallet_amount_mismatch",
        entityType: "ai_billing_usage",
        entityId: row.billing_id,
        expectedValue: row.customer_price_usd,
        actualValue: row.ledger_amount,
        deltaValue: row.delta,
        details: {
          billing_id: row.billing_id,
          ledger_id: row.ledger_id,
          tenant_id: row.tenant_id,
          customer_price_usd: row.customer_price_usd,
          ledger_amount_usd: row.ledger_amount,
          delta_usd: row.delta,
          created_at: row.created_at,
          note: "ledger credit_debit amount differs from ai_billing_usage.customer_price_usd",
        },
      });
      findingsCount++;
    }

    // ── Check 4: Duplicate effective wallet debits ─────────────────────────
    const duplicateDebits = await db.execute<{
      billing_usage_id: string;
      tenant_id: string;
      debit_count: string;
      total_debited: string;
    }>(sql`
      SELECT l.billing_usage_id, l.tenant_id,
             COUNT(*) AS debit_count,
             SUM(l.amount_usd) AS total_debited
      FROM tenant_credit_ledger l
      WHERE l.entry_type = 'credit_debit'
        AND l.billing_usage_id IS NOT NULL
        ${options?.tenantId ? sql`AND l.tenant_id = ${options.tenantId}` : sql``}
      GROUP BY l.billing_usage_id, l.tenant_id
      HAVING COUNT(*) > 1
      ORDER BY COUNT(*) DESC
      LIMIT ${sql.raw(String(limit))}
    `);

    for (const row of duplicateDebits.rows) {
      await recordBillingAuditFinding({
        runId,
        tenantId: row.tenant_id,
        findingType: "duplicate_wallet_debit",
        entityType: "tenant_credit_ledger",
        entityId: row.billing_usage_id,
        details: {
          billing_usage_id: row.billing_usage_id,
          tenant_id: row.tenant_id,
          debit_count: row.debit_count,
          total_debited_usd: row.total_debited,
          note: "More than one credit_debit row exists for the same billing_usage_id — possible double-charge",
        },
      });
      findingsCount++;
    }

    await markBillingAuditRunCompleted(runId, `findings=${findingsCount}`);
  } catch (err) {
    await markBillingAuditRunFailed(runId, err instanceof Error ? err.message : String(err));
    throw err;
  }

  return { runId, findingsCount };
}

// ─── Task 6: Period Snapshot ↔ Live Billing Consistency ───────────────────────

/**
 * Audit a specific closed billing period: compare stored snapshots vs live aggregation.
 *
 * Checks:
 *   1. provider_cost_usd total mismatch per tenant → snapshot_total_mismatch (critical)
 *   2. customer_price_usd total mismatch per tenant → snapshot_total_mismatch (critical)
 *   3. margin_usd total mismatch per tenant → snapshot_total_mismatch (critical)
 *   4. request_count mismatch per tenant → request_count_mismatch (warning)
 *   5. Missing snapshot row for active tenant → missing_snapshot_row (warning)
 *   6. Orphan snapshot row (no live activity) → orphan_snapshot_row (info)
 *   7. Period grand total mismatch → period_total_mismatch (critical)
 *
 * Only runs on 'closed' periods — throws if period is not closed.
 */
export async function runPeriodSnapshotConsistencyAudit(
  periodId: string,
): Promise<{ runId: string; findingsCount: number }> {
  const runId = await createBillingAuditRun("period_snapshot_consistency", { periodId });

  let findingsCount = 0;
  try {
    // Fetch and validate the period
    const periodRows = await db
      .select()
      .from(billingPeriods)
      .where(eq(billingPeriods.id, periodId))
      .limit(1);

    const period = periodRows[0];
    if (!period) {
      await markBillingAuditRunFailed(runId, `Period not found: ${periodId}`);
      throw new Error(`[billing-audit] Period not found: ${periodId}`);
    }
    if (period.status !== "closed") {
      await markBillingAuditRunFailed(runId, `Period ${periodId} is not closed (status=${period.status})`);
      throw new Error(`[billing-audit] Period ${periodId} is not closed — snapshot audit requires closed period`);
    }

    const { periodStart, periodEnd } = period;

    // Live aggregation from ai_billing_usage within exact period boundaries
    // Rule: created_at >= period_start AND created_at < period_end
    const liveAgg = await db.execute<{
      tenant_id: string;
      live_request_count: string;
      live_provider_cost: string;
      live_customer_price: string;
      live_margin: string;
    }>(sql`
      SELECT tenant_id,
             COUNT(*) AS live_request_count,
             COALESCE(SUM(provider_cost_usd), 0) AS live_provider_cost,
             COALESCE(SUM(customer_price_usd), 0) AS live_customer_price,
             COALESCE(SUM(margin_usd), 0) AS live_margin
      FROM ai_billing_usage
      WHERE created_at >= ${periodStart}
        AND created_at < ${periodEnd}
      GROUP BY tenant_id
    `);

    // Stored snapshots
    const snapshots = await db
      .select()
      .from(billingPeriodTenantSnapshots)
      .where(eq(billingPeriodTenantSnapshots.billingPeriodId, periodId));

    // Build lookup maps
    const liveByTenant = new Map(liveAgg.rows.map((r) => [r.tenant_id, r]));
    const snapshotByTenant = new Map(snapshots.map((s) => [s.tenantId, s]));

    // Check 5: Missing snapshot rows (tenants in live but not in snapshots)
    for (const [tenantId, live] of Array.from(liveByTenant)) {
      if (!snapshotByTenant.has(tenantId)) {
        await recordBillingAuditFinding({
          runId,
          tenantId,
          periodId,
          findingType: "missing_snapshot_row",
          entityType: "billing_period",
          entityId: periodId,
          details: {
            tenant_id: tenantId,
            period_id: periodId,
            period_start: periodStart,
            period_end: periodEnd,
            live_request_count: live.live_request_count,
            live_customer_price_usd: live.live_customer_price,
            live_provider_cost_usd: live.live_provider_cost,
            note: "Tenant has activity in closed period but no snapshot row",
          },
        });
        findingsCount++;
      }
    }

    // Check 6: Orphan snapshot rows (snapshot exists but no live activity)
    for (const [tenantId, snap] of Array.from(snapshotByTenant)) {
      if (!liveByTenant.has(tenantId)) {
        await recordBillingAuditFinding({
          runId,
          tenantId,
          periodId,
          findingType: "orphan_snapshot_row",
          entityType: "billing_period_tenant_snapshot",
          entityId: snap.id,
          details: {
            snapshot_id: snap.id,
            tenant_id: tenantId,
            period_id: periodId,
            period_start: periodStart,
            period_end: periodEnd,
            snapshot_request_count: snap.requestCount,
            snapshot_customer_price_usd: snap.customerPriceUsd,
            note: "Snapshot row exists for tenant with zero live activity in this period",
          },
        });
        findingsCount++;
      }
    }

    // Checks 1-4: Per-tenant numeric comparison
    for (const [tenantId, snap] of Array.from(snapshotByTenant)) {
      const live = liveByTenant.get(tenantId);
      if (!live) continue; // orphan handled above

      const snapProviderCost = Number(snap.providerCostUsd);
      const snapCustomerPrice = Number(snap.customerPriceUsd);
      const snapMargin = Number(snap.marginUsd);
      const snapCount = snap.requestCount;

      const liveProviderCost = Number(live.live_provider_cost);
      const liveCustomerPrice = Number(live.live_customer_price);
      const liveMargin = Number(live.live_margin);
      const liveCount = Number(live.live_request_count);

      const TOLERANCE = 0.00000001;

      // provider_cost mismatch
      if (Math.abs(snapProviderCost - liveProviderCost) > TOLERANCE) {
        await recordBillingAuditFinding({
          runId,
          tenantId,
          periodId,
          findingType: "snapshot_total_mismatch",
          entityType: "billing_period_tenant_snapshot",
          entityId: snap.id,
          expectedValue: String(liveProviderCost),
          actualValue: String(snapProviderCost),
          deltaValue: String(snapProviderCost - liveProviderCost),
          details: {
            snapshot_id: snap.id,
            tenant_id: tenantId,
            period_id: periodId,
            period_start: periodStart,
            period_end: periodEnd,
            field: "provider_cost_usd",
            snapshot_value: snapProviderCost,
            live_value: liveProviderCost,
            delta: snapProviderCost - liveProviderCost,
            note: "provider_cost_usd snapshot total does not match live aggregation",
          },
        });
        findingsCount++;
      }

      // customer_price mismatch
      if (Math.abs(snapCustomerPrice - liveCustomerPrice) > TOLERANCE) {
        await recordBillingAuditFinding({
          runId,
          tenantId,
          periodId,
          findingType: "snapshot_total_mismatch",
          entityType: "billing_period_tenant_snapshot",
          entityId: snap.id,
          expectedValue: String(liveCustomerPrice),
          actualValue: String(snapCustomerPrice),
          deltaValue: String(snapCustomerPrice - liveCustomerPrice),
          details: {
            snapshot_id: snap.id,
            tenant_id: tenantId,
            period_id: periodId,
            period_start: periodStart,
            period_end: periodEnd,
            field: "customer_price_usd",
            snapshot_value: snapCustomerPrice,
            live_value: liveCustomerPrice,
            delta: snapCustomerPrice - liveCustomerPrice,
            note: "customer_price_usd snapshot total does not match live aggregation",
          },
        });
        findingsCount++;
      }

      // margin mismatch
      if (Math.abs(snapMargin - liveMargin) > TOLERANCE) {
        await recordBillingAuditFinding({
          runId,
          tenantId,
          periodId,
          findingType: "snapshot_total_mismatch",
          entityType: "billing_period_tenant_snapshot",
          entityId: snap.id,
          expectedValue: String(liveMargin),
          actualValue: String(snapMargin),
          deltaValue: String(snapMargin - liveMargin),
          details: {
            snapshot_id: snap.id,
            tenant_id: tenantId,
            period_id: periodId,
            field: "margin_usd",
            snapshot_value: snapMargin,
            live_value: liveMargin,
            delta: snapMargin - liveMargin,
            note: "margin_usd snapshot total does not match live aggregation",
          },
        });
        findingsCount++;
      }

      // request_count mismatch
      if (snapCount !== liveCount) {
        await recordBillingAuditFinding({
          runId,
          tenantId,
          periodId,
          findingType: "request_count_mismatch",
          entityType: "billing_period_tenant_snapshot",
          entityId: snap.id,
          expectedValue: String(liveCount),
          actualValue: String(snapCount),
          deltaValue: String(snapCount - liveCount),
          details: {
            snapshot_id: snap.id,
            tenant_id: tenantId,
            period_id: periodId,
            snapshot_count: snapCount,
            live_count: liveCount,
            delta: snapCount - liveCount,
            note: "request_count in snapshot differs from live ai_billing_usage count",
          },
        });
        findingsCount++;
      }
    }

    // Check 7: Period grand totals
    const grandLiveResult = await db.execute<{
      total_provider_cost: string;
      total_customer_price: string;
    }>(sql`
      SELECT COALESCE(SUM(provider_cost_usd), 0) AS total_provider_cost,
             COALESCE(SUM(customer_price_usd), 0) AS total_customer_price
      FROM ai_billing_usage
      WHERE created_at >= ${periodStart}
        AND created_at < ${periodEnd}
    `);

    const grandSnapshotResult = await db.execute<{
      total_provider_cost: string;
      total_customer_price: string;
    }>(sql`
      SELECT COALESCE(SUM(provider_cost_usd), 0) AS total_provider_cost,
             COALESCE(SUM(customer_price_usd), 0) AS total_customer_price
      FROM billing_period_tenant_snapshots
      WHERE billing_period_id = ${periodId}
    `);

    const liveTotals = grandLiveResult.rows[0];
    const snapTotals = grandSnapshotResult.rows[0];

    if (liveTotals && snapTotals) {
      const liveGrandProvider = Number(liveTotals.total_provider_cost);
      const snapGrandProvider = Number(snapTotals.total_provider_cost);
      const liveGrandCustomer = Number(liveTotals.total_customer_price);
      const snapGrandCustomer = Number(snapTotals.total_customer_price);
      const TOLERANCE = 0.00000001;

      if (
        Math.abs(liveGrandProvider - snapGrandProvider) > TOLERANCE ||
        Math.abs(liveGrandCustomer - snapGrandCustomer) > TOLERANCE
      ) {
        await recordBillingAuditFinding({
          runId,
          periodId,
          findingType: "period_total_mismatch",
          entityType: "billing_period",
          entityId: periodId,
          details: {
            period_id: periodId,
            period_start: periodStart,
            period_end: periodEnd,
            live_total_provider_cost_usd: liveGrandProvider,
            snapshot_total_provider_cost_usd: snapGrandProvider,
            provider_cost_delta: snapGrandProvider - liveGrandProvider,
            live_total_customer_price_usd: liveGrandCustomer,
            snapshot_total_customer_price_usd: snapGrandCustomer,
            customer_price_delta: snapGrandCustomer - liveGrandCustomer,
            note: "Period grand total in snapshots does not match live ai_billing_usage aggregation",
          },
        });
        findingsCount++;
      }
    }

    await markBillingAuditRunCompleted(runId, `period=${periodId} findings=${findingsCount}`);
  } catch (err) {
    await markBillingAuditRunFailed(runId, err instanceof Error ? err.message : String(err));
    throw err;
  }

  return { runId, findingsCount };
}

// ─── Full Billing Audit ────────────────────────────────────────────────────────

/**
 * Run all audit types in sequence under a single parent run record.
 *
 * Executes:
 *   1. Usage ↔ billing consistency
 *   2. Billing ↔ wallet consistency
 *   3. Period snapshot consistency (for all closed periods, up to maxPeriods)
 *
 * All findings from sub-runs are stored under their individual run IDs.
 * The parent run record tracks overall execution status.
 */
export async function runFullBillingAudit(options?: {
  tenantId?: string;
  maxPeriods?: number;
  limit?: number;
}): Promise<{ runId: string; subRuns: string[]; totalFindings: number }> {
  const runId = await createBillingAuditRun("full_billing_audit", {
    notes: options?.tenantId ? `tenant_id=${options.tenantId}` : "system-wide",
  });

  const subRuns: string[] = [];
  let totalFindings = 0;

  try {
    const r1 = await runUsageBillingConsistencyAudit({ tenantId: options?.tenantId, limit: options?.limit });
    subRuns.push(r1.runId);
    totalFindings += r1.findingsCount;

    const r2 = await runBillingWalletConsistencyAudit({ tenantId: options?.tenantId, limit: options?.limit });
    subRuns.push(r2.runId);
    totalFindings += r2.findingsCount;

    const maxPeriods = options?.maxPeriods ?? 10;
    const closedPeriods = await db
      .select({ id: billingPeriods.id })
      .from(billingPeriods)
      .where(eq(billingPeriods.status, "closed"))
      .limit(maxPeriods);

    for (const { id } of closedPeriods) {
      const r3 = await runPeriodSnapshotConsistencyAudit(id);
      subRuns.push(r3.runId);
      totalFindings += r3.findingsCount;
    }

    await markBillingAuditRunCompleted(
      runId,
      `sub_runs=${subRuns.length} total_findings=${totalFindings}`,
    );
  } catch (err) {
    await markBillingAuditRunFailed(runId, err instanceof Error ? err.message : String(err));
    throw err;
  }

  return { runId, subRuns, totalFindings };
}
