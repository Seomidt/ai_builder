import type { Express, Request, Response } from "express";
import { z } from "zod";
import { runAiOpsQuery } from "../lib/ai-ops/orchestrator";
import { generateWeeklyDigest } from "../lib/ai-ops/digest";
import { getRecentAuditLog, getAuditStats } from "../lib/ai-ops/audit";
import { SUPPORTED_INTENTS, isValidIntent } from "../lib/ai-ops/intents";
import { resolveUserFromRequest } from "../lib/ai-ops/access-control";

const AiOpsQuerySchema = z.object({
  intent: z.string(),
  organizationId: z.string().optional(),
  tenantId: z.string().optional(),
  dateRange: z.object({ from: z.string(), to: z.string() }).optional(),
});

function resolveUser(req: Request) {
  return resolveUserFromRequest({
    user: (req as Request & { user?: { id?: string; role?: string; organizationId?: string } | null }).user,
  });
}

export function registerAdminRoutes(app: Express): void {

  app.get("/api/admin/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  app.get("/api/admin/tenants", (_req: Request, res: Response) => {
    res.json({ tenants: [], total: 0 });
  });

  app.get("/api/admin/plans", (_req: Request, res: Response) => {
    res.json({ plans: [] });
  });

  app.get("/api/admin/invoices", (_req: Request, res: Response) => {
    res.json({ invoices: [], total: 0 });
  });

  // ─── AI Ops Assistant Routes (Phase 51) ───────────────────────────────────

  app.post("/api/admin/ai-ops/query", async (req: Request, res: Response) => {
    const parsed = AiOpsQuerySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() });
      return;
    }

    const { intent, organizationId, tenantId } = parsed.data;

    if (!isValidIntent(intent)) {
      res.status(400).json({
        error: `Unsupported intent: "${intent}"`,
        supportedIntents: SUPPORTED_INTENTS,
      });
      return;
    }

    const user = resolveUser(req);
    const result = await runAiOpsQuery({
      intent,
      accessCtx: { user, requestedIntent: intent, requestedOrganizationId: organizationId },
      tenantId: tenantId ?? organizationId,
    });

    if (!result.success) {
      const statusCode =
        result.error?.includes("access") || result.error?.includes("role")
          ? 403
          : result.error?.includes("required") || result.error?.includes("Unsupported")
            ? 400
            : 500;
      res.status(statusCode).json({ error: result.error, auditId: result.auditId });
      return;
    }

    res.json({ data: result.response, auditId: result.auditId });
  });

  app.get("/api/admin/ai-ops/health-summary", async (req: Request, res: Response) => {
    const user = resolveUser(req);
    const result = await runAiOpsQuery({
      intent: "platform_health_summary",
      accessCtx: { user, requestedIntent: "platform_health_summary" },
    });

    if (!result.success) {
      res.status(result.error?.includes("access") ? 403 : 500).json({ error: result.error });
      return;
    }
    res.json({ data: result.response });
  });

  app.get("/api/admin/ai-ops/weekly-digest", async (req: Request, res: Response) => {
    const forceRefresh = req.query.refresh === "true";
    try {
      const digest = await generateWeeklyDigest(forceRefresh);
      res.json({ data: digest });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Digest generation failed" });
    }
  });

  app.get("/api/admin/ai-ops/tenant/:organizationId/summary", async (req: Request, res: Response) => {
    const { organizationId } = req.params;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }

    const user = resolveUser(req);
    const result = await runAiOpsQuery({
      intent: "tenant_usage_summary",
      accessCtx: { user, requestedIntent: "tenant_usage_summary", requestedOrganizationId: organizationId },
      tenantId: organizationId,
    });

    if (!result.success) {
      const statusCode =
        result.error?.includes("access") || result.error?.includes("Cross-tenant") ? 403 : 500;
      res.status(statusCode).json({ error: result.error });
      return;
    }
    res.json({ data: result.response });
  });

  app.get("/api/admin/ai-ops/intents", (_req: Request, res: Response) => {
    res.json({ intents: SUPPORTED_INTENTS });
  });

  app.get("/api/admin/ai-ops/audit", (req: Request, res: Response) => {
    const limit = parseInt(String(req.query.limit ?? "50"), 10);
    res.json({
      entries: getRecentAuditLog(Math.min(limit, 100)),
      stats: getAuditStats(),
    });
  });
}
