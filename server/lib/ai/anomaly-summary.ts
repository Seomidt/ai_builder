/**
 * AI Anomaly Summary — Phase 3K
 *
 * SERVER-ONLY: Must never be imported from client/ code.
 *
 * Returns a lightweight backend summary of recent anomaly events for a tenant.
 * No UI, no public route — purely for internal admin/debug use.
 *
 * Default window: last 24 hours.
 */

import { and, count, eq, gte, max, sql } from "drizzle-orm";
import { db } from "../../db";
import { aiAnomalyEvents } from "@shared/schema";

export interface AnomalySummary {
  tenantId: string;
  recentAnomalyCount: number;
  recentCostPerRequestEvents: number;
  recentWindowCostEvents: number;
  recentTokenEvents: number;
  lastEventAt: string | null;
}

/**
 * Returns a summary of anomaly events for the given tenant within the past
 * windowHours (default 24h).
 *
 * All DB errors are caught — returns zeroed summary on failure.
 */
export async function getAnomalySummary(
  tenantId: string,
  windowHours = 24,
): Promise<AnomalySummary> {
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const empty: AnomalySummary = {
    tenantId,
    recentAnomalyCount: 0,
    recentCostPerRequestEvents: 0,
    recentWindowCostEvents: 0,
    recentTokenEvents: 0,
    lastEventAt: null,
  };

  try {
    // Total count and last event timestamp
    const totals = await db
      .select({
        totalCount: count(),
        lastEventAt: max(aiAnomalyEvents.createdAt),
      })
      .from(aiAnomalyEvents)
      .where(
        and(
          eq(aiAnomalyEvents.tenantId, tenantId),
          gte(aiAnomalyEvents.createdAt, windowStart),
        ),
      );

    // Per-category counts
    const categories = await db
      .select({
        eventType: aiAnomalyEvents.eventType,
        cnt: count(),
      })
      .from(aiAnomalyEvents)
      .where(
        and(
          eq(aiAnomalyEvents.tenantId, tenantId),
          gte(aiAnomalyEvents.createdAt, windowStart),
        ),
      )
      .groupBy(aiAnomalyEvents.eventType);

    const byType: Record<string, number> = {};
    for (const row of categories) {
      byType[row.eventType] = Number(row.cnt);
    }

    const costPerRequestEvents =
      (byType["cost_per_request_exceeded"] ?? 0);

    const windowCostEvents =
      (byType["cost_per_5m_exceeded"] ?? 0) +
      (byType["cost_per_1h_exceeded"] ?? 0);

    const tokenEvents =
      (byType["tokens_per_request_exceeded"] ?? 0) +
      (byType["output_tokens_per_request_exceeded"] ?? 0);

    const totalRow = totals[0];

    return {
      tenantId,
      recentAnomalyCount: Number(totalRow?.totalCount ?? 0),
      recentCostPerRequestEvents: costPerRequestEvents,
      recentWindowCostEvents: windowCostEvents,
      recentTokenEvents: tokenEvents,
      lastEventAt: totalRow?.lastEventAt
        ? (totalRow.lastEventAt as Date).toISOString()
        : null,
    };
  } catch (err) {
    console.error(
      "[anomaly-summary] Failed to load anomaly summary:",
      err instanceof Error ? err.message : err,
    );
    return empty;
  }
}
