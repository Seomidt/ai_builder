/**
 * AI Request State Summary — Phase 3J
 *
 * SERVER-ONLY: Backend-only summary of idempotency state for admin/debug use.
 * No public route. No UI. Foundation for future admin observability.
 *
 * Phase 3J.
 */

import { eq, and, gte, sql } from "drizzle-orm";
import { db } from "../../db";
import { aiRequestStates, aiRequestStateEvents } from "@shared/schema";

export interface AiRequestStateSummary {
  tenantId: string;
  inProgressCount: number;
  completedCount: number;
  failedCount: number;
  recentDuplicateInflightCount: number;
  recentDuplicateReplayCount: number;
}

/**
 * Return a summary of current idempotency state for a tenant.
 * "Recent" = last 24 hours for event counts.
 */
export async function getAiRequestStateSummary(
  tenantId: string,
): Promise<AiRequestStateSummary> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

  // State counts by status
  const stateCounts = await db
    .select({
      status: aiRequestStates.status,
      count: sql<number>`count(*)::int`,
    })
    .from(aiRequestStates)
    .where(eq(aiRequestStates.tenantId, tenantId))
    .groupBy(aiRequestStates.status);

  const byStatus = Object.fromEntries(
    stateCounts.map((r) => [r.status, r.count]),
  );

  // Recent duplicate event counts
  const eventCounts = await db
    .select({
      eventType: aiRequestStateEvents.eventType,
      count: sql<number>`count(*)::int`,
    })
    .from(aiRequestStateEvents)
    .where(
      and(
        eq(aiRequestStateEvents.tenantId, tenantId),
        gte(aiRequestStateEvents.createdAt, since),
      ),
    )
    .groupBy(aiRequestStateEvents.eventType);

  const byEvent = Object.fromEntries(
    eventCounts.map((r) => [r.eventType, r.count]),
  );

  return {
    tenantId,
    inProgressCount: byStatus["in_progress"] ?? 0,
    completedCount: byStatus["completed"] ?? 0,
    failedCount: byStatus["failed"] ?? 0,
    recentDuplicateInflightCount: byEvent["duplicate_inflight"] ?? 0,
    recentDuplicateReplayCount: byEvent["duplicate_replayed"] ?? 0,
  };
}
