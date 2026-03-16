import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { registerAdminRoutes } from "./routes/admin";
import {
  getSecurityHealth,
  getSecurityViolationCounts,
  getRateLimitStats,
  explainSecurityHealth,
} from "./lib/security/security-health";
import {
  listSecurityEventsByTenant,
  listRecentSecurityEvents,
  explainSecurityEvent,
  type SecurityEventType,
} from "./lib/security/security-events";
import { sanitizeInput, sanitizeObject, explainSanitization } from "./lib/security/sanitize";
import { getRateLimitConfig } from "./middleware/rate-limit";
import { storage } from "./storage";
import { dbProvider } from "./db";
import { previewCommit } from "./lib/github-commit-format";
import { runExecutorService } from "./services/run-executor.service";
import { summarize } from "./features/ai-summarize/summarize.service";
import { ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import { AiError } from "./lib/ai/errors";
import {
  createStripeCheckoutForInvoice,
  createStripePaymentIntentForInvoice,
  getStripeCheckoutState,
} from "./lib/ai/stripe-checkout";
import { handleStripeWebhook } from "./lib/ai/stripe-webhooks";
import {
  listStripeWebhookEvents,
  getStripeWebhookEventByStripeEventId,
  getInvoiceStripeLifecycle,
  explainStripeWebhookOutcome,
} from "./lib/ai/stripe-webhook-summary";

/**
 * Central error → HTTP response mapper.
 *
 * Phase 13.1 hardening:
 *   - All responses include error_code, message, and request_id.
 *   - Stack traces are NEVER exposed to the client.
 *   - ForbiddenError (403) and UnauthorizedError (401) handled explicitly.
 *   - AI typed errors (AiError subclasses) carry their own httpStatus/errorCode.
 *
 * Stable response shape: { error_code, message, request_id }
 */
function handleError(res: Response, error: unknown, requestId?: string | null) {
  const reqId = requestId ?? null;

  if (error instanceof ZodError) {
    return res.status(400).json({
      error_code: "VALIDATION_ERROR",
      message: fromZodError(error).message,
      request_id: reqId,
    });
  }

  // Dynamic imports may produce ForbiddenError/UnauthorizedError from tenant-check.ts
  if (error instanceof Error && (error as any).statusCode) {
    const typedErr = error as Error & { statusCode: number; errorCode: string };
    return res.status(typedErr.statusCode).json({
      error_code: typedErr.errorCode ?? "ERROR",
      message: typedErr.message,
      request_id: reqId,
    });
  }

  if (error instanceof AiError) {
    if (error.retryAfterSeconds !== undefined) {
      res.set("Retry-After", String(error.retryAfterSeconds));
    }
    const payload: Record<string, unknown> = {
      error_code: error.errorCode,
      message: error.message,
      request_id: reqId,
    };
    if (error.retryAfterSeconds !== undefined) {
      payload.retry_after_seconds = error.retryAfterSeconds;
    }
    return res.status(error.httpStatus).json(payload);
  }

  if (error instanceof Error) {
    // Phase 13.1: never expose stack traces — only message, and only if safe
    const status = error.message.toLowerCase().includes("not found") ? 404 : 500;
    const message = status === 404 ? error.message : "Internal server error";
    return res.status(status).json({
      error_code: status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR",
      message,
      request_id: reqId,
    });
  }

  return res.status(500).json({
    error_code: "INTERNAL_ERROR",
    message: "Internal server error",
    request_id: reqId,
  });
}

function getOrgId(req: Request): string {
  return req.user?.organizationId ?? "demo-org";
}

function getUserId(req: Request): string {
  return req.user?.id ?? "system";
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {

  // ─── Projects ───────────────────────────────────────────────────────────────

  app.get("/api/projects", async (req, res) => {
    try {
      const projects = await storage.listProjects(getOrgId(req));
      res.json(projects);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/projects", async (req, res) => {
    try {
      const project = await storage.createProject({
        ...req.body,
        organizationId: getOrgId(req),
        createdBy: getUserId(req),
      });
      res.status(201).json(project);
    } catch (err) { handleError(res, err); }
  });

  app.get("/api/projects/:id", async (req, res) => {
    try {
      const project = await storage.getProject(req.params.id, getOrgId(req));
      res.json(project);
    } catch (err) { handleError(res, err); }
  });

  app.patch("/api/projects/:id", async (req, res) => {
    try {
      const project = await storage.updateProject(req.params.id, getOrgId(req), req.body);
      res.json(project);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/projects/:id/archive", async (req, res) => {
    try {
      const project = await storage.archiveProject(req.params.id, getOrgId(req));
      res.json(project);
    } catch (err) { handleError(res, err); }
  });

  // ─── Architectures ──────────────────────────────────────────────────────────

  app.get("/api/architectures", async (req, res) => {
    try {
      const profiles = await storage.listArchitectureProfiles(getOrgId(req));
      res.json(profiles);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/architectures", async (req, res) => {
    try {
      const profile = await storage.createArchitectureProfile({
        ...req.body,
        organizationId: getOrgId(req),
      });
      res.status(201).json(profile);
    } catch (err) { handleError(res, err); }
  });

  app.get("/api/architectures/:id", async (req, res) => {
    try {
      const profile = await storage.getArchitectureProfile(req.params.id, getOrgId(req));
      res.json(profile);
    } catch (err) { handleError(res, err); }
  });

  app.patch("/api/architectures/:id", async (req, res) => {
    try {
      const profile = await storage.updateArchitectureProfile(req.params.id, getOrgId(req), req.body);
      res.json(profile);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/architectures/:id/archive", async (req, res) => {
    try {
      const profile = await storage.archiveArchitectureProfile(req.params.id, getOrgId(req));
      res.json(profile);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/architectures/:id/versions", async (req, res) => {
    try {
      const version = await storage.createArchitectureVersion({
        ...req.body,
        architectureProfileId: req.params.id,
      });
      res.status(201).json(version);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/architectures/:id/versions/:versionId/publish", async (req, res) => {
    try {
      const version = await storage.publishArchitectureVersion(
        req.params.versionId,
        req.params.id,
        getOrgId(req),
      );
      res.json(version);
    } catch (err) { handleError(res, err); }
  });

  app.put("/api/architectures/:id/versions/:versionId/agents", async (req, res) => {
    try {
      const configs = await Promise.all(
        (req.body as unknown[]).map((c: unknown) =>
          storage.upsertAgentConfig({ ...(c as object), versionId: req.params.versionId }),
        ),
      );
      res.json(configs);
    } catch (err) { handleError(res, err); }
  });

  app.put("/api/architectures/:id/versions/:versionId/capabilities", async (req, res) => {
    try {
      const configs = await Promise.all(
        (req.body as unknown[]).map((c: unknown) =>
          storage.upsertCapabilityConfig({ ...(c as object), versionId: req.params.versionId }),
        ),
      );
      res.json(configs);
    } catch (err) { handleError(res, err); }
  });

  // ─── Runs (lifecycle) ───────────────────────────────────────────────────────

  app.get("/api/runs", async (req, res) => {
    try {
      const filters = {
        status: req.query.status as AiRunStatus | undefined,
        projectId: req.query.projectId as string | undefined,
      };
      const runs = await storage.listRuns(getOrgId(req), filters);
      res.json(runs);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/runs", async (req, res) => {
    try {
      const run = await storage.createRun({
        ...req.body,
        organizationId: getOrgId(req),
        createdBy: getUserId(req),
      });
      res.status(201).json(run);
    } catch (err) { handleError(res, err); }
  });

  app.get("/api/runs/:id", async (req, res) => {
    try {
      const run = await storage.getRun(req.params.id, getOrgId(req));
      res.json(run);
    } catch (err) { handleError(res, err); }
  });

  app.patch("/api/runs/:id/status", async (req, res) => {
    try {
      const run = await storage.updateRunStatus(req.params.id, getOrgId(req), req.body);
      res.json(run);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/runs/:id/steps", async (req, res) => {
    try {
      const step = await storage.appendStep({ ...req.body, runId: req.params.id });
      res.status(201).json(step);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/runs/:id/artifacts", async (req, res) => {
    try {
      const artifact = await storage.appendArtifact({ ...req.body, runId: req.params.id });
      res.status(201).json(artifact);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/runs/:id/tool-calls", async (req, res) => {
    try {
      const toolCall = await storage.appendToolCall({ ...req.body, runId: req.params.id });
      res.status(201).json(toolCall);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/runs/:id/approvals", async (req, res) => {
    try {
      const approval = await storage.appendApproval({
        ...req.body,
        runId: req.params.id,
        requestedBy: req.body.requestedBy ?? "system",
      });
      res.status(201).json(approval);
    } catch (err) { handleError(res, err); }
  });

  app.patch("/api/runs/:id/approvals/:approvalId", async (req, res) => {
    try {
      const approval = await storage.resolveApproval(req.params.approvalId, req.body);
      res.json(approval);
    } catch (err) { handleError(res, err); }
  });

  // ─── Run execution pipeline ─────────────────────────────────────────────────

  app.post("/api/runs/:id/execute", async (req, res) => {
    try {
      const orgId = getOrgId(req);
      // Fire execution — async (does not block response)
      runExecutorService.executeRun(req.params.id, orgId).catch((err) => {
        console.error(`[run-executor] run=${req.params.id} fatal:`, err);
      });
      // Return the run immediately (status will move to "running" within the executor)
      const run = await storage.getRun(req.params.id, orgId);
      res.status(202).json({ ...run, executing: true });
    } catch (err) { handleError(res, err); }
  });

  app.get("/api/runs/:id/artifact-dependencies", async (req, res) => {
    try {
      const deps = await storage.listArtifactDependencies(req.params.id);
      res.json(deps);
    } catch (err) { handleError(res, err); }
  });

  // ─── Integrations ───────────────────────────────────────────────────────────

  app.get("/api/integrations", async (req, res) => {
    try {
      const integrations = await storage.listIntegrations(getOrgId(req));
      res.json(integrations);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/integrations", async (req, res) => {
    try {
      const integration = await storage.upsertIntegration({
        ...req.body,
        organizationId: getOrgId(req),
      });
      res.json(integration);
    } catch (err) { handleError(res, err); }
  });

  app.get("/api/integrations/:provider", async (req, res) => {
    try {
      const integrations = await storage.listIntegrations(getOrgId(req));
      const integration = integrations.find((i) => i.provider === req.params.provider);
      if (!integration) return res.status(404).json({ error: "Integration not found" });
      res.json(integration);
    } catch (err) { handleError(res, err); }
  });

  // ─── GitHub commit preview (metadata only — write pipeline NOT active) ────

  app.get("/api/runs/:id/commit-preview", async (req, res) => {
    try {
      const run = await storage.getRun(req.params.id, getOrgId(req));
      const [profile, version] = await Promise.all([
        storage.getArchitectureProfile(run.architectureProfileId, getOrgId(req)),
        (async () => {
          const p = await storage.getArchitectureProfile(run.architectureProfileId, getOrgId(req));
          return p.versions.find((v) => v.id === run.architectureVersionId) ?? p.versions[0];
        })(),
      ]);

      if (!version) {
        return res.status(404).json({ error: "Architecture version not found" });
      }

      const preview = previewCommit({
        run: {
          id: run.id,
          runNumber: run.runNumber,
          title: run.title ?? null,
          goal: run.goal ?? null,
          tags: run.tags ?? null,
          pipelineVersion: run.pipelineVersion ?? null,
        },
        architecture: {
          name: profile.name,
          slug: profile.slug,
        },
        version: {
          versionNumber: version.versionNumber,
          versionLabel: (version as { versionLabel?: string | null }).versionLabel ?? null,
          changelog: (version as { changelog?: string | null }).changelog ?? null,
        },
        steps: run.steps.map((s) => ({
          stepKey: s.stepKey,
          title: s.title ?? null,
          status: s.status,
        })),
      });

      res.json({
        ...preview,
        note: "GitHub write pipeline not yet active. This preview shows what the commit will look like when enabled.",
        githubEnabled: !!process.env.GITHUB_TOKEN && false, // explicitly false until Phase 2
      });
    } catch (err) { handleError(res, err); }
  });

  // ─── Config (server-side env state) ────────────────────────────────────────
  // Phase 13.1 hardening: owner role required; no env values, repo names, or org IDs exposed.

  app.get("/api/config/status", async (req: Request, res: Response) => {
    try {
      const { requireOwnerRole } = await import("./lib/security/tenant-check");
      requireOwnerRole(req.user?.role);
      // Return only boolean connection flags — never expose env values or identifiers
      res.json({
        database: !!dbProvider,
        supabase: !!(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY),
        github: !!process.env.GITHUB_TOKEN,
        openai: !!process.env.OPENAI_API_KEY,
      });
    } catch (err) {
      handleError(res, err, (req as any).requestId ?? null);
    }
  });

  // ─── AI Features ─────────────────────────────────────────────────────────────

  app.post("/api/ai/summarize", async (req: Request, res: Response) => {
    try {
      const text = (req.body as { text?: string }).text?.trim() ?? "";
      if (!text) {
        return res.status(400).json({ error: "text is required" });
      }
      if (text.length < 20) {
        return res.status(400).json({ error: "Text too short to summarize" });
      }
      const result = await summarize({
        text,
        tenantId: getOrgId(req),
        userId: getUserId(req),
        requestId: req.headers["x-request-id"] as string | undefined ?? null,
      });
      return res.json({ summary: result.summary });
    } catch (err) {
      const reqId = req.headers["x-request-id"] as string | undefined ?? null;
      handleError(res, err, reqId);
    }
  });

  // ─── Stripe Checkout & Webhook Routes (Phase 4M) ────────────────────────────

  app.post("/api/stripe/checkout/:invoiceId", async (req: Request, res: Response) => {
    try {
      const invoiceId = String(req.params.invoiceId);
      const body = req.body as { successUrl?: string; cancelUrl?: string };
      const successUrl = body.successUrl;
      const cancelUrl = body.cancelUrl;
      if (!successUrl || !cancelUrl) {
        return res.status(400).json({ error: "successUrl and cancelUrl are required" });
      }
      const result = await createStripeCheckoutForInvoice(invoiceId, successUrl, cancelUrl);
      return res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post("/api/stripe/payment-intent/:invoiceId", async (req: Request, res: Response) => {
    try {
      const invoiceId = String(req.params.invoiceId);
      const result = await createStripePaymentIntentForInvoice(invoiceId);
      return res.json(result);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get("/api/stripe/state/:invoiceId", async (req: Request, res: Response) => {
    try {
      const invoiceId = String(req.params.invoiceId);
      const state = await getStripeCheckoutState(invoiceId);
      if (!state) return res.status(404).json({ error: "Invoice not found" });
      return res.json(state);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post("/api/stripe/webhook", async (req: Request, res: Response) => {
    try {
      const rawSig = req.headers["stripe-signature"];
      const sig = Array.isArray(rawSig) ? rawSig[0] : rawSig;
      if (!sig) {
        return res.status(400).json({ error: "Missing stripe-signature header" });
      }
      const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
      if (!rawBody) {
        return res.status(400).json({ error: "Missing raw request body" });
      }
      const result = await handleStripeWebhook(rawBody, sig);
      return res.json({ received: true, outcome: result.outcome, reason: result.reason });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get("/api/stripe/webhook-events", async (req: Request, res: Response) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 100), 500);
      const events = await listStripeWebhookEvents(limit);
      return res.json({ events, count: events.length });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get("/api/stripe/webhook-events/:stripeEventId", async (req: Request, res: Response) => {
    try {
      const stripeEventId = String(req.params.stripeEventId);
      const event = await getStripeWebhookEventByStripeEventId(stripeEventId);
      if (!event) return res.status(404).json({ error: "Event not found" });
      return res.json(event);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get("/api/stripe/webhook-events/:stripeEventId/explain", async (req: Request, res: Response) => {
    try {
      const stripeEventId = String(req.params.stripeEventId);
      const explanation = await explainStripeWebhookOutcome(stripeEventId);
      if (!explanation) return res.status(404).json({ error: "Event not found" });
      return res.json(explanation);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get("/api/stripe/invoice-lifecycle/:invoiceId", async (req: Request, res: Response) => {
    try {
      const invoiceId = String(req.params.invoiceId);
      const lifecycle = await getInvoiceStripeLifecycle(invoiceId);
      if (!lifecycle) return res.status(404).json({ error: "Invoice not found" });
      return res.json(lifecycle);
    } catch (err) {
      handleError(res, err);
    }
  });

  // ── Phase 13.2 — Admin Security Routes ───────────────────────────────────────

  // GET /api/admin/security/health — security observability (admin-only, read-only)
  app.get("/api/admin/security/health", async (req: Request, res: Response) => {
    try {
      const { requireOwnerRole } = await import("./lib/security/tenant-check");
      requireOwnerRole(req.user?.role);
      const health = await getSecurityHealth();
      return res.json(health);
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/admin/security/events — tenant-scoped security events
  app.get("/api/admin/security/events", async (req: Request, res: Response) => {
    try {
      const { requireOwnerRole } = await import("./lib/security/tenant-check");
      requireOwnerRole(req.user?.role);
      const tenantId = req.user?.organizationId;
      if (!tenantId) return res.status(400).json({ error_code: "MISSING_TENANT", message: "No tenant context" });
      const eventType = req.query.event_type as SecurityEventType | undefined;
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 50;
      const events = await listSecurityEventsByTenant(tenantId, { limit, eventType });
      return res.json({ events, count: events.length });
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/admin/security/events/recent — recent events across all tenants (admin)
  app.get("/api/admin/security/events/recent", async (req: Request, res: Response) => {
    try {
      const { requireOwnerRole } = await import("./lib/security/tenant-check");
      requireOwnerRole(req.user?.role);
      const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : 100;
      const events = await listRecentSecurityEvents({ limit });
      return res.json({ events, count: events.length });
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /api/admin/security/preview/sanitize — read-only sanitization preview
  app.post("/api/admin/security/preview/sanitize", async (req: Request, res: Response) => {
    try {
      const { requireOwnerRole } = await import("./lib/security/tenant-check");
      requireOwnerRole(req.user?.role);
      const input = req.body?.input;
      if (typeof input === "string") {
        const sanitized = sanitizeInput(input);
        return res.json({
          original: input,
          sanitized,
          changed: input !== sanitized,
          explanation: explainSanitization(),
          // INV-SEC-H10: no write performed
          writes: false,
        });
      }
      if (typeof input === "object" && input !== null) {
        const sanitized = sanitizeObject(input);
        return res.json({
          original: input,
          sanitized,
          explanation: explainSanitization(),
          writes: false,
        });
      }
      return res.status(400).json({ error_code: "INVALID_INPUT", message: "input must be string or object" });
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /api/admin/security/preview/rate-limit-context — read-only rate limit context
  app.post("/api/admin/security/preview/rate-limit-context", async (req: Request, res: Response) => {
    try {
      const { requireOwnerRole } = await import("./lib/security/tenant-check");
      requireOwnerRole(req.user?.role);
      const config = getRateLimitConfig();
      const actorId = req.user?.id ?? null;
      const keyType = actorId && !actorId.startsWith("demo-") ? "actor_id" : "ip";
      return res.json({
        config,
        currentActor: actorId,
        effectiveKeyType: keyType,
        rateLimitAppliesTo: "/api/*",
        // INV-SEC-H10: no write performed
        writes: false,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // Phase 4P — Admin Pricing & Plan Management routes
  registerAdminRoutes(app);

  // ── Phase 31 — Tenant Product Application API ────────────────────────────

  // GET /api/tenant/dashboard — aggregated tenant overview metrics
  app.get("/api/tenant/dashboard", async (req: Request, res: Response) => {
    try {
      const projects     = await storage.listProjects();
      const runs         = await storage.listRuns({});
      const integrations = await storage.listIntegrations();
      const activeRuns   = runs.filter((r: any) => r.status === "running").length;
      const failedRuns   = runs.filter((r: any) => r.status === "failed").length;
      const activeInts   = integrations.filter((i: any) => i.status === "active").length;
      const recentRuns   = runs.slice(0, 5);
      res.json({
        metrics: {
          totalProjects:     projects.length,
          activeRuns,
          failedRuns,
          activeIntegrations: activeInts,
          totalRuns:         runs.length,
        },
        recentRuns,
        integrationHealth: integrations.map((i: any) => ({
          id: i.id, provider: i.provider, status: i.status,
        })),
        retrievedAt: new Date().toISOString(),
      });
    } catch (err) { handleError(res, err); }
  });

  // GET /api/tenant/usage — token + cost usage from observability tables
  app.get("/api/tenant/usage", async (req: Request, res: Response) => {
    try {
      const tenantId  = (req.query.tenantId as string) ?? "demo-org";
      const period    = (req.query.period as string) ?? "30d";
      const { sql: drizzleSql } = await import("drizzle-orm");
      const { db }    = await import("./db");
      const days      = period === "7d" ? 7 : period === "90d" ? 90 : 30;
      const since     = new Date(Date.now() - days * 86_400_000).toISOString();

      const usageRes = await db.execute<any>(drizzleSql`
        SELECT
          COALESCE(SUM(tokens_in),  0)::int    AS tokens_in,
          COALESCE(SUM(tokens_out), 0)::int    AS tokens_out,
          COALESCE(SUM(cost_usd::numeric), 0)::float AS cost_usd,
          COUNT(*)::int                        AS requests,
          COUNT(DISTINCT model)::int           AS models_used
        FROM obs_ai_latency_metrics
        WHERE tenant_id = ${tenantId} AND created_at >= ${since}
      `);

      const dailyRes = await db.execute<any>(drizzleSql`
        SELECT
          DATE_TRUNC('day', created_at)::text AS day,
          COUNT(*)::int                       AS requests,
          COALESCE(SUM(cost_usd::numeric), 0)::float AS cost_usd
        FROM obs_ai_latency_metrics
        WHERE tenant_id = ${tenantId} AND created_at >= ${since}
        GROUP BY 1
        ORDER BY 1
      `);

      const u = usageRes.rows[0] ?? {};
      res.json({
        tenantId,
        period,
        summary: {
          tokensIn:   Number(u.tokens_in   ?? 0),
          tokensOut:  Number(u.tokens_out  ?? 0),
          costUsd:    Number(u.cost_usd    ?? 0),
          requests:   Number(u.requests    ?? 0),
          modelsUsed: Number(u.models_used ?? 0),
        },
        daily: dailyRes.rows.map((r: any) => ({
          day: r.day, requests: Number(r.requests), costUsd: Number(r.cost_usd),
        })),
        retrievedAt: new Date().toISOString(),
      });
    } catch (err) { handleError(res, err); }
  });

  // GET /api/tenant/billing — budget + subscription info
  app.get("/api/tenant/billing", async (req: Request, res: Response) => {
    try {
      const tenantId = (req.query.tenantId as string) ?? "demo-org";
      const { db }   = await import("./db");
      const { sql: drizzleSql } = await import("drizzle-orm");

      const budgetRes = await db.execute<any>(drizzleSql`
        SELECT * FROM tenant_ai_budgets WHERE tenant_id = ${tenantId} LIMIT 1
      `);
      const budget = budgetRes.rows[0] ?? null;

      const spendRes = await db.execute<any>(drizzleSql`
        SELECT COALESCE(SUM(cost_usd::numeric), 0)::float AS spend
        FROM obs_ai_latency_metrics
        WHERE tenant_id = ${tenantId}
          AND created_at >= DATE_TRUNC('month', NOW())
      `);
      const currentSpend = Number(spendRes.rows[0]?.spend ?? 0);

      res.json({
        tenantId,
        budget: budget ? {
          monthlyBudgetUsd:  Number(budget.monthly_budget_usd ?? 0),
          dailyBudgetUsd:    Number(budget.daily_budget_usd   ?? null),
          softLimitPercent:  Number(budget.soft_limit_percent ?? 80),
          hardLimitPercent:  Number(budget.hard_limit_percent ?? 100),
          updatedAt:         budget.updated_at,
        } : null,
        currentMonthSpendUsd: currentSpend,
        utilizationPercent: budget?.monthly_budget_usd
          ? Math.round((currentSpend / Number(budget.monthly_budget_usd)) * 100)
          : 0,
        retrievedAt: new Date().toISOString(),
      });
    } catch (err) { handleError(res, err); }
  });

  // GET /api/tenant/team — organization members list
  app.get("/api/tenant/team", async (req: Request, res: Response) => {
    try {
      const { db } = await import("./db");
      const { sql: drizzleSql } = await import("drizzle-orm");
      const limit  = Math.min(Number(req.query.limit) || 50, 100);
      const cursor = req.query.cursor as string | undefined;

      const rows = await db.execute<any>(drizzleSql`
        SELECT
          om.id, om.organization_id, om.role,
          om.created_at,
          p.id           AS user_id,
          p.display_name AS full_name,
          NULL::text     AS email
        FROM organization_members om
        LEFT JOIN profiles p ON p.id = om.user_id
        ${cursor ? drizzleSql`WHERE om.id > ${cursor}` : drizzleSql``}
        ORDER BY om.created_at DESC
        LIMIT ${limit + 1}
      `);

      const items   = rows.rows.slice(0, limit);
      const hasMore = rows.rows.length > limit;
      const nextCursor = hasMore ? items[items.length - 1]?.id : null;

      res.json({
        members: items.map((r: any) => ({
          id:    r.id, role: r.role, userId: r.user_id,
          email: r.email, fullName: r.full_name,
          joinedAt: r.created_at,
        })),
        pagination: { hasMore, nextCursor, limit },
        retrievedAt: new Date().toISOString(),
      });
    } catch (err) { handleError(res, err); }
  });

  // POST /api/tenant/team/invite — invite user placeholder
  app.post("/api/tenant/team/invite", async (req: Request, res: Response) => {
    try {
      const { email, role } = req.body as { email?: string; role?: string };
      if (!email) return res.status(400).json({ error: "email required" });
      const validRoles = ["owner", "admin", "member", "viewer"];
      const safeRole   = validRoles.includes(role ?? "") ? role! : "member";
      res.status(201).json({
        invited: true, email, role: safeRole,
        message: `Invitation queued for ${email} as ${safeRole}`,
        createdAt: new Date().toISOString(),
      });
    } catch (err) { handleError(res, err); }
  });

  // GET /api/tenant/audit — security event audit log with cursor pagination
  app.get("/api/tenant/audit", async (req: Request, res: Response) => {
    try {
      const { db } = await import("./db");
      const { sql: drizzleSql } = await import("drizzle-orm");
      const limit    = Math.min(Number(req.query.limit) || 25, 100);
      const cursor   = req.query.cursor as string | undefined;
      const tenantId = req.query.tenantId as string | undefined;

      const rows = await db.execute<any>(drizzleSql`
        SELECT id, event_type, tenant_id, ip_address, user_agent,
               user_id, created_at::text
        FROM security_events
        WHERE 1=1
          ${tenantId ? drizzleSql`AND tenant_id = ${tenantId}` : drizzleSql``}
          ${cursor   ? drizzleSql`AND id < ${cursor}`          : drizzleSql``}
        ORDER BY created_at DESC
        LIMIT ${limit + 1}
      `);

      const items   = rows.rows.slice(0, limit);
      const hasMore = rows.rows.length > limit;
      const nextCursor = hasMore ? items[items.length - 1]?.id : null;

      res.json({
        events: items.map((r: any) => ({
          id:        r.id,
          eventType: r.event_type,
          tenantId:  r.tenant_id,
          userId:    r.user_id,
          ipAddress: r.ip_address,
          createdAt: r.created_at,
        })),
        pagination: { hasMore, nextCursor, limit },
        retrievedAt: new Date().toISOString(),
      });
    } catch (err) { handleError(res, err); }
  });

  // GET /api/tenant/ai/runs — AI runs with quota + governance context
  app.get("/api/tenant/ai/runs", async (req: Request, res: Response) => {
    try {
      const limit  = Math.min(Number(req.query.limit) || 20, 100);
      const cursor = req.query.cursor as string | undefined;
      const runs   = await storage.listRuns({});
      const start  = cursor ? runs.findIndex((r: any) => r.id === cursor) + 1 : 0;
      const items  = runs.slice(start, start + limit);
      const hasMore = start + limit < runs.length;
      res.json({
        runs: items,
        pagination: { hasMore, nextCursor: hasMore ? items[items.length - 1]?.id : null, limit },
        retrievedAt: new Date().toISOString(),
      });
    } catch (err) { handleError(res, err); }
  });

  // GET /api/tenant/settings — tenant configuration
  app.get("/api/tenant/settings", async (req: Request, res: Response) => {
    try {
      res.json({
        tenant: {
          defaultLanguage: "en",
          defaultLocale:   "en-US",
          currency:        "USD",
          timezone:        "UTC",
          aiModel:         "gpt-4o",
          maxTokensPerRun: 100_000,
        },
        updatedAt: new Date().toISOString(),
      });
    } catch (err) { handleError(res, err); }
  });

  // PATCH /api/tenant/settings — update tenant configuration
  app.patch("/api/tenant/settings", async (req: Request, res: Response) => {
    try {
      const allowed = ["defaultLanguage","defaultLocale","currency","timezone","aiModel","maxTokensPerRun"];
      const updates: Record<string, unknown> = {};
      for (const key of allowed) {
        if (req.body[key] !== undefined) updates[key] = req.body[key];
      }
      res.json({ updated: true, fields: Object.keys(updates), updatedAt: new Date().toISOString() });
    } catch (err) { handleError(res, err); }
  });

  return httpServer;
}

type AiRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
