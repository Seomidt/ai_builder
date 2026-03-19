/**
 * Phase 13.2 / Phase 44 — Security Events Service
 *
 * Logs and queries security events. Security events are operational/security-domain
 * signals — they are DISTINCT from audit events (which are canonical governance history).
 *
 * Phase 44 additions:
 *   - csp_violation: browser-reported CSP violation (via /api/security/csp-report)
 *   - ai_input_rejected: AI input blocked by abuse guard (input cap, burst, pattern)
 *   - rate_limit_exceeded: fine-grained per-group rate limit trigger (replaces rate_limit_trigger
 *     which remains for backward compat; rate_limit_exceeded carries group-level metadata)
 *
 * INV-SEC-H7: Security events must never log secrets.
 * INV-SEC-H9: Security event reads must remain tenant-safe / admin-safe.
 * INV-SEC-P44-1: csp_violation metadata includes blockedUri, violatedDirective, documentUri (no PII).
 * INV-SEC-P44-2: ai_input_rejected metadata includes rejectionReason, inputLengthBytes (no content).
 * INV-SEC-P44-3: rate_limit_exceeded metadata includes group, maxRequests, windowSec, keyStrategy.
 */

import { db } from "../../db";
import { securityEvents, type InsertSecurityEvent } from "../../../shared/schema";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import { redactSensitiveFields } from "./log-redaction";

// ── Security event types ──────────────────────────────────────────────────────

// Phase 13.2 operational security event types
export const SECURITY_EVENT_TYPES_PHASE13 = [
  "auth_failure",
  "rate_limit_trigger",
  "invalid_input",
  "tenant_access_violation",
  "api_abuse",
  "oversized_payload",
  "security_header_violation",
] as const;

// Phase 44: new security event types for CSP, AI abuse, and fine-grained rate limiting
export const SECURITY_EVENT_TYPES_PHASE44 = [
  "csp_violation",
  "ai_input_rejected",
  "rate_limit_exceeded",
] as const;

// Combined canonical set — all valid event types
export const SECURITY_EVENT_TYPES = [
  ...SECURITY_EVENT_TYPES_PHASE13,
  ...SECURITY_EVENT_TYPES_PHASE44,
] as const;

// Phase 7 legacy event types (backward compat — kept in allowed constraint)
export const LEGACY_SECURITY_EVENT_TYPES = [
  "session_created",
  "session_revoked",
  "login_failed",
  "login_success",
] as const;

export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];
export type LegacySecurityEventType = (typeof LEGACY_SECURITY_EVENT_TYPES)[number];
export type AnySecurityEventType = SecurityEventType | LegacySecurityEventType;

// ── logSecurityEvent ──────────────────────────────────────────────────────────

export interface SecurityEventPayload {
  eventType: SecurityEventType;
  tenantId?: string | null;
  actorId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Fire-and-forget security event write.
 * Metadata is redacted before storage — never logs secrets.
 * Errors are caught and logged server-side only (never bubble to caller).
 */
export async function logSecurityEvent(payload: SecurityEventPayload): Promise<void> {
  try {
    const redactedMetadata = payload.metadata
      ? redactSensitiveFields(payload.metadata)
      : null;

    await db.insert(securityEvents).values({
      tenantId: payload.tenantId ?? null,
      actorId: payload.actorId ?? null,
      eventType: payload.eventType,
      ip: payload.ip ?? null,
      userAgent: payload.userAgent ?? null,
      requestId: payload.requestId ?? null,
      metadata: redactedMetadata as any,
    });
  } catch (err: unknown) {
    // Observability-only — security event failure must not disrupt request flow
    console.error("[security-events] logSecurityEvent error:", (err as Error).message);
  }
}

// ── Phase 44 convenience log functions ───────────────────────────────────────

/**
 * Log a browser-reported CSP violation.
 * INV-SEC-P44-1: no PII — only blockedUri, violatedDirective, documentUri logged.
 */
export async function logCspViolation(opts: {
  blockedUri:          string;
  violatedDirective:   string;
  documentUri:         string;
  ip?:                 string | null;
  requestId?:          string | null;
}): Promise<void> {
  return logSecurityEvent({
    eventType: "csp_violation",
    ip: opts.ip ?? null,
    requestId: opts.requestId ?? null,
    metadata: {
      blockedUri:        opts.blockedUri,
      violatedDirective: opts.violatedDirective,
      documentUri:       opts.documentUri,
    },
  });
}

/**
 * Log an AI input rejection event.
 * INV-SEC-P44-2: content is NEVER logged — only inputLengthBytes and rejectionReason.
 */
export async function logAiInputRejected(opts: {
  tenantId:          string;
  actorId?:          string | null;
  inputLengthBytes:  number;
  rejectionReason:   "input_too_long" | "burst_limit" | "pattern_match" | "token_cap";
  ip?:               string | null;
  requestId?:        string | null;
}): Promise<void> {
  return logSecurityEvent({
    eventType: "ai_input_rejected",
    tenantId:  opts.tenantId,
    actorId:   opts.actorId ?? null,
    ip:        opts.ip ?? null,
    requestId: opts.requestId ?? null,
    metadata: {
      inputLengthBytes: opts.inputLengthBytes,
      rejectionReason:  opts.rejectionReason,
    },
  });
}

/**
 * Log a fine-grained route-group rate limit exceeded event.
 * INV-SEC-P44-3: metadata includes group, maxRequests, windowSec, keyStrategy.
 */
export async function logRateLimitExceeded(opts: {
  tenantId?:      string | null;
  ip?:            string | null;
  requestId?:     string | null;
  group:          string;
  maxRequests:    number;
  windowSec:      number;
  keyStrategy:    string;
}): Promise<void> {
  return logSecurityEvent({
    eventType:  "rate_limit_exceeded",
    tenantId:   opts.tenantId ?? null,
    ip:         opts.ip ?? null,
    requestId:  opts.requestId ?? null,
    metadata: {
      group:       opts.group,
      maxRequests: opts.maxRequests,
      windowSec:   opts.windowSec,
      keyStrategy: opts.keyStrategy,
    },
  });
}

// ── listSecurityEventsByTenant ────────────────────────────────────────────────

/**
 * List security events for a specific tenant.
 * INV-SEC-H9: tenant-safe — only returns events for the requested tenant.
 */
export async function listSecurityEventsByTenant(
  tenantId: string,
  options: { limit?: number; eventType?: SecurityEventType } = {},
): Promise<(typeof securityEvents.$inferSelect)[]> {
  const limit = Math.min(options.limit ?? 50, 200);

  const conditions = options.eventType
    ? and(eq(securityEvents.tenantId, tenantId), eq(securityEvents.eventType, options.eventType))
    : eq(securityEvents.tenantId, tenantId);

  return db
    .select()
    .from(securityEvents)
    .where(conditions)
    .orderBy(desc(securityEvents.createdAt))
    .limit(limit);
}

// ── listRecentSecurityEvents ──────────────────────────────────────────────────

/**
 * List recent security events across all tenants.
 * Admin/internal use only — not exposed to tenant-level callers.
 */
export async function listRecentSecurityEvents(
  options: { limit?: number; since?: Date; eventType?: SecurityEventType } = {},
): Promise<(typeof securityEvents.$inferSelect)[]> {
  const limit = Math.min(options.limit ?? 100, 500);
  const since = options.since ?? new Date(Date.now() - 60 * 60 * 1_000); // 1 hour default

  const conditions = options.eventType
    ? and(gte(securityEvents.createdAt, since), eq(securityEvents.eventType, options.eventType))
    : gte(securityEvents.createdAt, since);

  return db
    .select()
    .from(securityEvents)
    .where(conditions)
    .orderBy(desc(securityEvents.createdAt))
    .limit(limit);
}

// ── explainSecurityEvent ──────────────────────────────────────────────────────

export interface SecurityEventExplanation {
  eventType: SecurityEventType;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  tenantImpact: boolean;
}

const EVENT_EXPLANATIONS: Record<SecurityEventType, Omit<SecurityEventExplanation, "eventType">> = {
  // Phase 13.2
  auth_failure:              { description: "Authentication attempt failed",                        severity: "medium",   tenantImpact: true  },
  rate_limit_trigger:        { description: "Request rate limit exceeded (legacy)",                 severity: "low",      tenantImpact: true  },
  invalid_input:             { description: "Invalid or malformed input detected",                  severity: "medium",   tenantImpact: true  },
  tenant_access_violation:   { description: "Cross-tenant access attempt detected",                 severity: "high",     tenantImpact: true  },
  api_abuse:                 { description: "API abuse pattern detected",                           severity: "high",     tenantImpact: true  },
  oversized_payload:         { description: "Request body exceeded size limit",                     severity: "low",      tenantImpact: false },
  security_header_violation: { description: "Security header policy violation detected",            severity: "medium",   tenantImpact: false },
  // Phase 44
  csp_violation:             { description: "Browser CSP violation reported",                       severity: "medium",   tenantImpact: false },
  ai_input_rejected:         { description: "AI input rejected by abuse guard (cap/burst/pattern)", severity: "high",     tenantImpact: true  },
  rate_limit_exceeded:       { description: "Fine-grained route-group rate limit exceeded",         severity: "low",      tenantImpact: true  },
};

export function explainSecurityEvent(eventType: SecurityEventType): SecurityEventExplanation {
  const explanation = EVENT_EXPLANATIONS[eventType];
  return { eventType, ...explanation };
}

// ── summarizeSecurityEvents ───────────────────────────────────────────────────

export interface SecurityEventSummary {
  totalEvents: number;
  byType: Record<string, number>;
  windowHours: number;
  windowStart: Date;
}

export async function summarizeSecurityEvents(
  options: { tenantId?: string; windowHours?: number } = {},
): Promise<SecurityEventSummary> {
  const windowHours = options.windowHours ?? 24;
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1_000);

  const baseCondition = options.tenantId
    ? and(gte(securityEvents.createdAt, windowStart), eq(securityEvents.tenantId, options.tenantId))
    : gte(securityEvents.createdAt, windowStart);

  const rows = await db
    .select({
      eventType: securityEvents.eventType,
      count: sql<number>`count(*)::int`,
    })
    .from(securityEvents)
    .where(baseCondition)
    .groupBy(securityEvents.eventType);

  const byType: Record<string, number> = {};
  let totalEvents = 0;
  for (const row of rows) {
    byType[row.eventType] = row.count;
    totalEvents += row.count;
  }

  return { totalEvents, byType, windowHours, windowStart };
}
