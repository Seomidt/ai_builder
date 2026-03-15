/**
 * Phase 16 — Usage Snapshotter
 * Captures periodic usage snapshots for tenant cost tracking.
 *
 * INV-GOV-1: Never throws — fail open.
 * INV-GOV-4: All snapshots are strictly per-tenant.
 * INV-GOV-5: Snapshot history provides full audit trail.
 */

import { db } from "../../db";
import { tenantAiUsageSnapshots } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { sql as drizzleSql } from "drizzle-orm";

/**
 * Return current period label (YYYY-MM).
 */
export function getCurrentPeriod(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Capture a usage snapshot for a tenant.
 * Reads from obs_ai_latency_metrics to get live aggregate.
 * INV-GOV-1: Never throws.
 */
export async function captureUsageSnapshot(
  tenantId: string,
  period?: string,
): Promise<{ tokensIn: number; tokensOut: number; costUsd: number; period: string } | null> {
  try {
    const p = period ?? getCurrentPeriod();
    const [yr, mo] = p.split("-").map(Number);
    const periodStart = new Date(Date.UTC(yr, mo - 1, 1));
    const periodEnd = new Date(Date.UTC(yr, mo, 1));

    const result = await db.execute<{
      tokens_in: string;
      tokens_out: string;
      cost_usd: string;
    }>(drizzleSql`
      SELECT
        COALESCE(SUM(tokens_in), 0)::int AS tokens_in,
        COALESCE(SUM(tokens_out), 0)::int AS tokens_out,
        COALESCE(SUM(cost_usd::numeric), 0)::float AS cost_usd
      FROM obs_ai_latency_metrics
      WHERE tenant_id = ${tenantId}
        AND created_at >= ${periodStart}
        AND created_at < ${periodEnd}
    `);

    const row = result.rows[0];
    const tokensIn = Number(row?.tokens_in ?? 0);
    const tokensOut = Number(row?.tokens_out ?? 0);
    const costUsd = Number(row?.cost_usd ?? 0);

    await db.insert(tenantAiUsageSnapshots).values({
      tenantId,
      period: p,
      tokensIn,
      tokensOut,
      costUsd: String(costUsd),
    });

    return { tokensIn, tokensOut, costUsd, period: p };
  } catch {
    return null; // INV-GOV-1: fail open
  }
}

/**
 * Get the most recent snapshot for a tenant and period.
 */
export async function getLatestSnapshot(tenantId: string, period?: string) {
  try {
    const p = period ?? getCurrentPeriod();
    const rows = await db
      .select()
      .from(tenantAiUsageSnapshots)
      .where(and(
        eq(tenantAiUsageSnapshots.tenantId, tenantId),
        eq(tenantAiUsageSnapshots.period, p),
      ))
      .orderBy(desc(tenantAiUsageSnapshots.createdAt))
      .limit(1);
    return rows[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * List all snapshots for a tenant, most recent first.
 */
export async function listSnapshots(tenantId: string, limit = 50) {
  try {
    return await db
      .select()
      .from(tenantAiUsageSnapshots)
      .where(eq(tenantAiUsageSnapshots.tenantId, tenantId))
      .orderBy(desc(tenantAiUsageSnapshots.createdAt))
      .limit(limit);
  } catch {
    return [];
  }
}

/**
 * List recent snapshots across all tenants (admin view).
 */
export async function listAllSnapshots(limit = 100) {
  try {
    return await db
      .select()
      .from(tenantAiUsageSnapshots)
      .orderBy(desc(tenantAiUsageSnapshots.createdAt))
      .limit(limit);
  } catch {
    return [];
  }
}
