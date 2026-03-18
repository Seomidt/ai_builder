/**
 * Phase 13.1 — Request ID + Structured Logging Middleware
 * Generates a UUID (v4) per request and attaches it to req.requestId.
 * Emits structured log entries on response finish:
 *   { request_id, tenant_id, actor_id, endpoint, method, status, latency_ms }
 *
 * The request ID is also set as the X-Request-Id response header so clients
 * can correlate their own logs with server-side logs.
 */

import type { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

// ── Extend Express Request ────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      requestStartMs: number;
    }
  }
}

// ── Structured log entry shape ────────────────────────────────────────────────

export interface RequestLogEntry {
  request_id: string;
  tenant_id: string | null;
  actor_id: string | null;
  endpoint: string;
  method: string;
  status: number;
  latency_ms: number;
}

// ── requestIdMiddleware ───────────────────────────────────────────────────────

/**
 * Attach a UUID request ID to every request.
 * Prefer the X-Request-Id header from the caller if present and valid.
 */
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const incoming = req.headers["x-request-id"];
  const id =
    typeof incoming === "string" && incoming.length > 0
      ? incoming
      : randomUUID();

  req.requestId = id;
  req.requestStartMs = Date.now();
  res.setHeader("X-Request-Id", id);
  next();
}

// ── structuredLoggingMiddleware ───────────────────────────────────────────────

/**
 * Emit a structured JSON log line per API request.
 * Only logs /api/* paths to avoid noise from static asset serving.
 */
export function structuredLoggingMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.path.startsWith("/api")) return next();

  res.on("finish", () => {
    const latencyMs = Date.now() - (req.requestStartMs ?? Date.now());
    const entry: RequestLogEntry = {
      request_id: req.requestId ?? "unknown",
      tenant_id: req.user?.organizationId ?? null,
      actor_id: req.user?.id ?? null,
      endpoint: req.path,
      method: req.method,
      status: res.statusCode,
      latency_ms: latencyMs,
    };
    // Emit structured log — never include req/res body to avoid PII leakage
    console.log("[req]", JSON.stringify(entry));
  });

  next();
}
