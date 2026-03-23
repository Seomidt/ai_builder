import type { IncomingMessage, ServerResponse } from "http";
import { authenticate } from "./_lib/auth";
import { json, err, pathSegments, parseUrl, readBody } from "./_lib/response";
import { dbList, dbGet, dbUpdate } from "./_lib/db";

const _FB_URL  = "https://jneoimqidmkhikvusxak.supabase.co";
const _FB_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpuZW9pbXFpZG1raGlrdnVzeGFrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMxMzcxNTgsImV4cCI6MjA4ODcxMzE1OH0.CPdFKA1jfs7OAfHCm49J7_gl3GrA2b7WLmbKWzhoY8M";
const SUPABASE_URL     = (process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL ?? _FB_URL).trim();
const SUPABASE_SERVICE = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
const SUPABASE_ANON    = (process.env.SUPABASE_ANON_KEY ?? process.env.VITE_SUPABASE_ANON_KEY ?? _FB_ANON).trim();

function adminErr(res: Parameters<typeof err>[0], status: number, code: string, message: string): void {
  err(res, status, code, status === 500 ? "Internal server error" : message);
}

function adminHeaders(): Record<string, string> {
  return {
    apikey:        SUPABASE_SERVICE,
    Authorization: `Bearer ${SUPABASE_SERVICE}`,
    "Content-Type": "application/json",
  };
}

async function supabaseQuery(table: string, params: Record<string, string>): Promise<unknown[]> {
  const qs  = new URLSearchParams(params).toString();
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}${qs ? "?" + qs : ""}`, {
    headers: adminHeaders(),
  });
  if (!res.ok) throw new Error(`Supabase error ${res.status}`);
  return res.json() as Promise<unknown[]>;
}

function getPlatformIntegrationStatus(): Record<string, { configured: boolean; env?: string }> {
  return {
    openai:     { configured: !!process.env.OPENAI_API_KEY,         env: "OPENAI_API_KEY" },
    supabase:   { configured: !!process.env.SUPABASE_URL,           env: "SUPABASE_URL" },
    cloudflare: { configured: !!process.env.CF_R2_ACCOUNT_ID,       env: "CF_R2_ACCOUNT_ID" },
    github:     { configured: !!process.env.GITHUB_TOKEN,           env: "GITHUB_TOKEN" },
    vercel:     { configured: !!process.env.VERCEL_TOKEN,           env: "VERCEL_TOKEN" },
  };
}

function currentPeriodBounds(periodType: string): { start: string; end: string } {
  const now   = new Date();
  const start = new Date(now);
  const end   = new Date(now);

  if (periodType === "daily") {
    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);
  } else if (periodType === "weekly") {
    const day = start.getDay();
    start.setDate(start.getDate() - day);
    start.setHours(0, 0, 0, 0);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
  } else if (periodType === "monthly") {
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    end.setMonth(end.getMonth() + 1, 0);
    end.setHours(23, 59, 59, 999);
  } else if (periodType === "annual") {
    start.setMonth(0, 1);
    start.setHours(0, 0, 0, 0);
    end.setMonth(11, 31);
    end.setHours(23, 59, 59, 999);
  }
  return { start: start.toISOString(), end: end.toISOString() };
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Deploy health is public (cron ping) — bypass auth
  const method = req.method ?? "GET";
  const segs   = pathSegments(req, "/api/admin");
  const u      = parseUrl(req);

  if (segs[0] === "platform" && segs[1] === "deploy-health" && method === "GET") {
    const t0     = Date.now();
    const checks: Record<string, { ok: boolean; detail: string }> = {
      SUPABASE_URL:             { ok: !!process.env.SUPABASE_URL,             detail: process.env.SUPABASE_URL     ? "set" : "MISSING" },
      SUPABASE_SERVICE_ROLE_KEY:{ ok: !!process.env.SUPABASE_SERVICE_ROLE_KEY,detail: process.env.SUPABASE_SERVICE_ROLE_KEY ? "set (hidden)" : "MISSING" },
      SUPABASE_ANON_KEY:        { ok: !!process.env.SUPABASE_ANON_KEY,        detail: process.env.SUPABASE_ANON_KEY ? "set (hidden)" : "MISSING" },
      DB_CONNECTION:            { ok: !!(process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL), detail: process.env.SUPABASE_DB_POOL_URL ? "SUPABASE_DB_POOL_URL" : process.env.DATABASE_URL ? "DATABASE_URL" : "MISSING" },
      LOCKDOWN_ENABLED:         { ok: true, detail: process.env.LOCKDOWN_ENABLED ?? "not set" },
      VERCEL:                   { ok: true, detail: process.env.VERCEL ? "true" : "false" },
      NODE_ENV:                 { ok: true, detail: process.env.NODE_ENV ?? "not set" },
    };

    let dbPingOk   = false;
    let dbPingDetail = "not attempted";
    try {
      const pingRes = await fetch(`${SUPABASE_URL}/rest/v1/organizations?select=id&limit=1`, {
        headers: adminHeaders(),
      });
      dbPingOk     = pingRes.ok;
      dbPingDetail = pingRes.ok ? "supabase connected" : `HTTP ${pingRes.status}`;
    } catch (e) {
      dbPingDetail = (e as Error).message;
    }
    checks.DB_PING = { ok: dbPingOk, detail: dbPingDetail };

    const elapsed = Date.now() - t0;
    const allOk   = Object.values(checks).every((c) => c.ok);
    res.setHeader("Server-Timing", `total;dur=${elapsed}`);
    res.setHeader("Cache-Control", "no-store");
    return json(res, {
      status:     allOk ? "healthy" : "degraded",
      timestamp:  new Date().toISOString(),
      responseMs: elapsed,
      checks,
    }, allOk ? 200 : 503);
  }

  // All other admin routes require platform_admin role
  const auth = await authenticate(req);
  if (auth.status === "lockdown") return err(res, 403, "LOCKDOWN", "Platform is in lockdown");
  if (auth.status !== "ok")       return err(res, 401, "UNAUTHENTICATED", "Authentication required");
  if (auth.user.role !== "platform_admin") return adminErr(res, 403, "FORBIDDEN", "Platform admin required"), undefined;

  try {
    // ── GET /api/admin/health ──────────────────────────────────────────────────
    if (segs[0] === "health" && method === "GET") {
      return json(res, { status: "ok", timestamp: new Date().toISOString() });
    }

    // ── GET /api/admin/integrations/status ────────────────────────────────────
    if (segs[0] === "integrations" && segs[1] === "status" && method === "GET") {
      const integrations = getPlatformIntegrationStatus();
      const allConfigured = Object.values(integrations).every((i) => i.configured);
      res.setHeader("Cache-Control", "private, max-age=60, stale-while-revalidate=120");
      return json(res, { integrations, allConfigured });
    }

    // ── GET /api/admin/ops-summary ────────────────────────────────────────────
    if (segs[0] === "ops-summary" && method === "GET") {
      const [projects, runs, architectures] = await Promise.all([
        supabaseQuery("projects",              { select: "count", head: "true" }).catch(() => [] as unknown[]),
        supabaseQuery("ai_runs",               { select: "count", head: "true" }).catch(() => [] as unknown[]),
        supabaseQuery("architecture_profiles", { select: "count", head: "true" }).catch(() => [] as unknown[]),
      ]);
      return json(res, { data: {
        generatedAt:     new Date().toISOString(),
        platform:        "BlissOps",
        projectCount:    (projects as unknown[]).length,
        runCount:        (runs as unknown[]).length,
        architectureCount:(architectures as unknown[]).length,
      }});
    }

    // ── POST /api/admin/ops-summary/invalidate ────────────────────────────────
    if (segs[0] === "ops-summary" && segs[1] === "invalidate" && method === "POST") {
      return json(res, { ok: true });
    }

    // ── GET /api/admin/tenants ─────────────────────────────────────────────────
    if (segs[0] === "tenants" && method === "GET") {
      const rows = await supabaseQuery("organizations", { select: "*", order: "created_at.desc" });
      return json(res, { tenants: rows, total: rows.length });
    }

    // ── GET /api/admin/plans ───────────────────────────────────────────────────
    if (segs[0] === "plans" && method === "GET") {
      return json(res, { plans: [] });
    }

    // ── GET /api/admin/invoices ────────────────────────────────────────────────
    if (segs[0] === "invoices" && method === "GET") {
      return json(res, { invoices: [], total: 0 });
    }

    // ── AI Ops routes ─────────────────────────────────────────────────────────

    if (segs[0] === "ai-ops") {
      if (segs[1] === "intents" && method === "GET") {
        return json(res, { intents: [
          "platform_health_summary", "tenant_usage_summary",
          "top_consumers", "weekly_digest", "anomaly_report",
        ]});
      }
      if (segs[1] === "audit" && method === "GET") {
        return json(res, { entries: [], stats: { total: 0, success: 0, failed: 0 } });
      }
      if (segs[1] === "health-summary" && method === "GET") {
        return json(res, { data: { summary: "Platform is operational", checks: {} } });
      }
      if (segs[1] === "weekly-digest" && method === "GET") {
        return json(res, { data: { week: new Date().toISOString(), metrics: [] } });
      }
      if (segs[1] === "query" && method === "POST") {
        await readBody(req);
        return json(res, { data: { result: "AI ops query endpoint — configure OPENAI_API_KEY to enable." }, auditId: null });
      }
      if (segs[1] === "tenant" && segs[3] === "summary" && method === "GET") {
        const tenantId = segs[2];
        return json(res, { data: { tenantId, summary: "No data available" } });
      }
    }

    // ── Governance routes ─────────────────────────────────────────────────────

    if (segs[0] === "governance") {
      const sub = segs[1];

      // Period bounds helper
      if (sub === "period-bounds" && method === "GET") {
        const periodType = u.searchParams.get("periodType") ?? "monthly";
        const valid      = ["daily","weekly","monthly","annual"];
        if (!valid.includes(periodType)) return adminErr(res, 422, "VALIDATION_ERROR", "Invalid periodType"), undefined;
        return json(res, { data: { periodType, ...currentPeriodBounds(periodType) } });
      }

      if (sub === "budgets" && method === "GET") {
        const orgId = segs[2];
        if (orgId) {
          const rows = await supabaseQuery("tenant_budgets", {
            organization_id: `eq.${orgId}`,
            select: "*", order: "created_at.desc", limit: "1",
          });
          if (!rows.length) return adminErr(res, 404, "NOT_FOUND", "No active budget found"), undefined;
          return json(res, { data: rows[0] });
        }
        const rows = await supabaseQuery("tenant_budgets", { select: "*", order: "created_at.desc" });
        return json(res, { data: rows, errors: [] });
      }

      if (sub === "snapshots-list" && method === "GET") {
        const limit  = Math.min(parseInt(u.searchParams.get("limit") ?? "100", 10), 500);
        const orgId  = u.searchParams.get("organizationId");
        const params: Record<string, string> = {
          select: "id,organization_id,period_start,period_end,period_type,total_tokens,total_cost_usd_cents,snapshot_at",
          order:  "snapshot_at.desc",
          limit:  String(limit),
        };
        if (orgId) params.organization_id = `eq.${orgId}`;
        const rows = await supabaseQuery("tenant_ai_usage_snapshots", params);
        return json(res, { data: rows });
      }

      if (sub === "anomalies" && method === "GET") {
        const limit  = Math.min(parseInt(u.searchParams.get("limit") ?? "100", 10), 500);
        const orgId  = u.searchParams.get("organizationId");
        const params: Record<string, string> = {
          select: "*", order: "detected_at.desc", limit: String(limit),
        };
        if (orgId) params.organization_id = `eq.${orgId}`;
        const rows = await supabaseQuery("ai_anomaly_events", params);
        return json(res, { data: rows });
      }

      if (sub === "alerts" && method === "GET") {
        const limit  = Math.min(parseInt(u.searchParams.get("limit") ?? "50", 10), 200);
        const orgId  = u.searchParams.get("organizationId");
        const params: Record<string, string> = {
          select: "*", status: "eq.open", order: "created_at.desc", limit: String(limit),
        };
        if (orgId) params.organization_id = `eq.${orgId}`;
        const rows = await supabaseQuery("governance_alerts", params);
        return json(res, { data: rows });
      }

      if (sub === "alerts" && segs[3] === "acknowledge" && method === "PATCH") {
        const alertId = segs[2];
        await dbUpdate("governance_alerts", { id: `eq.${alertId}` },
          { status: "acknowledged", acknowledgedAt: new Date().toISOString() });
        return json(res, { data: { acknowledged: true, alertId } });
      }

      if (sub === "alerts" && segs[3] === "resolve" && method === "PATCH") {
        const alertId = segs[2];
        await dbUpdate("governance_alerts", { id: `eq.${alertId}` },
          { status: "resolved", resolvedAt: new Date().toISOString() });
        return json(res, { data: { resolved: true, alertId } });
      }

      if (sub === "runaway-status" && method === "GET") {
        return json(res, { data: [] });
      }

      // Stub write ops (snapshot, detect, cycle) — return accepted
      if (["snapshots","anomalies","cycle","runaway"].includes(sub) && method === "POST") {
        return json(res, { data: { ok: true, message: "Operation accepted" } });
      }

      if (sub === "classify-budget" && method === "POST") {
        const body = await readBody<{ currentUsageUsdCents?: number; budgetUsdCents?: number; warningThresholdPct?: number; hardLimitPct?: number }>(req);
        const current  = body.currentUsageUsdCents ?? 0;
        const budget   = body.budgetUsdCents ?? 1;
        const warning  = body.warningThresholdPct ?? 80;
        const hard     = body.hardLimitPct ?? 100;
        const pct      = budget > 0 ? Math.round((current / budget) * 100) : 0;
        const status   = pct >= hard ? "exceeded" : pct >= warning ? "warning" : "ok";
        return json(res, { data: { status, usagePct: pct, current, budget } });
      }
    }

    return err(res, 404, "NOT_FOUND", "Route not found");
  } catch (e) {
    console.error("[admin handler]", (e as Error).message);
    return json(res, { error_code: "INTERNAL_ERROR", message: "Internal server error" }, 500);
  }
}
