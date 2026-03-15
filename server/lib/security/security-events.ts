/**
 * Phase 13.2 — Security Events Service
 *
 * Logs and queries security events. Security events are operational/security-domain
 * signals — they are DISTINCT from audit events (which are canonical governance history).
 *
 * INV-SEC-H7: Security events must never log secrets.
 * INV-SEC-H9: Security event reads must remain tenant-safe / admin-safe.
 */

import { db } from "../../db";
import { securityEvents, type InsertSecurityEvent } from "../../../shared/schema";
import { eq, desc, and, gte, sql } from "drizzle-orm";
import { redactSensitiveFields } from "./log-redaction";

// ── Security event types ──────────────────────────────────────────────────────

// Phase 13.2 operational security event types
export const SECURITY_EVENT_TYPES = [
  "auth_failure",
  "rate_limit_trigger",
  "invalid_input",
  "tenant_access_violation",
  "api_abuse",
  "oversized_payload",
  "security_header_violation",
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
  auth_failure: { description: "Authentication attempt failed", severity: "medium", tenantImpact: true },
  rate_limit_trigger: { description: "Request rate limit exceeded", severity: "low", tenantImpact: true },
  invalid_input: { description: "Invalid or malformed input detected", severity: "medium", tenantImpact: true },
  tenant_access_violation: { description: "Cross-tenant access attempt detected", severity: "high", tenantImpact: true },
  api_abuse: { description: "API abuse pattern detected", severity: "high", tenantImpact: true },
  oversized_payload: { description: "Request body exceeded size limit", severity: "low", tenantImpact: false },
  security_header_violation: { description: "Security header policy violation detected", severity: "medium", tenantImpact: false },
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
