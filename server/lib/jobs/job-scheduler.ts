/**
 * Phase 19 — Job Scheduler
 * Cron-based recurring job scheduling with next-run calculation.
 *
 * INV-JOB8: Schedules are deterministic and explainable.
 * INV-JOB5: Tenant-safe — schedules are tenant-isolated where applicable.
 */

import { db } from "../../db";
import { jobSchedules } from "@shared/schema";
import { eq, sql as drizzleSql } from "drizzle-orm";
import { dispatchJob } from "./job-dispatcher";

export interface CreateScheduleParams {
  jobType: string;
  scheduleCron: string;
  tenantId?: string;
  payloadTemplate?: Record<string, unknown>;
  active?: boolean;
}

const CRON_INTERVAL_MAP: Record<string, number> = {
  "@hourly": 3600_000,
  "@daily": 86_400_000,
  "@weekly": 604_800_000,
  "@monthly": 2_592_000_000,
  "0 * * * *": 3600_000,    // every hour
  "0 0 * * *": 86_400_000,  // daily midnight
  "*/5 * * * *": 300_000,   // every 5 minutes
  "*/15 * * * *": 900_000,  // every 15 minutes
  "*/30 * * * *": 1_800_000, // every 30 minutes
};

/**
 * Compute next run time from cron expression.
 * Uses a simple interval-based approach for common patterns.
 * Production use would integrate node-cron or similar.
 */
export function computeNextRunAt(scheduleCron: string, from: Date = new Date()): Date {
  const normalized = scheduleCron.trim().toLowerCase();
  const intervalMs = CRON_INTERVAL_MAP[normalized];
  if (intervalMs) {
    return new Date(from.getTime() + intervalMs);
  }
  // Fallback: unknown cron → schedule 1 hour from now
  return new Date(from.getTime() + 3600_000);
}

/**
 * Validate a cron expression (basic syntax check).
 */
export function validateCronExpression(cron: string): { valid: boolean; reason?: string } {
  const normalized = cron.trim();
  if (!normalized) return { valid: false, reason: "Empty cron expression" };
  if (CRON_INTERVAL_MAP[normalized.toLowerCase()]) return { valid: true };
  // Basic 5-field cron validation
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) {
    return { valid: false, reason: `Expected 5 fields, got ${parts.length}` };
  }
  return { valid: true };
}

export async function createSchedule(params: CreateScheduleParams): Promise<{ id: string; jobType: string; nextRunAt: Date }> {
  const { valid, reason } = validateCronExpression(params.scheduleCron);
  if (!valid) throw new Error(`Invalid cron expression: ${reason}`);

  const nextRunAt = computeNextRunAt(params.scheduleCron);

  const rows = await db
    .insert(jobSchedules)
    .values({
      jobType: params.jobType,
      scheduleCron: params.scheduleCron,
      tenantId: params.tenantId ?? null,
      active: params.active ?? true,
      payloadTemplate: (params.payloadTemplate ?? null) as Record<string, unknown> | null,
      lastRunAt: null,
      nextRunAt,
    })
    .returning({ id: jobSchedules.id, jobType: jobSchedules.jobType, nextRunAt: jobSchedules.nextRunAt });

  return { id: rows[0].id, jobType: rows[0].jobType, nextRunAt: rows[0].nextRunAt! };
}

export async function pauseSchedule(scheduleId: string): Promise<{ paused: boolean }> {
  await db.execute(drizzleSql`
    UPDATE job_schedules SET active = false, updated_at = NOW() WHERE id = ${scheduleId}
  `);
  return { paused: true };
}

export async function resumeSchedule(scheduleId: string): Promise<{ resumed: boolean; nextRunAt: Date }> {
  const schedRows = await db.execute(drizzleSql`
    SELECT schedule_cron FROM job_schedules WHERE id = ${scheduleId} LIMIT 1
  `);
  const sched = schedRows.rows[0] as Record<string, unknown> | undefined;
  if (!sched) throw new Error(`Schedule not found: ${scheduleId}`);
  const nextRunAt = computeNextRunAt(sched.schedule_cron as string);
  await db.execute(drizzleSql`
    UPDATE job_schedules SET active = true, next_run_at = ${nextRunAt.toISOString()}, updated_at = NOW()
    WHERE id = ${scheduleId}
  `);
  return { resumed: true, nextRunAt };
}

export async function listSchedules(filter?: {
  active?: boolean;
  tenantId?: string;
  limit?: number;
}): Promise<Array<Record<string, unknown>>> {
  const limit = Math.min(filter?.limit ?? 50, 200);
  const activeClause = filter?.active !== undefined ? drizzleSql`AND active = ${filter.active}` : drizzleSql``;
  const tenantClause = filter?.tenantId ? drizzleSql`AND tenant_id = ${filter.tenantId}` : drizzleSql``;
  const rows = await db.execute(drizzleSql`
    SELECT id, job_type, schedule_cron, tenant_id, active, last_run_at, next_run_at, created_at
    FROM job_schedules
    WHERE 1=1 ${activeClause} ${tenantClause}
    ORDER BY created_at DESC LIMIT ${limit}
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * Trigger all due schedules (schedules where next_run_at <= NOW() and active = true).
 * Returns the number of jobs dispatched.
 */
export async function triggerDueSchedules(): Promise<{
  triggered: number;
  jobs: Array<{ jobId: string; jobType: string; scheduleId: string }>;
}> {
  const dueRows = await db.execute(drizzleSql`
    SELECT id, job_type, tenant_id, payload_template, schedule_cron
    FROM job_schedules
    WHERE active = true AND (next_run_at IS NULL OR next_run_at <= NOW())
    ORDER BY next_run_at ASC
    LIMIT 100
  `);

  const triggered: Array<{ jobId: string; jobType: string; scheduleId: string }> = [];

  for (const row of dueRows.rows as Record<string, unknown>[]) {
    try {
      const result = await dispatchJob({
        jobType: row.job_type as string,
        tenantId: (row.tenant_id as string) ?? undefined,
        payload: (row.payload_template as Record<string, unknown>) ?? {},
        idempotencyKey: `schedule-${row.id as string}-${Math.floor(Date.now() / 60_000)}`,
      });
      const nextRunAt = computeNextRunAt(row.schedule_cron as string);
      await db.execute(drizzleSql`
        UPDATE job_schedules
        SET last_run_at = NOW(), next_run_at = ${nextRunAt.toISOString()}, updated_at = NOW()
        WHERE id = ${row.id as string}
      `);
      triggered.push({ jobId: result.id, jobType: row.job_type as string, scheduleId: row.id as string });
    } catch {
      // INV-JOB3: scheduling failure must not crash the loop
    }
  }

  return { triggered: triggered.length, jobs: triggered };
}

export async function explainSchedule(scheduleId: string): Promise<{
  schedule: Record<string, unknown> | null;
  nextRuns: Date[];
  intervalMs: number;
}> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM job_schedules WHERE id = ${scheduleId} LIMIT 1
  `);
  const schedule = (rows.rows[0] as Record<string, unknown>) ?? null;
  if (!schedule) return { schedule: null, nextRuns: [], intervalMs: 0 };

  const cron = schedule.schedule_cron as string;
  const intervalMs = CRON_INTERVAL_MAP[cron.toLowerCase()] ?? 3600_000;
  const nextRuns: Date[] = [];
  let from = new Date();
  for (let i = 0; i < 5; i++) {
    const next = computeNextRunAt(cron, from);
    nextRuns.push(next);
    from = next;
  }
  return { schedule, nextRuns, intervalMs };
}
