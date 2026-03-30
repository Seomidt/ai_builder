/**
 * Phase 8 — Audit Context Extraction
 * INV-AUD3: Actor identity or explicit unknown classification must always be recorded.
 * INV-AUD10: Does not fork a second actor model — reuses Phase 6 ResolvedActor.
 */

import type { Request } from "express";
import type { ResolvedActor } from "../auth/actor-resolution.ts";
import type { AuditActorType, AuditSource, AuditEventStatus } from "./audit-actions.ts";
import crypto from "crypto";

// ─── AuditContext ─────────────────────────────────────────────────────────────

export interface AuditContext {
  tenantId: string;
  actorId: string | null;
  actorType: AuditActorType;
  requestId: string | null;
  correlationId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  auditSource: AuditSource;
  eventStatus: AuditEventStatus;
}

// ─── Phase 6 actor type → Phase 8 audit actor type mapping ───────────────────
// INV-AUD10: Reuses existing actor model without forking it.

function mapActorTypeToAudit(actorType: string): AuditActorType {
  const mapping: Record<string, AuditActorType> = {
    human: "user",
    service_account: "service_account",
    api_key: "api_key",
    system: "system",
    job: "job",
    webhook: "webhook",
    unresolved: "unknown",
  };
  return mapping[actorType] ?? "unknown";
}

function extractIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress ?? null;
}

function generateRequestId(): string {
  return `req_${crypto.randomBytes(8).toString("hex")}`;
}

// ─── buildAuditActorFromResolvedActor ─────────────────────────────────────────

export function buildAuditActorFromResolvedActor(actor: ResolvedActor | null | undefined): {
  actorId: string | null;
  actorType: AuditActorType;
} {
  if (!actor) return { actorId: null, actorType: "unknown" };
  return {
    actorId: actor.actorId ?? null,
    actorType: mapActorTypeToAudit(actor.actorType),
  };
}

// ─── buildAuditRequestMetadata ────────────────────────────────────────────────

export function buildAuditRequestMetadata(req: Request): {
  requestId: string;
  correlationId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
} {
  return {
    requestId: (req.headers["x-request-id"] as string) ?? generateRequestId(),
    correlationId: (req.headers["x-correlation-id"] as string) ?? null,
    ipAddress: extractIp(req),
    userAgent: (req.headers["user-agent"] as string) ?? null,
  };
}

// ─── buildAuditContextFromRequest ─────────────────────────────────────────────
// INV-AUD3: Degrades safely to partial_context if actor is not fully resolved.

export function buildAuditContextFromRequest(
  req: Request,
  opts?: {
    auditSource?: AuditSource;
    tenantIdOverride?: string;
  },
): AuditContext {
  const actor: ResolvedActor | undefined = (req as any).resolvedActor;
  const legacyUser = (req as any).user;

  const tenantId =
    opts?.tenantIdOverride ??
    actor?.tenantId ??
    legacyUser?.organizationId ??
    "unknown";

  const { actorId, actorType } = buildAuditActorFromResolvedActor(actor ?? null);
  const { requestId, correlationId, ipAddress, userAgent } = buildAuditRequestMetadata(req);

  const hasFullActor = actor && actor.actorType !== "unresolved";
  const eventStatus: AuditEventStatus = hasFullActor ? "committed" : "partial_context";

  return {
    tenantId,
    actorId: actorId ?? legacyUser?.id ?? null,
    actorType: hasFullActor ? actorType : (legacyUser?.id ? "user" : "unknown"),
    requestId,
    correlationId,
    ipAddress,
    userAgent,
    auditSource: opts?.auditSource ?? "application",
    eventStatus,
  };
}

// ─── buildSystemAuditContext ──────────────────────────────────────────────────

export function buildSystemAuditContext(opts: {
  tenantId: string;
  source?: AuditSource;
  correlationId?: string;
}): AuditContext {
  return {
    tenantId: opts.tenantId,
    actorId: "system",
    actorType: "system",
    requestId: `sys_${crypto.randomBytes(8).toString("hex")}`,
    correlationId: opts.correlationId ?? null,
    ipAddress: null,
    userAgent: null,
    auditSource: opts.source ?? "system_process",
    eventStatus: "committed",
  };
}

// ─── buildBestEffortAuditContext ──────────────────────────────────────────────

export function buildBestEffortAuditContext(opts: {
  tenantId: string;
  actorId?: string;
  actorType?: AuditActorType;
  ipAddress?: string;
  source?: AuditSource;
}): AuditContext {
  return {
    tenantId: opts.tenantId,
    actorId: opts.actorId ?? null,
    actorType: opts.actorType ?? "unknown",
    requestId: `be_${crypto.randomBytes(8).toString("hex")}`,
    correlationId: null,
    ipAddress: opts.ipAddress ?? null,
    userAgent: null,
    auditSource: opts.source ?? "application",
    eventStatus: "best_effort",
  };
}

// ─── explainAuditContext ──────────────────────────────────────────────────────
// INV-AUD7: Read-only — no writes.

export function explainAuditContext(ctx: AuditContext): {
  tenantId: string;
  actorId: string | null;
  actorType: AuditActorType;
  requestId: string | null;
  correlationId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  auditSource: AuditSource;
  eventStatus: AuditEventStatus;
  isFullyResolved: boolean;
  isBestEffort: boolean;
  note: string;
} {
  return {
    ...ctx,
    isFullyResolved: ctx.eventStatus === "committed",
    isBestEffort: ctx.eventStatus === "best_effort",
    note: "INV-AUD7: explainAuditContext is read-only — no writes performed.",
  };
}
