import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { registerAdminRoutes } from "./routes/admin";
import { aiRouteChain } from "./middleware/ai-guards";
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
import type { DashboardSummary } from "./storage";

// ─── Dashboard bootstrap cache ────────────────────────────────────────────────
// Short-lived per-org cache (30 s) so rapid refresh / re-login doesn't
// hammer the DB with 7 parallel queries every time.
const BOOTSTRAP_CACHE_TTL_MS = 30_000;
interface BootstrapCacheEntry { data: DashboardSummary; expiresAt: number }
const bootstrapCache = new Map<string, BootstrapCacheEntry>();

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

  // ─── Dashboard bootstrap ────────────────────────────────────────────────────
  // Returns only what the first dashboard paint needs: 4 counts + 2×5 recent
  // items + org name. Runs 7 DB queries in parallel, result cached 30s per org.
  // Governance / analytics / ops data is NOT included — load deferred widgets
  // from their own endpoints after first paint.

  app.get("/api/dashboard/bootstrap", async (req, res) => {
    try {
      const orgId = getOrgId(req);
      const cached = bootstrapCache.get(orgId);
      if (cached && cached.expiresAt > Date.now()) {
        res.setHeader("X-Cache", "HIT");
        return res.json(cached.data);
      }
      const data = await storage.getDashboardSummary(orgId);
      bootstrapCache.set(orgId, { data, expiresAt: Date.now() + BOOTSTRAP_CACHE_TTL_MS });
      res.setHeader("X-Cache", "MISS");
      res.json(data);
    } catch (err) { handleError(res, err); }
  });

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

  app.post("/api/runs/:id/execute", ...aiRouteChain, async (req, res) => {
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

  app.post("/api/ai/summarize", ...aiRouteChain, async (req: Request, res: Response) => {
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

  // Phase 34 — Tenant locale settings (PATCH /api/tenant/settings/locale)
  app.get("/api/tenant/locale", async (req: Request, res: Response) => {
    try {
      const tenantId = (req.user as any)?.organizationId ?? (req.query.tenantId as string);
      if (!tenantId) return res.status(400).json({ error_code: "MISSING_TENANT", message: "No tenant context" });
      const { getTenantLocale } = await import("./lib/i18n/locale-service");
      const locale = await getTenantLocale(tenantId);
      return res.json(locale);
    } catch (err) {
      handleError(res, err);
    }
  });

  app.patch("/api/tenant/settings", async (req: Request, res: Response) => {
    try {
      const tenantId = (req.user as any)?.organizationId ?? (req.body?.tenantId as string);
      if (!tenantId) return res.status(400).json({ error_code: "MISSING_TENANT", message: "No tenant context" });

      const {
        updateTenantLocale,
        isValidLanguage,
        isValidLocale,
        isValidCurrency,
        isValidTimezone,
      } = await import("./lib/i18n/locale-service");

      const update: Record<string, string> = {};
      const errors: string[] = [];

      if (req.body.language !== undefined) {
        if (!isValidLanguage(req.body.language)) errors.push("Invalid language code (must be ISO 639-1/2, e.g. 'en', 'da')");
        else update.language = req.body.language;
      }
      if (req.body.locale !== undefined) {
        if (!isValidLocale(req.body.locale)) errors.push("Invalid locale (must be BCP-47, e.g. 'en-US', 'da-DK')");
        else update.locale = req.body.locale;
      }
      if (req.body.currency !== undefined) {
        if (!isValidCurrency(req.body.currency)) errors.push("Invalid currency (must be ISO 4217, e.g. 'USD', 'EUR', 'DKK')");
        else update.currency = req.body.currency;
      }
      if (req.body.timezone !== undefined) {
        if (!isValidTimezone(req.body.timezone)) errors.push("Invalid timezone (must be IANA, e.g. 'UTC', 'Europe/Copenhagen')");
        else update.timezone = req.body.timezone;
      }

      if (errors.length > 0) {
        return res.status(400).json({ error_code: "VALIDATION_ERROR", message: errors.join("; "), errors });
      }
      if (Object.keys(update).length === 0) {
        return res.status(400).json({ error_code: "NO_FIELDS", message: "No valid locale fields provided" });
      }

      await updateTenantLocale(tenantId, update);
      return res.json({ ok: true, updated: update });
    } catch (err) {
      handleError(res, err);
    }
  });

  // Phase 4P — Admin Pricing & Plan Management routes
  registerAdminRoutes(app);

  // Phase 37 — Secure Authentication Platform routes
  const { registerAuthPlatformRoutes } = await import("./routes/auth-platform");
  registerAuthPlatformRoutes(app);

  // Cloudflare R2 Storage routes
  const { registerR2Routes } = await import("./routes/r2");
  registerR2Routes(app);

  // Phase 46 — Tenant Storage routes (DB-first, signed URLs, tenant isolation)
  const storageRouter = await import("./routes/storage");
  app.use("/api/storage", storageRouter.default);

  // Phase 50 — Analytics Foundation routes
  const { analyticsRouter, adminAnalyticsRouter } = await import("./routes/analytics");
  app.use("/api/analytics", analyticsRouter);
  app.use("/api/admin/analytics", adminAnalyticsRouter);

  return httpServer;
}

type AiRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
