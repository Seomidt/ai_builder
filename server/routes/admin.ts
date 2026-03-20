import type { Express, Request, Response } from "express";
import { z } from "zod";
import { runAiOpsQuery } from "../lib/ai-ops/orchestrator";
import { generateWeeklyDigest } from "../lib/ai-ops/digest";
import { getOpsSummary, invalidateOpsSummaryCache } from "../lib/ai-ops/ops-summary";
import { getRecentAuditLog, getAuditStats } from "../lib/ai-ops/audit";
import { SUPPORTED_INTENTS, isValidIntent } from "../lib/ai-ops/intents";
import { resolveUserFromRequest } from "../lib/ai-ops/access-control";
import { checkTenantBudget, checkAllTenantBudgets, classifyBudgetStatus, currentPeriodBounds } from "../lib/ai-governance/budget-checker";
import { snapshotTenantUsage, snapshotAllTenants, getLatestSnapshot } from "../lib/ai-governance/usage-snapshotter";
import { detectTenantAnomalies, detectAllTenantAnomalies, persistAnomalies } from "../lib/ai-governance/anomaly-detector";
import { generateBudgetAlerts, generateAnomalyAlerts, listOpenAlerts, acknowledgeAlert, resolveAlert } from "../lib/ai-governance/alert-generator";
import { checkRunawayProtection, checkAllRunawayProtection } from "../lib/ai-governance/runaway-protection";
import type { PeriodType } from "../lib/ai-governance/budget-checker";

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

  // ── Ops Summary — consolidated critical-path read model (no AI call) ───────
  app.get("/api/admin/ops-summary", async (req: Request, res: Response) => {
    const forceRefresh = req.query.refresh === "true";
    try {
      const summary = await getOpsSummary(forceRefresh);
      res.json({ data: summary });
    } catch (err: unknown) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Ops summary failed" });
    }
  });

  // Invalidate ops summary cache (POST, e.g. after governance cycle)
  app.post("/api/admin/ops-summary/invalidate", (_req: Request, res: Response) => {
    invalidateOpsSummaryCache();
    res.json({ ok: true });
  });

  app.get("/api/admin/platform/deploy-health", async (_req: Request, res: Response) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};

    checks.SUPABASE_URL = {
      ok: !!process.env.SUPABASE_URL,
      detail: process.env.SUPABASE_URL ? process.env.SUPABASE_URL.replace(/\/\/(.{4}).*@/, "//$1***@") : "MISSING",
    };
    checks.SUPABASE_SERVICE_ROLE_KEY = {
      ok: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      detail: process.env.SUPABASE_SERVICE_ROLE_KEY ? "set (hidden)" : "MISSING",
    };
    checks.SUPABASE_ANON_KEY = {
      ok: !!process.env.SUPABASE_ANON_KEY,
      detail: process.env.SUPABASE_ANON_KEY ? "set (hidden)" : "MISSING",
    };
    checks.DB_CONNECTION = {
      ok: !!(process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL),
      detail: process.env.SUPABASE_DB_POOL_URL ? "SUPABASE_DB_POOL_URL" : process.env.DATABASE_URL ? "DATABASE_URL" : "MISSING",
    };
    checks.LOCKDOWN_ENABLED = {
      ok: true,
      detail: process.env.LOCKDOWN_ENABLED ?? "not set (lockdown off)",
    };
    checks.LOCKDOWN_ALLOWLIST = {
      ok: true,
      detail: process.env.LOCKDOWN_ALLOWLIST ?? "not set",
    };
    checks.DEMO_MODE = {
      ok: true,
      detail: process.env.DEMO_MODE ?? "not set",
    };
    checks.VERCEL = {
      ok: true,
      detail: process.env.VERCEL ? "true" : "false (not on Vercel)",
    };
    checks.NODE_ENV = {
      ok: true,
      detail: process.env.NODE_ENV ?? "not set",
    };

    try {
      const { getSupabaseAdmin } = await import("../lib/supabase");
      const { error } = await getSupabaseAdmin().from("organizations").select("id").limit(1);
      checks.DB_PING = { ok: !error, detail: error ? error.message : "supabase connected" };
    } catch (e: unknown) {
      checks.DB_PING = { ok: false, detail: e instanceof Error ? e.message : "unknown error" };
    }

    try {
      const { supabaseAdmin } = await import("../lib/supabase");
      const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 1 });
      checks.SUPABASE_AUTH = { ok: !error, detail: error ? error.message : `connected (${data?.users?.length ?? 0} user(s) sampled)` };
    } catch (e: unknown) {
      checks.SUPABASE_AUTH = { ok: false, detail: e instanceof Error ? e.message : "unknown error" };
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    res.status(allOk ? 200 : 503).json({
      status: allOk ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      checks,
    });
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

  // ── Phase 16: AI Cost Governance Routes ──────────────────────────────────────

  // Budget routes
  app.get("/api/admin/governance/budgets/:organizationId", async (req: Request, res: Response) => {
    const { organizationId } = req.params;
    const periodType = (req.query.periodType as PeriodType) ?? "monthly";
    const validPeriods: PeriodType[] = ["daily", "weekly", "monthly", "annual"];
    if (!validPeriods.includes(periodType)) {
      res.status(400).json({ error: "periodType must be daily|weekly|monthly|annual" });
      return;
    }
    try {
      const result = await checkTenantBudget(organizationId, periodType);
      if (!result) { res.status(404).json({ error: "No active budget for this organization+period" }); return; }
      res.json({ data: result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Budget check failed" });
    }
  });

  app.get("/api/admin/governance/budgets", async (req: Request, res: Response) => {
    const periodType = (req.query.periodType as PeriodType) ?? "monthly";
    try {
      const { results, errors } = await checkAllTenantBudgets(periodType);
      res.json({ data: results, errors });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Budget sweep failed" });
    }
  });

  // Usage snapshot routes
  app.post("/api/admin/governance/snapshots/:organizationId", async (req: Request, res: Response) => {
    const { organizationId } = req.params;
    const periodType = (req.body?.periodType as PeriodType) ?? "monthly";
    try {
      const result = await snapshotTenantUsage(organizationId, periodType);
      res.json({ data: result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Snapshot failed" });
    }
  });

  app.post("/api/admin/governance/snapshots", async (_req: Request, res: Response) => {
    try {
      const { results, errors } = await snapshotAllTenants("monthly");
      res.json({ data: results, errors });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Snapshot sweep failed" });
    }
  });

  app.get("/api/admin/governance/snapshots/:organizationId/latest", async (req: Request, res: Response) => {
    const { organizationId } = req.params;
    const periodType = (req.query.periodType as PeriodType) ?? "monthly";
    try {
      const snapshot = await getLatestSnapshot(organizationId, periodType);
      if (!snapshot) { res.status(404).json({ error: "No snapshot found" }); return; }
      res.json({ data: snapshot });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Snapshot fetch failed" });
    }
  });

  // Anomaly detection routes
  app.post("/api/admin/governance/anomalies/detect/:organizationId", async (req: Request, res: Response) => {
    const { organizationId } = req.params;
    const periodType = (req.body?.periodType as PeriodType) ?? "monthly";
    try {
      const candidates = await detectTenantAnomalies(organizationId, periodType);
      const ids = await persistAnomalies(candidates);
      res.json({ data: { candidates, persistedIds: ids } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Anomaly detection failed" });
    }
  });

  app.post("/api/admin/governance/anomalies/detect", async (_req: Request, res: Response) => {
    try {
      const result = await detectAllTenantAnomalies("monthly");
      res.json({ data: result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Anomaly sweep failed" });
    }
  });

  // Alert routes
  app.get("/api/admin/governance/alerts", async (req: Request, res: Response) => {
    const organizationId = req.query.organizationId as string | undefined;
    const limit = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
    try {
      const alerts = await listOpenAlerts(organizationId, limit);
      res.json({ data: alerts });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Alert fetch failed" });
    }
  });

  app.post("/api/admin/governance/alerts/generate/budget", async (_req: Request, res: Response) => {
    try {
      const { results } = await checkAllTenantBudgets("monthly");
      const alertResult = await generateBudgetAlerts(results);
      res.json({ data: alertResult });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Budget alert generation failed" });
    }
  });

  app.patch("/api/admin/governance/alerts/:alertId/acknowledge", async (req: Request, res: Response) => {
    const { alertId } = req.params;
    try {
      const ok = await acknowledgeAlert(alertId);
      if (!ok) { res.status(404).json({ error: "Alert not found or already closed" }); return; }
      res.json({ data: { acknowledged: true, alertId } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Acknowledge failed" });
    }
  });

  app.patch("/api/admin/governance/alerts/:alertId/resolve", async (req: Request, res: Response) => {
    const { alertId } = req.params;
    try {
      const ok = await resolveAlert(alertId);
      if (!ok) { res.status(404).json({ error: "Alert not found or already resolved" }); return; }
      res.json({ data: { resolved: true, alertId } });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Resolve failed" });
    }
  });

  // Runaway protection routes
  app.post("/api/admin/governance/runaway/check/:organizationId", async (req: Request, res: Response) => {
    const { organizationId } = req.params;
    try {
      const result = await checkRunawayProtection(organizationId);
      res.json({ data: result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Runaway check failed" });
    }
  });

  app.post("/api/admin/governance/runaway/check", async (_req: Request, res: Response) => {
    try {
      const results = await checkAllRunawayProtection();
      res.json({ data: results });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Runaway sweep failed" });
    }
  });

  // Full governance cycle: snapshot → check → alert (for a single tenant)
  app.post("/api/admin/governance/cycle/:organizationId", async (req: Request, res: Response) => {
    const { organizationId } = req.params;
    const periodType = (req.body?.periodType as PeriodType) ?? "monthly";
    try {
      const snapshot  = await snapshotTenantUsage(organizationId, periodType);
      const budget    = await checkTenantBudget(organizationId, periodType);
      const anomalies = await detectTenantAnomalies(organizationId, periodType);
      const persisted = await persistAnomalies(anomalies);
      const budgetAlerts  = budget ? await generateBudgetAlerts([budget]) : { created: [], suppressed: 0, errors: [] };
      const anomalyAlerts = await generateAnomalyAlerts(anomalies, persisted);
      const runaway       = await checkRunawayProtection(organizationId);

      res.json({
        data: {
          organizationId,
          periodType,
          snapshot,
          budget,
          anomalies: { candidates: anomalies.length, persisted: persisted.length },
          alerts: {
            budget:  budgetAlerts.created.length,
            anomaly: anomalyAlerts.created.length,
            runaway: runaway.alertIds.length,
          },
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : "Governance cycle failed" });
    }
  });

  // Utility: period bounds helper
  app.get("/api/admin/governance/period-bounds", (req: Request, res: Response) => {
    const periodType = (req.query.periodType as PeriodType) ?? "monthly";
    const validPeriods: PeriodType[] = ["daily", "weekly", "monthly", "annual"];
    if (!validPeriods.includes(periodType)) {
      res.status(400).json({ error: "periodType must be daily|weekly|monthly|annual" });
      return;
    }
    const bounds = currentPeriodBounds(periodType);
    res.json({ data: { periodType, periodStart: bounds.start, periodEnd: bounds.end } });
  });

  // Utility: classify budget status without DB
  app.post("/api/admin/governance/classify-budget", (req: Request, res: Response) => {
    const schema = z.object({
      currentUsageUsdCents: z.number().int().min(0),
      budgetUsdCents:       z.number().int().min(1),
      warningThresholdPct:  z.number().int().min(1).max(99).default(80),
      hardLimitPct:         z.number().int().min(1).max(100).default(100),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    const d = parsed.data;
    const result = classifyBudgetStatus(
      BigInt(d.currentUsageUsdCents),
      BigInt(d.budgetUsdCents),
      d.warningThresholdPct,
      d.hardLimitPct,
    );
    res.json({ data: result });
  });
}
