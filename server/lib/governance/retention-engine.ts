/**
 * Phase 26 — Retention Engine
 * Evaluates and enforces data retention policies across platform tables.
 * Integrates with legal hold system — active holds block all deletions.
 */

import { db } from "../../db";
import { sql, eq, and, lt, isNull } from "drizzle-orm";
import {
  dataRetentionPolicies, dataRetentionRules, dataDeletionJobs,
  type DataRetentionPolicy, type DataRetentionRule, type DataDeletionJob,
  type InsertDataRetentionPolicy, type InsertDataRetentionRule, type InsertDataDeletionJob,
} from "@shared/schema";
import { isUnderLegalHold } from "./legal-hold";

// ── Built-in seed policies ─────────────────────────────────────────────────────

export const BUILT_IN_RETENTION_POLICIES: InsertDataRetentionPolicy[] = [
  { policyKey: "audit_events_default",      description: "Audit event retention — 2 years",        defaultRetentionDays: 730,  active: true },
  { policyKey: "security_events_default",   description: "Security event retention — 1 year",       defaultRetentionDays: 365,  active: true },
  { policyKey: "moderation_events_default", description: "AI moderation event retention — 1 year",  defaultRetentionDays: 365,  active: true },
  { policyKey: "webhook_deliveries_default",description: "Webhook delivery log retention — 90 days", defaultRetentionDays: 90,   active: true },
  { policyKey: "ai_runs_default",           description: "AI run history retention — 1 year",        defaultRetentionDays: 365,  active: true },
  { policyKey: "evaluation_results_default",description: "Evaluation result retention — 2 years",   defaultRetentionDays: 730,  active: true },
  { policyKey: "deletion_jobs_default",     description: "Deletion job log retention — 180 days",   defaultRetentionDays: 180,  active: true },
  { policyKey: "stripe_events_default",     description: "Stripe webhook event retention — 1 year", defaultRetentionDays: 365,  active: true },
];

// ── Policy CRUD ────────────────────────────────────────────────────────────────

export async function createRetentionPolicy(data: InsertDataRetentionPolicy): Promise<DataRetentionPolicy> {
  const rows = await db.insert(dataRetentionPolicies).values(data).returning();
  return rows[0];
}

export async function listRetentionPolicies(activeOnly = true): Promise<DataRetentionPolicy[]> {
  if (activeOnly) {
    return db.select().from(dataRetentionPolicies).where(eq(dataRetentionPolicies.active, true));
  }
  return db.select().from(dataRetentionPolicies);
}

export async function getRetentionPolicy(policyKey: string): Promise<DataRetentionPolicy | null> {
  const rows = await db.select().from(dataRetentionPolicies)
    .where(eq(dataRetentionPolicies.policyKey, policyKey))
    .limit(1);
  return rows[0] ?? null;
}

export async function updateRetentionPolicy(id: string, updates: Partial<InsertDataRetentionPolicy>): Promise<DataRetentionPolicy | null> {
  const rows = await db.update(dataRetentionPolicies)
    .set({ ...updates, updatedAt: new Date() })
    .where(eq(dataRetentionPolicies.id, id))
    .returning();
  return rows[0] ?? null;
}

export async function deactivateRetentionPolicy(id: string): Promise<boolean> {
  const rows = await db.update(dataRetentionPolicies)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(dataRetentionPolicies.id, id))
    .returning();
  return rows.length > 0;
}

// ── Retention Rules CRUD ───────────────────────────────────────────────────────

export async function createRetentionRule(data: InsertDataRetentionRule): Promise<DataRetentionRule> {
  const rows = await db.insert(dataRetentionRules).values(data).returning();
  return rows[0];
}

export async function listRetentionRules(policyId?: string): Promise<DataRetentionRule[]> {
  if (policyId) {
    return db.select().from(dataRetentionRules)
      .where(and(eq(dataRetentionRules.policyId, policyId), eq(dataRetentionRules.active, true)));
  }
  return db.select().from(dataRetentionRules).where(eq(dataRetentionRules.active, true));
}

export async function updateRetentionRule(id: string, updates: Partial<InsertDataRetentionRule>): Promise<DataRetentionRule | null> {
  const rows = await db.update(dataRetentionRules)
    .set(updates)
    .where(eq(dataRetentionRules.id, id))
    .returning();
  return rows[0] ?? null;
}

// ── Policy evaluation ──────────────────────────────────────────────────────────

export interface RetentionEvaluationResult {
  policyKey: string;
  tableName: string;
  retentionDays: number;
  cutoffDate: Date;
  archiveEnabled: boolean;
  deleteEnabled: boolean;
  eligibleForAction: boolean;
}

/**
 * Evaluate all active retention policies and compute cutoff dates.
 */
export async function evaluateRetentionPolicies(): Promise<RetentionEvaluationResult[]> {
  const rules = await listRetentionRules();
  const now = new Date();
  const results: RetentionEvaluationResult[] = [];

  for (const rule of rules) {
    const policy = await db.select().from(dataRetentionPolicies)
      .where(eq(dataRetentionPolicies.id, rule.policyId))
      .limit(1);
    if (!policy[0]?.active) continue;

    const cutoffDate = new Date(now.getTime() - rule.retentionDays * 86_400_000);
    results.push({
      policyKey: policy[0].policyKey,
      tableName: rule.tableName,
      retentionDays: rule.retentionDays,
      cutoffDate,
      archiveEnabled: rule.archiveEnabled,
      deleteEnabled: rule.deleteEnabled,
      eligibleForAction: rule.archiveEnabled || rule.deleteEnabled,
    });
  }

  return results;
}

// ── Deletion job management ────────────────────────────────────────────────────

export async function createDeletionJob(data: InsertDataDeletionJob): Promise<DataDeletionJob> {
  const rows = await db.insert(dataDeletionJobs).values(data).returning();
  return rows[0];
}

export async function getDeletionJob(id: string): Promise<DataDeletionJob | null> {
  const rows = await db.select().from(dataDeletionJobs).where(eq(dataDeletionJobs.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listDeletionJobs(params?: {
  tenantId?: string;
  status?: string;
  jobType?: string;
  limit?: number;
}): Promise<DataDeletionJob[]> {
  let q = db.select().from(dataDeletionJobs);
  const conditions = [];
  if (params?.tenantId) conditions.push(eq(dataDeletionJobs.tenantId, params.tenantId));
  if (params?.status)   conditions.push(eq(dataDeletionJobs.status, params.status));
  if (params?.jobType)  conditions.push(eq(dataDeletionJobs.jobType, params.jobType));
  if (conditions.length) q = q.where(and(...conditions)) as typeof q;
  return q.limit(params?.limit ?? 50).orderBy(sql`${dataDeletionJobs.createdAt} DESC`);
}

export async function updateDeletionJobStatus(id: string, status: string, extra?: {
  recordsDeleted?: number;
  recordsArchived?: number;
  errorMessage?: string;
  blockedByHold?: boolean;
}): Promise<DataDeletionJob | null> {
  const update: Record<string, unknown> = { status };
  if (extra?.recordsDeleted !== undefined) update.recordsDeleted = extra.recordsDeleted;
  if (extra?.recordsArchived !== undefined) update.recordsArchived = extra.recordsArchived;
  if (extra?.errorMessage !== undefined) update.errorMessage = extra.errorMessage;
  if (extra?.blockedByHold !== undefined) update.blockedByHold = extra.blockedByHold;
  if (status === "running")   update.startedAt = new Date();
  if (status === "completed" || status === "failed" || status === "blocked_by_hold") update.completedAt = new Date();

  const rows = await db.update(dataDeletionJobs).set(update as any)
    .where(eq(dataDeletionJobs.id, id)).returning();
  return rows[0] ?? null;
}

// ── Retention cleanup scheduler ────────────────────────────────────────────────

export interface RetentionCleanupSchedule {
  jobId: string;
  tenantId: string;
  scheduledRules: RetentionEvaluationResult[];
  blockedByHold: boolean;
  scheduledAt: Date;
}

/**
 * Schedule a retention cleanup run for a tenant.
 * Checks for legal hold before scheduling.
 */
export async function scheduleRetentionCleanup(tenantId: string): Promise<RetentionCleanupSchedule> {
  const hold = await isUnderLegalHold(tenantId);

  const job = await createDeletionJob({
    tenantId,
    jobType: "retention_cleanup",
    status: hold ? "blocked_by_hold" : "pending",
    blockedByHold: hold,
    metadata: { scheduledAt: new Date().toISOString(), triggeredBy: "scheduler" },
  });

  const scheduledRules = hold ? [] : await evaluateRetentionPolicies();

  if (hold) {
    await updateDeletionJobStatus(job.id, "blocked_by_hold", { blockedByHold: true });
  }

  return {
    jobId: job.id,
    tenantId,
    scheduledRules,
    blockedByHold: hold,
    scheduledAt: new Date(),
  };
}

// ── Archive + delete stubs ─────────────────────────────────────────────────────

export interface ArchiveResult {
  tableName: string;
  recordsArchived: number;
  cutoffDate: Date;
  success: boolean;
}

/**
 * Archive records that have exceeded their retention period.
 * (In production: copy to cold storage / separate archive table before deletion.)
 */
export async function archiveExpiredRecords(rule: RetentionEvaluationResult): Promise<ArchiveResult> {
  if (!rule.archiveEnabled) {
    return { tableName: rule.tableName, recordsArchived: 0, cutoffDate: rule.cutoffDate, success: false };
  }

  // Soft count-only — actual archival requires table-specific logic
  const safeTable = rule.tableName.replace(/[^a-z_]/g, "");
  let count = 0;
  try {
    const result = await db.execute(
      sql.raw(`SELECT COUNT(*) AS cnt FROM ${safeTable} WHERE created_at < '${rule.cutoffDate.toISOString()}'`)
    );
    count = parseInt((result.rows[0] as any)?.cnt ?? "0", 10);
  } catch {
    count = 0;
  }

  return { tableName: rule.tableName, recordsArchived: count, cutoffDate: rule.cutoffDate, success: true };
}

export interface DeleteResult {
  tableName: string;
  recordsDeleted: number;
  cutoffDate: Date;
  success: boolean;
  blockedByHold: boolean;
}

/**
 * Delete records beyond retention period for a given table and tenant.
 * Blocked if tenant has an active legal hold.
 */
export async function deleteExpiredRecords(params: {
  tableName: string;
  cutoffDate: Date;
  tenantId?: string;
}): Promise<DeleteResult> {
  const hold = params.tenantId ? await isUnderLegalHold(params.tenantId) : false;
  if (hold) {
    return {
      tableName: params.tableName, recordsDeleted: 0,
      cutoffDate: params.cutoffDate, success: false, blockedByHold: true,
    };
  }

  const safeTable = params.tableName.replace(/[^a-z_]/g, "");
  let deleted = 0;
  try {
    let q: string;
    if (params.tenantId) {
      q = `DELETE FROM ${safeTable} WHERE created_at < '${params.cutoffDate.toISOString()}' AND tenant_id = '${params.tenantId}' RETURNING 1`;
    } else {
      q = `DELETE FROM ${safeTable} WHERE created_at < '${params.cutoffDate.toISOString()}' RETURNING 1`;
    }
    const result = await db.execute(sql.raw(q));
    deleted = result.rows.length;
  } catch {
    deleted = 0;
  }

  return { tableName: params.tableName, recordsDeleted: deleted, cutoffDate: params.cutoffDate, success: true, blockedByHold: false };
}

// ── Retention stats ────────────────────────────────────────────────────────────

export async function getRetentionStats(): Promise<{
  totalPolicies: number;
  activePolicies: number;
  totalRules: number;
  activeRules: number;
  pendingJobs: number;
  completedJobs: number;
  blockedJobs: number;
}> {
  const [policies, rules, jobs] = await Promise.all([
    db.execute(sql`SELECT COUNT(*) AS total, SUM(CASE WHEN active THEN 1 ELSE 0 END) AS active_count FROM data_retention_policies`),
    db.execute(sql`SELECT COUNT(*) AS total, SUM(CASE WHEN active THEN 1 ELSE 0 END) AS active_count FROM data_retention_rules`),
    db.execute(sql`SELECT status, COUNT(*) AS cnt FROM data_deletion_jobs GROUP BY status`),
  ]);

  const pRow = policies.rows[0] as any;
  const rRow = rules.rows[0] as any;
  const jobRows = jobs.rows as any[];

  const jobsByStatus = Object.fromEntries(jobRows.map(r => [r.status, parseInt(r.cnt, 10)]));

  return {
    totalPolicies: parseInt(pRow?.total ?? "0", 10),
    activePolicies: parseInt(pRow?.active_count ?? "0", 10),
    totalRules: parseInt(rRow?.total ?? "0", 10),
    activeRules: parseInt(rRow?.active_count ?? "0", 10),
    pendingJobs: jobsByStatus["pending"] ?? 0,
    completedJobs: jobsByStatus["completed"] ?? 0,
    blockedJobs: jobsByStatus["blocked_by_hold"] ?? 0,
  };
}
