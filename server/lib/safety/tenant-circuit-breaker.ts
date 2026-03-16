/**
 * Phase 30 — Tenant Circuit Breaker
 * Protects the platform from runaway tenants.
 * INV-SAFE1: Tenant abuse must not affect other tenants.
 * INV-SAFE2: Circuit breaker transitions must be logged.
 */

import { Client } from "pg";

// ── Types ─────────────────────────────────────────────────────────────────────

export type TenantState = "normal" | "throttled" | "restricted" | "frozen";

export interface TenantActivityMetrics {
  tenantId:                  string;
  agentRunsPerMinute:        number;
  tokensPerMinute:           number;
  webhookEventsPerMinute:    number;
  queueJobsPerMinute:        number;
  apiCallsPerMinute:         number;
  windowMinutes:             number;
  measuredAt:                string;
}

export interface TenantProtectionResult {
  tenantId:    string;
  state:       TenantState;
  reason:      string;
  signals:     { name: string; value: number; threshold: number; breached: boolean }[];
  allowedFlows: string[];
  blockedFlows: string[];
  appliedAt:   string;
}

export interface TenantSafetyTransition {
  tenantId:  string;
  from:      TenantState;
  to:        TenantState;
  reason:    string;
  timestamp: string;
}

// ── Thresholds ────────────────────────────────────────────────────────────────

export const TENANT_THRESHOLDS = {
  agentRunsPerMinute:     { throttled: 30,   restricted: 60,  frozen: 120 },
  tokensPerMinute:        { throttled: 50000, restricted: 100000, frozen: 250000 },
  webhookEventsPerMinute: { throttled: 60,   restricted: 120, frozen: 300 },
  queueJobsPerMinute:     { throttled: 20,   restricted: 50,  frozen: 100 },
  apiCallsPerMinute:      { throttled: 200,  restricted: 500, frozen: 1000 },
};

// ── Flow permissions by state ─────────────────────────────────────────────────

export const STATE_PERMISSIONS: Record<TenantState, { allowed: string[]; blocked: string[] }> = {
  normal: {
    allowed: ["agent_runs", "jobs", "webhooks", "ai_tokens", "api_calls", "billing", "recovery"],
    blocked: [],
  },
  throttled: {
    allowed: ["agent_runs", "jobs", "webhooks", "api_calls", "billing", "recovery"],
    blocked: ["high_concurrency_agents"],
  },
  restricted: {
    allowed: ["billing", "recovery", "auth"],
    blocked: ["agent_runs", "new_jobs", "webhook_dispatch", "ai_tokens"],
  },
  frozen: {
    allowed: ["billing", "recovery"],
    blocked: ["agent_runs", "new_jobs", "webhook_dispatch", "ai_tokens", "auth_non_admin", "api_writes"],
  },
};

// ── In-memory state + history ─────────────────────────────────────────────────

const _tenantStates = new Map<string, TenantState>();
const _transitions:  TenantSafetyTransition[] = [];

// ── DB helper ─────────────────────────────────────────────────────────────────

function getClient(): Client {
  return new Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

function num(v: string | null | undefined): number {
  return parseInt(v ?? "0", 10) || 0;
}

// ── Metrics collection ────────────────────────────────────────────────────────

export async function getTenantActivityMetrics(
  tenantId: string,
  windowMinutes = 5,
): Promise<TenantActivityMetrics> {
  const client = getClient();
  await client.connect();
  const cutoff = new Date(Date.now() - windowMinutes * 60_000).toISOString();

  try {
    // Agent runs
    const agentRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM ai_runs
       WHERE tenant_id = $1 AND created_at >= $2`,
      [tenantId, cutoff],
    );
    const agentRuns = num(agentRes.rows[0]?.cnt);

    // Token usage
    const tokenRes = await client.query<{ total: string }>(
      `SELECT COALESCE(SUM(total_tokens), 0)::text AS total FROM ai_usage
       WHERE tenant_id = $1 AND created_at >= $2`,
      [tenantId, cutoff],
    );
    const tokens = num(tokenRes.rows[0]?.total);

    // Webhook events
    const webhookRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM webhook_deliveries
       WHERE created_at >= $1`,
      [cutoff],
    );
    const webhookEvents = num(webhookRes.rows[0]?.cnt);

    // Queue jobs
    const jobRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM knowledge_processing_jobs
       WHERE tenant_id = $1 AND created_at >= $2`,
      [tenantId, cutoff],
    );
    const queueJobs = num(jobRes.rows[0]?.cnt);

    // API calls — use request_safety_events as proxy
    const apiRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM request_safety_events
       WHERE tenant_id = $1 AND created_at >= $2`,
      [tenantId, cutoff],
    );
    const apiCalls = num(apiRes.rows[0]?.cnt);

    // Per-minute normalization
    const factor = windowMinutes > 0 ? windowMinutes : 1;

    return {
      tenantId,
      agentRunsPerMinute:        Math.round(agentRuns     / factor),
      tokensPerMinute:            Math.round(tokens        / factor),
      webhookEventsPerMinute:     Math.round(webhookEvents / factor),
      queueJobsPerMinute:         Math.round(queueJobs     / factor),
      apiCallsPerMinute:          Math.round(apiCalls      / factor),
      windowMinutes,
      measuredAt: new Date().toISOString(),
    };
  } finally {
    await client.end();
  }
}

// ── State classification ──────────────────────────────────────────────────────

export function classifyTenantState(metrics: TenantActivityMetrics): {
  state:   TenantState;
  signals: { name: string; value: number; threshold: number; breached: boolean }[];
  reason:  string;
} {
  const T = TENANT_THRESHOLDS;

  const signals = [
    {
      name:      "agent_runs_per_minute",
      value:     metrics.agentRunsPerMinute,
      threshold: T.agentRunsPerMinute.throttled,
      frozen:    T.agentRunsPerMinute.frozen,
      restricted: T.agentRunsPerMinute.restricted,
    },
    {
      name:      "tokens_per_minute",
      value:     metrics.tokensPerMinute,
      threshold: T.tokensPerMinute.throttled,
      frozen:    T.tokensPerMinute.frozen,
      restricted: T.tokensPerMinute.restricted,
    },
    {
      name:      "webhook_events_per_minute",
      value:     metrics.webhookEventsPerMinute,
      threshold: T.webhookEventsPerMinute.throttled,
      frozen:    T.webhookEventsPerMinute.frozen,
      restricted: T.webhookEventsPerMinute.restricted,
    },
    {
      name:      "queue_jobs_per_minute",
      value:     metrics.queueJobsPerMinute,
      threshold: T.queueJobsPerMinute.throttled,
      frozen:    T.queueJobsPerMinute.frozen,
      restricted: T.queueJobsPerMinute.restricted,
    },
    {
      name:      "api_calls_per_minute",
      value:     metrics.apiCallsPerMinute,
      threshold: T.apiCallsPerMinute.throttled,
      frozen:    T.apiCallsPerMinute.frozen,
      restricted: T.apiCallsPerMinute.restricted,
    },
  ];

  let state: TenantState = "normal";
  const frozenCount    = signals.filter(s => s.value >= s.frozen).length;
  const restrictedCount = signals.filter(s => s.value >= s.restricted).length;
  const throttledCount = signals.filter(s => s.value >= s.threshold).length;

  if (frozenCount >= 1)     state = "frozen";
  else if (restrictedCount >= 2) state = "restricted";
  else if (restrictedCount >= 1) state = "throttled";
  else if (throttledCount >= 2)  state = "throttled";
  else if (throttledCount >= 1)  state = "normal"; // single breach → warning only

  const breached = signals.filter(s => s.value >= s.threshold);
  const reason   = breached.length === 0
    ? "All tenant signals nominal"
    : `Tenant ${state}: ${breached.map(s => `${s.name}=${s.value}`).join(", ")}`;

  return {
    state,
    signals: signals.map(s => ({
      name: s.name, value: s.value, threshold: s.threshold,
      breached: s.value >= s.threshold,
    })),
    reason,
  };
}

// ── Protection application ────────────────────────────────────────────────────

export function applyTenantProtection(
  tenantId: string,
  metrics:  TenantActivityMetrics,
): TenantProtectionResult {
  const { state, signals, reason } = classifyTenantState(metrics);
  const prev = _tenantStates.get(tenantId) ?? "normal";

  if (prev !== state) {
    const t: TenantSafetyTransition = {
      tenantId, from: prev, to: state, reason,
      timestamp: new Date().toISOString(),
    };
    _transitions.push(t);
    if (_transitions.length > 500) _transitions.shift();
    _tenantStates.set(tenantId, state);

    console.log(
      `[tenant-circuit-breaker] ${tenantId}: ${prev.toUpperCase()} → ${state.toUpperCase()} | ${reason}`,
    );
  }

  const perms = STATE_PERMISSIONS[state];
  return {
    tenantId, state, reason, signals,
    allowedFlows: perms.allowed,
    blockedFlows: perms.blocked,
    appliedAt: new Date().toISOString(),
  };
}

// ── Unfreeze / manual override ────────────────────────────────────────────────

export function unfreezeTenant(tenantId: string, reason: string): TenantProtectionResult {
  const prev = _tenantStates.get(tenantId) ?? "normal";
  _tenantStates.set(tenantId, "normal");
  _transitions.push({
    tenantId, from: prev, to: "normal", reason: `Manual unfreeze: ${reason}`,
    timestamp: new Date().toISOString(),
  });
  console.log(`[tenant-circuit-breaker] ${tenantId}: MANUAL UNFREEZE from ${prev}`);
  const perms = STATE_PERMISSIONS["normal"];
  return {
    tenantId, state: "normal",
    reason: `Manually unfrozen: ${reason}`,
    signals: [], allowedFlows: perms.allowed, blockedFlows: perms.blocked,
    appliedAt: new Date().toISOString(),
  };
}

export function throttleTenant(tenantId: string, reason: string): TenantProtectionResult {
  const prev = _tenantStates.get(tenantId) ?? "normal";
  _tenantStates.set(tenantId, "throttled");
  _transitions.push({
    tenantId, from: prev, to: "throttled", reason: `Manual throttle: ${reason}`,
    timestamp: new Date().toISOString(),
  });
  const perms = STATE_PERMISSIONS["throttled"];
  return {
    tenantId, state: "throttled",
    reason: `Manually throttled: ${reason}`,
    signals: [], allowedFlows: perms.allowed, blockedFlows: perms.blocked,
    appliedAt: new Date().toISOString(),
  };
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function getTenantCurrentState(tenantId: string): TenantState {
  return _tenantStates.get(tenantId) ?? "normal";
}

export function getAllTenantStates(): Record<string, TenantState> {
  return Object.fromEntries(_tenantStates);
}

export function getTenantTransitionHistory(tenantId?: string): TenantSafetyTransition[] {
  const all = [..._transitions];
  return tenantId ? all.filter(t => t.tenantId === tenantId) : all;
}

// ── Explain ───────────────────────────────────────────────────────────────────

export function explainTenantProtection(result: TenantProtectionResult): string {
  if (result.state === "normal") {
    return `Tenant ${result.tenantId} is NORMAL — no protection applied.`;
  }
  const blocked = result.blockedFlows.length > 0
    ? `Blocked: ${result.blockedFlows.join(", ")}.`
    : "";
  return [
    `Tenant ${result.tenantId} is ${result.state.toUpperCase()}.`,
    `Reason: ${result.reason}.`,
    `Allowed: ${result.allowedFlows.join(", ")}.`,
    blocked,
  ].filter(Boolean).join(" ");
}

export function summarizeTenantSafety(): string {
  const states = Object.fromEntries(_tenantStates);
  const frozen     = Object.values(states).filter(s => s === "frozen").length;
  const restricted = Object.values(states).filter(s => s === "restricted").length;
  const throttled  = Object.values(states).filter(s => s === "throttled").length;
  const total      = _tenantStates.size;
  return `Tenants monitored: ${total}. Frozen: ${frozen}, Restricted: ${restricted}, Throttled: ${throttled}, Normal: ${total - frozen - restricted - throttled}.`;
}
