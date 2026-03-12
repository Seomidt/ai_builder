/**
 * Billing Audit Summary & Read Helpers
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Read-only helpers for querying audit run metadata and findings.
 * No mutations in this file — audit records are immutable.
 */

import { eq, desc, and, inArray } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import {
  billingAuditRuns,
  billingAuditFindings,
} from "@shared/schema";
import type { BillingAuditRun, BillingAuditFinding } from "@shared/schema";

// ─── Audit Run Read Helpers ────────────────────────────────────────────────────

/**
 * Return a single audit run by ID, or null if not found.
 */
export async function getBillingAuditRunById(runId: string): Promise<BillingAuditRun | null> {
  const rows = await db
    .select()
    .from(billingAuditRuns)
    .where(eq(billingAuditRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * List recent audit runs, optionally filtered by audit type or status.
 */
export async function listBillingAuditRuns(options?: {
  auditType?: string;
  status?: string;
  limit?: number;
}): Promise<BillingAuditRun[]> {
  const conditions = [];
  if (options?.auditType) conditions.push(eq(billingAuditRuns.auditType, options.auditType));
  if (options?.status) conditions.push(eq(billingAuditRuns.status, options.status));

  return db
    .select()
    .from(billingAuditRuns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(billingAuditRuns.startedAt))
    .limit(options?.limit ?? 50);
}

// ─── Audit Finding Read Helpers ────────────────────────────────────────────────

/**
 * List findings for a specific audit run, ordered by severity then created_at.
 */
export async function listBillingAuditFindings(
  runId: string,
  limit = 200,
): Promise<BillingAuditFinding[]> {
  return db
    .select()
    .from(billingAuditFindings)
    .where(eq(billingAuditFindings.runId, runId))
    .orderBy(
      desc(billingAuditFindings.severity),
      desc(billingAuditFindings.createdAt),
    )
    .limit(limit);
}

/**
 * Return the most recent critical findings across all runs.
 * Useful for quick health checks and alerting.
 */
export async function getLatestCriticalBillingFindings(
  limit = 50,
): Promise<BillingAuditFinding[]> {
  return db
    .select()
    .from(billingAuditFindings)
    .where(eq(billingAuditFindings.severity, "critical"))
    .orderBy(desc(billingAuditFindings.createdAt))
    .limit(limit);
}

/**
 * Return findings scoped to a specific billing period (across all runs).
 */
export async function getBillingFindingsForPeriod(
  periodId: string,
  limit = 200,
): Promise<BillingAuditFinding[]> {
  return db
    .select()
    .from(billingAuditFindings)
    .where(eq(billingAuditFindings.periodId, periodId))
    .orderBy(desc(billingAuditFindings.severity), desc(billingAuditFindings.createdAt))
    .limit(limit);
}

/**
 * Return findings scoped to a specific tenant (across all runs).
 */
export async function getBillingFindingsForTenant(
  tenantId: string,
  limit = 200,
): Promise<BillingAuditFinding[]> {
  return db
    .select()
    .from(billingAuditFindings)
    .where(eq(billingAuditFindings.tenantId, tenantId))
    .orderBy(desc(billingAuditFindings.severity), desc(billingAuditFindings.createdAt))
    .limit(limit);
}

// ─── Audit Summary ─────────────────────────────────────────────────────────────

export interface BillingAuditSummary {
  runId: string;
  auditType: string;
  status: string;
  startedAt: Date;
  completedAt: Date | null;
  totalFindings: number;
  bySeverity: {
    critical: number;
    warning: number;
    info: number;
  };
  byFindingType: Record<string, number>;
}

/**
 * Return a structured summary of an audit run: totals by severity and finding type.
 * Returns null if the run does not exist.
 */
export async function getBillingAuditSummary(
  runId: string,
): Promise<BillingAuditSummary | null> {
  const run = await getBillingAuditRunById(runId);
  if (!run) return null;

  const countsBySeverity = await db.execute<{
    severity: string;
    cnt: string;
  }>(sql`
    SELECT severity, COUNT(*) AS cnt
    FROM billing_audit_findings
    WHERE run_id = ${runId}
    GROUP BY severity
  `);

  const countsByType = await db.execute<{
    finding_type: string;
    cnt: string;
  }>(sql`
    SELECT finding_type, COUNT(*) AS cnt
    FROM billing_audit_findings
    WHERE run_id = ${runId}
    GROUP BY finding_type
    ORDER BY COUNT(*) DESC
  `);

  const bySeverity = { critical: 0, warning: 0, info: 0 };
  for (const row of countsBySeverity.rows) {
    if (row.severity === "critical") bySeverity.critical = Number(row.cnt);
    else if (row.severity === "warning") bySeverity.warning = Number(row.cnt);
    else if (row.severity === "info") bySeverity.info = Number(row.cnt);
  }

  const byFindingType: Record<string, number> = {};
  for (const row of countsByType.rows) {
    byFindingType[row.finding_type] = Number(row.cnt);
  }

  const totalFindings = bySeverity.critical + bySeverity.warning + bySeverity.info;

  return {
    runId: run.id,
    auditType: run.auditType,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    totalFindings,
    bySeverity,
    byFindingType,
  };
}

/**
 * Return aggregate critical finding counts across all time.
 * Used for monitoring dashboards and health summaries.
 */
export async function getGlobalAuditHealthSnapshot(): Promise<{
  totalCritical: number;
  totalWarning: number;
  totalInfo: number;
  totalRuns: number;
  failedRuns: number;
}> {
  const [severityCounts, runCounts] = await Promise.all([
    db.execute<{ severity: string; cnt: string }>(sql`
      SELECT severity, COUNT(*) AS cnt FROM billing_audit_findings GROUP BY severity
    `),
    db.execute<{ status: string; cnt: string }>(sql`
      SELECT status, COUNT(*) AS cnt FROM billing_audit_runs GROUP BY status
    `),
  ]);

  const totals = { totalCritical: 0, totalWarning: 0, totalInfo: 0, totalRuns: 0, failedRuns: 0 };
  for (const row of severityCounts.rows) {
    if (row.severity === "critical") totals.totalCritical = Number(row.cnt);
    else if (row.severity === "warning") totals.totalWarning = Number(row.cnt);
    else if (row.severity === "info") totals.totalInfo = Number(row.cnt);
  }
  for (const row of runCounts.rows) {
    totals.totalRuns += Number(row.cnt);
    if (row.status === "failed") totals.failedRuns = Number(row.cnt);
  }

  return totals;
}
