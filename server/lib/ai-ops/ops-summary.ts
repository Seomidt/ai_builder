// ─── Ops Summary — Fast, Cached, No AI Call ───────────────────────────────────
//
// One consolidated read model for the Driftskonsol critical path.
// Replaces the dual waterfall (health-summary + weekly-digest) with a single
// server-side call that:
//   • Makes NO OpenAI call
//   • Runs all DB queries in parallel with Promise.allSettled
//   • Caches result for 60 seconds in-memory
//   • Returns exactly the shape the dashboard needs for first paint
//
// Role protection is handled at the route layer (platform_admin only).
// ─────────────────────────────────────────────────────────────────────────────

import { supabaseAdmin } from "../supabase";

export interface OpsSummary {
  healthStatus: "healthy" | "degraded" | "critical" | "unknown";
  checks: Record<string, { ok: boolean; detail?: string }>;
  activeAlerts: number;
  recentAnomalies: number;
  totalEventsLast7d: number;
  aiCostUsd: number;
  weekStart: string;
  weekEnd: string;
  highlights: string[];
  riskSignals: string[];
  generatedAt: string;
  cachedAt: string | null;
  fromCache: boolean;
}

let _cache: OpsSummary | null = null;
let _cachedAt: number | null = null;
const CACHE_TTL_MS = 60_000;

function isCacheValid(): boolean {
  return !!_cache && !!_cachedAt && Date.now() - _cachedAt < CACHE_TTL_MS;
}

export function invalidateOpsSummaryCache(): void {
  _cache = null;
  _cachedAt = null;
}

export async function getOpsSummary(forceRefresh = false): Promise<OpsSummary> {
  if (!forceRefresh && isCacheValid()) {
    return { ..._cache!, fromCache: true };
  }

  const now = new Date();
  const weekEnd = now.toISOString().split("T")[0];
  const weekStart = new Date(now.getTime() - 7 * 86_400_000).toISOString().split("T")[0];
  const since7d = new Date(now.getTime() - 7 * 86_400_000).toISOString();

  const [anomalyRes, alertRes, rollupRes, costRes, envChecks] = await Promise.allSettled([
    supabaseAdmin
      .from("gov_anomaly_events")
      .select("id", { count: "exact", head: true })
      .gte("created_at", since7d),

    supabaseAdmin
      .from("ai_usage_alerts")
      .select("id", { count: "exact", head: true })
      .in("status", ["open", "triggered"])
      .gte("triggered_at", since7d),

    supabaseAdmin
      .from("analytics_daily_rollups")
      .select("event_count")
      .gte("date", weekStart)
      .limit(500),

    supabaseAdmin
      .from("tenant_ai_usage_snapshots")
      .select("cost_usd")
      .gte("created_at", since7d)
      .limit(500),

    Promise.resolve({
      SUPABASE_URL: !!process.env.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_ANON_KEY: !!process.env.SUPABASE_ANON_KEY,
      DB_CONNECTION: !!(process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL),
      NODE_ENV: process.env.NODE_ENV ?? "unknown",
    }),
  ]);

  const recentAnomalies = anomalyRes.status === "fulfilled" ? (anomalyRes.value.count ?? 0) : 0;
  const activeAlerts = alertRes.status === "fulfilled" ? (alertRes.value.count ?? 0) : 0;

  let totalEventsLast7d = 0;
  if (rollupRes.status === "fulfilled" && rollupRes.value.data) {
    for (const row of rollupRes.value.data) {
      totalEventsLast7d += Number((row as { event_count?: unknown }).event_count ?? 0);
    }
  }

  let aiCostUsd = 0;
  if (costRes.status === "fulfilled" && costRes.value.data) {
    for (const row of costRes.value.data) {
      aiCostUsd += Number((row as { cost_usd?: unknown }).cost_usd ?? 0);
    }
  }

  const envData = envChecks.status === "fulfilled" ? envChecks.value : {};
  const checks: Record<string, { ok: boolean; detail?: string }> = {
    SUPABASE_URL: {
      ok: !!(envData as Record<string, unknown>).SUPABASE_URL,
      detail: (envData as Record<string, unknown>).SUPABASE_URL ? "set" : "MISSING",
    },
    SUPABASE_SERVICE_ROLE_KEY: {
      ok: !!(envData as Record<string, unknown>).SUPABASE_SERVICE_ROLE_KEY,
      detail: (envData as Record<string, unknown>).SUPABASE_SERVICE_ROLE_KEY ? "set (hidden)" : "MISSING",
    },
    SUPABASE_ANON_KEY: {
      ok: !!(envData as Record<string, unknown>).SUPABASE_ANON_KEY,
      detail: (envData as Record<string, unknown>).SUPABASE_ANON_KEY ? "set (hidden)" : "MISSING",
    },
    DB_CONNECTION: {
      ok: !!(envData as Record<string, unknown>).DB_CONNECTION,
      detail: process.env.SUPABASE_DB_POOL_URL
        ? "SUPABASE_DB_POOL_URL"
        : process.env.DATABASE_URL
          ? "DATABASE_URL"
          : "MISSING",
    },
    ANOMALY_MONITOR: {
      ok: anomalyRes.status === "fulfilled",
      detail: anomalyRes.status === "fulfilled"
        ? `${recentAnomalies} anomalies in last 7d`
        : "query failed",
    },
    ALERT_MONITOR: {
      ok: alertRes.status === "fulfilled",
      detail: alertRes.status === "fulfilled"
        ? `${activeAlerts} open alerts`
        : "query failed",
    },
    ANALYTICS_ROLLUPS: {
      ok: rollupRes.status === "fulfilled",
      detail: rollupRes.status === "fulfilled"
        ? `${totalEventsLast7d.toLocaleString()} events this week`
        : "query failed",
    },
  };

  const failedCount = Object.values(checks).filter((c) => !c.ok).length;
  const healthStatus: OpsSummary["healthStatus"] =
    recentAnomalies > 25 ? "critical"
    : recentAnomalies > 10 || activeAlerts > 5 || failedCount > 2 ? "degraded"
    : failedCount > 0 ? "degraded"
    : "healthy";

  const highlights: string[] = [];
  const riskSignals: string[] = [];

  if (totalEventsLast7d > 0) {
    highlights.push(`${totalEventsLast7d.toLocaleString()} platform events this week`);
  }
  if (aiCostUsd > 0) {
    highlights.push(`AI usage cost this week: $${aiCostUsd.toFixed(2)}`);
  }
  if (recentAnomalies > 0) {
    highlights.push(`${recentAnomalies} anomalies detected in last 7 days`);
    if (recentAnomalies > 5) riskSignals.push("High anomaly frequency — investigate runaway agents");
  }
  if (activeAlerts > 0) {
    riskSignals.push(`${activeAlerts} open AI budget/usage alerts`);
  }

  const summary: OpsSummary = {
    healthStatus,
    checks,
    activeAlerts,
    recentAnomalies,
    totalEventsLast7d,
    aiCostUsd,
    weekStart,
    weekEnd,
    highlights,
    riskSignals,
    generatedAt: now.toISOString(),
    cachedAt: null,
    fromCache: false,
  };

  _cache = summary;
  _cachedAt = Date.now();

  return summary;
}
