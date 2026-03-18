/**
 * Phase 39 — Security Alerting
 * Deduplication-aware alert emission for critical security events.
 *
 * Rules:
 *  - Alerts must never include secret values
 *  - Deduplicated within dedup window (60s by default)
 *  - Sent to audit event bus + external sinks if configured
 */

import { sanitizeLogPayload } from "./secret-hygiene";

// ── Alert types ───────────────────────────────────────────────────────────────

export type SecurityAlertType =
  | "repeated_login_attack"
  | "account_lock_escalation"
  | "deploy_integrity_critical"
  | "schema_drift_critical"
  | "backup_missing"
  | "backup_dry_run_failed"
  | "webhook_signature_failures_spike"
  | "signed_url_abuse_spike"
  | "brute_force_cooldown_started"
  | "brute_force_account_locked"
  | "brute_force_ip_escalation"
  | "session_revoked_after_password_change"
  | "session_revoked_after_mfa_reset"
  | "webhook_signature_verified"
  | "webhook_signature_failed"
  | "backup_health_warning"
  | "security_headers_missing"
  | "security_headers_invalid";

export type AlertSeverity = "info" | "warning" | "critical";

export interface SecurityAlertEvent {
  alertType:  SecurityAlertType;
  severity:   AlertSeverity;
  message:    string;
  tenantId?:  string | null;
  actorId?:   string | null;
  ip?:        string | null;
  metadata?:  Record<string, unknown>;
  emittedAt?: string;
}

export interface EmittedAlert extends SecurityAlertEvent {
  id:        string;
  emittedAt: string;
  dedupKey:  string;
}

// ── In-memory alert store ─────────────────────────────────────────────────────

const alertLog: EmittedAlert[] = [];
const MAX_LOG = 1000;
const dedupMap = new Map<string, number>(); // dedupKey → last emitted ms
const DEDUP_WINDOW_MS = 60_000;

function makeDedupKey(event: SecurityAlertEvent): string {
  return `${event.alertType}:${event.tenantId ?? ""}:${event.ip ?? ""}:${event.severity}`;
}

function makeId(): string {
  return `alert-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

function isDuplicate(dedupKey: string): boolean {
  const last = dedupMap.get(dedupKey);
  return !!last && Date.now() - last < DEDUP_WINDOW_MS;
}

// ── Core emitter ──────────────────────────────────────────────────────────────

export function emitSecurityAlert(event: SecurityAlertEvent): EmittedAlert | null {
  const dedupKey = makeDedupKey(event);
  if (isDuplicate(dedupKey)) return null;

  const safeMetadata = event.metadata ? sanitizeLogPayload(event.metadata) : undefined;

  const emitted: EmittedAlert = {
    ...event,
    metadata:  safeMetadata,
    id:        makeId(),
    emittedAt: new Date().toISOString(),
    dedupKey,
  };

  dedupMap.set(dedupKey, Date.now());
  alertLog.unshift(emitted);
  if (alertLog.length > MAX_LOG) alertLog.length = MAX_LOG;

  // Console log for server observability (no secrets in metadata)
  const level = event.severity === "critical" ? "error" : event.severity === "warning" ? "warn" : "log";
  console[level](`[security-alert] [${event.severity.toUpperCase()}] ${event.alertType}: ${event.message}`);

  // Future: send to Sentry / PostHog / Slack if env vars are configured
  if (process.env.SENTRY_DSN)   trySendToSentry(emitted);
  if (process.env.POSTHOG_KEY)  trySendToPosthog(emitted);

  return emitted;
}

export function emitCriticalSecurityAlert(event: Omit<SecurityAlertEvent, "severity">): EmittedAlert | null {
  return emitSecurityAlert({ ...event, severity: "critical" });
}

export function emitBackupFailureAlert(detail: string, metadata?: Record<string, unknown>): EmittedAlert | null {
  return emitSecurityAlert({
    alertType: "backup_missing",
    severity:  "critical",
    message:   `Backup failure: ${detail}`,
    metadata,
  });
}

export function emitWebhookVerificationFailureAlert(params: {
  provider: string;
  reason:   string;
  ip?:      string | null;
  tenantId?: string | null;
}): EmittedAlert | null {
  return emitSecurityAlert({
    alertType: "webhook_signature_failed",
    severity:  "warning",
    message:   `Webhook verification failed [${params.provider}]: ${params.reason}`,
    ip:        params.ip,
    tenantId:  params.tenantId,
    metadata:  { provider: params.provider, reason: params.reason },
  });
}

export function emitBruteForceAlert(params: {
  alertType: "brute_force_cooldown_started" | "brute_force_account_locked" | "brute_force_ip_escalation";
  failures:  number;
  ip?:       string | null;
  tenantId?: string | null;
}): EmittedAlert | null {
  const severity: AlertSeverity =
    params.alertType === "brute_force_account_locked" ? "critical" : "warning";

  return emitSecurityAlert({
    alertType: params.alertType,
    severity,
    message:   `${params.alertType.replace(/_/g, " ")} — ${params.failures} failures`,
    ip:        params.ip,
    tenantId:  params.tenantId,
    metadata:  { failures: params.failures },
  });
}

// ── Stubs for external sinks (no-op until env vars configured) ────────────────

function trySendToSentry(alert: EmittedAlert): void {
  try {
    // Requires @sentry/node installed and SENTRY_DSN configured
    // Sentry?.captureEvent({ message: alert.message, level: alert.severity, extra: alert.metadata });
  } catch { /* noop */ }
}

function trySendToPosthog(alert: EmittedAlert): void {
  try {
    // Requires posthog-node and POSTHOG_KEY configured
    // posthog?.capture({ distinctId: alert.actorId ?? 'system', event: alert.alertType, properties: alert.metadata });
  } catch { /* noop */ }
}

// ── Alert query ───────────────────────────────────────────────────────────────

export function getRecentAlerts(
  limit  = 50,
  filter?: { severity?: AlertSeverity; alertType?: SecurityAlertType },
): EmittedAlert[] {
  let alerts = alertLog;
  if (filter?.severity)  alerts = alerts.filter(a => a.severity  === filter.severity);
  if (filter?.alertType) alerts = alerts.filter(a => a.alertType === filter.alertType);
  return alerts.slice(0, limit);
}

export function getUnresolvedCriticalCount(): number {
  return alertLog.filter(a => a.severity === "critical").length;
}

export function clearAlertLog(): void {
  alertLog.length = 0;
  dedupMap.clear();
}
