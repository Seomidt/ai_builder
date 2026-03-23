import type { Express, Request, Response } from "express";
import { z } from "zod";
import { db } from "../db";
import { sql } from "drizzle-orm";
import { getPlatformIntegrationsStatus } from "../lib/integrations/platform-integrations-status";
import { getPlatformHealth } from "../lib/integrations/integrations-health";

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

/**
 * Central admin error helper.
 * Produces the standard { error_code, message } shape.
 * For 500s it logs internally but never exposes internal detail to the client.
 */
function adminErr(res: Response, status: number, errorCode: string, message: string, err?: unknown): void {
  if (err !== undefined) {
    console.error(`[admin/${errorCode}]`, err instanceof Error ? err.message : err);
  }
  res.status(status).json({ error_code: errorCode, message: status === 500 ? "Internal server error" : message });
}

export function registerAdminRoutes(app: Express): void {

  app.get("/api/admin/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // ── Platform Integrations Status ──────────────────────────────────────────
  app.get("/api/admin/integrations/status", (_req: Request, res: Response) => {
    try {
      const report = getPlatformIntegrationsStatus();
      res.set("Cache-Control", "private, max-age=60, stale-while-revalidate=120");
      res.json(report);
    } catch (err: unknown) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  // ── Enterprise Integrations Health (live API checks, 60s cache) ───────────
  app.get("/api/admin/integrations/health", async (req: Request, res: Response) => {
    const forceRefresh = req.query.refresh === "true";
    try {
      const report = await getPlatformHealth(forceRefresh);
      res.set("Cache-Control", "private, max-age=30, stale-while-revalidate=60");
      res.json(report);
    } catch (err: unknown) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  app.post("/api/admin/integrations/health/invalidate", async (_req: Request, res: Response) => {
    try {
      const report = await getPlatformHealth(true);
      res.json(report);
    } catch (err: unknown) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  // ── Ops Summary — consolidated critical-path read model (no AI call) ───────
  app.get("/api/admin/ops-summary", async (req: Request, res: Response) => {
    const forceRefresh = req.query.refresh === "true";
    try {
      const summary = await getOpsSummary(forceRefresh);
      res.json({ data: summary });
    } catch (err: unknown) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  // Invalidate ops summary cache (POST, e.g. after governance cycle)
  app.post("/api/admin/ops-summary/invalidate", (_req: Request, res: Response) => {
    invalidateOpsSummaryCache();
    res.json({ ok: true });
  });

  app.get("/api/admin/platform/deploy-health", async (_req: Request, res: Response) => {
    const t0 = Date.now();
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

    const elapsed = Date.now() - t0;
    const allOk = Object.values(checks).every((c) => c.ok);
    // Server-Timing header: visible in browser DevTools → Network → Timing.
    // Use this to measure cold (first hit after inactivity) vs warm response time.
    res.set("Server-Timing", `total;dur=${elapsed}`);
    res.set("Cache-Control", "no-store");
    res.status(allOk ? 200 : 503).json({
      status: allOk ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      responseMs: elapsed,
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
      adminErr(res, 422, "VALIDATION_ERROR", "Invalid request");
      return;
    }

    const { intent, organizationId, tenantId } = parsed.data;

    if (!isValidIntent(intent)) {
      adminErr(res, 422, "VALIDATION_ERROR", "Unsupported intent");
      return;
    }

    const user = resolveUser(req);
    const result = await runAiOpsQuery({
      intent,
      accessCtx: { user, requestedIntent: intent, requestedOrganizationId: organizationId },
      tenantId: tenantId ?? organizationId,
    });

    if (!result.success) {
      const is403 = result.error?.includes("access") || result.error?.includes("role");
      const is422 = result.error?.includes("required") || result.error?.includes("Unsupported");
      const statusCode = is403 ? 403 : is422 ? 422 : 500;
      const errorCode  = is403 ? "PLATFORM_ADMIN_REQUIRED" : is422 ? "VALIDATION_ERROR" : "INTERNAL_ERROR";
      const message    = statusCode === 500 ? "Internal server error" : (result.error ?? "AI ops query failed");
      if (statusCode === 500) console.error("[admin/ai-ops/query]", result.error);
      res.status(statusCode).json({ error_code: errorCode, message, audit_id: result.auditId ?? null });
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
      const is403 = !!result.error?.includes("access");
      const statusCode = is403 ? 403 : 500;
      const errorCode  = is403 ? "PLATFORM_ADMIN_REQUIRED" : "INTERNAL_ERROR";
      if (!is403) console.error("[admin/ai-ops/health-summary]", result.error);
      res.status(statusCode).json({ error_code: errorCode, message: is403 ? (result.error ?? "Access denied.") : "Internal server error" });
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
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  app.get("/api/admin/ai-ops/tenant/:organizationId/summary", async (req: Request, res: Response) => {
    const { organizationId } = req.params;
    if (!organizationId) {
      adminErr(res, 422, "VALIDATION_ERROR", "organizationId is required");
      return;
    }

    const user = resolveUser(req);
    const result = await runAiOpsQuery({
      intent: "tenant_usage_summary",
      accessCtx: { user, requestedIntent: "tenant_usage_summary", requestedOrganizationId: organizationId },
      tenantId: organizationId,
    });

    if (!result.success) {
      const is403 = result.error?.includes("access") || result.error?.includes("Cross-tenant");
      const statusCode = is403 ? 403 : 500;
      const errorCode  = is403 ? "PLATFORM_ADMIN_REQUIRED" : "INTERNAL_ERROR";
      if (!is403) console.error("[admin/ai-ops/tenant-summary]", result.error);
      res.status(statusCode).json({ error_code: errorCode, message: is403 ? (result.error ?? "Access denied.") : "Internal server error" });
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
      adminErr(res, 422, "VALIDATION_ERROR", "periodType must be daily, weekly, monthly, or annual");
      return;
    }
    try {
      const result = await checkTenantBudget(organizationId, periodType);
      if (!result) { adminErr(res, 404, "NOT_FOUND", "No active budget for this organization+period"); return; }
      res.json({ data: result });
    } catch (err) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  app.get("/api/admin/governance/budgets", async (req: Request, res: Response) => {
    const periodType = (req.query.periodType as PeriodType) ?? "monthly";
    try {
      const { results, errors } = await checkAllTenantBudgets(periodType);
      res.json({ data: results, errors });
    } catch (err) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
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
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  app.post("/api/admin/governance/snapshots", async (_req: Request, res: Response) => {
    try {
      const { results, errors } = await snapshotAllTenants("monthly");
      res.json({ data: results, errors });
    } catch (err) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  app.get("/api/admin/governance/snapshots/:organizationId/latest", async (req: Request, res: Response) => {
    const { organizationId } = req.params;
    const periodType = (req.query.periodType as PeriodType) ?? "monthly";
    try {
      const snapshot = await getLatestSnapshot(organizationId, periodType);
      if (!snapshot) { adminErr(res, 404, "NOT_FOUND", "No snapshot found"); return; }
      res.json({ data: snapshot });
    } catch (err) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
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
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  app.post("/api/admin/governance/anomalies/detect", async (_req: Request, res: Response) => {
    try {
      const result = await detectAllTenantAnomalies("monthly");
      res.json({ data: result });
    } catch (err) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
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
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  app.post("/api/admin/governance/alerts/generate/budget", async (_req: Request, res: Response) => {
    try {
      const { results } = await checkAllTenantBudgets("monthly");
      const alertResult = await generateBudgetAlerts(results);
      res.json({ data: alertResult });
    } catch (err) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  app.patch("/api/admin/governance/alerts/:alertId/acknowledge", async (req: Request, res: Response) => {
    const { alertId } = req.params;
    try {
      const ok = await acknowledgeAlert(alertId);
      if (!ok) { adminErr(res, 404, "NOT_FOUND", "Alert not found or already closed"); return; }
      res.json({ data: { acknowledged: true, alertId } });
    } catch (err) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  app.patch("/api/admin/governance/alerts/:alertId/resolve", async (req: Request, res: Response) => {
    const { alertId } = req.params;
    try {
      const ok = await resolveAlert(alertId);
      if (!ok) { adminErr(res, 404, "NOT_FOUND", "Alert not found or already resolved"); return; }
      res.json({ data: { resolved: true, alertId } });
    } catch (err) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  // Runaway protection routes
  app.post("/api/admin/governance/runaway/check/:organizationId", async (req: Request, res: Response) => {
    const { organizationId } = req.params;
    try {
      const result = await checkRunawayProtection(organizationId);
      res.json({ data: result });
    } catch (err) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  app.post("/api/admin/governance/runaway/check", async (_req: Request, res: Response) => {
    try {
      const results = await checkAllRunawayProtection();
      res.json({ data: results });
    } catch (err) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
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
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  // Utility: period bounds helper
  app.get("/api/admin/governance/period-bounds", (req: Request, res: Response) => {
    const periodType = (req.query.periodType as PeriodType) ?? "monthly";
    const validPeriods: PeriodType[] = ["daily", "weekly", "monthly", "annual"];
    if (!validPeriods.includes(periodType)) {
      adminErr(res, 422, "VALIDATION_ERROR", "periodType must be daily, weekly, monthly, or annual");
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
    if (!parsed.success) { adminErr(res, 422, "VALIDATION_ERROR", "Invalid request body"); return; }
    const d = parsed.data;
    const result = classifyBudgetStatus(
      BigInt(d.currentUsageUsdCents),
      BigInt(d.budgetUsdCents),
      d.warningThresholdPct,
      d.hardLimitPct,
    );
    res.json({ data: result });
  });

  // ── UI data endpoints (governance pages) ─────────────────────────────────

  // List anomaly events (newest first)
  app.get("/api/admin/governance/anomalies", async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10), 500);
    const organizationId = req.query.organizationId as string | undefined;
    try {
      const rows = await db.execute(sql`
        SELECT id, organization_id, anomaly_type, detected_at, window_minutes,
               baseline_value::text  AS baseline_value,
               observed_value::text  AS observed_value,
               deviation_pct::text   AS deviation_pct,
               severity, is_confirmed, linked_alert_id, metadata
        FROM   ai_anomaly_events
        ${organizationId ? sql`WHERE organization_id = ${organizationId}` : sql``}
        ORDER BY detected_at DESC
        LIMIT  ${sql.raw(String(limit))}
      `);
      res.json({ data: rows.rows });
    } catch (err) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  // List usage snapshots (newest first)
  app.get("/api/admin/governance/snapshots-list", async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(String(req.query.limit ?? "100"), 10), 500);
    const organizationId = req.query.organizationId as string | undefined;
    try {
      const rows = await db.execute(sql`
        SELECT id, organization_id, period_start, period_end, period_type,
               total_tokens, prompt_tokens, completion_tokens,
               total_cost_usd_cents, request_count, failed_request_count,
               model_breakdown, snapshot_at
        FROM   tenant_ai_usage_snapshots
        ${organizationId ? sql`WHERE organization_id = ${organizationId}` : sql``}
        ORDER BY snapshot_at DESC
        LIMIT  ${sql.raw(String(limit))}
      `);
      res.json({ data: rows.rows });
    } catch (err) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });

  // Platform-wide runaway protection status (read-only — no writes)
  app.get("/api/admin/governance/runaway-status", async (_req: Request, res: Response) => {
    try {
      const results = await checkAllRunawayProtection();
      res.json({ data: results });
    } catch (err) {
      adminErr(res, 500, "INTERNAL_ERROR", "Internal server error", err);
    }
  });
}
