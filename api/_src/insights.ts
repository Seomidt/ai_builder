/**
 * api/_src/insights.ts — Thin Vercel Serverless Handler for /api/insights/*
 *
 * Routes:
 *   GET  /api/insights                — list insights (filterable by status/severity/category)
 *   GET  /api/insights/summary        — counts by severity/category
 *   POST /api/insights/run            — trigger insight evaluation for tenant
 *   POST /api/insights/:id/dismiss    — dismiss an insight
 *   POST /api/insights/:id/resolve    — resolve an insight
 */

import "../../server/lib/env.ts";
import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth.ts";

// ── Helpers ───────────────────────────────────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(payload);
}

async function getDb() {
  const { db } = await import("../../server/db");
  return db;
}

async function getOrm() {
  return import("drizzle-orm");
}

function handleError(res: ServerResponse, err: unknown, label = "insights"): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[vercel/${label}]`, message);
  json(res, 500, { error_code: "INTERNAL_ERROR", message });
}

function pathSegments(url: string): string[] {
  return url.replace(/^\/api\/insights/, "").replace(/\?.*$/, "").split("/").filter(Boolean);
}

// ── Route: GET /api/insights ──────────────────────────────────────────────────

async function listInsights(orgId: string, url: string, res: ServerResponse): Promise<void> {
  try {
    const qs = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
    const severity = qs.get("severity") ?? undefined;
    const category = qs.get("category") ?? undefined;
    const status   = qs.get("status") ?? "active";

    const db = await getDb();
    const { tenantInsights } = await import("../../shared/schema");
    const { eq, and, desc } = await getOrm();

    const conditions: any[] = [
      eq(tenantInsights.tenantId, orgId),
      eq(tenantInsights.status,   status),
    ];
    if (severity) conditions.push(eq(tenantInsights.severity, severity));
    if (category) conditions.push(eq(tenantInsights.category, category));

    const rows = await db
      .select()
      .from(tenantInsights)
      .where(and(...conditions))
      .orderBy(desc(tenantInsights.lastDetectedAt));

    json(res, 200, rows);
  } catch (err) {
    handleError(res, err, "insights/list");
  }
}

// ── Route: GET /api/insights/summary ─────────────────────────────────────────

async function insightsSummary(orgId: string, res: ServerResponse): Promise<void> {
  try {
    const db = await getDb();
    const { tenantInsights } = await import("../../shared/schema");
    const { eq, and } = await getOrm();

    const rows = await db
      .select()
      .from(tenantInsights)
      .where(and(eq(tenantInsights.tenantId, orgId), eq(tenantInsights.status, "active")));

    const summary = {
      total:    rows.length,
      severity: { low: 0, moderate: 0, high: 0 } as Record<string, number>,
      category: {
        security: 0, performance: 0, cost: 0, configuration: 0, retrieval: 0,
      } as Record<string, number>,
    };

    for (const row of rows) {
      if (row.severity in summary.severity) summary.severity[row.severity]++;
      if (row.category in summary.category) summary.category[row.category]++;
    }

    json(res, 200, summary);
  } catch (err) {
    handleError(res, err, "insights/summary");
  }
}

// ── Route: POST /api/insights/run ────────────────────────────────────────────

async function runInsights(orgId: string, res: ServerResponse): Promise<void> {
  try {
    const { runTenantInsights } = await import("../../server/lib/insights/run-tenant-insights");
    const result = await runTenantInsights(orgId);
    json(res, 200, result);
  } catch (err) {
    handleError(res, err, "insights/run");
  }
}

// ── Route: POST /api/insights/:id/dismiss ────────────────────────────────────

async function dismissInsight(orgId: string, userId: string, insightId: string, res: ServerResponse): Promise<void> {
  try {
    const db = await getDb();
    const { tenantInsights } = await import("../../shared/schema");
    const { eq, and } = await getOrm();

    const [existing] = await db
      .select()
      .from(tenantInsights)
      .where(and(eq(tenantInsights.id, insightId), eq(tenantInsights.tenantId, orgId)))
      .limit(1);

    if (!existing) {
      json(res, 404, { error_code: "NOT_FOUND", message: "Insight ikke fundet" }); return;
    }
    if (existing.status !== "active") {
      json(res, 409, { error_code: "INVALID_STATE", message: `Insight har status '${existing.status}'` }); return;
    }

    const [updated] = await db
      .update(tenantInsights)
      .set({ status: "dismissed", dismissedAt: new Date(), dismissedBy: userId, updatedAt: new Date() })
      .where(and(eq(tenantInsights.id, insightId), eq(tenantInsights.tenantId, orgId)))
      .returning();

    json(res, 200, updated);
  } catch (err) {
    handleError(res, err, "insights/dismiss");
  }
}

// ── Route: POST /api/insights/:id/resolve ────────────────────────────────────

async function resolveInsight(orgId: string, insightId: string, res: ServerResponse): Promise<void> {
  try {
    const db = await getDb();
    const { tenantInsights } = await import("../../shared/schema");
    const { eq, and } = await getOrm();

    const [existing] = await db
      .select()
      .from(tenantInsights)
      .where(and(eq(tenantInsights.id, insightId), eq(tenantInsights.tenantId, orgId)))
      .limit(1);

    if (!existing) {
      json(res, 404, { error_code: "NOT_FOUND", message: "Insight ikke fundet" }); return;
    }
    if (existing.status === "resolved") { json(res, 200, existing); return; }

    const [updated] = await db
      .update(tenantInsights)
      .set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tenantInsights.id, insightId), eq(tenantInsights.tenantId, orgId)))
      .returning();

    json(res, 200, updated);
  } catch (err) {
    handleError(res, err, "insights/resolve");
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? "/";
  const method = req.method?.toUpperCase() ?? "GET";
  const segs   = pathSegments(rawUrl);

  const authResult = await authenticate(req);
  if (authResult.status !== "ok" || !authResult.user) {
    const status = authResult.status === "lockdown" ? 403 : 401;
    json(res, status, { error_code: "UNAUTHENTICATED", message: "Log ind for at fortsætte" });
    return;
  }

  const { user } = authResult;
  const orgId  = user.organizationId;
  const userId = user.id;

  try {
    // GET /api/insights/summary
    if (segs[0] === "summary" && method === "GET") return insightsSummary(orgId, res);

    // POST /api/insights/run
    if (segs[0] === "run" && method === "POST") return runInsights(orgId, res);

    // POST /api/insights/:id/dismiss
    if (segs.length === 2 && segs[1] === "dismiss" && method === "POST")
      return dismissInsight(orgId, userId, segs[0], res);

    // POST /api/insights/:id/resolve
    if (segs.length === 2 && segs[1] === "resolve" && method === "POST")
      return resolveInsight(orgId, segs[0], res);

    // GET /api/insights (root)
    if (segs.length === 0 && method === "GET") return listInsights(orgId, rawUrl, res);

    json(res, 404, { error_code: "NOT_FOUND", message: "Route ikke fundet" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[vercel/insights] unhandled:", message);
    if (!res.headersSent) json(res, 500, { error_code: "INTERNAL_ERROR", message });
  }
}
