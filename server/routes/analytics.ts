/**
 * Phase 50 — Analytics Foundation
 * Server-side Analytics Ingestion Route
 *
 * POST /api/analytics/track  — client event ingestion
 * GET  /api/admin/analytics/summary   — aggregated rollup summary (admin only)
 * GET  /api/admin/analytics/funnels   — funnel event aggregates
 * GET  /api/admin/analytics/retention — retention event aggregates
 */

import { Router, Request, Response } from "express";
import { db }                        from "../db";
import { analyticsEvents, analyticsDailyRollups } from "../../shared/schema";
import {
  isValidEventName,
  getFamilyForEvent,
  isValidDomainRole,
  isValidLocale,
} from "../lib/analytics/event-taxonomy";
import { sanitizeAnalyticsPayload } from "../lib/analytics/privacy-rules";
import { eq, sql, desc, and, gte }  from "drizzle-orm";

export const analyticsRouter = Router();

// ─── POST /api/analytics/track ────────────────────────────────────────────────

analyticsRouter.post("/track", async (req: Request, res: Response): Promise<void> => {
  const { eventName, domainRole, locale, sessionId, properties } = req.body ?? {};

  if (!eventName || !isValidEventName(eventName)) {
    res.status(400).json({ error: "Invalid or unknown event name" });
    return;
  }

  if (domainRole && !isValidDomainRole(domainRole)) {
    res.status(400).json({ error: "Invalid domain_role" });
    return;
  }

  if (locale && !isValidLocale(locale)) {
    res.status(400).json({ error: "Invalid locale" });
    return;
  }

  const family     = getFamilyForEvent(eventName);
  const cleanProps = sanitizeAnalyticsPayload(
    typeof properties === "object" && properties !== null ? properties : {},
  );

  const user: any = (req as any).user ?? null;

  try {
    await db.insert(analyticsEvents).values({
      organizationId: user?.organizationId ?? null,
      actorUserId:    user?.id             ?? null,
      clientId:       null,
      eventName,
      eventFamily:    family,
      source:         "client",
      domainRole:     domainRole ?? null,
      locale:         locale     ?? null,
      sessionId:      sessionId  ?? null,
      requestId:      (req as any).requestId ?? null,
      properties:     cleanProps,
    });

    res.status(204).end();
  } catch (err) {
    console.error("[analytics/track] write failed:", err);
    res.status(204).end();
  }
});

// ─── Admin analytics routes ───────────────────────────────────────────────────

export const adminAnalyticsRouter = Router();

adminAnalyticsRouter.get("/summary", async (_req: Request, res: Response): Promise<void> => {
  try {
    const rows = await db
      .select({
        eventFamily: analyticsDailyRollups.eventFamily,
        totalEvents: sql<number>`sum(${analyticsDailyRollups.eventCount})::bigint`,
        totalUsers:  sql<number>`sum(${analyticsDailyRollups.uniqueUsers})::bigint`,
      })
      .from(analyticsDailyRollups)
      .groupBy(analyticsDailyRollups.eventFamily)
      .orderBy(desc(sql`sum(${analyticsDailyRollups.eventCount})`));

    res.json({ summary: rows });
  } catch (err) {
    console.error("[analytics/admin/summary]", err);
    res.status(500).json({ error: "Internal error" });
  }
});

adminAnalyticsRouter.get("/funnels", async (_req: Request, res: Response): Promise<void> => {
  try {
    const rows = await db
      .select({
        eventName:   analyticsDailyRollups.eventName,
        totalEvents: sql<number>`sum(${analyticsDailyRollups.eventCount})::bigint`,
        totalUsers:  sql<number>`sum(${analyticsDailyRollups.uniqueUsers})::bigint`,
      })
      .from(analyticsDailyRollups)
      .where(eq(analyticsDailyRollups.eventFamily, "funnel"))
      .groupBy(analyticsDailyRollups.eventName)
      .orderBy(desc(sql`sum(${analyticsDailyRollups.eventCount})`));

    res.json({ funnels: rows });
  } catch (err) {
    console.error("[analytics/admin/funnels]", err);
    res.status(500).json({ error: "Internal error" });
  }
});

adminAnalyticsRouter.get("/retention", async (_req: Request, res: Response): Promise<void> => {
  try {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const cutoff = thirtyDaysAgo.toISOString().slice(0, 10);

    const rows = await db
      .select({
        date:        analyticsDailyRollups.date,
        eventName:   analyticsDailyRollups.eventName,
        totalEvents: sql<number>`sum(${analyticsDailyRollups.eventCount})::bigint`,
        totalUsers:  sql<number>`sum(${analyticsDailyRollups.uniqueUsers})::bigint`,
      })
      .from(analyticsDailyRollups)
      .where(
        and(
          eq(analyticsDailyRollups.eventFamily, "retention"),
          gte(analyticsDailyRollups.date, cutoff),
        ),
      )
      .groupBy(analyticsDailyRollups.date, analyticsDailyRollups.eventName)
      .orderBy(desc(analyticsDailyRollups.date));

    res.json({ retention: rows });
  } catch (err) {
    console.error("[analytics/admin/retention]", err);
    res.status(500).json({ error: "Internal error" });
  }
});
