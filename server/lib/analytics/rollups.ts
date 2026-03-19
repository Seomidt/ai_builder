/**
 * Phase 50 — Analytics Foundation
 * Daily Rollup / Summarization Layer
 *
 * Aggregates analytics_events → analytics_daily_rollups.
 * Designed for script-driven or scheduled job execution.
 * Does not stream — runs as batch aggregation per day.
 */

import { db }           from "../../db";
import { analyticsEvents, analyticsDailyRollups } from "../../../shared/schema";
import { sql, and, gte, lt, eq } from "drizzle-orm";

export interface DailyRollupResult {
  date:        string;
  family:      string;
  eventName:   string;
  eventCount:  number;
  uniqueUsers: number;
}

// ─── Count events per name/family for a given date ───────────────────────────

export async function countDailyEvents(date: Date): Promise<DailyRollupResult[]> {
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const rows = await db
    .select({
      eventFamily: analyticsEvents.eventFamily,
      eventName:   analyticsEvents.eventName,
      eventCount:  sql<number>`count(*)::bigint`,
      uniqueUsers: sql<number>`count(distinct ${analyticsEvents.actorUserId})::bigint`,
    })
    .from(analyticsEvents)
    .where(
      and(
        gte(analyticsEvents.occurredAt, dayStart),
        lt(analyticsEvents.occurredAt, dayEnd),
      ),
    )
    .groupBy(analyticsEvents.eventFamily, analyticsEvents.eventName);

  const dateStr = dayStart.toISOString().slice(0, 10);

  return rows.map((r) => ({
    date:        dateStr,
    family:      r.eventFamily,
    eventName:   r.eventName,
    eventCount:  Number(r.eventCount),
    uniqueUsers: Number(r.uniqueUsers),
  }));
}

// ─── Compute unique users for a given event on a given date ──────────────────

export async function computeUniqueUsers(
  eventName: string,
  date: Date,
): Promise<number> {
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const [row] = await db
    .select({
      uniqueUsers: sql<number>`count(distinct ${analyticsEvents.actorUserId})::bigint`,
    })
    .from(analyticsEvents)
    .where(
      and(
        eq(analyticsEvents.eventName, eventName),
        gte(analyticsEvents.occurredAt, dayStart),
        lt(analyticsEvents.occurredAt, dayEnd),
      ),
    );

  return Number(row?.uniqueUsers ?? 0);
}

// ─── Summarize common properties for a given event on a given date ───────────

export async function summarizeProperties(
  eventName: string,
  date: Date,
): Promise<Record<string, unknown>> {
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const rows = await db
    .select({ properties: analyticsEvents.properties })
    .from(analyticsEvents)
    .where(
      and(
        eq(analyticsEvents.eventName, eventName),
        gte(analyticsEvents.occurredAt, dayStart),
        lt(analyticsEvents.occurredAt, dayEnd),
      ),
    )
    .limit(1000);

  const summary: Record<string, Record<string, number>> = {};

  for (const row of rows) {
    const props = (row.properties ?? {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(props)) {
      if (typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
        const strVal = String(value);
        if (!summary[key]) summary[key] = {};
        summary[key][strVal] = (summary[key][strVal] ?? 0) + 1;
      }
    }
  }

  return summary;
}

// ─── Main aggregation function ────────────────────────────────────────────────

export async function aggregateDailyAnalyticsRollups(date: Date): Promise<void> {
  console.log(`[analytics/rollups] Aggregating for date: ${date.toISOString().slice(0, 10)}`);

  const results = await countDailyEvents(date);

  if (results.length === 0) {
    console.log("[analytics/rollups] No events to aggregate.");
    return;
  }

  for (const result of results) {
    const propertiesSummary = await summarizeProperties(result.eventName, date);

    await db
      .insert(analyticsDailyRollups)
      .values({
        organizationId:    null,
        eventFamily:       result.family,
        eventName:         result.eventName,
        date:              result.date,
        eventCount:        BigInt(result.eventCount),
        uniqueUsers:       BigInt(result.uniqueUsers),
        propertiesSummary,
      })
      .onConflictDoUpdate({
        target: [
          analyticsDailyRollups.date,
          analyticsDailyRollups.eventFamily,
          analyticsDailyRollups.eventName,
        ],
        set: {
          eventCount:        BigInt(result.eventCount),
          uniqueUsers:       BigInt(result.uniqueUsers),
          propertiesSummary,
        },
      });
  }

  console.log(`[analytics/rollups] Done — ${results.length} rows upserted.`);
}
