/**
 * server/routes/insights.ts
 * Phase 2.2 — Tenant Insights Engine API
 *
 * Routes:
 *   GET  /api/insights                — list active insights (filterable)
 *   GET  /api/insights/summary        — counts by severity/category
 *   POST /api/insights/run            — trigger insight evaluation for tenant
 *   POST /api/insights/:id/dismiss    — dismiss an insight
 *   POST /api/insights/:id/resolve    — manually resolve (optional)
 */

import type { Express, Request, Response } from "express";
import { db } from "../db";
import { tenantInsights } from "@shared/schema";
import { eq, and, desc } from "drizzle-orm";
import { runTenantInsights } from "../lib/insights/run-tenant-insights";

function getOrgId(req: Request): string {
  return (req as any).user?.organizationId ?? "demo-org";
}

function getUserId(req: Request): string {
  return (req as any).user?.id ?? "system";
}

export function registerInsightRoutes(app: Express): void {

  // ── GET /api/insights — list insights ──────────────────────────────────────

  app.get("/api/insights", async (req: Request, res: Response) => {
    try {
      const orgId    = getOrgId(req);
      const severity = req.query.severity as string | undefined;
      const category = req.query.category as string | undefined;
      const status   = (req.query.status as string | undefined) ?? "active";

      const rows = await db
        .select()
        .from(tenantInsights)
        .where(
          and(
            eq(tenantInsights.tenantId, orgId),
            eq(tenantInsights.status, status),
            severity ? eq(tenantInsights.severity, severity) : undefined,
            category ? eq(tenantInsights.category, category) : undefined,
          ),
        )
        .orderBy(desc(tenantInsights.lastDetectedAt));

      return res.json(rows);
    } catch (err) {
      console.error("[insights/list]", err);
      return res.status(500).json({ error_code: "INTERNAL_ERROR", message: "Kunne ikke hente insights" });
    }
  });

  // ── GET /api/insights/summary — counts by severity/category ───────────────

  app.get("/api/insights/summary", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);

      const rows = await db
        .select()
        .from(tenantInsights)
        .where(and(eq(tenantInsights.tenantId, orgId), eq(tenantInsights.status, "active")));

      const summary = {
        total:    rows.length,
        severity: { low: 0, moderate: 0, high: 0 } as Record<string, number>,
        category: {
          security:      0,
          performance:   0,
          cost:          0,
          configuration: 0,
          retrieval:     0,
        } as Record<string, number>,
      };

      for (const row of rows) {
        if (row.severity in summary.severity) summary.severity[row.severity]++;
        if (row.category in summary.category) summary.category[row.category]++;
      }

      return res.json(summary);
    } catch (err) {
      console.error("[insights/summary]", err);
      return res.status(500).json({ error_code: "INTERNAL_ERROR", message: "Kunne ikke hente opsummering" });
    }
  });

  // ── POST /api/insights/run — trigger evaluation ────────────────────────────

  app.post("/api/insights/run", async (req: Request, res: Response) => {
    try {
      const orgId  = getOrgId(req);
      const result = await runTenantInsights(orgId);
      return res.json(result);
    } catch (err) {
      console.error("[insights/run]", err);
      return res.status(500).json({ error_code: "INTERNAL_ERROR", message: "Insight-kørsel fejlede" });
    }
  });

  // ── POST /api/insights/:id/dismiss ────────────────────────────────────────

  app.post("/api/insights/:id/dismiss", async (req: Request, res: Response) => {
    try {
      const orgId   = getOrgId(req);
      const userId  = getUserId(req);
      const insightId = req.params.id;

      const [existing] = await db
        .select()
        .from(tenantInsights)
        .where(and(eq(tenantInsights.id, insightId), eq(tenantInsights.tenantId, orgId)))
        .limit(1);

      if (!existing) {
        return res.status(404).json({ error_code: "NOT_FOUND", message: "Insight ikke fundet" });
      }

      if (existing.status !== "active") {
        return res.status(409).json({
          error_code: "INVALID_STATE",
          message: `Insight har status '${existing.status}' — kan ikke afvises`,
        });
      }

      const [updated] = await db
        .update(tenantInsights)
        .set({
          status:      "dismissed",
          dismissedAt: new Date(),
          dismissedBy: userId,
          updatedAt:   new Date(),
        })
        .where(and(eq(tenantInsights.id, insightId), eq(tenantInsights.tenantId, orgId)))
        .returning();

      return res.json(updated);
    } catch (err) {
      console.error("[insights/dismiss]", err);
      return res.status(500).json({ error_code: "INTERNAL_ERROR", message: "Afvisning fejlede" });
    }
  });

  // ── POST /api/insights/:id/resolve ────────────────────────────────────────

  app.post("/api/insights/:id/resolve", async (req: Request, res: Response) => {
    try {
      const orgId     = getOrgId(req);
      const insightId = req.params.id;

      const [existing] = await db
        .select()
        .from(tenantInsights)
        .where(and(eq(tenantInsights.id, insightId), eq(tenantInsights.tenantId, orgId)))
        .limit(1);

      if (!existing) {
        return res.status(404).json({ error_code: "NOT_FOUND", message: "Insight ikke fundet" });
      }

      if (existing.status === "resolved") {
        return res.json(existing);
      }

      const [updated] = await db
        .update(tenantInsights)
        .set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(tenantInsights.id, insightId), eq(tenantInsights.tenantId, orgId)))
        .returning();

      return res.json(updated);
    } catch (err) {
      console.error("[insights/resolve]", err);
      return res.status(500).json({ error_code: "INTERNAL_ERROR", message: "Løsning fejlede" });
    }
  });
}
