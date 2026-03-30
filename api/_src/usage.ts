/**
 * api/_src/usage.ts — Vercel Serverless Handler for /api/usage/*
 *
 * Routes:
 *   GET  /api/usage/summary   — current period cost, budget %, remaining
 *   GET  /api/usage/history   — paginated ai_usage events for the tenant
 *   POST /api/budget/update   — update tenant monthly AI budget (admin only)
 */

import "../../server/lib/env.ts";
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
function forbidden(res: ServerResponse, msg = "Adgang nægtet"): void { jsonOut(res, 403, { error_code: "FORBIDDEN", message: msg }); }

function handleErr(res: ServerResponse, e: unknown, label = "usage"): void {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[vercel/${label}]`, msg);
  if (!res.headersSent) jsonOut(res, 500, { error_code: "INTERNAL_ERROR", message: msg });
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { reject(new Error("Ugyldig JSON")); }
    });
    req.on("error", reject);
  });
}

function getQuery(url: string): URLSearchParams {
  return new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
}

// ── GET /api/usage/summary ────────────────────────────────────────────────────

async function getUsageSummary(orgId: string, res: ServerResponse): Promise<void> {
  try {
    const { checkBudget } = await import("../../server/lib/ai/budget-guard");
    const { getCurrentAiUsageForPeriod } = await import("../../server/lib/ai/guards");
    const { getCurrentPeriod } = await import("../../server/lib/ai/usage-periods");
    const { db } = await import("../../server/db");
    const { aiUsage } = await import("../../shared/schema");
    const { eq, and, gte, lt, count } = await import("drizzle-orm");

    const { periodStart, periodEnd } = getCurrentPeriod();
    const [budgetResult, currentCostUsd] = await Promise.all([
      checkBudget(orgId),
      getCurrentAiUsageForPeriod(orgId),
    ]);

    // Request count for this period
    const countRows = await db
      .select({ cnt: count() })
      .from(aiUsage)
      .where(
        and(
          eq(aiUsage.tenantId, orgId),
          gte(aiUsage.createdAt, periodStart),
          lt(aiUsage.createdAt, periodEnd),
        ),
      );
    const requestCount = Number(countRows[0]?.cnt ?? 0);

    const budgetUsd   = budgetResult.budgetUsd;
    const usedUsd     = currentCostUsd;
    const remainingUsd = budgetUsd !== null ? Math.max(0, budgetUsd - usedUsd) : null;

    ok(res, {
      tenantId:         orgId,
      period:           { start: periodStart.toISOString(), end: periodEnd.toISOString() },
      usedUsd:          parseFloat(usedUsd.toFixed(6)),
      budgetUsd,
      remainingUsd,
      usagePercent:     budgetResult.usagePercent,
      requestCount,
      usageState:       budgetResult.usageState,      // "normal" | "budget_mode" | "blocked"
      isSoftExceeded:   budgetResult.isSoftExceeded,
      isHardExceeded:   budgetResult.isHardExceeded,
      softLimitPercent: budgetResult.softLimitPercent, // threshold for warning state (default 80%)
      hardLimitPercent: budgetResult.hardLimitPercent, // threshold for blocked state (default 100%)
      retrievedAt:      new Date().toISOString(),
    });
  } catch (e) { handleErr(res, e, "usage/summary"); }
}

// ── GET /api/usage/history ────────────────────────────────────────────────────

async function getUsageHistory(orgId: string, url: string, res: ServerResponse): Promise<void> {
  try {
    const qs     = getQuery(url);
    const limit  = Math.min(parseInt(qs.get("limit") ?? "50", 10), 200);
    const cursor = qs.get("cursor") ?? null; // ISO date — exclusive upper bound
    const period = qs.get("period") ?? "30d";
    const days   = period === "7d" ? 7 : period === "90d" ? 90 : 30;

    const { db } = await import("../../server/db");
    const { aiUsage } = await import("../../shared/schema");
    const { eq, and, gte, lt, desc } = await import("drizzle-orm");

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const conditions: ReturnType<typeof eq>[] = [
      eq(aiUsage.tenantId, orgId),
      gte(aiUsage.createdAt, since),
    ];
    if (cursor) {
      conditions.push(lt(aiUsage.createdAt, new Date(cursor)));
    }

    const rows = await db
      .select({
        id:               aiUsage.id,
        feature:          aiUsage.feature,
        model:            aiUsage.model,
        provider:         aiUsage.provider,
        promptTokens:     aiUsage.promptTokens,
        completionTokens: aiUsage.completionTokens,
        totalTokens:      aiUsage.totalTokens,
        estimatedCostUsd: aiUsage.estimatedCostUsd,
        status:           aiUsage.status,
        latencyMs:        aiUsage.latencyMs,
        createdAt:        aiUsage.createdAt,
      })
      .from(aiUsage)
      .where(and(...conditions))
      .orderBy(desc(aiUsage.createdAt))
      .limit(limit + 1);

    const hasMore     = rows.length > limit;
    const page        = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor  = hasMore ? page[page.length - 1]?.createdAt?.toISOString() ?? null : null;

    ok(res, {
      tenantId: orgId,
      period,
      events:   page,
      nextCursor,
      hasMore,
      retrievedAt: new Date().toISOString(),
    });
  } catch (e) { handleErr(res, e, "usage/history"); }
}

// ── POST /api/budget/update ───────────────────────────────────────────────────

async function updateBudget(orgId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req) as {
      monthlyBudgetUsd?: number;
      warningThresholdPercent?: number;
      hardLimitPercent?: number;
      hardStopEnabled?: boolean;
      budgetModeEnabled?: boolean;
    };

    if (body.monthlyBudgetUsd !== undefined && (typeof body.monthlyBudgetUsd !== "number" || body.monthlyBudgetUsd < 0)) {
      return badRequest(res, "monthlyBudgetUsd skal være et positivt tal");
    }

    const { db } = await import("../../server/db");
    const { aiUsageLimits } = await import("../../shared/schema");
    const { eq } = await import("drizzle-orm");

    // Upsert budget limit row
    const existing = await db
      .select({ id: aiUsageLimits.id })
      .from(aiUsageLimits)
      .where(eq(aiUsageLimits.tenantId, orgId))
      .limit(1);

    const updates: Record<string, unknown> = {};
    if (body.monthlyBudgetUsd !== undefined)        updates.monthlyAiBudgetUsd       = String(body.monthlyBudgetUsd);
    if (body.warningThresholdPercent !== undefined)  updates.warningThresholdPercent  = body.warningThresholdPercent;
    if (body.hardLimitPercent !== undefined)         updates.hardLimitPercent         = body.hardLimitPercent;
    if (body.hardStopEnabled !== undefined)          updates.hardStopEnabled          = body.hardStopEnabled;
    if (body.budgetModeEnabled !== undefined)        updates.budgetModeEnabled        = body.budgetModeEnabled;

    if (Object.keys(updates).length === 0) {
      return badRequest(res, "Ingen felter at opdatere");
    }

    let result;
    if (existing.length > 0) {
      const rows = await db
        .update(aiUsageLimits)
        .set({ ...updates, updatedAt: new Date() } as any)
        .where(eq(aiUsageLimits.tenantId, orgId))
        .returning();
      result = rows[0];
    } else {
      const rows = await db
        .insert(aiUsageLimits)
        .values({ tenantId: orgId, ...updates } as any)
        .returning();
      result = rows[0];
    }

    console.log(`[usage/budget] Updated budget for tenant ${orgId}:`, updates);
    ok(res, { tenantId: orgId, budget: result, updatedAt: new Date().toISOString() }, 200);
  } catch (e) { handleErr(res, e, "budget/update"); }
}

// ── Router ────────────────────────────────────────────────────────────────────

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const auth = await authenticate(req);
  if (auth.status === "lockdown") return jsonOut(res, 403, { error_code: "LOCKDOWN", message: "Platform er i lockdown" });
  if (auth.status !== "ok")       return jsonOut(res, 401, { error_code: "UNAUTHENTICATED", message: "Login krævet" });

  const { user } = auth;
  const orgId    = user.organizationId;
  const url      = req.url ?? "/";
  const method   = req.method ?? "GET";

  // Strip query string for path matching
  const path = url.split("?")[0].replace(/\/+$/, "");

  if (method === "GET"  && (path === "/api/usage/summary" || path === "/api/usage")) {
    return getUsageSummary(orgId, res);
  }
  if (method === "GET"  && path === "/api/usage/history") {
    return getUsageHistory(orgId, url, res);
  }
  if (method === "POST" && path === "/api/budget/update") {
    // Only allow owner/admin to update budget
    if (user.role !== "owner" && user.role !== "admin") {
      return forbidden(res, "Kun administratorer kan opdatere budgettet");
    }
    return updateBudget(orgId, req, res);
  }

  return notFound(res, "Endpoint ikke fundet");
}
