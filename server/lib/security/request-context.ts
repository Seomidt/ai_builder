/**
 * Phase 13.2 — Security Request Context
 *
 * Helpers for accessing and propagating request correlation identifiers
 * across route handlers, AI runtime logging, and security event logging.
 *
 * INV-SEC-H6: request_id must be attached and propagated consistently.
 * INV-SEC-H10: Explain helpers must not perform unexpected writes.
 */

import type { Request } from "express";

// ── getRequestId ──────────────────────────────────────────────────────────────

/**
 * Returns the request_id attached by requestIdMiddleware.
 * Falls back to "unknown" if middleware was not yet applied (e.g. tests).
 */
export function getRequestId(req: Request): string {
  return (req as any).requestId ?? "unknown";
}

// ── RequestSecurityContext ────────────────────────────────────────────────────

export interface RequestSecurityContext {
  request_id: string;
  actor_id: string | null;
  tenant_id: string | null;
  ip: string | null;
  user_agent: string | null;
  method: string;
  path: string;
  request_start_ms: number | null;
}

/**
 * Returns a structured security context for a request.
 * Safe to include in logs and security events — no secrets exposed.
 */
export function getRequestSecurityContext(req: Request): RequestSecurityContext {
  const user = (req as any).user;
  return {
    request_id: getRequestId(req),
    actor_id: user?.id ?? null,
    tenant_id: user?.organizationId ?? null,
    // Use socket address — avoids X-Forwarded-For spoofing
    ip: req.socket?.remoteAddress ?? null,
    user_agent: (req.headers["user-agent"] as string) ?? null,
    method: req.method,
    path: req.path,
    request_start_ms: (req as any).requestStartMs ?? null,
  };
}

// ── explainRequestCorrelation ─────────────────────────────────────────────────

export interface RequestCorrelationExplanation {
  requestIdSource: string;
  callerPreservation: boolean;
  responseHeaderName: string;
  propagatedTo: string[];
  redactedFields: string[];
}

/**
 * Read-only explanation of request correlation behavior.
 */
export function explainRequestCorrelation(): RequestCorrelationExplanation {
  return {
    requestIdSource: "X-Request-Id header (caller-provided) or crypto.randomUUID()",
    callerPreservation: true,
    responseHeaderName: "X-Request-Id",
    propagatedTo: [
      "req.requestId",
      "structured request logs",
      "error response payloads",
      "security event records",
    ],
    redactedFields: [
      "Authorization header value",
      "Cookie header value",
      "request body (not logged)",
    ],
  };
}
