/**
 * Phase 29 — Brownout Mode / Degradation Control
 * INV-REC9:  Brownout mode must protect core flows first.
 * INV-REC10: Brownout transitions must be logged and explainable.
 */

import type { PressureLevel } from "./system-pressure";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BrownoutLevel = "normal" | "elevated" | "degraded" | "critical";

export interface BrownoutPolicy {
  level:          BrownoutLevel;
  deferredFlows:  string[];
  throttledFlows: string[];
  protectedFlows: string[];
  description:    string;
}

export interface BrownoutTransition {
  from:      BrownoutLevel;
  to:        BrownoutLevel;
  reason:    string;
  manual:    boolean;
  timestamp: string;
}

export interface BrownoutState {
  level:              BrownoutLevel;
  active:             boolean;
  policy:             BrownoutPolicy;
  enteredAt:          string | null;
  manualOverride:     boolean;
  transitionCount:    number;
  lastTransitionAt:   string | null;
  explanation:        string;
}

// ── Core protected flows (INV-REC9) ──────────────────────────────────────────

export const CORE_FLOWS = [
  "auth",
  "billing",
  "quota_enforcement",
  "retrieval_answer_path",
  "stripe_webhook_handling",
  "restore_recovery_endpoints",
] as const;

// ── Brownout policies ─────────────────────────────────────────────────────────

export const BROWNOUT_POLICIES: Record<BrownoutLevel, BrownoutPolicy> = {
  normal: {
    level:          "normal",
    deferredFlows:  [],
    throttledFlows: [],
    protectedFlows: [...CORE_FLOWS],
    description:    "Platform operating normally — no degradation active.",
  },
  elevated: {
    level:          "elevated",
    deferredFlows:  [
      "non_critical_exports",
      "low_priority_cleanup_jobs",
      "optional_observability_rollups",
    ],
    throttledFlows: [],
    protectedFlows: [...CORE_FLOWS],
    description:    "Elevated pressure — deferring non-critical exports and cleanup.",
  },
  degraded: {
    level:          "degraded",
    deferredFlows:  [
      "non_critical_exports",
      "low_priority_cleanup_jobs",
      "optional_observability_rollups",
    ],
    throttledFlows: [
      "webhook_retry_throughput",
      "agent_concurrency",
      "evaluation_throughput",
      "expensive_admin_diagnostics",
    ],
    protectedFlows: [...CORE_FLOWS],
    description:    "Degraded — throttling webhook retries, agent concurrency, and evaluation.",
  },
  critical: {
    level:          "critical",
    deferredFlows:  [
      "non_critical_exports",
      "low_priority_cleanup_jobs",
      "optional_observability_rollups",
      "webhook_retry_throughput",
      "agent_concurrency",
      "evaluation_throughput",
      "expensive_admin_diagnostics",
      "background_knowledge_ingestion",
      "analytics_rollups",
    ],
    throttledFlows: [],
    protectedFlows: [...CORE_FLOWS],
    description:    "CRITICAL — only core platform flows preserved: auth, billing, quota, retrieval, Stripe webhooks, and recovery.",
  },
};

// ── In-memory state ───────────────────────────────────────────────────────────

interface RuntimeState {
  level:            BrownoutLevel;
  enteredAt:        string | null;
  manualOverride:   boolean;
  history:          BrownoutTransition[];
}

const _state: RuntimeState = {
  level:          "normal",
  enteredAt:      null,
  manualOverride: false,
  history:        [],
};

// ── Accessors ─────────────────────────────────────────────────────────────────

export function getBrownoutState(): BrownoutState {
  const policy = BROWNOUT_POLICIES[_state.level];
  return {
    level:            _state.level,
    active:           _state.level !== "normal",
    policy,
    enteredAt:        _state.enteredAt,
    manualOverride:   _state.manualOverride,
    transitionCount:  _state.history.length,
    lastTransitionAt: _state.history.at(-1)?.timestamp ?? null,
    explanation:      explainBrownoutDecision(_state.level),
  };
}

export function getBrownoutHistory(): BrownoutTransition[] {
  return [..._state.history];
}

// ── Transitions ───────────────────────────────────────────────────────────────

function transition(
  to: BrownoutLevel,
  reason: string,
  manual: boolean,
): void {
  const from = _state.level;
  if (from === to) return; // no-op

  const entry: BrownoutTransition = {
    from, to, reason, manual,
    timestamp: new Date().toISOString(),
  };

  _state.history.push(entry);
  if (_state.history.length > 200) _state.history.shift(); // bounded history

  _state.level          = to;
  _state.enteredAt      = to === "normal" ? null : entry.timestamp;
  _state.manualOverride = manual;

  console.log(
    `[brownout] TRANSITION ${from.toUpperCase()} → ${to.toUpperCase()} | reason: ${reason} | manual: ${manual}`,
  );
}

export function enterBrownoutMode(
  level: BrownoutLevel,
  reason: string,
  manual = false,
): BrownoutState {
  if (level === "normal") {
    return exitBrownoutMode(reason, manual);
  }
  transition(level, reason, manual);
  return getBrownoutState();
}

export function exitBrownoutMode(
  reason = "System pressure returned to normal",
  manual = false,
): BrownoutState {
  if (_state.level === "normal") {
    // Already normal — just reset manualOverride flag regardless
    _state.manualOverride = manual;
  } else {
    transition("normal", reason, manual);
  }
  return getBrownoutState();
}

// ── Auto-policy from pressure ─────────────────────────────────────────────────

export function applyBrownoutPolicy(pressureLevel: PressureLevel): BrownoutState {
  const target = pressureLevel as BrownoutLevel; // levels match 1:1
  if (target !== _state.level && !_state.manualOverride) {
    transition(target, `Auto: pressure level=${pressureLevel}`, false);
  }
  return getBrownoutState();
}

// ── Flow checks ───────────────────────────────────────────────────────────────

export function isFlowAllowed(flowName: string): boolean {
  const policy = BROWNOUT_POLICIES[_state.level];
  // Always allow core flows (INV-REC9)
  if (CORE_FLOWS.includes(flowName as any)) return true;
  // Deferred flows are blocked
  if (policy.deferredFlows.includes(flowName)) return false;
  return true;
}

export function isFlowThrottled(flowName: string): boolean {
  const policy = BROWNOUT_POLICIES[_state.level];
  return policy.throttledFlows.includes(flowName);
}

// ── Explain ───────────────────────────────────────────────────────────────────

export function explainBrownoutDecision(level: BrownoutLevel): string {
  const policy = BROWNOUT_POLICIES[level];
  if (level === "normal") return policy.description;

  return [
    policy.description,
    `Protected: ${policy.protectedFlows.join(", ")}.`,
    policy.deferredFlows.length  > 0 ? `Deferred: ${policy.deferredFlows.join(", ")}.`  : "",
    policy.throttledFlows.length > 0 ? `Throttled: ${policy.throttledFlows.join(", ")}.` : "",
  ].filter(Boolean).join(" ");
}

export function summarizeBrownoutState(): string {
  const s = getBrownoutState();
  if (!s.active) return "Brownout: inactive (normal)";
  return `Brownout: ${s.level.toUpperCase()} since ${s.enteredAt} | ${s.policy.deferredFlows.length} deferred, ${s.policy.throttledFlows.length} throttled | manual=${s.manualOverride}`;
}
