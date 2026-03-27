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

  // ─── AI Chat ──────────────────────────────────────────────────────────────────

  app.post("/api/chat", async (req: Request, res: Response) => {
    try {
      const documentContextSchema = z.object({
        filename:       z.string(),
        mime_type:      z.string(),
        char_count:     z.number(),
        extracted_text: z.string(),
        status:         z.enum(["ok", "unsupported", "error"]),
        message:        z.string().optional(),
      });

      const body = z.object({
        message:          z.string().min(1, "Besked er påkrævet").max(4000),
        conversation_id:  z.string().optional().nullable(),
        document_context: z.array(documentContextSchema).optional().default([]),
        context: z.object({
          document_ids:        z.array(z.string()).optional().default([]),
          preferred_expert_id: z.string().optional().nullable(),
        }).optional().default({}),
      }).parse(req.body);

      const orgId  = getOrgId(req);
      const userId = getUserId(req);

      const {
        listAccessibleExpertsForUser,
        scoreExpertsForMessage,
        selectBestExpert,
        verifyExpertAccess,
      } = await import("./services/chat-routing");

      // 1. List all experts this user can access
      const accessible = await listAccessibleExpertsForUser({ organizationId: orgId });

      if (accessible.length === 0) {
        return res.status(422).json({
          error_code: "NO_EXPERTS_AVAILABLE",
          message: "Ingen AI-eksperter er tilgængelige for din organisation.",
        });
      }

      // 2. Verify preferred expert hint (client hint — never trusted blindly)
      let selectedExpert = null;
      const hint = body.context?.preferred_expert_id;
      if (hint) {
        selectedExpert = await verifyExpertAccess({ expertId: hint, organizationId: orgId });
      }

      // 3. Score and route if no verified hint
      let routingExplanation = "Ekspert valgt via brugerpræference.";
      if (!selectedExpert) {
        const scored = scoreExpertsForMessage(accessible, body.message);
        const routing = selectBestExpert(scored);
        if (!routing) {
          return res.status(422).json({
            error_code: "NO_RELEVANT_EXPERT",
            message: "Ingen relevant ekspert fundet til din forespørgsel.",
          });
        }
        selectedExpert = routing.expert;
        routingExplanation = routing.explanation;
      }

      // 4. Execute via chat-runner (reuses existing orchestration)
      const { runChatMessage } = await import("./services/chat-runner");

      const result = await runChatMessage({
        message:         body.message,
        expert:          selectedExpert,
        organizationId:  orgId,
        userId,
        conversationId:  body.conversation_id ?? null,
        routingExplanation,
        documentContext: body.document_context ?? [],
      });

      return res.json({
        answer:          result.answer,
        conversation_id: result.conversationId,
        expert: {
          id:       result.expert.id,
          name:     result.expert.name,
          category: result.expert.category,
        },
        used_sources:       result.usedSources,
        used_rules:         result.usedRules,
        warnings:           result.warnings,
        latency_ms:         result.latencyMs,
        confidence_band:    result.confidenceBand,
        needs_manual_review: result.needsManualReview,
        routing_explanation: result.routingExplanation,
      });
    } catch (err) { handleError(res, err); }
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
  app.get("/api/kb", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { db } = await import("./db");
      const { knowledgeBases, knowledgeDocuments } = await import("../shared/schema");
      const { eq, and, count, desc } = await import("drizzle-orm");

      const bases = await db
        .select()
        .from(knowledgeBases)
        .where(and(
          eq(knowledgeBases.tenantId, orgId),
          eq(knowledgeBases.lifecycleState, "active"),
        ))
        .orderBy(desc(knowledgeBases.createdAt));

      // Get asset counts per base
      const counts = await db
        .select({ knowledgeBaseId: knowledgeDocuments.knowledgeBaseId, cnt: count() })
        .from(knowledgeDocuments)
        .where(and(
          eq(knowledgeDocuments.tenantId, orgId),
          eq(knowledgeDocuments.lifecycleState, "active"),
        ))
        .groupBy(knowledgeDocuments.knowledgeBaseId);

      const countMap = Object.fromEntries(counts.map((c) => [c.knowledgeBaseId, Number(c.cnt)]));

      return res.json(bases.map((b) => ({
        id: b.id,
        name: b.name,
        slug: b.slug,
        description: b.description,
        status: b.lifecycleState,
        assetCount: countMap[b.id] ?? 0,
        createdAt: b.createdAt,
        updatedAt: b.updatedAt,
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

  // GET /api/kb/:id/assets — list assets in a knowledge base
  app.get("/api/kb/:id/assets", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const { db } = await import("./db");
      const { knowledgeDocuments, knowledgeDocumentVersions } = await import("../shared/schema");
      const { eq, and, desc } = await import("drizzle-orm");

      const assets = await db
        .select()
        .from(knowledgeDocuments)
        .where(and(
          eq(knowledgeDocuments.knowledgeBaseId, req.params.id),
          eq(knowledgeDocuments.tenantId, orgId),
          eq(knowledgeDocuments.lifecycleState, "active"),
        ))
        .orderBy(desc(knowledgeDocuments.createdAt));

      // Fetch current versions for file size info
      const versionIds = assets.map((a) => a.currentVersionId).filter(Boolean) as string[];
      let versionMap: Record<string, typeof knowledgeDocumentVersions.$inferSelect> = {};
      if (versionIds.length > 0) {
        const { inArray } = await import("drizzle-orm");
        const versions = await db
          .select()
          .from(knowledgeDocumentVersions)
          .where(inArray(knowledgeDocumentVersions.id, versionIds));
        versionMap = Object.fromEntries(versions.map((v) => [v.id, v]));
      }

      return res.json(assets.map((a) => {
        const ver = a.currentVersionId ? versionMap[a.currentVersionId] : undefined;
        return {
          id: a.id,
          title: a.title,
          documentType: a.documentType,
          status: a.documentStatus,
          mimeType: ver?.mimeType ?? null,
          fileSizeBytes: ver?.fileSizeBytes ?? null,
          versionNumber: a.latestVersionNumber,
          createdAt: a.createdAt,
          updatedAt: a.updatedAt,
        };
      }));
    } catch (err) {
      return handleError(res, err);
    }
  });

  // POST /api/kb/:id/upload — upload asset to knowledge base
  app.post("/api/kb/:id/upload", async (req: Request, res: Response) => {
    try {
      const orgId = getOrgId(req);
      const userId = getUserId(req);
      const kbId = req.params.id;

      const contentType = req.headers["content-type"] ?? "";
      if (!contentType.includes("multipart/form-data")) {
        return res.status(400).json({ error_code: "INVALID_CONTENT_TYPE", message: "Forventet multipart/form-data" });
      }

      // Verify knowledge base belongs to tenant
      const { db } = await import("./db");
      const { knowledgeBases, knowledgeDocuments, knowledgeDocumentVersions, knowledgeProcessingJobs } = await import("../shared/schema");
      const { eq, and } = await import("drizzle-orm");

      const [kb] = await db
        .select({ id: knowledgeBases.id })
        .from(knowledgeBases)
        .where(and(eq(knowledgeBases.id, kbId), eq(knowledgeBases.tenantId, orgId)));
      if (!kb) return res.status(404).json({ error_code: "NOT_FOUND", message: "Datakilde ikke fundet" });

      const Busboy = (await import("busboy")).default;
      const bb = Busboy({ headers: req.headers as Record<string, string>, limits: { fileSize: 100 * 1024 * 1024 } });

      let fileResult: { filename: string; mimeType: string; sizeBytes: number } | null = null;

      await new Promise<void>((resolve, reject) => {
        bb.on("file", (_field: string, stream: NodeJS.ReadableStream, info: { filename: string; mimeType: string }) => {
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => {
            const buf = Buffer.concat(chunks);
            fileResult = { filename: info.filename, mimeType: info.mimeType, sizeBytes: buf.length };
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

      const { filename, mimeType, sizeBytes } = fileResult;

      // Determine asset type from mime type
      let documentType = "other";
      if (mimeType.startsWith("image/")) documentType = "image";
      else if (mimeType.startsWith("video/")) documentType = "video";
      else if (["application/pdf", "application/msword", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain", "text/csv", "application/vnd.ms-excel", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"].includes(mimeType)) documentType = "document";

      // Determine job type based on document type
      const jobType = documentType === "video" ? "transcript_parse" : documentType === "image" ? "ocr_parse" : "parse";

      // Storage key placeholder (no R2 configured)
      const storageKey = `${orgId}/${kbId}/${Date.now()}-${filename}`;

      // Create document
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

      // Create version
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
        metadata: { storageKey } as any,
      }).returning();

      // Update document with current version id
      await db.update(knowledgeDocuments)
        .set({ currentVersionId: ver.id, updatedAt: new Date() })
        .where(eq(knowledgeDocuments.id, doc.id));

      // Enqueue processing job
      await db.insert(knowledgeProcessingJobs).values({
        tenantId: orgId,
        knowledgeDocumentId: doc.id,
        knowledgeDocumentVersionId: ver.id,
        jobType,
        status: "queued",
        priority: 100,
        payload: { documentType, mimeType, storageKey } as any,
      });

      console.log(`[kb-upload] ${orgId}/${kbId}: ${filename} (${documentType}, ${sizeBytes} bytes)`);

      return res.status(201).json({
        id: doc.id,
        title: doc.title,
        documentType: doc.documentType,
        status: doc.documentStatus,
        mimeType,
        fileSizeBytes: sizeBytes,
        versionNumber: 1,
        createdAt: doc.createdAt,
      });
    } catch (err) {
      return handleError(res, err);
    }
  });

  return httpServer;
}

type AiRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
