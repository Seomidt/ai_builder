/**
 * AI Step Budget Summary — Phase 3L
 *
 * SERVER-ONLY: Must never be imported from client/ code.
 *
 * Returns a lightweight backend summary of step budget state for a tenant.
 * No UI, no public route — purely for internal admin/debug use.
 */

import { and, count, eq, gte, sql } from "drizzle-orm";
import { db } from "../../db";
import { aiRequestStepStates, aiRequestStepEvents } from "@shared/schema";

export interface StepBudgetSummary {
  tenantId: string;
  activeRequests: number;
  exhaustedRequests: number;
  completedRequests: number;
  recentStepBudgetExceededCount: number;
}

/**
 * Returns a step budget summary for the given tenant.
 * Looks at current step states and recent exceeded events (last 24h).
 * All DB errors are caught — returns zeroed summary on failure.
 */
export async function getStepBudgetSummary(tenantId: string): Promise<StepBudgetSummary> {
  const empty: StepBudgetSummary = {
    tenantId,
    activeRequests: 0,
    exhaustedRequests: 0,
    completedRequests: 0,
    recentStepBudgetExceededCount: 0,
  };

  try {
    // Status breakdown from active step state rows (not yet expired)
    const now = new Date();
    const statusRows = await db
      .select({
        status: aiRequestStepStates.status,
        cnt: count(),
      })
      .from(aiRequestStepStates)
      .where(
        and(
          eq(aiRequestStepStates.tenantId, tenantId),
          gte(aiRequestStepStates.expiresAt, now),
        ),
      )
      .groupBy(aiRequestStepStates.status);

    const byStatus: Record<string, number> = {};
    for (const row of statusRows) {
      byStatus[row.status] = Number(row.cnt);
    }

    // Recent step_budget_exceeded events (last 24h)
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const exceededRows = await db
      .select({ cnt: count() })
      .from(aiRequestStepEvents)
      .where(
        and(
          eq(aiRequestStepEvents.tenantId, tenantId),
          eq(aiRequestStepEvents.eventType, "step_budget_exceeded"),
          gte(aiRequestStepEvents.createdAt, windowStart),
        ),
      );

    return {
      tenantId,
      activeRequests: byStatus["active"] ?? 0,
      exhaustedRequests: byStatus["exhausted"] ?? 0,
      completedRequests: byStatus["completed"] ?? 0,
      recentStepBudgetExceededCount: Number(exceededRows[0]?.cnt ?? 0),
    };
  } catch (err) {
    console.error(
      "[step-budget-summary] Failed to load summary:",
      err instanceof Error ? err.message : err,
    );
    return empty;
  }
}
