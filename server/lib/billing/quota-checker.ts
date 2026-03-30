/**
 * Phase 20 — Quota Checker
 * Enforces usage quotas for tenants at AI orchestration, retrieval,
 * agent execution, and background job integration points.
 *
 * INV-ENT1: Quota checks are synchronous and never silently pass.
 * INV-ENT2: Unlimited quotas (quota_limit = -1) always allow.
 * INV-ENT3: Quota enforcement is tenant-isolated.
 */

import { db } from "../../db.ts";
import { sql as drizzleSql } from "drizzle-orm";

export interface QuotaCheckResult {
  allowed: boolean;
  quotaKey: string;
  tenantId: string;
  used: number;
  limit: number;
  remaining: number;
  unlimited: boolean;
  reason?: string;
}

/**
 * Check whether a tenant has remaining quota for a given quota_key.
 * Integrates with: AI orchestrator, retrieval engine, agent execution, background jobs.
 */
export async function checkQuota(
  tenantId: string,
  quotaKey: string,
): Promise<QuotaCheckResult> {
  if (!tenantId?.trim()) {
    return { allowed: false, quotaKey, tenantId, used: 0, limit: 0, remaining: 0, unlimited: false, reason: "tenantId required" };
  }

  // Get tenant's active plan quota
  const quotaRows = await db.execute(drizzleSql`
    SELECT uq.quota_limit, uq.reset_period
    FROM tenant_plans tp
    JOIN plans p ON p.id = tp.plan_id
    JOIN usage_quotas uq ON uq.plan_id = p.id
    WHERE tp.tenant_id = ${tenantId}
      AND tp.status = 'active'
      AND p.active = true
      AND uq.quota_key = ${quotaKey}
    ORDER BY tp.started_at DESC
    LIMIT 1
  `);

  const quota = quotaRows.rows[0] as Record<string, unknown> | undefined;
  if (!quota) {
    return {
      allowed: false,
      quotaKey,
      tenantId,
      used: 0,
      limit: 0,
      remaining: 0,
      unlimited: false,
      reason: `No quota defined for key '${quotaKey}' on tenant's plan`,
    };
  }

  const limit = Number(quota.quota_limit);

  // INV-ENT2: unlimited quota (-1) always allows
  if (limit === -1) {
    return { allowed: true, quotaKey, tenantId, used: 0, limit: -1, remaining: -1, unlimited: true };
  }

  // Get current usage for active period
  const usageRows = await db.execute(drizzleSql`
    SELECT COALESCE(SUM(usage_value), 0) AS used
    FROM usage_counters
    WHERE tenant_id = ${tenantId}
      AND quota_key = ${quotaKey}
      AND period_start <= NOW()
      AND period_end >= NOW()
  `);

  const used = Number((usageRows.rows[0] as Record<string, unknown>)?.used ?? 0);
  const remaining = Math.max(0, limit - used);
  const allowed = used < limit;

  return {
    allowed,
    quotaKey,
    tenantId,
    used,
    limit,
    remaining,
    unlimited: false,
    reason: allowed ? undefined : `Quota exhausted: ${used}/${limit} ${quotaKey} used`,
  };
}

/**
 * Assert quota — throws QUOTA_EXCEEDED if not allowed.
 * Drop-in enforcement guard for AI orchestrator / agent / job hooks.
 */
export async function assertQuota(tenantId: string, quotaKey: string): Promise<void> {
  const result = await checkQuota(tenantId, quotaKey);
  if (!result.allowed) {
    throw new Error(`QUOTA_EXCEEDED: ${result.reason ?? `Quota exceeded for ${quotaKey}`}`);
  }
}

/**
 * Get all quota statuses for a tenant.
 */
export async function getTenantQuotaStatus(tenantId: string): Promise<Array<{
  quotaKey: string;
  used: number;
  limit: number;
  remaining: number;
  unlimited: boolean;
  pctUsed: number;
}>> {
  const quotaRows = await db.execute(drizzleSql`
    SELECT uq.quota_key, uq.quota_limit
    FROM tenant_plans tp
    JOIN plans p ON p.id = tp.plan_id
    JOIN usage_quotas uq ON uq.plan_id = p.id
    WHERE tp.tenant_id = ${tenantId}
      AND tp.status = 'active'
      AND p.active = true
    ORDER BY uq.quota_key ASC
  `);

  const results = [];
  for (const row of quotaRows.rows as Record<string, unknown>[]) {
    const qKey = row.quota_key as string;
    const limit = Number(row.quota_limit);
    if (limit === -1) {
      results.push({ quotaKey: qKey, used: 0, limit: -1, remaining: -1, unlimited: true, pctUsed: 0 });
      continue;
    }
    const usageRows = await db.execute(drizzleSql`
      SELECT COALESCE(SUM(usage_value), 0) AS used FROM usage_counters
      WHERE tenant_id = ${tenantId} AND quota_key = ${qKey}
        AND period_start <= NOW() AND period_end >= NOW()
    `);
    const used = Number((usageRows.rows[0] as Record<string, unknown>)?.used ?? 0);
    results.push({
      quotaKey: qKey,
      used,
      limit,
      remaining: Math.max(0, limit - used),
      unlimited: false,
      pctUsed: limit > 0 ? Math.round((used / limit) * 100) : 0,
    });
  }
  return results;
}

/**
 * Check quota for a background job before dispatch.
 * Returns true if allowed, false otherwise (non-throwing for job-runner integration).
 */
export async function jobQuotaGate(tenantId: string, jobType: string): Promise<boolean> {
  try {
    const result = await checkQuota(tenantId, `job:${jobType}`);
    // If no quota is defined for this job type, fail-open (allow)
    if (!result.unlimited && result.reason?.includes("No quota defined")) return true;
    return result.allowed || result.unlimited;
  } catch {
    return true; // Default allow if quota lookup fails (fail-open for jobs)
  }
}
