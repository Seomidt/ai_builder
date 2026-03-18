/**
 * Phase 26 — Legal Hold System
 * When an active legal hold exists for a tenant, all retention rules and
 * deletion workflows are bypassed. Holds must be explicitly released.
 */

import { db } from "../../db";
import { sql, eq, and } from "drizzle-orm";
import {
  legalHolds, type LegalHold, type InsertLegalHold,
} from "@shared/schema";

// ── Hold creation ─────────────────────────────────────────────────────────────

/**
 * Place a legal hold on a tenant. Prevents all data deletion for the tenant.
 */
export async function placeLegalHold(data: {
  tenantId: string;
  reason: string;
  requestedBy?: string;
  scope?: string;
}): Promise<LegalHold> {
  const rows = await db.insert(legalHolds).values({
    tenantId: data.tenantId,
    reason: data.reason,
    requestedBy: data.requestedBy,
    scope: data.scope ?? "all",
    active: true,
  }).returning();
  return rows[0];
}

// ── Hold query ────────────────────────────────────────────────────────────────

/**
 * Check if a tenant is currently under an active legal hold.
 */
export async function isUnderLegalHold(tenantId: string, scope?: string): Promise<boolean> {
  const conditions = [
    eq(legalHolds.tenantId, tenantId),
    eq(legalHolds.active, true),
  ];

  // scope "all" blocks everything; specific scope blocks only that scope
  if (scope) {
    // block if there is a hold with scope "all" OR the matching scope
    const rows = await db.select().from(legalHolds)
      .where(and(
        eq(legalHolds.tenantId, tenantId),
        eq(legalHolds.active, true),
      ));
    return rows.some(h => h.scope === "all" || h.scope === scope);
  }

  const rows = await db.select().from(legalHolds).where(and(...conditions)).limit(1);
  return rows.length > 0;
}

/**
 * Get active legal hold details for a tenant.
 */
export async function getActiveLegalHolds(tenantId: string): Promise<LegalHold[]> {
  return db.select().from(legalHolds)
    .where(and(eq(legalHolds.tenantId, tenantId), eq(legalHolds.active, true)));
}

/**
 * Get all legal holds for a tenant (active + released).
 */
export async function listLegalHolds(params?: {
  tenantId?: string;
  activeOnly?: boolean;
  limit?: number;
}): Promise<LegalHold[]> {
  let q = db.select().from(legalHolds);
  const conditions = [];
  if (params?.tenantId) conditions.push(eq(legalHolds.tenantId, params.tenantId));
  if (params?.activeOnly) conditions.push(eq(legalHolds.active, true));
  if (conditions.length) q = q.where(and(...conditions)) as typeof q;
  return q.limit(params?.limit ?? 50).orderBy(sql`${legalHolds.createdAt} DESC`);
}

/**
 * Get a single legal hold by ID.
 */
export async function getLegalHold(id: string): Promise<LegalHold | null> {
  const rows = await db.select().from(legalHolds).where(eq(legalHolds.id, id)).limit(1);
  return rows[0] ?? null;
}

// ── Hold release ──────────────────────────────────────────────────────────────

export interface ReleaseResult {
  released: boolean;
  holdId: string;
  tenantId: string;
  releasedAt: Date;
  message: string;
}

/**
 * Release a specific legal hold.
 */
export async function releaseLegalHold(id: string, releasedBy?: string): Promise<ReleaseResult> {
  const hold = await getLegalHold(id);
  if (!hold) {
    return { released: false, holdId: id, tenantId: "", releasedAt: new Date(), message: "Hold not found" };
  }
  if (!hold.active) {
    return { released: false, holdId: id, tenantId: hold.tenantId, releasedAt: new Date(), message: "Hold already released" };
  }

  await db.update(legalHolds).set({
    active: false,
    releasedAt: new Date(),
    releasedBy: releasedBy ?? "system",
  }).where(eq(legalHolds.id, id));

  return {
    released: true,
    holdId: id,
    tenantId: hold.tenantId,
    releasedAt: new Date(),
    message: `Legal hold released by ${releasedBy ?? "system"}`,
  };
}

/**
 * Release all active holds for a tenant.
 */
export async function releaseAllLegalHolds(tenantId: string, releasedBy?: string): Promise<number> {
  const result = await db.update(legalHolds).set({
    active: false,
    releasedAt: new Date(),
    releasedBy: releasedBy ?? "system",
  }).where(and(eq(legalHolds.tenantId, tenantId), eq(legalHolds.active, true))).returning();
  return result.length;
}

// ── Hold enforcement ──────────────────────────────────────────────────────────

export interface HoldEnforcementResult {
  blocked: boolean;
  reason?: string;
  holdIds: string[];
  tenantId: string;
}

/**
 * Enforce legal hold check before any deletion. Returns blocked=true if holds prevent action.
 */
export async function enforceLegalHold(tenantId: string, operation: string, scope?: string): Promise<HoldEnforcementResult> {
  const activeHolds = await getActiveLegalHolds(tenantId);

  if (activeHolds.length === 0) {
    return { blocked: false, holdIds: [], tenantId };
  }

  // Check scope match
  const blockingHolds = scope
    ? activeHolds.filter(h => h.scope === "all" || h.scope === scope)
    : activeHolds;

  if (blockingHolds.length === 0) {
    return { blocked: false, holdIds: [], tenantId };
  }

  return {
    blocked: true,
    reason: `Operation '${operation}' blocked by ${blockingHolds.length} active legal hold(s): ${blockingHolds.map(h => h.reason).join("; ")}`,
    holdIds: blockingHolds.map(h => h.id),
    tenantId,
  };
}

// ── Hold statistics ───────────────────────────────────────────────────────────

export async function getLegalHoldStats(): Promise<{
  totalHolds: number;
  activeHolds: number;
  tenantsAffected: number;
  holdsByScope: Record<string, number>;
}> {
  const result = await db.execute(sql`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN active THEN 1 ELSE 0 END) AS active_count,
      COUNT(DISTINCT CASE WHEN active THEN tenant_id END) AS tenants_affected,
      scope,
      SUM(CASE WHEN active THEN 1 ELSE 0 END) AS scope_active
    FROM legal_holds
    GROUP BY scope
  `);

  const rows = result.rows as any[];
  const holdsByScope: Record<string, number> = {};
  let total = 0, active = 0, tenants = 0;

  for (const row of rows) {
    holdsByScope[row.scope] = parseInt(row.scope_active ?? "0", 10);
    total += parseInt(row.total ?? "0", 10);
    active += parseInt(row.active_count ?? "0", 10);
    tenants = Math.max(tenants, parseInt(row.tenants_affected ?? "0", 10));
  }

  return { totalHolds: total, activeHolds: active, tenantsAffected: tenants, holdsByScope };
}
