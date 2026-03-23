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
import { createStorageForRequest } from "./storage";
import { previewCommit } from "./lib/github-commit-format";
import { runExecutorService } from "./services/run-executor.service";
import { summarize } from "./features/ai-summarize/summarize.service";
import { z, ZodError } from "zod";
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
import type { IStorage } from "./storage";
import { AppError } from "./lib/errors";


/**
 * Central error → HTTP response mapper.
 *
 * Priority order:
 *  1. AppError (typed: UnauthorizedError, ForbiddenError, NotFoundError, ConflictError, ValidationError)
 *  2. ZodError → 422 VALIDATION_ERROR
 *  3. AiError (typed AI errors with retry-after)
 *  4. Generic Error with "statusCode" duck-typed property (legacy compat)
 *  5. Heuristic: "not found" → 404; all else → 500 INTERNAL_ERROR
 *
 * Contract: { error_code, message, request_id } — no stacks, no raw Supabase detail.
 */
function handleError(res: Response, error: unknown, requestId?: string | null) {
  const reqId = requestId ?? null;

  // 1. Typed AppError (highest priority — always trusted)
  if (error instanceof AppError) {
    if (error.statusCode === 500) {
      console.error(`[handleError] ${error.errorCode}:`, error.message);
    }
    return res.status(error.statusCode).json({
      error_code: error.errorCode,
      message: error.message,
      request_id: reqId,
    });
  }

  // 2. Zod validation error → 422 (not 400 — consistent with spec)
  if (error instanceof ZodError) {
    return res.status(422).json({
      error_code: "VALIDATION_ERROR",
      message: fromZodError(error).message,
      request_id: reqId,
    });
  }

  // 3. AI typed errors (carry own httpStatus / errorCode / retryAfter)
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

  // 4. Legacy duck-typed errors (e.g. from dynamically imported tenant-check.ts)
  if (error instanceof Error && (error as unknown as { statusCode?: number }).statusCode) {
    const typedErr = error as Error & { statusCode: number; errorCode: string };
    if (typedErr.statusCode === 500) {
      console.error("[handleError] legacy typed 500:", typedErr.message);
    }
    return res.status(typedErr.statusCode).json({
      error_code: typedErr.errorCode ?? "ERROR",
      message: typedErr.message,
      request_id: reqId,
    });
  }

  // 5. Generic Error — heuristic classification; never expose stack to client
  if (error instanceof Error) {
    const lc = error.message.toLowerCase();
    const status = lc.includes("not found") ? 404 : 500;
    const message = status === 404 ? error.message : "Internal server error";
    if (status === 500) {
      console.error("[handleError] 500:", error.message, error.stack?.split("\n")[1]?.trim());
    }
    return res.status(status).json({
      error_code: status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR",
      message,
      request_id: reqId,
    });
  }

  console.error("[handleError] unknown error type:", error);
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

function checkAdminRole(req: Request, res: Response): boolean {
  const role = req.user?.role;
  if (!role) {
    res.status(401).json({ error_code: "SESSION_REQUIRED", message: "Authentication required." });
    return false;
  }
  const elevated = ["owner", "superadmin", "platform_admin"];
  if (!elevated.includes(role)) {
    res.status(403).json({ error_code: "PLATFORM_ADMIN_REQUIRED", message: "Platform admin role required." });
    return false;
  }
  return true;
}

// ── Input validation schemas ──────────────────────────────────────────────────

const CreateProjectSchema = z.object({
  name: z.string().min(1, "name is required"),
  slug: z.string().min(1, "slug is required").regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, and hyphens only"),
  description: z.string().optional(),
});

const CreateArchitectureSchema = z.object({
  name: z.string().min(1, "name is required"),
  slug: z.string().min(1, "slug is required").regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, and hyphens only"),
  description: z.string().optional(),
  category: z.string().optional(),
});

/** Set private browser cache header (no CDN caching — data is user-scoped via RLS). */
function setCachePrivate(res: Response, maxAgeSeconds: number) {
  res.set("Cache-Control", `private, max-age=${maxAgeSeconds}, stale-while-revalidate=${maxAgeSeconds * 2}`);
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {

  // ─── Dashboard aggregation ──────────────────────────────────────────────────
  // Single endpoint replaces direct Supabase RPC from client.
  // Runs storage reads in parallel → first-paint latency reduced.

  app.get("/api/dashboard", async (req, res) => {
    try {
      const orgId   = getOrgId(req);
      const storage = createStorageForRequest(req);
      const [projects, architectures, runs, integrations] = await Promise.all([
        storage.listProjects(orgId),
        storage.listArchitectureProfiles(orgId),
        storage.listRuns(orgId),
        storage.listIntegrations(orgId),
      ]);

      const recentProjects = [...projects]
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
        .slice(0, 5)
        .map((p) => ({ id: p.id, name: p.name, status: p.status, updatedAt: p.updatedAt }));

      const recentRuns = [...runs]
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        .slice(0, 5)
        .map((r) => ({ id: r.id, status: r.status, createdAt: r.createdAt }));

      setCachePrivate(res, 30);
      return res.json({
        orgName: "AI Builder Platform",
        projectCount: projects.length,
        activeRunCount: runs.filter((r) => r.status === "running").length,
        architectureCount: architectures.length,
        configuredIntegrationCount: integrations.filter((i) => i.status === "active").length,
        recentProjects,
        recentRuns,
      });
    } catch (err) { handleError(res, err); }
  });

  // ─── Projects ───────────────────────────────────────────────────────────────

  app.get("/api/projects", async (req, res) => {
    try {
      const projects = await createStorageForRequest(req).listProjects(getOrgId(req));
      setCachePrivate(res, 10);
      res.json(projects);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/projects", async (req, res) => {
    try {
      const body = CreateProjectSchema.parse(req.body);
      const project = await createStorageForRequest(req).createProject({
        ...body,
        organizationId: getOrgId(req),
        createdBy: getUserId(req),
      });
      res.status(201).json(project);
    } catch (err) { handleError(res, err); }
  });

  app.get("/api/projects/:id", async (req, res) => {
    try {
      const project = await createStorageForRequest(req).getProject(req.params.id, getOrgId(req));
      res.json(project);
    } catch (err) { handleError(res, err); }
  });

  app.patch("/api/projects/:id", async (req, res) => {
    try {
      const project = await createStorageForRequest(req).updateProject(req.params.id, getOrgId(req), req.body);
      res.json(project);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/projects/:id/archive", async (req, res) => {
    try {
      const project = await createStorageForRequest(req).archiveProject(req.params.id, getOrgId(req));
      res.json(project);
    } catch (err) { handleError(res, err); }
  });

  // ─── Architectures ──────────────────────────────────────────────────────────

  app.get("/api/architectures", async (req, res) => {
    try {
      const profiles = await createStorageForRequest(req).listArchitectureProfiles(getOrgId(req));
      setCachePrivate(res, 10);
      res.json(profiles);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/architectures", async (req, res) => {
    try {
      const body = CreateArchitectureSchema.parse(req.body);
      const profile = await createStorageForRequest(req).createArchitectureProfile({
        ...body,
        organizationId: getOrgId(req),
      });
      res.status(201).json(profile);
    } catch (err) { handleError(res, err); }
  });

  app.get("/api/architectures/:id", async (req, res) => {
    try {
      const profile = await createStorageForRequest(req).getArchitectureProfile(req.params.id, getOrgId(req));
      res.json(profile);
    } catch (err) { handleError(res, err); }
  });

  app.patch("/api/architectures/:id", async (req, res) => {
    try {
      const profile = await createStorageForRequest(req).updateArchitectureProfile(req.params.id, getOrgId(req), req.body);
      res.json(profile);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/architectures/:id/archive", async (req, res) => {
    try {
      const profile = await createStorageForRequest(req).archiveArchitectureProfile(req.params.id, getOrgId(req));
      res.json(profile);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/architectures/:id/versions", async (req, res) => {
    try {
      const version = await createStorageForRequest(req).createArchitectureVersion({
        ...req.body,
        architectureProfileId: req.params.id,
      });
      res.status(201).json(version);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/architectures/:id/versions/:versionId/publish", async (req, res) => {
    try {
      const version = await createStorageForRequest(req).publishArchitectureVersion(
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
          createStorageForRequest(req).upsertAgentConfig({ ...(c as object), versionId: req.params.versionId }),
        ),
      );
      res.json(configs);
    } catch (err) { handleError(res, err); }
  });

  app.put("/api/architectures/:id/versions/:versionId/capabilities", async (req, res) => {
    try {
      const configs = await Promise.all(
        (req.body as unknown[]).map((c: unknown) =>
          createStorageForRequest(req).upsertCapabilityConfig({ ...(c as object), versionId: req.params.versionId }),
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
      const runs = await createStorageForRequest(req).listRuns(getOrgId(req), filters);
      setCachePrivate(res, 5);
      res.json(runs);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/runs", async (req, res) => {
    try {
      const run = await createStorageForRequest(req).createRun({
        ...req.body,
        organizationId: getOrgId(req),
        createdBy: getUserId(req),
      });
      res.status(201).json(run);
    } catch (err) { handleError(res, err); }
  });

  app.get("/api/runs/:id", async (req, res) => {
    try {
      const run = await createStorageForRequest(req).getRun(req.params.id, getOrgId(req));
      res.json(run);
    } catch (err) { handleError(res, err); }
  });

  app.patch("/api/runs/:id/status", async (req, res) => {
    try {
      const run = await createStorageForRequest(req).updateRunStatus(req.params.id, getOrgId(req), req.body);
      res.json(run);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/runs/:id/steps", async (req, res) => {
    try {
      const step = await createStorageForRequest(req).appendStep({ ...req.body, runId: req.params.id });
      res.status(201).json(step);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/runs/:id/artifacts", async (req, res) => {
    try {
      const artifact = await createStorageForRequest(req).appendArtifact({ ...req.body, runId: req.params.id });
      res.status(201).json(artifact);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/runs/:id/tool-calls", async (req, res) => {
    try {
      const toolCall = await createStorageForRequest(req).appendToolCall({ ...req.body, runId: req.params.id });
      res.status(201).json(toolCall);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/runs/:id/approvals", async (req, res) => {
    try {
      const approval = await createStorageForRequest(req).appendApproval({
        ...req.body,
        runId: req.params.id,
        requestedBy: req.body.requestedBy ?? "system",
      });
      res.status(201).json(approval);
    } catch (err) { handleError(res, err); }
  });

  app.patch("/api/runs/:id/approvals/:approvalId", async (req, res) => {
    try {
      const approval = await createStorageForRequest(req).resolveApproval(req.params.approvalId, req.body);
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
      const run = await createStorageForRequest(req).getRun(req.params.id, orgId);
      res.status(202).json({ ...run, executing: true });
    } catch (err) { handleError(res, err); }
  });

  app.get("/api/runs/:id/artifact-dependencies", async (req, res) => {
    try {
      const deps = await createStorageForRequest(req).listArtifactDependencies(req.params.id);
      res.json(deps);
    } catch (err) { handleError(res, err); }
  });

  // ─── Integrations ───────────────────────────────────────────────────────────

  app.get("/api/integrations", async (req, res) => {
    try {
      const integrations = await createStorageForRequest(req).listIntegrations(getOrgId(req));
      res.json(integrations);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/integrations", async (req, res) => {
    try {
      const integration = await createStorageForRequest(req).upsertIntegration({
        ...req.body,
        organizationId: getOrgId(req),
      });
      res.json(integration);
    } catch (err) { handleError(res, err); }
  });

  app.get("/api/integrations/:provider", async (req, res) => {
    try {
      const integrations = await createStorageForRequest(req).listIntegrations(getOrgId(req));
      const integration = integrations.find((i) => i.provider === req.params.provider);
      if (!integration) return res.status(404).json({ error: "Integration not found" });
      res.json(integration);
    } catch (err) { handleError(res, err); }
  });

  // ─── GitHub commit preview (metadata only — write pipeline NOT active) ────

  app.get("/api/runs/:id/commit-preview", async (req, res) => {
    try {
      const run = await createStorageForRequest(req).getRun(req.params.id, getOrgId(req));
      const [profile, version] = await Promise.all([
        createStorageForRequest(req).getArchitectureProfile(run.architectureProfileId, getOrgId(req)),
        (async () => {
          const p = await createStorageForRequest(req).getArchitectureProfile(run.architectureProfileId, getOrgId(req));
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
      if (!checkAdminRole(req, res)) return;
      // Delegate to canonical module — never compute env checks here
      const { getPlatformIntegrationsStatus } = await import("./lib/integrations/platform-integrations-status");
      const report = getPlatformIntegrationsStatus();
      const byKey = Object.fromEntries(report.providers.map((p) => [p.key, p.configured]));
      res.json({
        database: byKey.supabase ?? false,
        supabase: byKey.supabase ?? false,
        github: byKey.github ?? false,
        openai: byKey.openai ?? false,
        anthropic: byKey.anthropic ?? false,
        gemini: byKey.gemini ?? false,
        stripe: byKey.stripe ?? false,
        cloudflare: byKey.cloudflare ?? false,
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
      if (!checkAdminRole(req, res)) return;
      const health = await getSecurityHealth();
      return res.json(health);
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/admin/security/events — tenant-scoped security events
  app.get("/api/admin/security/events", async (req: Request, res: Response) => {
    try {
      if (!checkAdminRole(req, res)) return;
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
      if (!checkAdminRole(req, res)) return;
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
      if (!checkAdminRole(req, res)) return;
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
      if (!checkAdminRole(req, res)) return;
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

  // ─── Tenant Surface Routes ────────────────────────────────────────────────────

  // GET /api/tenant/settings — full tenant settings (locale + AI config)
  app.get("/api/tenant/settings", async (req: Request, res: Response) => {
    try {
      const tenantId = (req.user as any)?.organizationId ?? (req.query.tenantId as string);
      if (!tenantId) return res.status(400).json({ error_code: "MISSING_TENANT", message: "No tenant context" });
      const { getTenantLocale } = await import("./lib/i18n/locale-service");
      const locale = await getTenantLocale(tenantId);
      return res.json({
        tenant: {
          defaultLanguage:  (locale as any)?.language  ?? "en",
          defaultLocale:    (locale as any)?.locale     ?? "en-US",
          currency:         (locale as any)?.currency   ?? "USD",
          timezone:         (locale as any)?.timezone   ?? "UTC",
          aiModel:          "gpt-4o",
          maxTokensPerRun:  100_000,
        },
        updatedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/tenant/dashboard — aggregate metrics for tenant overview
  app.get("/api/tenant/dashboard", async (req: Request, res: Response) => {
    try {
      const orgId   = getOrgId(req);
      const storage = createStorageForRequest(req);
      const [projects, runs, integrations] = await Promise.all([
        storage.listProjects(orgId),
        storage.listRuns(orgId),
        storage.listIntegrations(orgId),
      ]);
      return res.json({
        metrics: {
          totalProjects:      projects.length,
          activeRuns:         runs.filter((r) => r.status === "running").length,
          failedRuns:         runs.filter((r) => r.status === "failed").length,
          activeIntegrations: integrations.filter((i) => i.status === "active").length,
          totalRuns:          runs.length,
        },
        recentRuns: runs.slice(0, 5).map((r) => ({
          id: r.id, status: r.status, projectId: r.projectId, createdAt: r.createdAt,
        })),
        integrationHealth: integrations.slice(0, 6).map((i) => ({
          id: i.id, provider: i.provider, status: i.status,
        })),
        retrievedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/tenant/ai/runs — cursor-paginated AI runs for the tenant
  app.get("/api/tenant/ai/runs", async (req: Request, res: Response) => {
    try {
      const orgId   = getOrgId(req);
      const status  = req.query.status as string | undefined;
      const limit   = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);
      const cursor  = req.query.cursor as string | undefined;

      const filters: { status?: AiRunStatus } = {};
      if (status && status !== "all") filters.status = status as AiRunStatus;

      const allRuns = await createStorageForRequest(req).listRuns(orgId, filters);
      let startIdx  = 0;
      if (cursor) {
        const idx = allRuns.findIndex((r) => r.id === cursor);
        if (idx !== -1) startIdx = idx + 1;
      }
      const page       = allRuns.slice(startIdx, startIdx + limit);
      const nextCursor = page.length === limit && startIdx + limit < allRuns.length
        ? page[page.length - 1].id
        : null;
      return res.json({ runs: page, nextCursor, total: allRuns.length });
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/tenant/usage — token/cost usage summary + daily trends by period
  app.get("/api/tenant/usage", async (req: Request, res: Response) => {
    try {
      const orgId  = getOrgId(req);
      const period = (req.query.period as string) ?? "30d";
      const days   = period === "7d" ? 7 : period === "90d" ? 90 : 30;
      const since  = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

      const { getLatestSnapshot } = await import("./lib/ai-governance/usage-snapshotter");
      const snapshot = await getLatestSnapshot(orgId, "monthly");

      const runs     = await createStorageForRequest(req).listRuns(orgId);
      const filtered = runs.filter((r) => new Date(r.createdAt) >= since);

      const byDay: Record<string, { day: string; requests: number; costUsd: number }> = {};
      for (const run of filtered) {
        const day = new Date(run.createdAt).toISOString().slice(0, 10);
        if (!byDay[day]) byDay[day] = { day, requests: 0, costUsd: 0 };
        byDay[day].requests++;
      }

      return res.json({
        tenantId: orgId,
        period,
        summary: {
          tokensIn:    snapshot ? Number(snapshot.promptTokens)     : 0,
          tokensOut:   snapshot ? Number(snapshot.completionTokens) : 0,
          costUsd:     snapshot ? Number(snapshot.totalCostUsdCents) / 100 : 0,
          requests:    snapshot ? snapshot.requestCount             : filtered.length,
          modelsUsed:  snapshot ? Object.keys(snapshot.modelBreakdown ?? {}).length : 0,
        },
        daily: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
        retrievedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/tenant/billing — budget and spend overview from governance tables
  app.get("/api/tenant/billing", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { checkTenantBudget } = await import("./lib/ai-governance/budget-checker");
      const result = await checkTenantBudget(orgId, "monthly");

      if (!result) {
        return res.json({
          tenantId:              orgId,
          budget:                null,
          currentMonthSpendUsd:  0,
          utilizationPercent:    0,
          retrievedAt:           new Date().toISOString(),
        });
      }

      return res.json({
        tenantId: orgId,
        budget: {
          monthlyBudgetUsd:  Number(result.budgetUsdCents) / 100,
          dailyBudgetUsd:    null,
          softLimitPercent:  result.warningThresholdPct,
          hardLimitPercent:  result.hardLimitPct,
          updatedAt:         new Date().toISOString(),
        },
        currentMonthSpendUsd: Number(result.currentUsageUsdCents) / 100,
        utilizationPercent:   Math.round(result.utilizationPct),
        retrievedAt:          new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/tenant/team — org members list with cursor pagination
  app.get("/api/tenant/team", async (req: Request, res: Response) => {
    try {
      const orgId  = getOrgId(req);
      const limit  = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);
      const cursor = req.query.cursor as string | undefined;

      const { db }                  = await import("./db");
      const { organizationMembers } = await import("@shared/schema");
      const { eq, gt, and }         = await import("drizzle-orm");

      const conditions = [eq(organizationMembers.organizationId, orgId)];
      if (cursor) conditions.push(gt(organizationMembers.id, cursor));

      const rows = await db
        .select()
        .from(organizationMembers)
        .where(and(...conditions))
        .limit(limit + 1);

      const hasMore    = rows.length > limit;
      const members    = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? members[members.length - 1].id : null;

      return res.json({
        members,
        pagination: { hasMore, nextCursor, limit },
        retrievedAt: new Date().toISOString(),
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /api/tenant/team/invite — invite a new member via Supabase
  app.post("/api/tenant/team/invite", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { email, role } = req.body as { email?: string; role?: string };
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error_code: "INVALID_EMAIL", message: "A valid email is required" });
      }
      const memberRole = role === "owner" ? "owner" : "member";

      const { createClient } = await import("@supabase/supabase-js");
      const supabaseAdmin = createClient(
        process.env.SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { autoRefreshToken: false, persistSession: false } },
      );
      const { error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
        data: { organizationId: orgId, role: memberRole },
      });
      if (error) return res.status(400).json({ error_code: "INVITE_FAILED", message: error.message });
      return res.json({ ok: true, email, role: memberRole });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ─── /api/tenant/departments — CRUD ──────────────────────────────────────────

  // GET /api/tenant/departments — list all departments for the org
  app.get("/api/tenant/departments", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { db } = await import("./db");
      const { tenantDepartments } = await import("@shared/schema");
      const { eq, asc } = await import("drizzle-orm");

      const rows = await db
        .select()
        .from(tenantDepartments)
        .where(eq(tenantDepartments.tenantId, orgId))
        .orderBy(asc(tenantDepartments.name));

      return res.json({ departments: rows });
    } catch (err) {
      handleError(res, err);
    }
  });

  // POST /api/tenant/departments — create a department
  app.post("/api/tenant/departments", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { z } = await import("zod");
      const schema = z.object({
        name:        z.string().min(1).max(120),
        slug:        z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
        description: z.string().max(500).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(422).json({ error_code: "VALIDATION_ERROR", message: "Invalid department data", details: parsed.error.issues });
      }
      const { name, slug, description } = parsed.data;

      const { db } = await import("./db");
      const { tenantDepartments } = await import("@shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const existing = await db
        .select({ id: tenantDepartments.id })
        .from(tenantDepartments)
        .where(and(eq(tenantDepartments.tenantId, orgId), eq(tenantDepartments.slug, slug)))
        .limit(1);
      if (existing.length > 0) {
        return res.status(409).json({ error_code: "SLUG_CONFLICT", message: "Department with this slug already exists" });
      }

      const [row] = await db
        .insert(tenantDepartments)
        .values({ tenantId: orgId, name, slug, description: description ?? null })
        .returning();

      return res.status(201).json({ department: row });
    } catch (err) {
      handleError(res, err);
    }
  });

  // DELETE /api/tenant/departments/:id — remove a department
  app.delete("/api/tenant/departments/:id", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { id } = req.params;
      const { db } = await import("./db");
      const { tenantDepartments } = await import("@shared/schema");
      const { eq, and } = await import("drizzle-orm");

      await db
        .delete(tenantDepartments)
        .where(and(eq(tenantDepartments.id, id), eq(tenantDepartments.tenantId, orgId)));

      return res.json({ ok: true });
    } catch (err) {
      handleError(res, err);
    }
  });

  // ─── /api/tenant/permissions — member permissions ────────────────────────────

  // GET /api/tenant/permissions/:userId — get permissions for a member
  app.get("/api/tenant/permissions/:userId", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { userId } = req.params;
      const { db } = await import("./db");
      const { tenantMemberPermissions } = await import("@shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const rows = await db
        .select()
        .from(tenantMemberPermissions)
        .where(and(eq(tenantMemberPermissions.tenantId, orgId), eq(tenantMemberPermissions.userId, userId)))
        .limit(1);

      if (rows.length === 0) {
        return res.json({
          tenantId: orgId, userId, tenantRole: "member",
          canAccessAllDepartments: false, allowedDepartmentIds: [],
          allowedSectionKeys: [], canAccessAllExperts: true, allowedExpertIds: [],
        });
      }
      return res.json(rows[0]);
    } catch (err) {
      handleError(res, err);
    }
  });

  // PUT /api/tenant/permissions/:userId — upsert permissions for a member
  app.put("/api/tenant/permissions/:userId", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { userId } = req.params;
      const { z } = await import("zod");
      const schema = z.object({
        tenantRole:              z.string().optional(),
        canAccessAllDepartments: z.boolean().optional(),
        allowedDepartmentIds:    z.array(z.string()).optional(),
        allowedSectionKeys:      z.array(z.string()).optional(),
        canAccessAllExperts:     z.boolean().optional(),
        allowedExpertIds:        z.array(z.string()).optional(),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(422).json({ error_code: "VALIDATION_ERROR", message: "Invalid permission data" });
      }

      const { db } = await import("./db");
      const { tenantMemberPermissions } = await import("@shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const existing = await db
        .select({ id: tenantMemberPermissions.id })
        .from(tenantMemberPermissions)
        .where(and(eq(tenantMemberPermissions.tenantId, orgId), eq(tenantMemberPermissions.userId, userId)))
        .limit(1);

      const values: Record<string, unknown> = {
        tenantId: orgId, userId, updatedAt: new Date(),
        ...parsed.data,
      };

      let row;
      if (existing.length === 0) {
        const insertRow = {
          tenantId:                orgId,
          userId,
          tenantRole:              parsed.data.tenantRole              ?? "member",
          canAccessAllDepartments: parsed.data.canAccessAllDepartments ?? false,
          allowedDepartmentIds:    parsed.data.allowedDepartmentIds    ?? [],
          allowedSectionKeys:      parsed.data.allowedSectionKeys      ?? [],
          canAccessAllExperts:     parsed.data.canAccessAllExperts      ?? true,
          allowedExpertIds:        parsed.data.allowedExpertIds         ?? [],
        };
        [row] = await db.insert(tenantMemberPermissions).values(insertRow).returning();
      } else {
        [row] = await db.update(tenantMemberPermissions)
          .set({ ...parsed.data, updatedAt: new Date() })
          .where(and(eq(tenantMemberPermissions.tenantId, orgId), eq(tenantMemberPermissions.userId, userId)))
          .returning();
      }

      return res.json(row);
    } catch (err) {
      handleError(res, err);
    }
  });

  // GET /api/tenant/audit — paginated tenant-scoped audit events
  app.get("/api/tenant/audit", async (req: Request, res: Response) => {
    try {
      const orgId  = getOrgId(req);
      const limit  = Math.min(parseInt(String(req.query.limit ?? "20"), 10), 100);
      const cursor = req.query.cursor as string | undefined;
      const offset = cursor ? parseInt(cursor, 10) : 0;

      const { listAuditEventsByTenant } = await import("./lib/audit/audit-log");
      const raw = await listAuditEventsByTenant({
        tenantId: orgId,
        limit:    limit + 1,
        offset,
      });

      const hasMore    = raw.length > limit;
      const page       = hasMore ? raw.slice(0, limit) : raw;
      const nextOffset = hasMore ? offset + limit : null;

      const events = page.map((r: Record<string, unknown>) => ({
        id:        String(r.id ?? ""),
        eventType: String(r.action ?? r.event_type ?? "unknown"),
        tenantId:  r.tenant_id != null ? String(r.tenant_id) : null,
        userId:    r.actor_id  != null ? String(r.actor_id)  : null,
        ipAddress: r.ip_address != null ? String(r.ip_address) : null,
        createdAt: String(r.created_at ?? r.createdAt ?? new Date().toISOString()),
      }));

      return res.json({
        events,
        pagination: {
          hasMore,
          nextCursor: nextOffset != null ? String(nextOffset) : null,
          limit,
        },
        retrievedAt: new Date().toISOString(),
      });
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

  // ─── Waitlist (public, no auth) ──────────────────────────────────────────────
  app.post("/api/waitlist", async (req: Request, res: Response) => {
    try {
      const { db }                 = await import("./db");
      const { waitlistSignups }    = await import("@shared/schema");
      const { eq }                 = await import("drizzle-orm");
      const { z }                  = await import("zod");

      const schema = z.object({
        email:  z.string().email(),
        source: z.string().optional().default("marketing"),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(422).json({ error: "Ugyldig e-mailadresse" });
      }
      const { email, source } = parsed.data;

      // Upsert — ignore duplicate silently
      const existing = await db.select().from(waitlistSignups).where(eq(waitlistSignups.email, email)).limit(1);
      if (existing.length > 0) {
        return res.status(200).json({ status: "already_registered" });
      }

      await db.insert(waitlistSignups).values({ email, source });
      console.log(`[waitlist] New signup: ${email} (source=${source})`);
      return res.status(201).json({ status: "registered" });
    } catch (err) {
      console.error("[waitlist] Error:", err);
      return res.status(500).json({ error: "Der skete en fejl. Prøv igen." });
    }
  });

  // ─── Waitlist admin (platform admin only) ────────────────────────────────────
  app.get("/api/admin/waitlist", async (req: Request, res: Response) => {
    try {
      const secret = req.headers["x-internal-secret"];
      const PLATFORM_ADMIN_EMAILS = ["seomidt@gmail.com"];
      const userEmail = (req as any).user?.email ?? "";
      const isAdmin   = PLATFORM_ADMIN_EMAILS.includes(userEmail) || secret === process.env.INTERNAL_API_SECRET;
      if (!isAdmin) return res.status(403).json({ error: "Forbidden" });

      const { db }              = await import("./db");
      const { waitlistSignups } = await import("@shared/schema");
      const { desc }            = await import("drizzle-orm");

      const rows = await db.select().from(waitlistSignups).orderBy(desc(waitlistSignups.createdAt));
      return res.json({ count: rows.length, signups: rows });
    } catch (err) {
      console.error("[waitlist-admin] Error:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });

  return httpServer;
}

type AiRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
