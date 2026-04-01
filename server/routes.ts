import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerInsightRoutes } from "./routes/insights.ts";
import { aiRouteChain } from "./middleware/ai-guards.ts";
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
import { sanitizeInput, sanitizeObject, explainSanitization } from "./lib/security/sanitize.ts";
import { getRateLimitConfig } from "./middleware/rate-limit.ts";
import { createStorageForRequest } from "./storage.ts";
import { previewCommit } from "./lib/github-commit-format.ts";
import { runExecutorService } from "./services/run-executor.service.ts";
import { summarize } from "./features/ai-summarize/summarize.service.ts";
import { z, ZodError } from "zod";
import { fromZodError } from "zod-validation-error";
import { AiError } from "./lib/ai/errors.ts";
import {
  createStripeCheckoutForInvoice,
  createStripePaymentIntentForInvoice,
  getStripeCheckoutState,
} from "./lib/ai/stripe-checkout";
import { handleStripeWebhook } from "./lib/ai/stripe-webhooks.ts";
import {
  listStripeWebhookEvents,
  getStripeWebhookEventByStripeEventId,
  getInvoiceStripeLifecycle,
  explainStripeWebhookOutcome,
} from "./lib/ai/stripe-webhook-summary";
import type { IStorage } from "./storage.ts";
import { AppError } from "./lib/errors.ts";


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
  name:         z.string().min(1, "name is required"),
  slug:         z.string().regex(/^[a-z0-9-]+$/, "slug must be lowercase letters, numbers, and hyphens only").optional(),
  description:  z.string().optional(),
  category:     z.string().optional(),
  departmentId: z.string().optional(),
  language:     z.string().optional().default("da"),
  goal:         z.string().optional(),
  instructions: z.string().optional(),
  outputStyle:  z.string().optional(),
});

const CreateSpecialistRuleSchema = z.object({
  type:             z.enum(["decision", "threshold", "required_evidence", "source_restriction", "escalation"]),
  name:             z.string().min(1),
  description:      z.string().optional(),
  priority:         z.number().int().min(1).max(999).default(100),
  enforcementLevel: z.enum(["hard", "soft"]).default("soft"),
  config:           z.record(z.unknown()).optional(),
});

const CreateSpecialistSourceSchema = z.object({
  sourceName:    z.string().min(1),
  sourceType:    z.enum(["document", "policy", "legal", "rulebook", "image", "other"]).default("document"),
  projectId:     z.string().optional(),
  dataSourceId:  z.string().optional(),
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

  // ════════════════════════════════════════════════════════════════════════════
  // /api/experts — Primary AI Expert API surface (versioned, tenant-safe)
  // Model/provider selection is platform-managed only — not tenant-editable.
  // ════════════════════════════════════════════════════════════════════════════

  // ─── Helpers ────────────────────────────────────────────────────────────────

  async function loadExpert(expertId: string, orgId: string) {
    const { db } = await import("./db");
    const { architectureProfiles } = await import("../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    const [expert] = await db
      .select()
      .from(architectureProfiles)
      .where(and(eq(architectureProfiles.id, expertId), eq(architectureProfiles.organizationId, orgId)));
    return expert ?? null;
  }

  async function loadVersion(versionId: string, orgId: string) {
    const { db } = await import("./db");
    const { expertVersions } = await import("../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    const [version] = await db
      .select()
      .from(expertVersions)
      .where(and(eq(expertVersions.id, versionId), eq(expertVersions.organizationId, orgId)));
    return version ?? null;
  }

  async function buildAndUpsertDraft(expertId: string, orgId: string, userId: string | null) {
    const { db } = await import("./db");
    const { architectureProfiles, specialistRules, specialistSources, expertVersions } = await import("../shared/schema");
    const { eq, and, asc, desc } = await import("drizzle-orm");
    const { buildVersionSnapshot } = await import("./lib/ai/expert-prompt-builder");

    const [expert] = await db.select().from(architectureProfiles)
      .where(and(eq(architectureProfiles.id, expertId), eq(architectureProfiles.organizationId, orgId)));
    if (!expert) throw new Error("Expert not found");

    const rules = await db.select().from(specialistRules)
      .where(and(eq(specialistRules.expertId, expertId), eq(specialistRules.organizationId, orgId)))
      .orderBy(asc(specialistRules.priority));

    const sources = await db.select().from(specialistSources)
      .where(and(eq(specialistSources.expertId, expertId), eq(specialistSources.organizationId, orgId)));

    const snapshot = buildVersionSnapshot({
      expert: {
        name:             expert.name,
        description:      expert.description,
        departmentId:     expert.departmentId,
        language:         expert.language ?? "da",
        instructions:     expert.instructions,
        goal:             expert.goal,
        outputStyle:      expert.outputStyle,
        escalationPolicy: expert.escalationPolicy,
      },
      rules: rules.map((r) => ({
        id:               r.id,
        type:             r.type,
        name:             r.name,
        description:      r.description ?? null,
        priority:         r.priority,
        enforcementLevel: r.enforcementLevel,
      })),
      sources: sources.map((s) => ({
        id:         s.id,
        sourceName: s.sourceName,
        sourceType: s.sourceType,
        status:     s.status,
      })),
    });

    if (expert.draftVersionId) {
      // Update existing draft
      const [updated] = await db
        .update(expertVersions)
        .set({ configJson: snapshot as any })
        .where(and(eq(expertVersions.id, expert.draftVersionId), eq(expertVersions.organizationId, orgId)))
        .returning();
      return updated;
    } else {
      // Determine next version number
      const [latest] = await db
        .select()
        .from(expertVersions)
        .where(eq(expertVersions.expertId, expertId))
        .orderBy(desc(expertVersions.versionNumber))
        .limit(1);
      const nextNum = (latest?.versionNumber ?? 0) + 1;

      const [newDraft] = await db
        .insert(expertVersions)
        .values({
          expertId:       expertId,
          organizationId: orgId,
          versionNumber:  nextNum,
          status:         "draft",
          configJson:     snapshot as any,
          createdBy:      userId ?? undefined,
        })
        .returning();

      // Link draft to expert
      await db
        .update(architectureProfiles)
        .set({ draftVersionId: newDraft.id, updatedAt: new Date() })
        .where(eq(architectureProfiles.id, expertId));

      return newDraft;
    }
  }

  // ─── CRUD ────────────────────────────────────────────────────────────────────

  app.get("/api/experts", async (req, res) => {
    try {
      const profiles = await createStorageForRequest(req).listArchitectureProfiles(getOrgId(req));
      setCachePrivate(res, 10);
      res.json(profiles);
    } catch (err) { handleError(res, err); }
  });

  // Staged creation: expert → rules → sources handled by client; wizard commits in steps
  app.post("/api/experts", async (req, res) => {
    try {
      const body = CreateArchitectureSchema.parse(req.body);
      const orgId = getOrgId(req);

      // Auto-generate slug server-side if not provided
      let slug = body.slug;
      if (!slug || !slug.trim()) {
        const base = body.name.toLowerCase()
          .replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa")
          .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "ekspert";
        slug = `${base}-${Date.now().toString(36)}`;
      }

      // Language resolved server-side — never exposed as tenant choice
      // Falls back to "da" (Danish) as platform default for Nordic market
      const language = "da";

      const profile = await createStorageForRequest(req).createArchitectureProfile({
        ...body,
        slug,
        language,
        organizationId: orgId,
      });
      res.status(201).json(profile);
    } catch (err) { handleError(res, err); }
  });

  // GET /api/experts/:id — includes version state and resolved config
  app.get("/api/experts/:id", async (req, res) => {
    try {
      const orgId  = getOrgId(req);
      const expert = await loadExpert(req.params.id, orgId);
      if (!expert) return res.status(404).json({ error: "Expert not found" });

      const { db } = await import("./db");
      const { specialistRules, specialistSources } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const [rules, sources] = await Promise.all([
        db.select().from(specialistRules)
          .where(and(eq(specialistRules.expertId, expert.id), eq(specialistRules.organizationId, orgId))),
        db.select().from(specialistSources)
          .where(and(eq(specialistSources.expertId, expert.id), eq(specialistSources.organizationId, orgId))),
      ]);

      let liveConfig: unknown = null;
      let draftConfig: unknown = null;

      if (expert.currentVersionId) {
        const v = await loadVersion(expert.currentVersionId, orgId);
        liveConfig = v?.configJson ?? null;
      }
      if (expert.draftVersionId) {
        const v = await loadVersion(expert.draftVersionId, orgId);
        draftConfig = v?.configJson ?? null;
      }

      setCachePrivate(res, 10);
      res.json({
        ...expert,
        rule_count:   rules.length,
        source_count: sources.length,
        live_config:  liveConfig,
        draft_config: draftConfig,
      });
    } catch (err) { handleError(res, err); }
  });

  // PATCH /api/experts/:id — tenant-editable fields only; writes to draft version
  app.patch("/api/experts/:id", async (req, res) => {
    try {
      const { db } = await import("./db");
      const { architectureProfiles } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const orgId  = getOrgId(req);
      const userId = getUserId(req);

      // Model/provider/temperature/tokens are NOT tenant-editable
      const UpdateExpertSchema = z.object({
        name:             z.string().min(1).optional(),
        description:      z.string().optional(),
        goal:             z.string().optional(),
        instructions:     z.string().optional(),
        outputStyle:      z.enum(["concise","formal","advisory"]).optional(),
        language:         z.string().optional(),
        departmentId:     z.string().optional(),
        escalationPolicy: z.record(z.unknown()).optional(),
      });
      const body = UpdateExpertSchema.parse(req.body);

      const [updated] = await db
        .update(architectureProfiles)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(architectureProfiles.id, req.params.id), eq(architectureProfiles.organizationId, orgId)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Expert not found" });

      // Async draft snapshot update (non-blocking; errors logged not thrown)
      buildAndUpsertDraft(req.params.id, orgId, userId).catch((e) =>
        console.error("[expert-patch] draft snapshot error:", e),
      );

      res.json(updated);
    } catch (err) { handleError(res, err); }
  });

  // POST /api/experts/:id/archive
  app.post("/api/experts/:id/archive", async (req, res) => {
    try {
      const profile = await createStorageForRequest(req).archiveArchitectureProfile(req.params.id, getOrgId(req));
      res.json(profile);
    } catch (err) { handleError(res, err); }
  });

  // POST /api/experts/:id/unarchive
  app.post("/api/experts/:id/unarchive", async (req, res) => {
    try {
      const { db } = await import("./db");
      const { architectureProfiles } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const orgId = getOrgId(req);
      const [updated] = await db
        .update(architectureProfiles)
        .set({ status: "active", updatedAt: new Date() })
        .where(and(eq(architectureProfiles.id, req.params.id), eq(architectureProfiles.organizationId, orgId)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Expert not found" });
      res.json(updated);
    } catch (err) { handleError(res, err); }
  });

  // POST /api/experts/:id/pause
  app.post("/api/experts/:id/pause", async (req, res) => {
    try {
      const { db } = await import("./db");
      const { architectureProfiles } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const orgId = getOrgId(req);
      const [updated] = await db
        .update(architectureProfiles)
        .set({ status: "paused", updatedAt: new Date() })
        .where(and(eq(architectureProfiles.id, req.params.id), eq(architectureProfiles.organizationId, orgId)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Expert not found" });
      res.json(updated);
    } catch (err) { handleError(res, err); }
  });

  // POST /api/experts/:id/resume
  app.post("/api/experts/:id/resume", async (req, res) => {
    try {
      const { db } = await import("./db");
      const { architectureProfiles } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const orgId = getOrgId(req);
      const [updated] = await db
        .update(architectureProfiles)
        .set({ status: "active", updatedAt: new Date() })
        .where(and(eq(architectureProfiles.id, req.params.id), eq(architectureProfiles.organizationId, orgId)))
        .returning();
      if (!updated) return res.status(404).json({ error: "Expert not found" });
      res.json(updated);
    } catch (err) { handleError(res, err); }
  });

  // POST /api/experts/:id/duplicate
  app.post("/api/experts/:id/duplicate", async (req, res) => {
    try {
      const { db } = await import("./db");
      const { architectureProfiles } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const orgId  = getOrgId(req);
      const userId = getUserId(req);
      const [src]  = await db.select().from(architectureProfiles)
        .where(and(eq(architectureProfiles.id, req.params.id), eq(architectureProfiles.organizationId, orgId)));
      if (!src) return res.status(404).json({ error: "Expert not found" });
      const slug = `${src.slug}-kopi-${Date.now().toString(36)}`;
      const [copy] = await db.insert(architectureProfiles).values({
        organizationId: orgId,
        createdBy:      userId,
        name:           `${src.name} (kopi)`,
        slug,
        description:    src.description,
        goal:           src.goal,
        instructions:   src.instructions,
        outputStyle:    src.outputStyle,
        departmentId:   src.departmentId,
        language:       src.language ?? "da",
        status:         "draft",
      }).returning();
      res.json(copy);
    } catch (err) { handleError(res, err); }
  });

  // POST /api/experts/ai-refine — per-field AI refinement, routed through tenant runtime
  app.post("/api/experts/ai-refine", async (req, res) => {
    try {
      const body = z.object({
        field:        z.string().min(1),
        currentValue: z.string().min(1),
        action:       z.enum(["improve", "shorten", "rewrite", "more_precise"]),
      }).parse(req.body);

      const { runAiCall } = await import("./lib/ai/runner");

      const ACTION_PROMPTS: Record<string, string> = {
        improve:      "Improve this text while keeping its meaning and purpose. Make it more professional and clear.",
        shorten:      "Shorten this text significantly while keeping all key meaning. Keep it Danish if it is Danish.",
        rewrite:      "Rewrite this text with different wording but the same intent. Keep it Danish if it is Danish.",
        more_precise: "Make this text more precise and specific. Remove vague language. Keep it Danish if it is Danish.",
      };

      const systemPrompt = `You are an expert configuration assistant for a B2B AI platform. 
The user wants to refine a specific field of their AI expert configuration.
Field being refined: "${body.field}"
Action requested: ${ACTION_PROMPTS[body.action]}
Return ONLY the refined text — no quotes, no explanation, no JSON. Just the improved text directly.`;

      const result = await runAiCall(
        { feature: "expert-refine", useCase: "configuration_assist", tenantId: getOrgId(req), userId: getUserId(req) },
        { systemPrompt, userInput: body.currentValue },
      );

      res.json({ refined: result.content.trim() });
    } catch (err) { handleError(res, err); }
  });

  // POST /api/experts/:id/promote — promote draft → live
  app.post("/api/experts/:id/promote", async (req, res) => {
    try {
      const { db } = await import("./db");
      const { architectureProfiles, expertVersions } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const orgId   = getOrgId(req);
      const userId  = getUserId(req);
      const expert  = await loadExpert(req.params.id, orgId);
      if (!expert) return res.status(404).json({ error: "Expert not found" });

      // Ensure a draft exists (create one if not yet materialized)
      let draftVersionId = expert.draftVersionId;
      if (!draftVersionId) {
        const newDraft = await buildAndUpsertDraft(req.params.id, orgId, userId);
        draftVersionId = newDraft.id;
      }

      // Archive previous live version
      if (expert.currentVersionId) {
        await db
          .update(expertVersions)
          .set({ status: "archived" })
          .where(and(eq(expertVersions.id, expert.currentVersionId), eq(expertVersions.organizationId, orgId)));
      }

      // Promote draft → live
      await db
        .update(expertVersions)
        .set({ status: "live" })
        .where(and(eq(expertVersions.id, draftVersionId), eq(expertVersions.organizationId, orgId)));

      // Update expert pointers
      const [updatedExpert] = await db
        .update(architectureProfiles)
        .set({ currentVersionId: draftVersionId, draftVersionId: null, updatedAt: new Date() })
        .where(and(eq(architectureProfiles.id, req.params.id), eq(architectureProfiles.organizationId, orgId)))
        .returning();

      res.json({ expert: updatedExpert, promoted_version_id: draftVersionId });
    } catch (err) { handleError(res, err); }
  });

  // GET /api/experts/:id/versions — version history
  app.get("/api/experts/:id/versions", async (req, res) => {
    try {
      const { db } = await import("./db");
      const { expertVersions } = await import("../shared/schema");
      const { eq, and, desc } = await import("drizzle-orm");
      const orgId = getOrgId(req);
      const expert = await loadExpert(req.params.id, orgId);
      if (!expert) return res.status(404).json({ error: "Expert not found" });

      const versions = await db
        .select()
        .from(expertVersions)
        .where(and(eq(expertVersions.expertId, req.params.id), eq(expertVersions.organizationId, orgId)))
        .orderBy(desc(expertVersions.versionNumber));

      setCachePrivate(res, 10);
      res.json(versions);
    } catch (err) { handleError(res, err); }
  });

  // ─── Rules ───────────────────────────────────────────────────────────────────

  app.get("/api/experts/:id/rules", async (req, res) => {
    try {
      const { db } = await import("./db");
      const { specialistRules } = await import("../shared/schema");
      const { eq, and, asc } = await import("drizzle-orm");
      const orgId = getOrgId(req);
      const rows = await db
        .select()
        .from(specialistRules)
        .where(and(eq(specialistRules.expertId, req.params.id), eq(specialistRules.organizationId, orgId)))
        .orderBy(asc(specialistRules.priority));
      setCachePrivate(res, 10);
      res.json(rows);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/experts/:id/rules", async (req, res) => {
    try {
      const body = CreateSpecialistRuleSchema.parse(req.body);
      const { db } = await import("./db");
      const { specialistRules } = await import("../shared/schema");
      const orgId = getOrgId(req);
      const [row] = await db
        .insert(specialistRules)
        .values({
          ...body,
          expertId:       req.params.id,
          organizationId: orgId,
          config:         body.config ?? null,
        })
        .returning();
      res.status(201).json(row);
    } catch (err) { handleError(res, err); }
  });

  // PUT /api/experts/:id/rules/:ruleId — update a rule
  app.put("/api/experts/:id/rules/:ruleId", async (req, res) => {
    try {
      const { db } = await import("./db");
      const { specialistRules } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const body = z.object({
        type:             z.string().optional(),
        name:             z.string().min(1).optional(),
        description:      z.string().optional(),
        priority:         z.number().int().min(1).max(999).optional(),
        enforcementLevel: z.enum(["hard","soft"]).optional(),
        config:           z.record(z.unknown()).optional(),
      }).parse(req.body);

      const [updated] = await db
        .update(specialistRules)
        .set({ ...body, updatedAt: new Date() })
        .where(and(
          eq(specialistRules.id, req.params.ruleId),
          eq(specialistRules.expertId, req.params.id),
          eq(specialistRules.organizationId, getOrgId(req)),
        ))
        .returning();
      if (!updated) return res.status(404).json({ error: "Rule not found" });
      res.json(updated);
    } catch (err) { handleError(res, err); }
  });

  app.delete("/api/experts/:id/rules/:ruleId", async (req, res) => {
    try {
      const { db } = await import("./db");
      const { specialistRules } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");
      await db
        .delete(specialistRules)
        .where(and(
          eq(specialistRules.id, req.params.ruleId),
          eq(specialistRules.expertId, req.params.id),
          eq(specialistRules.organizationId, getOrgId(req)),
        ));
      res.json({ ok: true });
    } catch (err) { handleError(res, err); }
  });

  // ─── Sources ─────────────────────────────────────────────────────────────────

  app.get("/api/experts/:id/sources", async (req, res) => {
    try {
      const { db } = await import("./db");
      const { specialistSources } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const orgId = getOrgId(req);
      const rows = await db
        .select()
        .from(specialistSources)
        .where(and(eq(specialistSources.expertId, req.params.id), eq(specialistSources.organizationId, orgId)));
      setCachePrivate(res, 10);
      res.json(rows);
    } catch (err) { handleError(res, err); }
  });

  app.post("/api/experts/:id/sources", async (req, res) => {
    try {
      const body = CreateSpecialistSourceSchema.parse(req.body);
      const { db } = await import("./db");
      const { specialistSources } = await import("../shared/schema");
      const orgId = getOrgId(req);
      const [row] = await db
        .insert(specialistSources)
        .values({ ...body, expertId: req.params.id, organizationId: orgId })
        .returning();
      res.status(201).json(row);
    } catch (err) { handleError(res, err); }
  });

  app.patch("/api/experts/:id/sources/:sourceId", async (req, res) => {
    try {
      const { db } = await import("./db");
      const { specialistSources } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");
      const body = z.object({
        status:          z.enum(["pending","processed","failed","linked"]).optional(),
        processingNotes: z.string().optional(),
        chunksCount:     z.number().int().optional(),
      }).parse(req.body);
      const [updated] = await db
        .update(specialistSources)
        .set({ ...body, updatedAt: new Date() })
        .where(and(
          eq(specialistSources.id, req.params.sourceId),
          eq(specialistSources.expertId, req.params.id),
          eq(specialistSources.organizationId, getOrgId(req)),
        ))
        .returning();
      res.json(updated);
    } catch (err) { handleError(res, err); }
  });

  app.delete("/api/experts/:id/sources/:sourceId", async (req, res) => {
    try {
      const { db } = await import("./db");
      const { specialistSources } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");
      await db
        .delete(specialistSources)
        .where(and(
          eq(specialistSources.id, req.params.sourceId),
          eq(specialistSources.expertId, req.params.id),
          eq(specialistSources.organizationId, getOrgId(req)),
        ));
      res.json({ ok: true });
    } catch (err) { handleError(res, err); }
  });

  // ─── Content Authenticity — Synthetic Content Risk Signals ──────────────────

  app.post("/api/experts/:id/sources/:sourceId/analyze-authenticity", async (req, res) => {
    try {
      const { db }              = await import("./db");
      const { specialistSources, documentRiskScores } = await import("../shared/schema");
      const { eq, and }         = await import("drizzle-orm");
      const orgId               = getOrgId(req);

      const [source] = await db.select().from(specialistSources)
        .where(and(
          eq(specialistSources.id, req.params.sourceId),
          eq(specialistSources.expertId, req.params.id),
          eq(specialistSources.organizationId, orgId),
        ));

      if (!source) return res.status(404).json({ error: "Source not found" });

      // Heuristic synthetic-content risk signals (deterministic, no ML dependency)
      const signals: string[] = [];
      const name = (source.sourceName ?? "").toLowerCase();
      const type = source.sourceType ?? "document";

      if (!source.sourceName || source.sourceName.length < 4) signals.push("very_short_name");
      if (source.status === "pending") signals.push("not_yet_processed");
      if (type === "image") signals.push("image_source_unverifiable");
      if (name.includes("test") || name.includes("demo") || name.includes("sample")) signals.push("test_or_demo_name");
      if (source.status === "failed") signals.push("ingestion_failed");

      const hasRisk = signals.length >= 2;
      const riskScore = Math.min(signals.length * 0.2, 0.9);
      const riskLevel = riskScore >= 0.6 ? "high_risk" : riskScore >= 0.3 ? "medium_risk" : "low_risk";

      // Store in document_risk_scores (append-only)
      await db.insert(documentRiskScores).values({
        tenantId:            orgId,
        documentId:          source.id,
        documentVersionId:   null,
        riskLevel,
        riskScore:           riskScore.toString(),
        scoringVersion:      "heuristic-v1",
        contributingSignals: { signals, sourceType: type, sourceName: source.sourceName },
      });

      return res.json({
        source_id:          source.id,
        source_name:        source.sourceName,
        risk_score:         riskScore,
        risk_level:         riskLevel,
        signals,
        confidence:         signals.length === 0 ? 0.9 : 0.6,
        has_risk:           hasRisk,
        checked_at:         new Date().toISOString(),
        scoring_version:    "heuristic-v1",
        notes:              signals.length === 0
          ? "Ingen risikosignaler opdaget. Kilden fremstår autentisk."
          : `${signals.length} signal(er) identificeret. Verificér kildens oprindelse.`,
      });
    } catch (err) { handleError(res, err); }
  });

  // ─── AI Assist — structured validated output ──────────────────────────────────

  app.post("/api/experts/ai-suggest", async (req, res) => {
    try {
      const body = z.object({
        rawDescription: z.string().min(1),
        industry:       z.string().optional(),
        department:     z.string().optional(),
        language:       z.string().optional().default("da"),
      }).parse(req.body);

      const { runAiCall } = await import("./lib/ai/runner");
      const langNote = body.language === "en" ? "English" : "danish";

      const systemPrompt = `You are an AI configuration assistant for a multi-tenant B2B AI specialist platform.
The user describes an AI expert they want to build. Return ONLY valid JSON with this exact schema:
{
  "suggested_name": "string — precise professional name",
  "improved_description": "string — clear purpose-driven description, max 2 sentences",
  "goal": "string — one sentence: what this expert achieves",
  "instructions": "string — 3-6 bullet points describing what the AI SHOULD do (use newline-separated bullets starting with -)",
  "restrictions": "string — 3-5 bullet points describing what the AI must NOT do (use newline-separated bullets starting with -)",
  "suggested_output_style": "concise | formal | advisory",
  "suggested_rules": [
    {
      "type": "decision | threshold | required_evidence | source_restriction | escalation",
      "name": "string",
      "description": "string",
      "priority": 100,
      "enforcement_level": "hard | soft"
    }
  ],
  "suggested_source_types": ["document | policy | legal | rulebook | image | other"],
  "warnings": []
}
Respond only in JSON. No markdown fences. No explanation.
Generate names and content in ${langNote}.`;

      const userInput = [
        body.rawDescription,
        body.industry   ? `Industry: ${body.industry}`   : "",
        body.department ? `Department: ${body.department}` : "",
      ].filter(Boolean).join("\n");

      const result = await runAiCall(
        { feature: "expert-suggest", useCase: "analysis", tenantId: getOrgId(req), userId: getUserId(req) },
        { systemPrompt, userInput },
      );

      const AiSuggestionSchema = z.object({
        suggested_name:         z.string().min(1),
        improved_description:   z.string(),
        goal:                   z.string(),
        instructions:           z.string(),
        restrictions:           z.string().optional().default(""),
        suggested_output_style: z.enum(["concise","formal","advisory"]).catch("advisory"),
        suggested_rules: z.array(z.object({
          type:              z.string(),
          name:              z.string(),
          description:       z.string(),
          priority:          z.number().int().catch(100),
          enforcement_level: z.enum(["hard","soft"]).catch("soft"),
        })).default([]),
        suggested_source_types: z.array(z.string()).default([]),
        warnings:               z.array(z.string()).default([]),
      });

      let parsed: unknown;
      try {
        parsed = JSON.parse(result.content.replace(/```json\n?|\n?```/g, "").trim());
      } catch {
        return res.status(422).json({ error: "AI output could not be parsed. Please try again." });
      }

      const validated = AiSuggestionSchema.safeParse(parsed);
      if (!validated.success) {
        return res.status(422).json({ error: "AI output did not match expected schema. Please try again." });
      }

      res.json(validated.data);
    } catch (err) { handleError(res, err); }
  });

  // ─── Test Engine — supports draft | live version ──────────────────────────────

  app.post("/api/experts/:id/test", async (req, res) => {
    try {
      const body = z.object({
        prompt:  z.string().min(1),
        version: z.enum(["draft","live"]).optional().default("live"),
      }).parse(req.body);

      const startMs = Date.now();
      const orgId   = getOrgId(req);
      const userId  = getUserId(req);

      // 1. Load expert — tenant-scoped
      const expert = await loadExpert(req.params.id, orgId);
      if (!expert) return res.status(404).json({ error: "Expert not found or access denied." });
      if (expert.status === "archived") return res.status(400).json({ error: "Expert is archived." });

      // 2. Resolve version snapshot
      const { buildExpertPromptFromSnapshot, buildExpertPrompt } = await import("./lib/ai/expert-prompt-builder");
      let builtPrompt: Awaited<ReturnType<typeof buildExpertPromptFromSnapshot>>;

      const targetVersionId = body.version === "draft" ? expert.draftVersionId : expert.currentVersionId;

      if (targetVersionId) {
        const version = await loadVersion(targetVersionId, orgId);
        if (!version) return res.status(404).json({ error: `${body.version} version not found.` });
        builtPrompt = buildExpertPromptFromSnapshot(version.configJson as any);
      } else {
        // Fallback: build directly from live expert fields + current rules/sources
        const { db } = await import("./db");
        const { specialistRules, specialistSources } = await import("../shared/schema");
        const { eq, and } = await import("drizzle-orm");

        const [allRules, allSources] = await Promise.all([
          db.select().from(specialistRules)
            .where(and(eq(specialistRules.expertId, req.params.id), eq(specialistRules.organizationId, orgId))),
          db.select().from(specialistSources)
            .where(and(eq(specialistSources.expertId, req.params.id), eq(specialistSources.organizationId, orgId))),
        ]);

        builtPrompt = buildExpertPrompt(
          {
            name:            expert.name,
            goal:            expert.goal ?? null,
            instructions:    expert.instructions ?? null,
            outputStyle:     expert.outputStyle ?? null,
            language:        expert.language ?? "da",
            modelProvider:   expert.modelProvider ?? "openai",
            modelName:       expert.modelName ?? "gpt-4o",
            temperature:     expert.temperature ?? 0.3,
            maxOutputTokens: expert.maxOutputTokens ?? 2048,
          },
          allRules.map((r) => ({
            id:               r.id, type: r.type, name: r.name,
            description:      r.description ?? null,
            priority:         r.priority, enforcementLevel: r.enforcementLevel,
          })),
          allSources.map((s) => ({
            id: s.id, sourceName: s.sourceName, sourceType: s.sourceType, status: s.status,
          })),
        );
      }

      // 3. RAG retrieval — parallel with AI call for latency efficiency
      const { runAiCall } = await import("./lib/ai/runner");
      const { runRetrieval } = await import("./lib/retrieval/retrieval-orchestrator");

      const [aiResult, retrievalResult] = await Promise.all([
        runAiCall(
          { feature: "expert-test", useCase: "analysis", tenantId: orgId, userId, model: builtPrompt.modelName },
          { systemPrompt: builtPrompt.systemPrompt, userInput: body.prompt },
        ),
        runRetrieval({ tenantId: orgId, queryText: body.prompt, strategy: "hybrid", topK: 5 })
          .catch(() => null),
      ]);

      const latencyMs = Date.now() - startMs;

      // 4. Merge retrieval results into used_sources
      const metadataSources = builtPrompt.usedSources.map((s) => ({
        id: s.id, name: s.sourceName, source_type: s.sourceType, status: s.status,
        retrieval_type: "metadata" as const,
      }));

      const retrievedSources = (retrievalResult?.results ?? []).map((r) => ({
        id:             r.chunkId,
        name:           `Hentet kilde (score: ${r.scoreCombined.toFixed(2)})`,
        source_type:    "retrieved",
        status:         "active",
        retrieval_type: "semantic" as const,
        relevance_score: r.scoreCombined,
        rank_position:  r.rankPosition,
      }));

      const allSources = metadataSources.length > 0
        ? metadataSources
        : retrievedSources;

      const warnings: string[] = [];
      if (retrievalResult && !retrievalResult.success) {
        warnings.push("Retrieval utilgængeligt — svar baseret på ekspertens regler og instruktioner.");
      }

      // 5. Return structured response — provider/model as read-only observability
      res.json({
        output:      aiResult.content,
        used_rules:  builtPrompt.usedRules.map((r) => ({
          id: r.id, name: r.name, type: r.type, enforcement_level: r.enforcementLevel,
        })),
        used_sources:    allSources,
        retrieved_chunks: retrievedSources.length,
        retrieval_strategy: retrievalResult?.strategy ?? null,
        retrieval_latency_ms: retrievalResult?.latencyMs ?? null,
        warnings,
        latency_ms:     latencyMs,
        version_tested: body.version,
        provider:       builtPrompt.modelProvider,
        model_name:     builtPrompt.modelName,
      });
    } catch (err) { handleError(res, err); }
  });

  // ─── Document Extraction (dev + prod parity with Vercel /api/extract) ────────

  app.post("/api/extract", async (req: Request, res: Response) => {
    try {
      const contentType = req.headers["content-type"] ?? "";
      if (!contentType.includes("multipart/form-data")) {
        return res.status(400).json({ error_code: "INVALID_CONTENT_TYPE", message: "Forventet multipart/form-data" });
      }

      const Busboy  = (await import("busboy")).default;
      const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;

      const bb = Busboy({ headers: req.headers as Record<string, string>, limits: { fileSize: 26 * 1024 * 1024 } });
      const results: Array<{ filename: string; mime_type: string; char_count: number; extracted_text: string; status: string; message?: string }> = [];
      const pending: Promise<void>[] = [];

      bb.on("file", (fieldname: string, stream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
        const { filename, mimeType } = info;
        const chunks: Buffer[] = [];

        stream.on("data", (chunk: Buffer) => chunks.push(chunk));

        const p = new Promise<void>((resFile) => {
          stream.on("end", async () => {
            const buf = Buffer.concat(chunks);
            if (!buf.length) {
              results.push({ filename, mime_type: mimeType, char_count: 0, extracted_text: "", status: "error", message: "Tom fil" });
              return resFile();
            }

            try {
              let text = "";
              if (mimeType.startsWith("text/") || ["application/json","application/xml"].includes(mimeType)) {
                text = buf.toString("utf-8").slice(0, 80_000);
              } else if (mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
                const parsed = await pdfParse(buf);
                text = (parsed.text ?? "").trim().slice(0, 80_000);
                if (!text) {
                  results.push({ filename, mime_type: mimeType, char_count: 0, extracted_text: "", status: "error", message: "PDF indeholder ingen læsbar tekst" });
                  return resFile();
                }
              } else {
                results.push({ filename, mime_type: mimeType, char_count: 0, extracted_text: "", status: "unsupported", message: `Filtype '${mimeType}' understøttes ikke` });
                return resFile();
              }
              console.log(`[extract] ${filename}: ${text.length} chars extracted`);
              results.push({ filename, mime_type: mimeType, char_count: text.length, extracted_text: text, status: "ok" });
            } catch (e) {
              results.push({ filename, mime_type: mimeType, char_count: 0, extracted_text: "", status: "error", message: (e as Error).message });
            }
            resFile();
          });
          stream.on("error", (e: Error) => {
            results.push({ filename, mime_type: mimeType, char_count: 0, extracted_text: "", status: "error", message: e.message });
            resFile();
          });
        });
        pending.push(p);
      });

      bb.on("finish", async () => {
        await Promise.all(pending);
        res.json({ results });
      });

      bb.on("error", (e: Error) => {
        console.error("[extract] busboy error:", e.message);
        res.status(500).json({ error_code: "PARSE_ERROR", message: "Fil-parsing fejlede" });
      });

      req.pipe(bb as any);
    } catch (err) { handleError(res, err); }
  });

  // ─── Direct-to-R2 Upload (dev + prod parity with Vercel /api/upload) ─────────
  // POST /api/upload/url      — generate presigned PUT URL (no file bytes in Vercel)
  // POST /api/upload/finalize — post-upload: extract content + route A/B

  app.post("/api/upload/url", async (req: Request, res: Response) => {
    try {
      const orgId  = getOrgId(req);
      const userId = getUserId(req);
      const { filename, contentType, size, context = "chat" } = req.body as {
        filename: string; contentType: string; size: number; context?: string;
      };

      if (!filename || !contentType || typeof size !== "number") {
        return res.status(400).json({ error_code: "INVALID_INPUT", message: "filename, contentType og size er påkrævet" });
      }

      const ALLOWED_MIME_TYPES: Record<string, string> = {
        "application/pdf": "document", "application/msword": "document",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
        "text/plain": "document", "text/csv": "document", "text/markdown": "document",
        "text/html": "document", "application/vnd.ms-excel": "document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "document",
        "application/rtf": "document", "image/jpeg": "image", "image/png": "image",
        "image/gif": "image", "image/webp": "image", "image/tiff": "image",
        "image/bmp": "image", "video/mp4": "video", "video/quicktime": "video",
        "video/x-msvideo": "video", "video/webm": "video", "video/mpeg": "video",
        "audio/mpeg": "audio", "audio/wav": "audio", "audio/ogg": "audio",
        "audio/mp4": "audio", "audio/webm": "audio", "audio/aac": "audio",
        "audio/flac": "audio", "audio/x-wav": "audio",
      };
      if (!ALLOWED_MIME_TYPES[contentType]) {
        return res.status(415).json({ error_code: "UNSUPPORTED_MIME", message: `Filtypen "${contentType}" understøttes ikke` });
      }

      const { r2Client, R2_BUCKET, R2_CONFIGURED } = await import("./lib/r2/r2-client");
      if (!R2_CONFIGURED) {
        return res.status(503).json({ error_code: "R2_NOT_CONFIGURED", message: "Filopbevaring er ikke konfigureret" });
      }
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      const { getSignedUrl }     = await import("@aws-sdk/s3-request-presigner");
      const safeFilename = filename.replace(/[^a-zA-Z0-9._\-]/g, "-").slice(0, 200);
      const objectKey    = `tenants/${orgId}/uploads/${context}/${Date.now()}-${safeFilename}`;
      const command      = new PutObjectCommand({ Bucket: R2_BUCKET, Key: objectKey, ContentType: contentType });
      const uploadUrl    = await getSignedUrl(r2Client, command, { expiresIn: 900 });
      console.log(`[upload/url] tenant=${orgId} user=${userId} key=${objectKey} mime=${contentType} size=${size}`);
      return res.json({ uploadUrl, objectKey, expiresIn: 900 });
    } catch (e) {
      console.error("[upload/url] error:", e);
      return res.status(500).json({ error_code: "INTERNAL_ERROR", message: "Upload URL kunne ikke genereres" });
    }
  });

  app.post("/api/upload/finalize", async (req: Request, res: Response) => {
    try {
      const orgId  = getOrgId(req);
      const userId = getUserId(req);
      const { objectKey, filename, contentType, size, context = "chat", fileCount = 1 } = req.body as {
        objectKey: string; filename: string; contentType: string; size: number;
        context?: string; fileCount?: number; sourceId?: string;
      };

      if (!objectKey || !filename || !contentType || typeof size !== "number") {
        return res.status(400).json({ error_code: "INVALID_INPUT", message: "objectKey, filename, contentType og size er påkrævet" });
      }
      if (!objectKey.startsWith(`tenants/${orgId}/`)) {
        return res.status(403).json({ error_code: "FORBIDDEN", message: "Ugyldig object key" });
      }

      // ── PDF: Hybrid tilgang — native tekst-ekstraktion → fallback til async OCR ─
      const isPdf = contentType === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
      if (isPdf) {
        // ── Download PDF fra R2 (shared buffer for both pdf-parse and Gemini OCR) ──
        let pdfBuf: Buffer = Buffer.alloc(0);
        try {
          const { r2Client: r2c, R2_BUCKET: r2bucket, R2_CONFIGURED: r2ok } = await import("./lib/r2/r2-client");
          if (r2ok) {
            const { GetObjectCommand } = await import("@aws-sdk/client-s3");
            const r2resp = await r2c.send(new GetObjectCommand({ Bucket: r2bucket, Key: objectKey }));
            if (r2resp.Body) {
              const bufs: Buffer[] = [];
              for await (const chunk of r2resp.Body as AsyncIterable<Uint8Array>) {
                bufs.push(Buffer.from(chunk));
              }
              pdfBuf = Buffer.concat(bufs);
            }
          }
        } catch (r2Err) {
          console.error(`[upload/finalize] R2 download fejlede: ${(r2Err as Error).message}`);
          return res.status(500).json({ error_code: "R2_ERROR", message: "Kunne ikke downloade fil til behandling" });
        }

        if (!pdfBuf.length) {
          return res.status(500).json({ error_code: "R2_EMPTY", message: "R2 returnerede tom fil" });
        }

        // Trin 1: Forsøg native tekst-ekstraktion med pdf-parse (hurtig, præcis)
        let embeddedText = "";
        try {
          const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
          const parsed   = await pdfParse(pdfBuf);
          embeddedText   = (parsed.text ?? "").trim();
        } catch (parseErr) {
          console.warn(`[upload/finalize] pdf-parse fejlede (fortsætter til Gemini): ${(parseErr as Error).message}`);
        }

        // Trin 2: Native PDF (indlejret tekst) → returnér direkte
        const nonWsChars = embeddedText.replace(/\s+/g, "").length;
        if (nonWsChars >= 120) {
          console.log(`[upload/finalize] PDF native tekst ok — ${embeddedText.length} chars (${nonWsChars} non-ws). Returnerer direkte.`);
          return res.json({
            mode:    "direct",
            routing: "native_pdf_text",
            results: [{
              filename,
              mime_type:      contentType,
              char_count:     embeddedText.length,
              extracted_text: embeddedText.slice(0, 80_000),
              status:         "ok",
              source:         "r2_pdf_parse",
            }],
          });
        }

        // Trin 3: Tom/scannet PDF → Segment-first async OCR (page-by-page Gemini)
        // Enqueue the job + fire-and-forget inline processing.
        // Returns OCR_PENDING immediately — client polls /api/ocr-status.
        // First page ready in ~3–5 s (partial_ready stage), full doc in 15–45 s.
        console.log(`[upload/finalize] PDF scannet/tom (${nonWsChars} non-ws chars) — segment-first OCR. tenant=${orgId}`);
        try {
          const userId = getUserId(req);
          const { enqueueOcrJob }        = await import("./lib/jobs/job-queue");
          const { processOcrJobInline }  = await import("./lib/jobs/ocr-inline-processor");

          const { id: taskId } = await enqueueOcrJob({
            tenantId:    orgId,
            userId,
            r2Key:       objectKey,
            filename,
            contentType: "application/pdf",
          });

          // Fire-and-forget: page-split + parallel OCR runs in background.
          // The pre-downloaded pdfBuf is passed to skip R2 re-download.
          processOcrJobInline(taskId, pdfBuf, filename, "application/pdf").catch((err: Error) =>
            console.error(`[upload/finalize] inline OCR error taskId=${taskId}: ${err.message}`),
          );

          console.log(`[upload/finalize] OCR_PENDING taskId=${taskId} — inline processor started`);
          return res.json({ mode: "OCR_PENDING", taskId, routing: "inline_page_ocr" });

        } catch (enqErr) {
          const msg = enqErr instanceof Error ? enqErr.message : String(enqErr);
          console.error(`[upload/finalize] enqueueOcrJob fejlede: ${msg}`);
          return res.json({ mode: "B_FALLBACK", routing: "enqueue_error", message: `OCR-kø fejlede: ${msg.slice(0, 300)}`, results: [] });
        }
      }

      // ── A/B routing for non-PDFs ──────────────────────────────────────────
      const { decideAttachmentProcessingMode } = await import("./lib/chat/attachment-router");
      const routing = decideAttachmentProcessingMode({
        mimeType: contentType, sizeBytes: size, fileCount: fileCount ?? 1, context: context as "chat" | "storage",
      });
      console.log(`[upload/finalize] tenant=${orgId} key=${objectKey} mode=${routing.mode} reason=${routing.reason}`);

      const { processDirectAttachment } = await import("./lib/chat/direct-attachment-processor");
      const result = await processDirectAttachment({ objectKey, filename, contentType, sizeBytes: size });

      if (result.status === "ok") {
        return res.json({ mode: routing.mode, routing: routing.reason, results: [result] });
      }
      return res.json({ mode: "B_FALLBACK", routing: routing.reason, message: result.message, results: [] });
    } catch (e) {
      console.error("[upload/finalize] error:", e);
      return res.status(500).json({ error_code: "INTERNAL_ERROR", message: "Finalisering fejlede" });
    }
  });

  // ─── OCR Status ─────────────────────────────────────────────────────────────

  app.get("/api/ocr-status", async (req: Request, res: Response) => {
    try {
      const orgId  = getOrgId(req);
      const taskId = req.query.id as string;
      if (!taskId) {
        return res.status(400).json({ error_code: "MISSING_ID", message: "id query parameter krævet" });
      }
      const { getJob } = await import("./lib/jobs/job-queue");
      const task = await getJob(taskId);
      if (!task) {
        return res.status(404).json({ error_code: "NOT_FOUND", message: `OCR task ${taskId} ikke fundet` });
      }
      // Tenant isolation
      if (task.tenantId !== orgId) {
        return res.status(403).json({ error_code: "FORBIDDEN", message: "Adgang nægtet" });
      }
      if (task.status === "completed") {
        return res.json({
          status:       "completed",
          taskId:       task.id,
          ocrText:      task.ocrText ?? "",
          charCount:    task.charCount ?? 0,
          chunkCount:   task.chunkCount ?? 0,
          qualityScore: task.qualityScore ?? 0,
          pageCount:    task.pageCount ?? 1,
          provider:     task.provider ?? "manus-agent",
          completedAt:  task.completed_at,
        });
      }
      if (task.status === "failed" || task.status === "dead") {
        return res.json({
          status:       task.status,
          taskId:       task.id,
          errorReason:  task.errorReason ?? task.lastError ?? "Ukendt fejl",
          attemptCount: task.attemptCount ?? 0,
          maxAttempts:  task.maxAttempts ?? 3,
        });
      }
      return res.json({
        status:       task.status ?? "pending",
        taskId:       task.id,
        stage:        task.stage ?? null,
        attemptCount: task.attemptCount ?? 0,
      });
    } catch (e) {
      console.error("[ocr-status] error:", e);
      return res.status(500).json({ error_code: "INTERNAL_ERROR", message: "Status opslag fejlede" });
    }
  });

  // ─── OCR Job Observability (Phase 5Z-PERF) ───────────────────────────────────
  // GET /api/ocr-job-debug?id=<taskId>
  // Returns full segmentation/performance facts for a chat_ocr_tasks job.

  app.get("/api/ocr-job-debug", async (req: Request, res: Response) => {
    try {
      const orgId  = getOrgId(req);
      const taskId = req.query.id as string;
      if (!taskId) {
        return res.status(400).json({ error_code: "MISSING_ID", message: "id query parameter krævet" });
      }
      const { getJob } = await import("./lib/jobs/job-queue");
      const task = await getJob(taskId);
      if (!task) {
        return res.status(404).json({ error_code: "NOT_FOUND", message: `OCR task ${taskId} ikke fundet` });
      }
      if (task.tenantId !== orgId) {
        return res.status(403).json({ error_code: "FORBIDDEN", message: "Adgang nægtet" });
      }

      const startedAt   = task.startedAt   ? new Date(task.startedAt).getTime()   : null;
      const completedAt = task.completedAt  ? new Date(task.completedAt).getTime() : null;
      const createdAt   = task.createdAt    ? new Date(task.createdAt).getTime()   : null;

      const waitBeforeClaimMs = (startedAt && createdAt)   ? startedAt - createdAt     : null;
      const processingDurationMs = (completedAt && startedAt) ? completedAt - startedAt : null;

      return res.json({
        jobId:               task.id,
        status:              task.status,
        stage:               task.stage ?? null,
        filename:            task.filename,
        contentType:         task.contentType,
        provider:            task.provider ?? null,
        plannerDecision:     task.charCount && task.charCount > 0 ? "single_segment_fast_path" : "pending",
        segmentsTotal:       1,
        segmentsPending:     task.status === "pending"   ? 1 : 0,
        segmentsProcessing:  task.status === "running"   ? 1 : 0,
        segmentsCompleted:   task.status === "completed" ? 1 : 0,
        segmentsRetrievalReady: task.status === "completed" ? 1 : 0,
        coveragePercent:     task.status === "completed" ? 100 : 0,
        charCount:           task.charCount  ?? null,
        chunkCount:          task.chunkCount ?? null,
        qualityScore:        task.qualityScore ? parseFloat(task.qualityScore) : null,
        attemptCount:        task.attemptCount,
        maxAttempts:         task.maxAttempts,
        nextRetryAt:         task.nextRetryAt ?? null,
        lastError:           task.lastError   ?? null,
        createdAt:           task.createdAt,
        startedAt:           task.startedAt   ?? null,
        completedAt:         task.completedAt  ?? null,
        waitBeforeClaimMs,
        processingDurationMs,
        firstRetrievalReadyAt:         task.completedAt ?? null,
        timeToFirstRetrievalReadyMs:   (completedAt && createdAt) ? completedAt - createdAt : null,
      });
    } catch (e) {
      console.error("[ocr-job-debug] error:", e);
      return res.status(500).json({ error_code: "INTERNAL_ERROR", message: "Debug opslag fejlede" });
    }
  });

  // ─── AI Chat ──────────────────────────────────────────────────────────────────
  // Shared document context schema (used by both /api/chat and /api/chat/stream)
  const documentContextSchema = z.object({
    filename:       z.string(),
    mime_type:      z.string(),
    char_count:     z.number(),
    extracted_text: z.string(),
    status:         z.enum(["ok", "unsupported", "error"]),
    message:        z.string().optional(),
    source:         z.string().optional(),
  });

  const chatBodySchema = z.object({
    message:          z.string().min(1, "Besked er påkrævet").max(4000),
    conversation_id:  z.string().optional().nullable(),
    document_context: z.array(documentContextSchema).optional().default([]),
    context: z.object({
      document_ids:        z.array(z.string()).optional().default([]),
      preferred_expert_id: z.string().optional().nullable(),
    }).optional().default({}),
    // Phase 5Z.3 — Idempotency key prevents duplicate AI calls for the same readiness generation
    idempotency_key: z.string().max(256).optional().nullable(),
  });

  // ── Phase 5Z.3 — Chat idempotency cache ─────────────────────────────────────
  // Keyed by: `${orgId}:${idempotency_key}`. TTL: 10 minutes (covers reconnect window).
  // Only non-streaming /api/chat responses are cached. Streaming cannot be replayed byte-for-byte.
  const _chatIdempotencyCache = new Map<string, { ts: number; payload: object }>();
  const CHAT_IDEM_TTL_MS = 10 * 60 * 1000;

  function _chatIdemGet(orgId: string, key: string | null | undefined) {
    if (!key) return null;
    const cacheKey = `${orgId}:${key}`;
    const entry = _chatIdempotencyCache.get(cacheKey);
    if (!entry) return null;
    if (Date.now() - entry.ts > CHAT_IDEM_TTL_MS) { _chatIdempotencyCache.delete(cacheKey); return null; }
    return entry.payload;
  }

  function _chatIdemSet(orgId: string, key: string | null | undefined, payload: object) {
    if (!key) return;
    const cacheKey = `${orgId}:${key}`;
    _chatIdempotencyCache.set(cacheKey, { ts: Date.now(), payload });
    // Prune old entries (keep cache bounded to 500 entries)
    if (_chatIdempotencyCache.size > 500) {
      const oldest = [..._chatIdempotencyCache.entries()]
        .sort((a, b) => a[1].ts - b[1].ts)
        .slice(0, 100)
        .map(([k]) => k);
      oldest.forEach(k => _chatIdempotencyCache.delete(k));
    }
  }

  app.post("/api/chat", async (req: Request, res: Response) => {
    try {
      const body   = chatBodySchema.parse(req.body);
      const orgId  = getOrgId(req);
      const userId = getUserId(req);

      // ── Phase 5Z.3 — Idempotency check (non-streaming) ──────────────────────
      const idemKey = body.idempotency_key ?? null;
      const cached  = _chatIdemGet(orgId, idemKey);
      if (cached) {
        return res.json({ ...cached, _idempotent: true });
      }

      const { resolveRouteDecision } = await import("./lib/chat/route-decision");
      const { runChatMessage }        = await import("./services/chat-runner");

      // ── Automatic routing (RULE A-E) ────────────────────────────────────────
      const decision = await resolveRouteDecision({
        message:           body.message,
        organizationId:    orgId,
        userId,
        conversationId:    body.conversation_id ?? null,
        documentContext:   body.document_context as any[],
        preferredExpertId: body.context?.preferred_expert_id ?? null,
      });

      // ── Gated responses (no AI call) ─────────────────────────────────────
      if (!decision.requiresAiCall) {
        return res.status(decision.routeType === "processing" ? 202 : 200).json({
          route_type:      decision.routeType,
          gating_message:  decision.gatingMessage,
          routing_explanation: decision.routingExplanation,
        });
      }

      // ── Execute AI call ──────────────────────────────────────────────────
      const result = await runChatMessage({
        message:         body.message,
        expert:          decision.primaryExpert,
        organizationId:  orgId,
        userId,
        conversationId:  body.conversation_id ?? null,
        routingExplanation: decision.routingExplanation,
        documentContext: decision.documentContext,
        routeType:       decision.routeType,
      });

      // ── Optional: partial readiness metadata (non-fatal) ─────────────────
      const { enrichResponseWithReadiness } = await import("./lib/chat/readiness-enrichment");
      const partialReadiness = await enrichResponseWithReadiness({
        tenantId:    orgId,
        documentIds: body.context?.document_ids ?? [],
      });

      const chatResponse: object = {
        answer:              result.answer,
        conversation_id:     result.conversationId,
        route_type:          decision.routeType,
        expert: {
          id:       result.expert.id,
          name:     result.expert.name,
          category: result.expert.category,
        },
        used_sources:        result.usedSources,
        used_rules:          result.usedRules,
        warnings:            result.warnings,
        latency_ms:          result.latencyMs,
        confidence_band:     result.confidenceBand,
        needs_manual_review: result.needsManualReview,
        routing_explanation: result.routingExplanation,
        // Phase 5Z.3 — Idempotency + answer generation metadata
        trigger_key_used:    idemKey ?? null,
        answer_generation:   { partial: !!(partialReadiness as any)?.fullCompletionBlocked, generation: 1 },
        // Readiness fields are spread flat for direct access AND available nested as partial_readiness
        ...(partialReadiness ? { partial_readiness: partialReadiness, ...partialReadiness } : {}),
      };
      _chatIdemSet(orgId, idemKey, chatResponse);
      return res.json(chatResponse);
    } catch (err) { handleError(res, err); }
  });

  // POST /api/chat/stream — SSE streaming variant (automatic routing)
  // Events: {"type":"status","text":"..."} | {"type":"delta","text":"..."} | {"type":"done",...} | {"type":"error",...}
  app.post("/api/chat/stream", async (req: Request, res: Response) => {
    res.setHeader("Content-Type",      "text/event-stream");
    res.setHeader("Cache-Control",     "no-cache");
    res.setHeader("Connection",        "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const sendEvent = (data: object) => {
      try { res.write(`data: ${JSON.stringify(data)}\n\n`); } catch { /* client disconnected */ }
    };

    try {
      const body   = chatBodySchema.parse(req.body);
      const orgId  = getOrgId(req);
      const userId = getUserId(req);

      const { resolveRouteDecision }    = await import("./lib/chat/route-decision");
      const { getRoutingStatusMessage } = await import("./lib/chat/hybrid-context-builder");
      const { runChatMessage }          = await import("./services/chat-runner");

      // ── Automatic routing (RULE A-E) ─────────────────────────────────────
      sendEvent({ type: "status", text: "Analyserer forespørgsel..." });

      const decision = await resolveRouteDecision({
        message:           body.message,
        organizationId:    orgId,
        userId,
        conversationId:    body.conversation_id ?? null,
        documentContext:   body.document_context as any[],
        preferredExpertId: body.context?.preferred_expert_id ?? null,
      });

      // ── Gated responses ──────────────────────────────────────────────────
      if (!decision.requiresAiCall) {
        sendEvent({
          type:       "gated",
          routeType:  decision.routeType,
          message:    decision.gatingMessage,
        });
        return res.end();
      }

      sendEvent({
        type:      "status",
        text:      getRoutingStatusMessage(decision.routeType),
        routeType: decision.routeType,
      });

      // ── Execute AI call with streaming ───────────────────────────────────
      const result = await runChatMessage({
        message:         body.message,
        expert:          decision.primaryExpert,
        organizationId:  orgId,
        userId,
        conversationId:  body.conversation_id ?? null,
        routingExplanation: decision.routingExplanation,
        documentContext: decision.documentContext,
        routeType:       decision.routeType,
        onToken: (delta) => sendEvent({ type: "delta", text: delta }),
      });

      const { enrichResponseWithReadiness: enrichStream } = await import("./lib/chat/readiness-enrichment");
      const streamReadiness = await enrichStream({
        tenantId:    orgId,
        documentIds: body.context?.document_ids ?? [],
      });

      sendEvent({
        type:                "done",
        answer:              result.answer,
        conversation_id:     result.conversationId,
        route_type:          decision.routeType,
        expert:              { id: result.expert.id, name: result.expert.name, category: result.expert.category },
        used_sources:        result.usedSources,
        used_rules:          result.usedRules,
        warnings:            result.warnings,
        latency_ms:          result.latencyMs,
        confidence_band:     result.confidenceBand,
        needs_manual_review: result.needsManualReview,
        routing_explanation: result.routingExplanation,
        similar_cases:       result.similarCases,
        // Phase 5Z.3 — Idempotency + answer generation metadata
        trigger_key_used:    body.idempotency_key ?? null,
        answer_generation:   { partial: !!(streamReadiness as any)?.fullCompletionBlocked, generation: 1 },
        // Readiness fields are spread flat for direct access AND available nested as partial_readiness
        ...(streamReadiness ? { partial_readiness: streamReadiness, ...streamReadiness } : {}),
      });
      res.end();
    } catch (err) {
      const msg  = err instanceof Error ? err.message : String(err);
      const code = (err as any)?.errorCode ?? "CHAT_ERROR";
      sendEvent({ type: "error", errorCode: code, message: msg });
      res.end();
    }
  });

  // GET /api/chat/conversations — list conversations for current user
  app.get("/api/chat/conversations", async (req: Request, res: Response) => {
    try {
      const orgId  = getOrgId(req);
      const userId = getUserId(req);
      const { db: dbInst } = await import("./db");
      const { chatConversations } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const rows = await dbInst
        .select()
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.organizationId, orgId),
            eq(chatConversations.createdBy, userId),
          ),
        )
        .orderBy(chatConversations.createdAt);

      return res.json({ conversations: rows });
    } catch (err) { handleError(res, err); }
  });

  // GET /api/chat/conversations/:id/messages
  app.get("/api/chat/conversations/:id/messages", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { db: dbInst } = await import("./db");
      const { chatMessages, chatConversations } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");

      // Verify conversation belongs to this org (tenant isolation)
      const [conv] = await dbInst
        .select({ id: chatConversations.id })
        .from(chatConversations)
        .where(
          and(
            eq(chatConversations.id, req.params.id),
            eq(chatConversations.organizationId, orgId),
          ),
        )
        .limit(1);

      if (!conv) return res.status(404).json({ error: "Samtale ikke fundet." });

      const msgs = await dbInst
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.conversationId, req.params.id),
            eq(chatMessages.organizationId, orgId),
          ),
        )
        .orderBy(chatMessages.createdAt);

      return res.json({ messages: msgs });
    } catch (err) { handleError(res, err); }
  });

  // ─── Backward-compat aliases (keep old /api/architectures routes above) ───────

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

  // Phase 2.2 — Tenant Insights Engine routes
  registerInsightRoutes(app);

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

  // ── Early Access Applications ──────────────────────────────────────────────
  app.post("/api/early-access", async (req: Request, res: Response) => {
    try {
      const { pool } = await import("./db");
      const { z }   = await import("zod");

      const schema = z.object({
        email:    z.string().email(),
        fullName: z.string().optional(),
        company:  z.string().min(1).optional(),
        role:     z.string().optional(),
        useCase:  z.string().optional(),
        teamSize: z.string().optional(),
      });

      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(422).json({ error: "Ugyldig formulardata", details: parsed.error.issues });
      }

      const { email, fullName, company, role, useCase, teamSize } = parsed.data;

      // Ensure table exists (idempotent DDL)
      await pool.query(`
        CREATE TABLE IF NOT EXISTS early_access_applications (
          id         text PRIMARY KEY DEFAULT gen_random_uuid()::text,
          email      text NOT NULL,
          full_name  text,
          company    text,
          role       text,
          use_case   text,
          team_size  text,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS ea_email_uq ON early_access_applications (email);
        CREATE INDEX IF NOT EXISTS ea_created_idx ON early_access_applications (created_at);
      `);

      // Upsert — ignore duplicates silently
      const existing = await pool.query(
        "SELECT id FROM early_access_applications WHERE email = $1 LIMIT 1",
        [email],
      );
      if (existing.rows.length > 0) {
        return res.status(200).json({ status: "already_registered" });
      }

      await pool.query(
        `INSERT INTO early_access_applications (email, full_name, company, role, use_case, team_size)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [email, fullName ?? null, company ?? null, role ?? null, useCase ?? null, teamSize ?? null],
      );

      console.log(`[early-access] New application: ${email} (company=${company ?? "—"})`);
      return res.status(201).json({ status: "registered" });
    } catch (err) {
      console.error("[early-access] Error:", err);
      return res.status(500).json({ error: "Der skete en fejl. Prøv igen." });
    }
  });

  // ─── Knowledge Bases (Storage Data Sources) ─────────────────────────────────

  // GET /api/kb — list all knowledge bases for tenant
  // Query params: ?status=active|archived|all (default: active)
  app.get("/api/kb", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const statusFilter = (req.query.status as string | undefined) ?? "active";
      const { db } = await import("./db");
      const { knowledgeBases, knowledgeDocuments, expertKnowledgeBases } = await import("../shared/schema");
      const { eq, and, count, desc, or } = await import("drizzle-orm");

      const baseWhere = statusFilter === "all"
        ? eq(knowledgeBases.tenantId, orgId)
        : statusFilter === "archived"
          ? and(eq(knowledgeBases.tenantId, orgId), eq(knowledgeBases.lifecycleState, "archived"))
          : and(eq(knowledgeBases.tenantId, orgId), eq(knowledgeBases.lifecycleState, "active"));

      const bases = await db
        .select()
        .from(knowledgeBases)
        .where(baseWhere)
        .orderBy(desc(knowledgeBases.updatedAt));

      if (bases.length === 0) return res.json([]);

      // Get asset counts, expert counts in parallel
      const [counts, expertCounts] = await Promise.all([
        db.select({ knowledgeBaseId: knowledgeDocuments.knowledgeBaseId, cnt: count() })
          .from(knowledgeDocuments)
          .where(and(eq(knowledgeDocuments.tenantId, orgId), eq(knowledgeDocuments.lifecycleState, "active")))
          .groupBy(knowledgeDocuments.knowledgeBaseId),
        db.select({ knowledgeBaseId: expertKnowledgeBases.knowledgeBaseId, cnt: count() })
          .from(expertKnowledgeBases)
          .where(eq(expertKnowledgeBases.tenantId, orgId))
          .groupBy(expertKnowledgeBases.knowledgeBaseId),
      ]);

      const countMap  = Object.fromEntries(counts.map((c) => [c.knowledgeBaseId, Number(c.cnt)]));
      const expertMap = Object.fromEntries(expertCounts.map((c) => [c.knowledgeBaseId, Number(c.cnt)]));

      return res.json(bases.map((b) => ({
        id:           b.id,
        name:         b.name,
        slug:         b.slug,
        description:  b.description,
        status:       b.lifecycleState,
        assetCount:   countMap[b.id]  ?? 0,
        expertCount:  expertMap[b.id] ?? 0,
        createdAt:    b.createdAt,
        updatedAt:    b.updatedAt,
      })));
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /api/kb — create knowledge base
  app.post("/api/kb", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const userId = getUserId(req);
      const { db } = await import("./db");
      const { knowledgeBases } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const bodySchema = z.object({
        name: z.string().min(1).max(200),
        slug: z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
        description: z.string().max(1000).optional(),
      });
      const body = bodySchema.parse(req.body);

      // Check slug uniqueness
      const [existing] = await db
        .select({ id: knowledgeBases.id })
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.tenantId, orgId), eq(knowledgeBases.slug, body.slug)));
      if (existing) {
        return res.status(409).json({ error_code: "SLUG_CONFLICT", message: "Slug er allerede i brug" });
      }

      const [kb] = await db.insert(knowledgeBases).values({
        tenantId: orgId,
        name: body.name,
        slug: body.slug,
        description: body.description ?? null,
        lifecycleState: "active",
        visibility: "private",
        createdBy: userId,
        updatedBy: userId,
      }).returning();

      return res.status(201).json({
        id: kb.id,
        name: kb.name,
        slug: kb.slug,
        description: kb.description,
        status: kb.lifecycleState,
        assetCount: 0,
        createdAt: kb.createdAt,
        updatedAt: kb.updatedAt,
      });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // GET /api/kb/:id — knowledge base detail
  app.get("/api/kb/:id", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { db } = await import("./db");
      const { knowledgeBases, knowledgeDocuments } = await import("../shared/schema");
      const { eq, and, count } = await import("drizzle-orm");

      const [kb] = await db
        .select()
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.id, req.params.id), eq(knowledgeBases.tenantId, orgId)));
      if (!kb) return res.status(404).json({ error_code: "NOT_FOUND", message: "Datakilde ikke fundet" });

      const [{ cnt }] = await db
        .select({ cnt: count() })
        .from(knowledgeDocuments)
        .where(and(
          eq(knowledgeDocuments.knowledgeBaseId, kb.id),
          eq(knowledgeDocuments.tenantId, orgId),
          eq(knowledgeDocuments.lifecycleState, "active"),
        ));

      return res.json({
        id: kb.id,
        name: kb.name,
        slug: kb.slug,
        description: kb.description,
        status: kb.lifecycleState,
        assetCount: Number(cnt),
        createdAt: kb.createdAt,
        updatedAt: kb.updatedAt,
      });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // PATCH /api/kb/:id/archive — archive knowledge base
  app.patch("/api/kb/:id/archive", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { db } = await import("./db");
      const { knowledgeBases } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const [updated] = await db
        .update(knowledgeBases)
        .set({ lifecycleState: "archived", updatedAt: new Date() })
        .where(and(eq(knowledgeBases.id, req.params.id), eq(knowledgeBases.tenantId, orgId)))
        .returning();
      if (!updated) return res.status(404).json({ error_code: "NOT_FOUND", message: "Datakilde ikke fundet" });

      return res.json({ id: updated.id, status: updated.lifecycleState });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // PATCH /api/kb/:id — edit knowledge base name/description (slug is immutable)
  app.patch("/api/kb/:id", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { db } = await import("./db");
      const { knowledgeBases } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const bodySchema = z.object({
        name:        z.string().min(1).max(200).optional(),
        description: z.string().max(1000).nullable().optional(),
      });
      const body = bodySchema.parse(req.body);

      const updateSet: Record<string, unknown> = { updatedAt: new Date() };
      if (body.name        !== undefined) updateSet.name        = body.name;
      if (body.description !== undefined) updateSet.description = body.description;

      const [updated] = await db
        .update(knowledgeBases)
        .set(updateSet as any)
        .where(and(eq(knowledgeBases.id, req.params.id), eq(knowledgeBases.tenantId, orgId)))
        .returning();
      if (!updated) return res.status(404).json({ error_code: "NOT_FOUND", message: "Datakilde ikke fundet" });

      return res.json({
        id:          updated.id,
        name:        updated.name,
        slug:        updated.slug,
        description: updated.description,
        status:      updated.lifecycleState,
        updatedAt:   updated.updatedAt,
      });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // PATCH /api/kb/:id/reactivate — reactivate an archived knowledge base
  app.patch("/api/kb/:id/reactivate", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { db } = await import("./db");
      const { knowledgeBases } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const [updated] = await db
        .update(knowledgeBases)
        .set({ lifecycleState: "active", updatedAt: new Date() })
        .where(and(eq(knowledgeBases.id, req.params.id), eq(knowledgeBases.tenantId, orgId)))
        .returning();
      if (!updated) return res.status(404).json({ error_code: "NOT_FOUND", message: "Datakilde ikke fundet" });

      return res.json({ id: updated.id, status: updated.lifecycleState });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // GET /api/kb/:id/assets — list assets in a knowledge base
  app.get("/api/kb/:id/assets", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { db } = await import("./db");
      const { knowledgeDocuments, knowledgeDocumentVersions, knowledgeProcessingJobs, knowledgeChunks } = await import("../shared/schema");
      const { eq, and, desc, inArray, count } = await import("drizzle-orm");

      const assets = await db
        .select()
        .from(knowledgeDocuments)
        .where(and(
          eq(knowledgeDocuments.knowledgeBaseId, req.params.id),
          eq(knowledgeDocuments.tenantId, orgId),
          eq(knowledgeDocuments.lifecycleState, "active"),
        ))
        .orderBy(desc(knowledgeDocuments.createdAt));

      if (assets.length === 0) return res.json([]);

      const docIds = assets.map((a) => a.id);

      // Fetch versions, jobs and chunk counts in parallel
      const { knowledgeEmbeddings } = await import("../shared/schema");
      const [versions, jobs, chunkCounts, embeddingCounts] = await Promise.all([
        // current versions for file size / MIME
        (async () => {
          const versionIds = assets.map((a) => a.currentVersionId).filter(Boolean) as string[];
          if (versionIds.length === 0) return [] as (typeof knowledgeDocumentVersions.$inferSelect)[];
          return db.select().from(knowledgeDocumentVersions).where(inArray(knowledgeDocumentVersions.id, versionIds));
        })(),
        // latest processing job per document (Part F: full pipeline visibility)
        db.select().from(knowledgeProcessingJobs)
          .where(and(eq(knowledgeProcessingJobs.tenantId, orgId), inArray(knowledgeProcessingJobs.knowledgeDocumentId, docIds)))
          .orderBy(desc(knowledgeProcessingJobs.createdAt)),
        // chunk counts per document (Part C: traceability)
        db.select({ docId: knowledgeChunks.knowledgeDocumentId, cnt: count() })
          .from(knowledgeChunks)
          .where(and(eq(knowledgeChunks.tenantId, orgId), inArray(knowledgeChunks.knowledgeDocumentId, docIds), eq(knowledgeChunks.chunkActive, true)))
          .groupBy(knowledgeChunks.knowledgeDocumentId),
        // embedding counts per document (Part G: observability)
        db.select({ docId: knowledgeEmbeddings.knowledgeDocumentId, cnt: count() })
          .from(knowledgeEmbeddings)
          .where(and(eq(knowledgeEmbeddings.tenantId, orgId), inArray(knowledgeEmbeddings.knowledgeDocumentId, docIds), eq(knowledgeEmbeddings.embeddingStatus, "completed")))
          .groupBy(knowledgeEmbeddings.knowledgeDocumentId),
      ]);

      const versionMap = Object.fromEntries(versions.map((v) => [v.id, v]));
      const chunkCountMap = Object.fromEntries(chunkCounts.map((c) => [c.docId, Number(c.cnt)]));
      const embeddingCountMap = Object.fromEntries(embeddingCounts.map((c) => [c.docId, Number(c.cnt)]));

      // Group jobs by document — build pipeline status map
      type JobSummary = { jobType: string; status: string; failureReason: string | null; createdAt: Date };
      const jobsByDoc: Record<string, JobSummary[]> = {};
      for (const j of jobs) {
        if (!jobsByDoc[j.knowledgeDocumentId]) jobsByDoc[j.knowledgeDocumentId] = [];
        jobsByDoc[j.knowledgeDocumentId].push({
          jobType: j.jobType,
          status: j.status,
          failureReason: j.failureReason ?? null,
          createdAt: j.createdAt,
        });
      }

      return res.json(assets.map((a) => {
        const ver = a.currentVersionId ? versionMap[a.currentVersionId] : undefined;
        const docJobs = jobsByDoc[a.id] ?? [];
        const latestJob = docJobs[0] ?? null;
        const hasFailed = docJobs.some((j) => j.status === "failed");
        const allDone  = docJobs.length > 0 && docJobs.every((j) => j.status === "completed");

        // Derive processing stage label (Part F)
        let processingStage: string = a.documentStatus;
        if (allDone) processingStage = "indexed";
        else if (hasFailed) processingStage = "failed";
        else if (latestJob?.status === "running") processingStage = "processing";
        else if (docJobs.some((j) => j.status === "queued")) processingStage = "queued";

        return {
          id: a.id,
          title: a.title,
          documentType: a.documentType,
          status: processingStage,
          mimeType: ver?.mimeType ?? null,
          fileSizeBytes: ver?.fileSizeBytes ?? null,
          versionNumber: a.latestVersionNumber,
          chunkCount: chunkCountMap[a.id] ?? 0,
          embeddingCount: embeddingCountMap[a.id] ?? 0,
          pipeline: docJobs.map((j) => ({ jobType: j.jobType, status: j.status, failureReason: j.failureReason })),
          latestJobType: latestJob?.jobType ?? null,
          latestJobStatus: latestJob?.status ?? null,
          parseStatus: ver?.parseStatus ?? null,
          ocrStatus: ver?.ocrStatus ?? null,
          transcriptStatus: ver?.transcriptStatus ?? null,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
        };
      }));
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /api/kb/:id/upload — upload asset to knowledge base (Storage 1.1 hardened)
  app.post("/api/kb/:id/upload", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const userId = getUserId(req);
      const kbId = req.params.id;

      const contentType = req.headers["content-type"] ?? "";
      if (!contentType.includes("multipart/form-data")) {
        return res.status(400).json({ error_code: "INVALID_CONTENT_TYPE", message: "Forventet multipart/form-data" });
      }

      // ── Part E: MIME type whitelist per asset category ────────────────────
      const ALLOWED_MIME: Record<string, string> = {
        // documents
        "application/pdf": "document",
        "application/msword": "document",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
        "text/plain": "document",
        "text/csv": "document",
        "application/vnd.ms-excel": "document",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "document",
        "application/vnd.oasis.opendocument.text": "document",
        "application/rtf": "document",
        "text/html": "document",
        "text/markdown": "document",
        // images
        "image/jpeg": "image",
        "image/png": "image",
        "image/gif": "image",
        "image/webp": "image",
        "image/tiff": "image",
        "image/bmp": "image",
        // video
        "video/mp4": "video",
        "video/quicktime": "video",
        "video/x-msvideo": "video",
        "video/webm": "video",
        "video/mpeg": "video",
      };

      const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

      // Verify knowledge base belongs to tenant
      const { db } = await import("./db");
      const {
        knowledgeBases, knowledgeDocuments, knowledgeDocumentVersions,
        knowledgeProcessingJobs, knowledgeStorageObjects,
      } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const [kb] = await db
        .select({ id: knowledgeBases.id })
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, orgId)));
      if (!kb) return res.status(404).json({ error_code: "NOT_FOUND", message: "Datakilde ikke fundet" });

      const Busboy = (await import("busboy")).default;
      const bb = Busboy({ headers: req.headers as Record<string, string>, limits: { fileSize: MAX_FILE_SIZE } });

      let fileResult: { filename: string; mimeType: string; buffer: Buffer; truncated: boolean } | null = null;

      await new Promise<void>((resolve, reject) => {
        bb.on("file", (_field: string, stream: NodeJS.ReadableStream & { truncated?: boolean }, info: { filename: string; mimeType: string }) => {
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            fileResult = {
              filename: info.filename,
              mimeType: info.mimeType,
              buffer: Buffer.concat(chunks),
              truncated: !!(stream as any).truncated,
            };
          });
          stream.on("error", reject);
        });
        bb.on("finish", resolve);
        bb.on("error", reject);
        req.pipe(bb);
      });

      if (!fileResult) {
        return res.status(400).json({ error_code: "NO_FILE", message: "Ingen fil modtaget" });
      }

      const { filename, mimeType, buffer, truncated } = fileResult;

      // ── Part E: reject files exceeding size limit ─────────────────────────
      if (truncated) {
        return res.status(413).json({ error_code: "FILE_TOO_LARGE", message: `Filen overstiger den maksimale størrelse på ${MAX_FILE_SIZE / 1024 / 1024} MB` });
      }

      // ── Part E: MIME type validation ──────────────────────────────────────
      const documentType: string = ALLOWED_MIME[mimeType] ?? "";
      if (!documentType) {
        return res.status(415).json({
          error_code: "UNSUPPORTED_FILE_TYPE",
          message: `Filtypen "${mimeType}" understøttes ikke. Upload PDF, Word, Excel, billede eller video.`,
        });
      }

      const sizeBytes = buffer.length;

      // ── Part E: idempotency key — prevents duplicate uploads in quick replay ─
      const { createHash } = await import("crypto");
      const idempotencyKey = createHash("sha256")
        .update(`${orgId}:${kbId}:${filename}:${sizeBytes}:${mimeType}`)
        .digest("hex");

      const existingJob = await db
        .select({ id: knowledgeProcessingJobs.id, knowledgeDocumentId: knowledgeProcessingJobs.knowledgeDocumentId })
        .from(knowledgeProcessingJobs)
        .where(eq(knowledgeProcessingJobs.idempotencyKey, idempotencyKey))
        .limit(1);

      if (existingJob[0]) {
        const [existingDoc] = await db.select().from(knowledgeDocuments)
          .where(eq(knowledgeDocuments.id, existingJob[0].knowledgeDocumentId));
        if (existingDoc) {
          return res.status(200).json({
            id: existingDoc.id,
            title: existingDoc.title,
            documentType: existingDoc.documentType,
            status: existingDoc.documentStatus,
            mimeType,
            fileSizeBytes: sizeBytes,
            versionNumber: 1,
            createdAt: existingDoc.createdAt,
            idempotent: true,
          });
        }
      }

      // ── R2 upload ─────────────────────────────────────────────────────────
      const safeFilename = filename.replace(/[^a-zA-Z0-9._\-]/g, "-").slice(0, 200);
      const storageKey = `tenants/${orgId}/uploads/${kbId}/${Date.now()}-${safeFilename}`;
      let r2Uploaded = false;

      const { R2_CONFIGURED, R2_BUCKET, r2Client } = await import("./lib/r2/r2-client");
      if (R2_CONFIGURED) {
        const { PutObjectCommand } = await import("@aws-sdk/client-s3");
        await r2Client.send(new PutObjectCommand({
          Bucket:      R2_BUCKET,
          Key:         storageKey,
          Body:        buffer,
          ContentType: mimeType,
          Metadata:    { tenantId: orgId, kbId, originalFilename: filename },
        }));
        r2Uploaded = true;
        console.log(`[kb-upload] R2 upload OK: ${storageKey} (${sizeBytes} bytes)`);
      } else {
        console.warn("[kb-upload] R2 ikke konfigureret — gemmer kun metadata");
      }

      // ── Part A: inline text extraction for documents ──────────────────────
      let extractedText: string | null = null;
      if (documentType === "document" && mimeType === "application/pdf") {
        try {
          const pdfParse = require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
          const parsed = await pdfParse(buffer);
          extractedText = parsed.text?.trim() || null;
        } catch (pdfErr) {
          console.warn("[kb-upload] pdf-parse fejlede:", (pdfErr as Error).message);
        }
      } else if (documentType === "document" && ["text/plain", "text/csv", "text/html", "text/markdown"].includes(mimeType)) {
        extractedText = buffer.toString("utf-8").trim();
      }

      // ── Create document record ────────────────────────────────────────────
      const [doc] = await db.insert(knowledgeDocuments).values({
        tenantId: orgId,
        knowledgeBaseId: kbId,
        title: filename,
        documentType,
        sourceType: "upload",
        lifecycleState: "active",
        documentStatus: "processing",
        latestVersionNumber: 1,
        createdBy: userId,
        updatedBy: userId,
        metadata: { storageKey, originalFilename: filename } as any,
      }).returning();

      // ── Create version record ─────────────────────────────────────────────
      const [ver] = await db.insert(knowledgeDocumentVersions).values({
        tenantId: orgId,
        knowledgeDocumentId: doc.id,
        versionNumber: 1,
        mimeType,
        fileSizeBytes: sizeBytes,
        isCurrent: true,
        versionStatus: "uploaded",
        sourceLabel: filename,
        uploadedAt: new Date(),
        createdBy: userId,
        // Part F: set type-specific status fields
        parseStatus:       documentType === "document" ? "pending" : null,
        ocrStatus:         documentType === "image"    ? "pending" : null,
        transcriptStatus:  documentType === "video"    ? "pending" : null,
        metadata: {
          storageKey,
          r2Uploaded,
          extractedText: extractedText ? extractedText.slice(0, 500) : null,
        } as any,
      }).returning();

      await db.update(knowledgeDocuments)
        .set({ currentVersionId: ver.id, updatedAt: new Date() })
        .where(eq(knowledgeDocuments.id, doc.id));

      // ── Part B + G: register storage object (traceable to source) ─────────
      await db.insert(knowledgeStorageObjects).values({
        tenantId: orgId,
        knowledgeDocumentVersionId: ver.id,
        storageProvider: r2Uploaded ? "r2" : "local",
        bucketName: r2Uploaded ? R2_BUCKET : null,
        objectKey: storageKey,
        originalFilename: filename,
        mimeType,
        fileSizeBytes: sizeBytes,
        uploadStatus: r2Uploaded ? "uploaded" : "pending",
        uploadedAt: r2Uploaded ? new Date() : null,
        metadata: { kbId, extractedLength: extractedText?.length ?? 0 } as any,
      });

      // ── Part A: enqueue type-specific processing pipeline ─────────────────
      // document: parse → chunk → embed → index
      // image:    ocr_parse → chunk → embed → index  (OCR is placeholder-ready)
      // video:    transcript_parse → chunk → embed → index  (transcript is placeholder)
      const primaryJobType =
        documentType === "video" ? "transcript_parse" :
        documentType === "image" ? "ocr_parse" :
        "parse";

      const pipelineJobs = [
        { jobType: primaryJobType,        priority: 100, payload: { documentType, mimeType, storageKey, stage: "extract" } },
        { jobType: "chunk",               priority: 90,  payload: { documentType, mimeType, storageKey, stage: "chunk", dependsOn: primaryJobType } },
        { jobType: "embedding_generate",  priority: 80,  payload: { documentType, mimeType, storageKey, stage: "embed", dependsOn: "chunk" } },
        { jobType: "index",               priority: 70,  payload: { documentType, mimeType, storageKey, stage: "index", dependsOn: "embedding_generate" } },
      ];

      // For documents where text was already extracted: skip parse step, start with chunk
      const startIdx = (documentType === "document" && extractedText) ? 1 : 0;
      const jobsToEnqueue = pipelineJobs.slice(startIdx);

      for (const j of jobsToEnqueue) {
        await db.insert(knowledgeProcessingJobs).values({
          tenantId: orgId,
          knowledgeDocumentId: doc.id,
          knowledgeDocumentVersionId: ver.id,
          jobType: j.jobType,
          status: "queued",
          priority: j.priority,
          idempotencyKey: j === jobsToEnqueue[0] ? idempotencyKey : null,
          payload: {
            ...j.payload,
            extractedText: j.jobType === "chunk" && extractedText ? extractedText : undefined,
          } as any,
        });
      }

      // ── Part C: inline chunking for small documents with extracted text ────
      // If text was extracted synchronously, create chunks immediately for fast indexing.
      if (extractedText && extractedText.length > 0 && extractedText.length < 50_000) {
        try {
          const { knowledgeChunks } = await import("../shared/schema");
          const CHUNK_SIZE = 1000;
          const OVERLAP = 100;
          const words = extractedText.split(/\s+/).filter(Boolean);
          const chunkTexts: string[] = [];
          for (let i = 0; i < words.length; i += CHUNK_SIZE - OVERLAP) {
            chunkTexts.push(words.slice(i, i + CHUNK_SIZE).join(" "));
            if (i + CHUNK_SIZE >= words.length) break;
          }

          for (let idx = 0; idx < chunkTexts.length; idx++) {
            const text = chunkTexts[idx];
            const chunkKey = `${doc.id}:${idx}`;
            const chunkHash = createHash("sha256").update(text).digest("hex").slice(0, 32);
            await db.insert(knowledgeChunks).values({
              tenantId: orgId,
              knowledgeBaseId: kbId,
              knowledgeDocumentId: doc.id,
              knowledgeDocumentVersionId: ver.id,
              chunkIndex: idx,
              chunkKey,
              chunkText: text,
              chunkHash,
              chunkActive: true,
              tokenEstimate: Math.ceil(text.length / 4),
              chunkStrategy: "word-window",
              chunkVersion: "1.0",
              overlapCharacters: OVERLAP,
            }).onConflictDoNothing();
          }

          // Update doc status to reflect chunks are ready (awaiting embedding)
          await db.update(knowledgeDocuments)
            .set({ documentStatus: "processing", updatedAt: new Date() })
            .where(eq(knowledgeDocuments.id, doc.id));

          console.log(`[kb-upload] ${chunkTexts.length} chunks oprettet for doc ${doc.id}`);
        } catch (chunkErr) {
          console.warn("[kb-upload] Chunking fejlede (ikke kritisk):", (chunkErr as Error).message);
        }
      }

      console.log(`[kb-upload] ${orgId}/${kbId}: "${filename}" (${documentType}, ${sizeBytes} bytes) → pipeline: ${jobsToEnqueue.map((j) => j.jobType).join(" → ")}`);

      return res.status(201).json({
        id: doc.id,
        title: doc.title,
        documentType: doc.documentType,
        status: doc.documentStatus,
        mimeType,
        fileSizeBytes: sizeBytes,
        versionNumber: 1,
        storageKey,
        pipeline: jobsToEnqueue.map((j) => j.jobType),
        chunksCreated: extractedText ? true : false,
        createdAt: doc.createdAt,
      });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // GET /api/kb/:id/experts — list experts linked to knowledge base (with names)
  app.get("/api/kb/:id/experts", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const kbId = req.params.id;
      const { db } = await import("./db");
      const { expertKnowledgeBases, architectureProfiles } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const links = await db
        .select({
          id:              expertKnowledgeBases.id,
          expertId:        expertKnowledgeBases.expertId,
          knowledgeBaseId: expertKnowledgeBases.knowledgeBaseId,
          createdAt:       expertKnowledgeBases.createdAt,
          expertName:      architectureProfiles.name,
          expertSlug:      architectureProfiles.slug,
          expertStatus:    architectureProfiles.status,
        })
        .from(expertKnowledgeBases)
        .leftJoin(architectureProfiles, eq(expertKnowledgeBases.expertId as any, architectureProfiles.id as any))
        .where(and(
          eq(expertKnowledgeBases.knowledgeBaseId, kbId),
          eq(expertKnowledgeBases.tenantId, orgId),
        ));

      return res.json(links.map((l) => ({
        id:              l.id,
        expertId:        l.expertId,
        knowledgeBaseId: l.knowledgeBaseId,
        expertName:      l.expertName ?? l.expertId,
        expertSlug:      l.expertSlug ?? null,
        expertStatus:    l.expertStatus ?? null,
        createdAt:       l.createdAt,
      })));
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /api/kb/:id/experts — link an expert to a knowledge base (Part D)
  app.post("/api/kb/:id/experts", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const userId = getUserId(req);
      const kbId = req.params.id;
      const { expertId } = req.body ?? {};

      if (!expertId || typeof expertId !== "string") {
        return res.status(400).json({ error_code: "MISSING_EXPERT_ID", message: "expertId er påkrævet" });
      }

      const { db } = await import("./db");
      const { expertKnowledgeBases, knowledgeBases } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const [kb] = await db.select({ id: knowledgeBases.id }).from(knowledgeBases)
        .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, orgId)));
      if (!kb) return res.status(404).json({ error_code: "NOT_FOUND", message: "Datakilde ikke fundet" });

      const [link] = await db.insert(expertKnowledgeBases).values({
        tenantId: orgId,
        expertId,
        knowledgeBaseId: kbId,
        createdBy: userId,
      }).onConflictDoNothing().returning();

      if (!link) {
        const [existing] = await db.select().from(expertKnowledgeBases)
          .where(and(
            eq(expertKnowledgeBases.tenantId, orgId),
            eq(expertKnowledgeBases.expertId, expertId),
            eq(expertKnowledgeBases.knowledgeBaseId, kbId),
          ));
        return res.status(200).json({ ...existing, idempotent: true });
      }

      return res.status(201).json(link);
    } catch (err) {
      return handleError(res, err);
    }
  });

  // DELETE /api/kb/:id/experts/:expertId — unlink expert from knowledge base (Part D)
  app.delete("/api/kb/:id/experts/:expertId", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const kbId = req.params.id;
      const expertId = req.params.expertId;
      const { db } = await import("./db");
      const { expertKnowledgeBases } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");

      await db.delete(expertKnowledgeBases).where(and(
        eq(expertKnowledgeBases.tenantId, orgId),
        eq(expertKnowledgeBases.expertId, expertId),
        eq(expertKnowledgeBases.knowledgeBaseId, kbId),
      ));

      return res.status(204).send();
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /api/kb/:id/assets/:assetId/retry — retry/reprocess a failed asset
  app.post("/api/kb/:id/assets/:assetId/retry", async (req: Request, res: Response) => {
    try {
      const orgId    = getOrgId(req);
      const kbId     = req.params.id;
      const assetId  = req.params.assetId;
      const { db }   = await import("./db");
      const { knowledgeDocuments, knowledgeProcessingJobs } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const [doc] = await db
        .select()
        .from(knowledgeDocuments)
        .where(and(
          eq(knowledgeDocuments.id, assetId),
          eq(knowledgeDocuments.knowledgeBaseId, kbId),
          eq(knowledgeDocuments.tenantId, orgId),
        ))
        .limit(1);

      if (!doc) return res.status(404).json({ error_code: "NOT_FOUND", message: "Asset ikke fundet" });

      // Create a new parse job (restarts the pipeline)
      const [job] = await db.insert(knowledgeProcessingJobs).values({
        tenantId:                   orgId,
        knowledgeDocumentId:        assetId,
        knowledgeDocumentVersionId: doc.currentVersionId ?? undefined,
        jobType:                    "parse",
        status:                     "queued",
        priority:                   50,
        payload:                    { retry: true, triggeredBy: "tenant_ui" },
      }).returning();

      // Reset document status so UI reflects "processing" immediately
      await db.update(knowledgeDocuments)
        .set({ documentStatus: "processing", updatedAt: new Date() })
        .where(eq(knowledgeDocuments.id, assetId));

      return res.status(201).json({ jobId: job.id, status: "queued" });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // GET /api/experts/:expertId/sources — list KBs linked to an expert (Part D)
  app.get("/api/experts/:expertId/sources", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const expertId = req.params.expertId;
      const { db } = await import("./db");
      const { expertKnowledgeBases, knowledgeBases } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const links = await db
        .select({
          id:              expertKnowledgeBases.id,
          expertId:        expertKnowledgeBases.expertId,
          knowledgeBaseId: expertKnowledgeBases.knowledgeBaseId,
          createdAt:       expertKnowledgeBases.createdAt,
          kbName:          knowledgeBases.name,
          kbSlug:          knowledgeBases.slug,
        })
        .from(expertKnowledgeBases)
        .innerJoin(knowledgeBases, eq(expertKnowledgeBases.knowledgeBaseId, knowledgeBases.id))
        .where(and(
          eq(expertKnowledgeBases.tenantId, orgId),
          eq(expertKnowledgeBases.expertId, expertId),
        ));

      return res.json(links);
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /api/kb/search — search knowledge chunks (Storage 1.2 Part D+F)
  // Supports expert-aware filtering and real embedding reranking.
  app.post("/api/kb/search", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { queryText, topK, kbIds, expertId, sourceIds } = req.body as {
        queryText?: string;
        topK?: number;
        kbIds?: string[];
        expertId?: string;
        sourceIds?: string[];
      };

      if (!queryText?.trim()) return res.status(400).json({ error: "queryText is required" });

      const { searchKnowledge } = await import("./lib/knowledge/kb-retrieval");
      const results = await searchKnowledge({
        tenantId: orgId,
        queryText: queryText.trim(),
        topK:      Math.min(Number(topK ?? 10), 100),
        kbIds:     kbIds?.length ? kbIds : undefined,
        expertId:  expertId ?? undefined,
        sourceIds: sourceIds?.length ? sourceIds : undefined,
      });

      return res.json({ results, total: results.length });
    } catch (err) {
      return handleError(res, err);
    }
  });

  // GET /api/kb/document-debug?id=<knowledgeDocumentId>
  // Returns partial-readiness + timing metrics for a knowledge document.
  // Phase 5Z.2 observability endpoint.
  app.get("/api/kb/document-debug", async (req: Request, res: Response) => {
    try {
      const orgId      = getOrgId(req);
      const documentId = req.query["id"] as string;
      if (!documentId) {
        return res.status(400).json({ error_code: "MISSING_ID", message: "id query parameter krævet" });
      }

      const { db: dbInst }        = await import("./db");
      const { knowledgeDocuments, knowledgeDocumentVersions } = await import("../shared/schema");
      const { eq, and }           = await import("drizzle-orm");

      // Tenant-scoped document lookup
      const [doc] = await dbInst
        .select()
        .from(knowledgeDocuments)
        .where(
          and(
            eq(knowledgeDocuments.id, documentId),
            eq(knowledgeDocuments.tenantId, orgId),
          ),
        )
        .limit(1);

      if (!doc) {
        return res.status(404).json({ error_code: "NOT_FOUND", message: `Dokument ${documentId} ikke fundet` });
      }

      const versionId = doc.currentVersionId;
      if (!versionId) {
        return res.json({
          documentId,
          documentStatus: doc.documentStatus,
          hasVersion:     false,
          message:        "Ingen aktiv version fundet",
        });
      }

      const [ver] = await dbInst
        .select()
        .from(knowledgeDocumentVersions)
        .where(
          and(
            eq(knowledgeDocumentVersions.id, versionId),
            eq(knowledgeDocumentVersions.tenantId, orgId),
          ),
        )
        .limit(1);

      const { getDocumentAggregation } = await import("./lib/media/segment-aggregator");
      const { evaluateAnswerTiming, WAIT_TIMEOUT_MS } = await import("./lib/media/answer-timing-policy");
      const { checkInstantAnswerEligibility } = await import("./lib/media/instant-answer-readiness");

      const agg         = await getDocumentAggregation({ tenantId: orgId, knowledgeDocumentVersionId: versionId });
      const eligibility = await checkInstantAnswerEligibility({ tenantId: orgId, knowledgeDocumentVersionId: versionId });

      // Compute timing from job data
      const jobs          = agg.jobDetails ?? [];
      const createdAtMs   = ver?.createdAt ? new Date(ver.createdAt as unknown as string).getTime() : null;
      const nowMs         = Date.now();

      const firstCompletedJob = jobs
        .filter((j) => j.status === "completed" && j.completed_at)
        .sort((a, b) => {
          const aMs = a.completed_at instanceof Date ? a.completed_at.getTime() : 0;
          const bMs = b.completed_at instanceof Date ? b.completed_at.getTime() : 0;
          return aMs - bMs;
        })[0];

      const firstSegmentReadyMs  = (createdAtMs && firstCompletedJob?.completed_at)
        ? (firstCompletedJob.completed_at instanceof Date
            ? firstCompletedJob.completed_at.getTime()
            : new Date(firstCompletedJob.completed_at as unknown as string).getTime()) - createdAtMs
        : null;

      const TERMINAL_STATUSES = ["completed", "skipped", "failed", "cancelled"];
      const allJobsTerminal = jobs.length > 0 && jobs.every((j) => TERMINAL_STATUSES.includes(j.status));
      const lastTerminalCompletedAtMs = allJobsTerminal
        ? jobs.reduce((max, j) => {
            if (!j.completed_at) return max;
            const t = j.completed_at instanceof Date
              ? j.completed_at.getTime()
              : new Date(j.completed_at as unknown as string).getTime();
            return t > max ? t : max;
          }, 0)
        : 0;
      // Use actual last completed_at timestamp instead of now() to avoid overstating/blurring
      const allDoneMs = (createdAtMs && lastTerminalCompletedAtMs > 0)
        ? lastTerminalCompletedAtMs - createdAtMs
        : null;

      const timeSinceCreatedMs = createdAtMs ? nowMs - createdAtMs : 0;

      const timingResult = evaluateAnswerTiming({
        coveragePercent:       agg.coveragePercent,
        segmentsReady:         agg.segmentsCompleted,
        segmentsTotal:         agg.segmentsTotal,
        retrievalChunksActive: agg.retrievalChunksActive,
        timeSinceUploadMs:     timeSinceCreatedMs,
        fullCompletionBlocked: agg.fullCompletionBlocked,
      });

      // upload_to_first_partial_answer_ms: time from upload to first retrieval-producing job completing
      const firstRetrievalReadyMs = (createdAtMs && agg.firstRetrievalReadyAt)
        ? new Date(agg.firstRetrievalReadyAt).getTime() - createdAtMs
        : null;

      // retrieval_query_wait_ms: remaining time in the WAIT_TIMEOUT window before forced answer
      const retrievalQueryWaitMs = Math.max(0, WAIT_TIMEOUT_MS - timeSinceCreatedMs);

      return res.json({
        documentId,
        versionId,
        documentStatus:              doc.documentStatus,
        aggregatedDocumentStatus:    agg.documentStatus,
        answerCompleteness:          agg.answerCompleteness,
        coveragePercent:             agg.coveragePercent,
        segmentsTotal:               agg.segmentsTotal,
        segmentsCompleted:           agg.segmentsCompleted,
        segmentsFailed:              agg.segmentsFailed,
        segmentsProcessing:          agg.segmentsProcessing,
        segmentsQueued:              agg.segmentsQueued,
        segmentsDeadLetter:          agg.segmentsDeadLetter,
        hasFailedSegments:           agg.hasFailedSegments,
        hasDeadLetterSegments:       agg.hasDeadLetterSegments,
        fullCompletionBlocked:       agg.fullCompletionBlocked,
        retrievalChunksActive:       agg.retrievalChunksActive,
        firstRetrievalReadyAt:       agg.firstRetrievalReadyAt,
        invariantViolations:         agg.invariantViolations,
        instantAnswerEligibility:    eligibility.eligibility,
        canRefreshForBetterAnswer:   eligibility.canRefreshForBetterAnswer,
        answer_timing_policy_result: {
          decision:        timingResult.decision,
          reason:          timingResult.reason,
          coveragePercent: timingResult.coveragePercent,
        },
        timing: {
          upload_to_first_segment_ready_ms:   firstSegmentReadyMs,
          upload_to_first_retrieval_ready_ms: firstRetrievalReadyMs,
          upload_to_first_partial_answer_ms:  firstRetrievalReadyMs,
          upload_to_full_completion_ms:       allDoneMs,
          time_since_upload_ms:              timeSinceCreatedMs,
          retrieval_query_wait_ms:           retrievalQueryWaitMs,
        },
      });
    } catch (err) {
      console.error("[kb/document-debug] error:", err);
      return res.status(500).json({ error_code: "INTERNAL_ERROR", message: "Debug opslag fejlede" });
    }
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // GET /api/readiness-stream — SSE real-time readiness updates (Phase 5Z.3)
  //
  // Streams document readiness changes to the client as Server-Sent Events.
  // Authenticated, tenant-scoped. Polls DB on 1.5s interval, emits only when
  // state materially changes. Auto-closes after terminal state or max 15 min.
  //
  // Query params:
  //   documentId — ID of the knowledge document to monitor
  //
  // Events:
  //   connected        — initial confirmation (always first)
  //   status_snapshot  — current state (always after connected)
  //   partial_ready    — emitted when first retrieval-ready chunks appear
  //   readiness_progress — emitted on coverage improvements
  //   completed        — document fully processed
  //   failed           — document failed (with retries remaining)
  //   dead_letter      — document permanently failed
  //   blocked          — fullCompletionBlocked=true
  //   keepalive        — heartbeat every 15s for idle connections
  //   error            — error during readiness check
  // ─────────────────────────────────────────────────────────────────────────────
  app.get("/api/readiness-stream", async (req: Request, res: Response) => {
    const orgId      = getOrgId(req);
    const documentId = req.query["documentId"] as string | undefined;

    if (!documentId) {
      res.status(400).json({ error_code: "MISSING_DOCUMENT_ID", message: "documentId query parameter krævet" });
      return;
    }

    // ── SSE headers ────────────────────────────────────────────────────────
    res.setHeader("Content-Type",      "text/event-stream");
    res.setHeader("Cache-Control",     "no-cache");
    res.setHeader("Connection",        "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const sendEvent = (eventType: string, data: object) => {
      try {
        res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        // client disconnected — will be cleaned up by close handler
      }
    };

    // ── Observability counters ─────────────────────────────────────────────
    let streamConnectCount    = 0;
    let streamReconnectCount  = 0;
    let pollCount             = 0;
    let lastTriggerKey: string | null   = null;
    let lastDocumentStatus: string | null = null;
    let lastCoveragePercent   = -1;
    let isTerminated          = false;
    const startedAt           = Date.now();

    // ── Cleanup ────────────────────────────────────────────────────────────
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let keepaliveInterval: ReturnType<typeof setInterval> | null = null;
    const MAX_DURATION_MS  = 15 * 60 * 1000; // 15 min
    const POLL_INTERVAL_MS = 1_500;
    const KEEPALIVE_MS     = 15_000;

    function cleanup() {
      if (isTerminated) return;
      isTerminated = true;
      if (pollInterval)      clearInterval(pollInterval);
      if (keepaliveInterval) clearInterval(keepaliveInterval);
      try { res.end(); } catch { /* already closed */ }
    }

    req.on("close",   cleanup);
    req.on("error",   cleanup);
    res.on("finish",  cleanup);

    // ── Verify document belongs to tenant ──────────────────────────────────
    try {
      const { db: dbInst }          = await import("./db");
      const { knowledgeDocuments }  = await import("../shared/schema");
      const { eq, and }             = await import("drizzle-orm");

      const [doc] = await dbInst
        .select({ id: knowledgeDocuments.id, currentVersionId: knowledgeDocuments.currentVersionId })
        .from(knowledgeDocuments)
        .where(and(
          eq(knowledgeDocuments.id, documentId),
          eq(knowledgeDocuments.tenantId, orgId),
        ))
        .limit(1);

      if (!doc) {
        sendEvent("error", { error_code: "NOT_FOUND", message: `Dokument ${documentId} ikke fundet` });
        cleanup();
        return;
      }

      // ── Confirm connected ────────────────────────────────────────────────
      streamConnectCount++;
      sendEvent("connected", {
        documentId,
        tenantId:         orgId,
        connectedAt:      new Date().toISOString(),
        streamConnectCount,
      });

      // ── Poll function ────────────────────────────────────────────────────
      const poll = async () => {
        if (isTerminated) return;
        if (Date.now() - startedAt > MAX_DURATION_MS) {
          sendEvent("error", { error_code: "TIMEOUT", message: "Stream max duration reached" });
          cleanup();
          return;
        }

        pollCount++;

        try {
          // Re-fetch doc for latest versionId (may have changed)
          const { knowledgeDocuments: kd2 } = await import("../shared/schema");
          const [latestDoc] = await dbInst
            .select({ id: kd2.id, currentVersionId: kd2.currentVersionId, createdAt: kd2.createdAt })
            .from(kd2)
            .where(and(eq(kd2.id, documentId), eq(kd2.tenantId, orgId)))
            .limit(1);

          if (!latestDoc?.currentVersionId) {
            // No version yet — document still initializing
            sendEvent("readiness_progress", {
              documentId,
              documentStatus:    "not_started",
              answerCompleteness: "none",
              isPartial:         false,
              segmentsReady:     0,
              segmentsTotal:     0,
              coveragePercent:   0,
              retrievalChunksActive: 0,
              canAutoStartChat:  false,
              triggerKey:        null,
            });
            return;
          }

          // Aggregate readiness state
          const { getDocumentAggregation } = await import("./lib/media/segment-aggregator");
          const { deriveEligibility }       = await import("./lib/media/instant-answer-readiness");
          const { generateTriggerKey }      = await import("./lib/media/readiness-trigger-key");

          const agg = await getDocumentAggregation({
            tenantId:                    orgId,
            knowledgeDocumentVersionId:  latestDoc.currentVersionId,
          });

          const eligibility = deriveEligibility(agg);
          const triggerResult = generateTriggerKey({
            documentId,
            documentStatus:        agg.documentStatus,
            coveragePercent:       agg.coveragePercent,
            firstRetrievalReadyAt: agg.firstRetrievalReadyAt,
            retrievalChunksActive: agg.retrievalChunksActive,
          });

          const createdAtMs = latestDoc.createdAt
            ? (latestDoc.createdAt instanceof Date
                ? latestDoc.createdAt.getTime()
                : new Date(latestDoc.createdAt as string).getTime())
            : null;
          const nowMs = Date.now();
          const timeToFirstRetrievalReadyMs = (createdAtMs && agg.firstRetrievalReadyAt)
            ? new Date(agg.firstRetrievalReadyAt).getTime() - createdAtMs
            : null;

          const payload = {
            documentId,
            documentStatus:       agg.documentStatus,
            answerCompleteness:   agg.answerCompleteness,
            isPartial:            agg.answerCompleteness === "partial",
            segmentsReady:        agg.segmentsCompleted,
            segmentsTotal:        agg.segmentsTotal,
            coveragePercent:      agg.coveragePercent,
            retrievalChunksActive: agg.retrievalChunksActive,
            hasFailedSegments:    agg.hasFailedSegments,
            hasDeadLetterSegments: agg.hasDeadLetterSegments,
            fullCompletionBlocked: agg.fullCompletionBlocked,
            firstRetrievalReadyAt: agg.firstRetrievalReadyAt,
            timeToFirstRetrievalReadyMs,
            partialWarning:       eligibility.eligibility === "partial_ready"
              ? `Kun ${agg.coveragePercent}% af dokumentet er behandlet endnu.`
              : null,
            canAutoStartChat:     eligibility.eligibility === "partial_ready" || eligibility.eligibility === "fully_ready",
            canRefreshForBetterAnswer: eligibility.canRefreshForBetterAnswer,
            triggerKey:           triggerResult.key,
            triggerKeyDescription: triggerResult.description,
            eligibility:          eligibility.eligibility,
            pollCount,
            timeSinceConnectMs:   nowMs - startedAt,
          };

          const statusChanged   = agg.documentStatus !== lastDocumentStatus;
          const coverageChanged = agg.coveragePercent !== lastCoveragePercent;
          const keyChanged      = triggerResult.key   !== lastTriggerKey;
          const isFirstPoll     = pollCount === 1;

          // ── Determine event type ─────────────────────────────────────────
          let eventType: string;

          if (isFirstPoll) {
            eventType = "status_snapshot";
          } else if (agg.documentStatus === "completed" && statusChanged) {
            eventType = "completed";
          } else if ((agg.documentStatus === "failed" || agg.documentStatus === "retryable_failed") && statusChanged) {
            eventType = "failed";
          } else if (agg.documentStatus === "dead_letter" && statusChanged) {
            eventType = "dead_letter";
          } else if (agg.fullCompletionBlocked && agg.retrievalChunksActive === 0 && statusChanged) {
            eventType = "blocked";
          } else if (
            lastCoveragePercent === 0 && agg.coveragePercent > 0 && agg.retrievalChunksActive > 0
          ) {
            // First retrieval-ready chunks appeared
            eventType = "partial_ready";
          } else if (keyChanged) {
            // Coverage bucket improved
            eventType = "readiness_progress";
          } else {
            // No material change — skip emission (avoids noisy duplicate events)
            return;
          }

          sendEvent(eventType, payload);
          lastTriggerKey     = triggerResult.key;
          lastDocumentStatus = agg.documentStatus;
          lastCoveragePercent = agg.coveragePercent;

          // ── Auto-close on terminal state ─────────────────────────────────
          if (
            agg.documentStatus === "completed" ||
            agg.documentStatus === "dead_letter" ||
            (agg.documentStatus === "failed" && !agg.hasFailedSegments)
          ) {
            // Allow client to receive the event, then close
            setTimeout(() => cleanup(), 3_000);
          }

        } catch (pollErr) {
          console.error("[readiness-stream] poll error:", pollErr);
          sendEvent("error", { error_code: "POLL_ERROR", message: "Intern fejl under readiness-tjek" });
        }
      };

      // ── Start immediately + schedule ───────────────────────────────────
      await poll();
      pollInterval      = setInterval(poll, POLL_INTERVAL_MS);
      keepaliveInterval = setInterval(() => {
        if (!isTerminated) {
          sendEvent("keepalive", { ts: new Date().toISOString(), pollCount });
        }
      }, KEEPALIVE_MS);

    } catch (err) {
      console.error("[readiness-stream] setup error:", err);
      sendEvent("error", { error_code: "INTERNAL_ERROR", message: "Stream opsætning fejlede" });
      cleanup();
    }
  });

  // POST /api/kb/similar — Similar Cases API (Storage 1.5)
  //
  // Modes:
  //   text  — { query, topK?, kbId?, kbIds?, expertId?, minScore? }
  //   asset — { assetId, topK?, kbId?, kbIds?, expertId?, minScore? }
  //   chunk — { chunkId, topK?, kbId?, kbIds?, expertId?, minScore? }
  //
  // Response:
  //   { cases: SimilarCase[], total, debug }
  //   Each SimilarCase includes: snippet, score, sourceLabel, assetTitle,
  //   assetType, kbName, mimeType, fileName, chunkId, assetId, kbId,
  //   pageNumber, timestampSec, whyMatched, retrievalChannel
  app.post("/api/kb/similar", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);

      const {
        query, assetId, chunkId,
        topK, kbId, kbIds, expertId, minScore,
      } = req.body as {
        query?:     string;
        assetId?:   string;
        chunkId?:   string;
        topK?:      number;
        kbId?:      string;
        kbIds?:     string[];
        expertId?:  string;
        minScore?:  number;
      };

      // Determine mode from input
      let mode: "text" | "asset" | "chunk";
      if (assetId?.trim()) {
        mode = "asset";
      } else if (chunkId?.trim()) {
        mode = "chunk";
      } else if (query?.trim()) {
        mode = "text";
      } else {
        return res.status(400).json({
          error: "Provide one of: query (text mode), assetId (asset mode), or chunkId (chunk mode)",
        });
      }

      const { findSimilarCases } = await import("./lib/knowledge/kb-similar");
      const result = await findSimilarCases({
        tenantId:  orgId,
        mode,
        queryText: query?.trim(),
        assetId:   assetId?.trim(),
        chunkId:   chunkId?.trim(),
        kbId:      kbId?.trim(),
        kbIds:     kbIds?.length ? kbIds : undefined,
        expertId:  expertId?.trim(),
        topK:      topK ? Math.min(Number(topK), 50) : undefined,
        minScore:  minScore !== undefined ? Number(minScore) : undefined,
      });

      return res.json(result);
    } catch (err) {
      return handleError(res, err);
    }
  });

  // ── GET /api/usage/summary — dev parity (Vercel: api/usage.js) ──────────────
  app.get("/api/usage/summary", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { checkBudget } = await import("./lib/ai/budget-guard");
      const { getCurrentAiUsageForPeriod } = await import("./lib/ai/guards");
      const { getCurrentPeriod } = await import("./lib/ai/usage-periods");
      const { db: database } = await import("./db");
      const { aiUsage: aiUsageTable } = await import("../shared/schema");
      const { eq, and, gte, lt, count: drmCount } = await import("drizzle-orm");
      const { periodStart, periodEnd } = getCurrentPeriod();
      const [budgetResult, currentCostUsd] = await Promise.all([
        checkBudget(orgId),
        getCurrentAiUsageForPeriod(orgId),
      ]);
      const countRows = await database
        .select({ cnt: drmCount() })
        .from(aiUsageTable)
        .where(and(eq(aiUsageTable.tenantId, orgId), gte(aiUsageTable.createdAt, periodStart), lt(aiUsageTable.createdAt, periodEnd)));
      const requestCount = Number(countRows[0]?.cnt ?? 0);
      const budgetUsd   = budgetResult.budgetUsd;
      const remainingUsd = budgetUsd !== null ? Math.max(0, budgetUsd - currentCostUsd) : null;
      return res.json({
        tenantId: orgId,
        period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
        usedUsd: parseFloat(currentCostUsd.toFixed(6)),
        budgetUsd, remainingUsd,
        usagePercent:     budgetResult.usagePercent,
        requestCount,
        usageState:       budgetResult.usageState,
        isSoftExceeded:   budgetResult.isSoftExceeded,
        isHardExceeded:   budgetResult.isHardExceeded,
        softLimitPercent: budgetResult.softLimitPercent,
        hardLimitPercent: budgetResult.hardLimitPercent,
        retrievedAt:      new Date().toISOString(),
      });
    } catch (err) { return handleError(res, err); }
  });

  // ── GET /api/usage/history — dev parity ────────────────────────────────────
  app.get("/api/usage/history", async (req: Request, res: Response) => {
    try {
      const orgId  = getOrgId(req);
      const limit  = Math.min(parseInt(String(req.query.limit ?? "50"), 10), 200);
      const cursor = req.query.cursor ? String(req.query.cursor) : null;
      const period = String(req.query.period ?? "30d");
      const days   = period === "7d" ? 7 : period === "90d" ? 90 : 30;
      const since  = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const { db: database } = await import("./db");
      const { aiUsage: aiUsageTable } = await import("../shared/schema");
      const { eq, and, gte, lt, desc } = await import("drizzle-orm");
      const conditions: ReturnType<typeof eq>[] = [
        eq(aiUsageTable.tenantId, orgId),
        gte(aiUsageTable.createdAt, since),
      ];
      if (cursor) conditions.push(lt(aiUsageTable.createdAt, new Date(cursor)));
      const rows = await database
        .select({
          id: aiUsageTable.id, feature: aiUsageTable.feature, model: aiUsageTable.model,
          provider: aiUsageTable.provider, promptTokens: aiUsageTable.promptTokens,
          completionTokens: aiUsageTable.completionTokens, totalTokens: aiUsageTable.totalTokens,
          estimatedCostUsd: aiUsageTable.estimatedCostUsd, status: aiUsageTable.status,
          latencyMs: aiUsageTable.latencyMs, createdAt: aiUsageTable.createdAt,
        })
        .from(aiUsageTable)
        .where(and(...conditions))
        .orderBy(desc(aiUsageTable.createdAt))
        .limit(limit + 1);
      const hasMore    = rows.length > limit;
      const page       = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? (page[page.length - 1]?.createdAt?.toISOString() ?? null) : null;
      return res.json({ tenantId: orgId, period, events: page, nextCursor, hasMore, retrievedAt: new Date().toISOString() });
    } catch (err) { return handleError(res, err); }
  });

  // ── POST /api/budget/update — dev parity ───────────────────────────────────
  app.post("/api/budget/update", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const body = req.body as {
        monthlyBudgetUsd?: number;
        warningThresholdPercent?: number;
        hardLimitPercent?: number;
        hardStopEnabled?: boolean;
        budgetModeEnabled?: boolean;
      };
      const { db: database } = await import("./db");
      const { aiUsageLimits: aiUsageLimitsTable } = await import("../shared/schema");
      const { eq } = await import("drizzle-orm");
      const updates: Record<string, unknown> = {};
      if (body.monthlyBudgetUsd !== undefined)        updates.monthlyAiBudgetUsd      = String(body.monthlyBudgetUsd);
      if (body.warningThresholdPercent !== undefined)  updates.warningThresholdPercent = body.warningThresholdPercent;
      if (body.hardLimitPercent !== undefined)         updates.hardLimitPercent        = body.hardLimitPercent;
      if (body.hardStopEnabled !== undefined)          updates.hardStopEnabled         = body.hardStopEnabled;
      if (body.budgetModeEnabled !== undefined)        updates.budgetModeEnabled       = body.budgetModeEnabled;
      if (Object.keys(updates).length === 0) return res.status(400).json({ error: "Ingen felter at opdatere" });
      const existing = await database.select({ id: aiUsageLimitsTable.id }).from(aiUsageLimitsTable).where(eq(aiUsageLimitsTable.tenantId, orgId)).limit(1);
      let result;
      if (existing.length > 0) {
        const rows = await database.update(aiUsageLimitsTable).set({ ...updates, updatedAt: new Date() } as any).where(eq(aiUsageLimitsTable.tenantId, orgId)).returning();
        result = rows[0];
      } else {
        const rows = await database.insert(aiUsageLimitsTable).values({ tenantId: orgId, ...updates } as any).returning();
        result = rows[0];
      }
      return res.json({ tenantId: orgId, budget: result, updatedAt: new Date().toISOString() });
    } catch (err) { return handleError(res, err); }
  });

  return httpServer;
}

type AiRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
