/**
 * Phase 30 — Safety Observability
 * Tracks circuit breaker triggers, rate limit violations,
 * restart recovery actions, and frozen tenant history.
 */

import type { TenantState, TenantSafetyTransition } from "./tenant-circuit-breaker";

// ── Types ─────────────────────────────────────────────────────────────────────

export type SafetyEventType =
  | "tenant_throttled"
  | "tenant_restricted"
  | "tenant_frozen"
  | "tenant_unfrozen"
  | "rate_limit_violation"
  | "restart_recovery_run"
  | "job_resumed"
  | "job_marked_failed"
  | "circuit_breaker_open"
  | "circuit_breaker_closed";

export interface SafetyEvent {
  id:        string;
  type:      SafetyEventType;
  tenantId?: string;
  severity:  "info" | "warn" | "error" | "critical";
  message:   string;
  metadata:  Record<string, unknown>;
  timestamp: string;
}

export interface TenantSafetyRecord {
  tenantId:      string;
  currentState:  TenantState;
  transitions:   TenantSafetyTransition[];
  frozenCount:   number;
  lastFrozenAt:  string | null;
  lastUpdated:   string;
}

export interface SafetySnapshot {
  totalEvents:       number;
  recentEvents:      SafetyEvent[];
  tenantRecords:     TenantSafetyRecord[];
  rateLimitViolations: number;
  restartRecoveries: number;
  frozenTenants:     string[];
  checkedAt:         string;
}

// ── In-memory store ───────────────────────────────────────────────────────────

const MAX_EVENTS = 500;

const _events:        SafetyEvent[]                      = [];
const _tenantRecords  = new Map<string, TenantSafetyRecord>();
let   _restartRecoveries = 0;
let   _rateLimitViolations = 0;

function nextId(): string {
  return `sev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function addEvent(event: Omit<SafetyEvent, "id" | "timestamp">): void {
  _events.push({ ...event, id: nextId(), timestamp: new Date().toISOString() });
  if (_events.length > MAX_EVENTS) _events.shift();
}

// ── Circuit breaker tracking ──────────────────────────────────────────────────

export function recordTenantStateChange(
  tenantId:  string,
  prevState: TenantState,
  newState:  TenantState,
  reason:    string,
): void {
  const severity: SafetyEvent["severity"] =
    newState === "frozen"     ? "critical" :
    newState === "restricted" ? "error"    :
    newState === "throttled"  ? "warn"     : "info";

  const type: SafetyEventType =
    newState === "frozen"     ? "tenant_frozen"     :
    newState === "restricted" ? "tenant_restricted" :
    newState === "throttled"  ? "tenant_throttled"  : "tenant_unfrozen";

  addEvent({
    type, tenantId, severity,
    message:  `Tenant ${tenantId}: ${prevState.toUpperCase()} → ${newState.toUpperCase()}`,
    metadata: { prevState, newState, reason },
  });

  // Update tenant record
  const existing = _tenantRecords.get(tenantId) ?? {
    tenantId,
    currentState: "normal" as TenantState,
    transitions:  [],
    frozenCount:  0,
    lastFrozenAt: null,
    lastUpdated:  new Date().toISOString(),
  };

  existing.currentState = newState;
  existing.transitions.push({ tenantId, from: prevState, to: newState, reason, timestamp: new Date().toISOString() });
  if (existing.transitions.length > 50) existing.transitions.shift();

  if (newState === "frozen") {
    existing.frozenCount++;
    existing.lastFrozenAt = new Date().toISOString();
  }
  existing.lastUpdated = new Date().toISOString();
  _tenantRecords.set(tenantId, existing);
}

export function recordCircuitBreakerOpen(tenantId: string, reason: string): void {
  addEvent({
    type: "circuit_breaker_open", tenantId, severity: "error",
    message: `Circuit breaker OPEN for tenant ${tenantId}: ${reason}`,
    metadata: { reason },
  });
}

export function recordCircuitBreakerClosed(tenantId: string): void {
  addEvent({
    type: "circuit_breaker_closed", tenantId, severity: "info",
    message: `Circuit breaker CLOSED for tenant ${tenantId}`,
    metadata: {},
  });
}

// ── Rate limit tracking ───────────────────────────────────────────────────────

export function recordRateLimitViolation(
  key:      string,
  category: string,
  count:    number,
  metadata: Record<string, unknown> = {},
): void {
  _rateLimitViolations++;
  addEvent({
    type: "rate_limit_violation", severity: "warn",
    message: `Rate limit violation: ${key} (${category}) — count=${count}`,
    metadata: { key, category, count, ...metadata },
  });
}

// ── Restart recovery tracking ─────────────────────────────────────────────────

export function recordRestartRecovery(
  incompleteJobs: number,
  resumedJobs:    number,
  errors:         string[],
): void {
  _restartRecoveries++;
  const severity: SafetyEvent["severity"] =
    errors.length > 0    ? "warn"  :
    incompleteJobs === 0 ? "info"  : "warn";

  addEvent({
    type: "restart_recovery_run", severity,
    message: `Restart recovery: ${incompleteJobs} incomplete, ${resumedJobs} resumed`,
    metadata: { incompleteJobs, resumedJobs, errors: errors.slice(0, 5) },
  });
}

export function recordJobResumed(jobId: string, tenantId?: string): void {
  addEvent({
    type: "job_resumed", tenantId, severity: "info",
    message: `Job ${jobId} resumed by restart recovery`,
    metadata: { jobId },
  });
}

export function recordJobMarkedFailed(jobId: string, reason: string, tenantId?: string): void {
  addEvent({
    type: "job_marked_failed", tenantId, severity: "warn",
    message: `Job ${jobId} marked failed: ${reason}`,
    metadata: { jobId, reason },
  });
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function getSafetySnapshot(limit = 50): SafetySnapshot {
  const records  = [..._tenantRecords.values()];
  const frozen   = records.filter(r => r.currentState === "frozen").map(r => r.tenantId);

  return {
    totalEvents:         _events.length,
    recentEvents:        [..._events].slice(-limit).reverse(),
    tenantRecords:       records.sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated)),
    rateLimitViolations: _rateLimitViolations,
    restartRecoveries:   _restartRecoveries,
    frozenTenants:       frozen,
    checkedAt:           new Date().toISOString(),
  };
}

export function getTenantSafetyRecord(tenantId: string): TenantSafetyRecord | null {
  return _tenantRecords.get(tenantId) ?? null;
}

export function getRecentSafetyEvents(type?: SafetyEventType, limit = 50): SafetyEvent[] {
  const events = type ? _events.filter(e => e.type === type) : _events;
  return [...events].slice(-limit).reverse();
}

export function getFrozenTenants(): string[] {
  return [..._tenantRecords.values()]
    .filter(r => r.currentState === "frozen")
    .map(r => r.tenantId);
}
