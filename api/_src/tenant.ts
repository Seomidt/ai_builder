/**
 * api/_src/tenant.ts — Vercel Serverless Handler for /api/tenant/*
 *
 * Routes:
 *   GET    /api/tenant/org
 *   GET    /api/tenant/settings
 *   PATCH  /api/tenant/settings
 *   GET    /api/tenant/locale
 *   GET    /api/tenant/dashboard
 *   GET    /api/tenant/usage
 *   GET    /api/tenant/billing
 *   GET    /api/tenant/ai/runs
 *   GET    /api/tenant/team
 *   POST   /api/tenant/team/invite
 *   GET    /api/tenant/departments
 *   POST   /api/tenant/departments
 *   DELETE /api/tenant/departments/:id
 *   GET    /api/tenant/permissions/:userId
 *   PUT    /api/tenant/permissions/:userId
 *   GET    /api/tenant/audit
 */

import "../../server/lib/env.ts";
import { z } from "zod";
import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth.ts";

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function jsonOut(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(payload);
}

function ok(res: ServerResponse, body: unknown, status = 200): void { jsonOut(res, status, body); }
function notFound(res: ServerResponse, msg = "Ikke fundet"): void { jsonOut(res, 404, { error_code: "NOT_FOUND", message: msg }); }
function badRequest(res: ServerResponse, msg: string): void { jsonOut(res, 400, { error_code: "BAD_REQUEST", message: msg }); }

function handleErr(res: ServerResponse, err: unknown, label = "tenant"): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[vercel/${label}]`, msg);
  if (!res.headersSent) jsonOut(res, 500, { error_code: "INTERNAL_ERROR", message: msg });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("Invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function getQuery(url: string): URLSearchParams {
  return new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
}

async function getDb() {
  const { db } = await import("../../server/db");
  return db;
}

// ── Route handlers ────────────────────────────────────────────────────────────

async function getOrg(orgId: string, token: string, res: ServerResponse) {
  try {
    const SUPABASE_URL     = process.env.SUPABASE_URL ?? "";
    const SUPABASE_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
    const headers = { "Authorization": `Bearer ${SUPABASE_SERVICE || token}`, "apikey": SUPABASE_SERVICE || token };
    const r = await fetch(`${SUPABASE_URL}/rest/v1/organizations?id=eq.${orgId}&limit=1`, { headers });
    const rows = await r.json() as unknown[];
    ok(res, rows[0] ?? { id: orgId, name: "BlissOps" });
  } catch (err) { handleErr(res, err, "tenant/org"); }
}

async function getSettings(orgId: string, res: ServerResponse) {
  try {
    const { getTenantLocale } = await import("../../server/lib/i18n/locale-service");
    const locale = await getTenantLocale(orgId) as any;
    ok(res, {
      tenant: {
        defaultLanguage:  locale?.language  ?? "en",
        defaultLocale:    locale?.locale    ?? "en-US",
        currency:         locale?.currency  ?? "USD",
        timezone:         locale?.timezone  ?? "UTC",
        aiModel:          "gpt-4o",
        maxTokensPerRun:  100_000,
      },
      updatedAt: new Date().toISOString(),
    });
  } catch (err) { handleErr(res, err, "tenant/settings"); }
}

async function patchSettings(orgId: string, body: unknown, res: ServerResponse) {
  try {
    const {
      updateTenantLocale, isValidLanguage, isValidLocale, isValidCurrency, isValidTimezone,
    } = await import("../../server/lib/i18n/locale-service");

    const data = body as Record<string, unknown>;
    const update: Record<string, string> = {};
    const errors: string[] = [];

    if (data.language !== undefined) {
      if (!isValidLanguage(data.language as string)) errors.push("Invalid language code");
      else update.language = data.language as string;
    }
    if (data.locale !== undefined) {
      if (!isValidLocale(data.locale as string)) errors.push("Invalid locale (must be BCP-47, e.g. 'da-DK')");
      else update.locale = data.locale as string;
    }
    if (data.currency !== undefined) {
      if (!isValidCurrency(data.currency as string)) errors.push("Invalid currency (ISO 4217, e.g. 'DKK')");
      else update.currency = data.currency as string;
    }
    if (data.timezone !== undefined) {
      if (!isValidTimezone(data.timezone as string)) errors.push("Invalid timezone (IANA, e.g. 'Europe/Copenhagen')");
      else update.timezone = data.timezone as string;
    }

    if (errors.length > 0) return jsonOut(res, 400, { error_code: "VALIDATION_ERROR", message: errors.join("; "), errors });
    if (Object.keys(update).length === 0) return badRequest(res, "No valid locale fields provided");

    await updateTenantLocale(orgId, update);
    ok(res, { ok: true, updated: update });
  } catch (err) { handleErr(res, err, "tenant/settings/patch"); }
}

async function getLocale(orgId: string, res: ServerResponse) {
  try {
    const { getTenantLocale } = await import("../../server/lib/i18n/locale-service");
    const locale = await getTenantLocale(orgId);
    ok(res, locale);
  } catch (err) { handleErr(res, err, "tenant/locale"); }
}

async function getDashboard(orgId: string, res: ServerResponse) {
  try {
    const db = await getDb();
    const { projects, aiRuns, integrations } = await import("../../shared/schema");
    const { eq } = await import("drizzle-orm");

    const [allProjects, allRuns, allIntegrations] = await Promise.all([
      db.select().from(projects).where(eq(projects.organizationId, orgId)),
      db.select().from(aiRuns).where(eq(aiRuns.organizationId, orgId)),
      db.select().from(integrations).where(eq(integrations.organizationId, orgId)),
    ]);

    ok(res, {
      metrics: {
        totalProjects:      allProjects.length,
        activeRuns:         allRuns.filter((r) => r.status === "running").length,
        failedRuns:         allRuns.filter((r) => r.status === "failed").length,
        activeIntegrations: allIntegrations.filter((i) => i.status === "active").length,
        totalRuns:          allRuns.length,
      },
      recentRuns: allRuns.slice(0, 5).map((r) => ({
        id: r.id, status: r.status, projectId: r.projectId, createdAt: r.createdAt,
      })),
      integrationHealth: allIntegrations.slice(0, 6).map((i) => ({
        id: i.id, provider: i.provider, status: i.status,
      })),
      retrievedAt: new Date().toISOString(),
    });
  } catch (err) { handleErr(res, err, "tenant/dashboard"); }
}

async function getAiRuns(orgId: string, url: string, res: ServerResponse) {
  try {
    const qs     = getQuery(url);
    const status = qs.get("status") ?? undefined;
    const limit  = Math.min(parseInt(qs.get("limit") ?? "20", 10), 100);
    const cursor = qs.get("cursor") ?? undefined;

    const db = await getDb();
    const { aiRuns } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");

    const conditions: any[] = [eq(aiRuns.organizationId, orgId)];
    if (status && status !== "all") conditions.push(eq(aiRuns.status, status as any));

    const allRuns = await db.select().from(aiRuns).where(and(...conditions));
    let startIdx = 0;
    if (cursor) {
      const idx = allRuns.findIndex((r) => r.id === cursor);
      if (idx !== -1) startIdx = idx + 1;
    }
    const page       = allRuns.slice(startIdx, startIdx + limit);
    const nextCursor = page.length === limit && startIdx + limit < allRuns.length
      ? page[page.length - 1].id
      : null;

    ok(res, { runs: page, nextCursor, total: allRuns.length });
  } catch (err) { handleErr(res, err, "tenant/ai/runs"); }
}

async function getUsage(orgId: string, url: string, res: ServerResponse) {
  try {
    const qs     = getQuery(url);
    const period = qs.get("period") ?? "30d";
    const days   = period === "7d" ? 7 : period === "90d" ? 90 : 30;
    const since  = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const { getLatestSnapshot } = await import("../../server/lib/ai-governance/usage-snapshotter");
    const snapshot = await getLatestSnapshot(orgId, "monthly");

    const db = await getDb();
    const { aiRuns } = await import("../../shared/schema");
    const { eq } = await import("drizzle-orm");
    const allRuns = await db.select().from(aiRuns).where(eq(aiRuns.organizationId, orgId));
    const filtered = allRuns.filter((r) => new Date(r.createdAt) >= since);

    const byDay: Record<string, { day: string; requests: number; costUsd: number }> = {};
    for (const run of filtered) {
      const day = new Date(run.createdAt).toISOString().slice(0, 10);
      if (!byDay[day]) byDay[day] = { day, requests: 0, costUsd: 0 };
      byDay[day].requests++;
    }

    ok(res, {
      tenantId: orgId, period,
      summary: {
        tokensIn:    snapshot ? Number((snapshot as any).promptTokens)     : 0,
        tokensOut:   snapshot ? Number((snapshot as any).completionTokens) : 0,
        costUsd:     snapshot ? Number((snapshot as any).totalCostUsdCents) / 100 : 0,
        requests:    snapshot ? (snapshot as any).requestCount             : filtered.length,
        modelsUsed:  snapshot ? Object.keys((snapshot as any).modelBreakdown ?? {}).length : 0,
      },
      daily: Object.values(byDay).sort((a, b) => a.day.localeCompare(b.day)),
      retrievedAt: new Date().toISOString(),
    });
  } catch (err) { handleErr(res, err, "tenant/usage"); }
}

async function getBilling(orgId: string, res: ServerResponse) {
  try {
    const { checkTenantBudget } = await import("../../server/lib/ai-governance/budget-checker");
    const result = await checkTenantBudget(orgId, "monthly");

    if (!result) {
      return ok(res, { tenantId: orgId, budget: null, currentMonthSpendUsd: 0, utilizationPercent: 0, retrievedAt: new Date().toISOString() });
    }

    ok(res, {
      tenantId: orgId,
      budget: {
        monthlyBudgetUsd: Number((result as any).budgetUsdCents) / 100,
        dailyBudgetUsd:   null,
        softLimitPercent: (result as any).warningThresholdPct,
        hardLimitPercent: (result as any).hardLimitPct,
        updatedAt:        new Date().toISOString(),
      },
      currentMonthSpendUsd: Number((result as any).currentUsageUsdCents) / 100,
      utilizationPercent:   Math.round((result as any).utilizationPct),
      retrievedAt:          new Date().toISOString(),
    });
  } catch (err) { handleErr(res, err, "tenant/billing"); }
}

async function getTeam(orgId: string, url: string, res: ServerResponse) {
  try {
    const qs     = getQuery(url);
    const limit  = Math.min(parseInt(qs.get("limit") ?? "20", 10), 100);
    const cursor = qs.get("cursor") ?? undefined;

    const db = await getDb();
    const { organizationMembers } = await import("../../shared/schema");
    const { eq, gt, and } = await import("drizzle-orm");

    const conditions: any[] = [eq(organizationMembers.organizationId, orgId)];
    if (cursor) conditions.push(gt(organizationMembers.id, cursor));

    const rows = await db.select().from(organizationMembers)
      .where(and(...conditions))
      .limit(limit + 1);

    const hasMore    = rows.length > limit;
    const members    = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore ? members[members.length - 1].id : null;

    ok(res, { members, pagination: { hasMore, nextCursor, limit }, retrievedAt: new Date().toISOString() });
  } catch (err) { handleErr(res, err, "tenant/team"); }
}

async function inviteTeamMember(orgId: string, body: unknown, res: ServerResponse) {
  try {
    const { email, role } = body as { email?: string; role?: string };
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return jsonOut(res, 400, { error_code: "INVALID_EMAIL", message: "A valid email is required" });
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
    if (error) return jsonOut(res, 400, { error_code: "INVITE_FAILED", message: error.message });
    ok(res, { ok: true, email, role: memberRole });
  } catch (err) { handleErr(res, err, "tenant/team/invite"); }
}

async function listDepartments(orgId: string, res: ServerResponse) {
  try {
    const db = await getDb();
    const { tenantDepartments } = await import("../../shared/schema");
    const { eq, asc } = await import("drizzle-orm");
    const rows = await db.select().from(tenantDepartments)
      .where(eq(tenantDepartments.tenantId, orgId))
      .orderBy(asc(tenantDepartments.name));
    ok(res, { departments: rows });
  } catch (err) { handleErr(res, err, "tenant/departments/list"); }
}

async function createDepartment(orgId: string, body: unknown, res: ServerResponse) {
  try {
    const schema = z.object({
      name:        z.string().min(1).max(120),
      slug:        z.string().min(1).max(80).regex(/^[a-z0-9-]+$/),
      description: z.string().max(500).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return jsonOut(res, 422, { error_code: "VALIDATION_ERROR", message: "Invalid department data", details: parsed.error.issues });

    const { name, slug, description } = parsed.data;
    const db = await getDb();
    const { tenantDepartments } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");

    const existing = await db.select({ id: tenantDepartments.id }).from(tenantDepartments)
      .where(and(eq(tenantDepartments.tenantId, orgId), eq(tenantDepartments.slug, slug))).limit(1);
    if (existing.length > 0) return jsonOut(res, 409, { error_code: "SLUG_CONFLICT", message: "Department with this slug already exists" });

    const [row] = await db.insert(tenantDepartments)
      .values({ tenantId: orgId, name, slug, description: description ?? null })
      .returning();
    ok(res, { department: row }, 201);
  } catch (err) { handleErr(res, err, "tenant/departments/create"); }
}

async function deleteDepartment(orgId: string, deptId: string, res: ServerResponse) {
  try {
    const db = await getDb();
    const { tenantDepartments } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    await db.delete(tenantDepartments).where(and(eq(tenantDepartments.id, deptId), eq(tenantDepartments.tenantId, orgId)));
    ok(res, { ok: true });
  } catch (err) { handleErr(res, err, "tenant/departments/delete"); }
}

async function getPermissions(orgId: string, userId: string, res: ServerResponse) {
  try {
    const db = await getDb();
    const { tenantMemberPermissions } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");
    const rows = await db.select().from(tenantMemberPermissions)
      .where(and(eq(tenantMemberPermissions.tenantId, orgId), eq(tenantMemberPermissions.userId, userId)))
      .limit(1);

    if (rows.length === 0) {
      return ok(res, {
        tenantId: orgId, userId, tenantRole: "member",
        canAccessAllDepartments: false, allowedDepartmentIds: [],
        allowedSectionKeys: [], canAccessAllExperts: true, allowedExpertIds: [],
      });
    }
    ok(res, rows[0]);
  } catch (err) { handleErr(res, err, "tenant/permissions/get"); }
}

async function upsertPermissions(orgId: string, userId: string, body: unknown, res: ServerResponse) {
  try {
    const schema = z.object({
      tenantRole:              z.string().optional(),
      canAccessAllDepartments: z.boolean().optional(),
      allowedDepartmentIds:    z.array(z.string()).optional(),
      allowedSectionKeys:      z.array(z.string()).optional(),
      canAccessAllExperts:     z.boolean().optional(),
      allowedExpertIds:        z.array(z.string()).optional(),
    });
    const parsed = schema.safeParse(body);
    if (!parsed.success) return jsonOut(res, 422, { error_code: "VALIDATION_ERROR", message: "Invalid permission data" });

    const db = await getDb();
    const { tenantMemberPermissions } = await import("../../shared/schema");
    const { eq, and } = await import("drizzle-orm");

    const existing = await db.select({ id: tenantMemberPermissions.id }).from(tenantMemberPermissions)
      .where(and(eq(tenantMemberPermissions.tenantId, orgId), eq(tenantMemberPermissions.userId, userId)))
      .limit(1);

    let row;
    if (existing.length === 0) {
      [row] = await db.insert(tenantMemberPermissions).values({
        tenantId: orgId, userId,
        tenantRole:              parsed.data.tenantRole              ?? "member",
        canAccessAllDepartments: parsed.data.canAccessAllDepartments ?? false,
        allowedDepartmentIds:    parsed.data.allowedDepartmentIds    ?? [],
        allowedSectionKeys:      parsed.data.allowedSectionKeys      ?? [],
        canAccessAllExperts:     parsed.data.canAccessAllExperts     ?? true,
        allowedExpertIds:        parsed.data.allowedExpertIds        ?? [],
      }).returning();
    } else {
      [row] = await db.update(tenantMemberPermissions)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(and(eq(tenantMemberPermissions.tenantId, orgId), eq(tenantMemberPermissions.userId, userId)))
        .returning();
    }
    ok(res, row);
  } catch (err) { handleErr(res, err, "tenant/permissions/upsert"); }
}

async function getAudit(orgId: string, url: string, res: ServerResponse) {
  try {
    const qs     = getQuery(url);
    const limit  = Math.min(parseInt(qs.get("limit") ?? "20", 10), 100);
    const cursor = qs.get("cursor") ?? undefined;
    const offset = cursor ? parseInt(cursor, 10) : 0;

    const { listAuditEventsByTenant } = await import("../../server/lib/audit/audit-log");
    const raw = await listAuditEventsByTenant({ tenantId: orgId, limit: limit + 1, offset });

    const hasMore    = raw.length > limit;
    const page       = hasMore ? raw.slice(0, limit) : raw;
    const nextOffset = hasMore ? offset + limit : null;

    const events = page.map((r: any) => ({
      id:        String(r.id ?? ""),
      eventType: String(r.action ?? r.event_type ?? "unknown"),
      tenantId:  r.tenant_id != null ? String(r.tenant_id) : null,
      userId:    r.actor_id  != null ? String(r.actor_id)  : null,
      ipAddress: r.ip_address != null ? String(r.ip_address) : null,
      createdAt: String(r.created_at ?? r.createdAt ?? new Date().toISOString()),
    }));

    ok(res, {
      events,
      pagination: { hasMore, nextCursor: nextOffset != null ? String(nextOffset) : null, limit },
      retrievedAt: new Date().toISOString(),
    });
  } catch (err) { handleErr(res, err, "tenant/audit"); }
}

// ── Router ────────────────────────────────────────────────────────────────────

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? "/";
  const method = req.method?.toUpperCase() ?? "GET";
  const segs   = rawUrl.replace(/^\/api\/tenant/, "").replace(/\?.*$/, "").split("/").filter(Boolean);

  const authResult = await authenticate(req);
  if (authResult.status !== "ok" || !authResult.user) {
    const status = authResult.status === "lockdown" ? 403 : 401;
    jsonOut(res, status, { error_code: "UNAUTHENTICATED", message: "Log ind for at fortsætte" });
    return;
  }

  const { user } = authResult;
  const orgId = user.organizationId;
  const token = (req.headers.authorization ?? "").slice(7);

  let body: unknown = {};
  if (["POST", "PATCH", "PUT"].includes(method)) {
    try { body = await readBody(req); }
    catch { return badRequest(res, "Ugyldigt JSON"); }
  }

  try {
    const [seg0, seg1, seg2] = segs;

    // GET  /api/tenant/org
    if (seg0 === "org" && method === "GET")      return getOrg(orgId, token, res);

    // GET  /api/tenant/settings
    // PATCH /api/tenant/settings
    if (seg0 === "settings") {
      if (method === "GET")   return getSettings(orgId, res);
      if (method === "PATCH") return patchSettings(orgId, body, res);
    }

    // GET /api/tenant/locale
    if (seg0 === "locale" && method === "GET") return getLocale(orgId, res);

    // GET /api/tenant/dashboard
    if (seg0 === "dashboard" && method === "GET") return getDashboard(orgId, res);

    // GET /api/tenant/usage
    if (seg0 === "usage" && method === "GET") return getUsage(orgId, rawUrl, res);

    // GET /api/tenant/billing
    if (seg0 === "billing" && method === "GET") return getBilling(orgId, res);

    // GET /api/tenant/ai/runs
    if (seg0 === "ai" && seg1 === "runs" && method === "GET") return getAiRuns(orgId, rawUrl, res);

    // GET  /api/tenant/team
    // POST /api/tenant/team/invite
    if (seg0 === "team") {
      if (!seg1 && method === "GET")                             return getTeam(orgId, rawUrl, res);
      if (seg1 === "invite" && method === "POST")                return inviteTeamMember(orgId, body, res);
    }

    // GET    /api/tenant/departments
    // POST   /api/tenant/departments
    // DELETE /api/tenant/departments/:id
    if (seg0 === "departments") {
      if (!seg1 && method === "GET")                             return listDepartments(orgId, res);
      if (!seg1 && method === "POST")                            return createDepartment(orgId, body, res);
      if (seg1 && method === "DELETE")                           return deleteDepartment(orgId, seg1, res);
    }

    // GET /api/tenant/permissions/:userId
    // PUT /api/tenant/permissions/:userId
    if (seg0 === "permissions" && seg1) {
      if (method === "GET") return getPermissions(orgId, seg1, res);
      if (method === "PUT") return upsertPermissions(orgId, seg1, body, res);
    }

    // GET /api/tenant/audit
    if (seg0 === "audit" && method === "GET") return getAudit(orgId, rawUrl, res);

    // Legacy compatibility: GET /api/tenant/members → same as team list
    if (seg0 === "members" && method === "GET") return getTeam(orgId, rawUrl, res);

    // Legacy: GET /api/tenant/budget → billing
    if (seg0 === "budget" && method === "GET") return getBilling(orgId, res);

    notFound(res, "Route ikke fundet");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[vercel/tenant] unhandled:", msg);
    if (!res.headersSent) jsonOut(res, 500, { error_code: "INTERNAL_ERROR", message: msg });
  }
}
