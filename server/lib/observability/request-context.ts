/**
 * Phase 25 — Request Context & Tracing
 * Generates and manages request IDs, correlation IDs, and trace metadata.
 * Augments Phase 13.1 request-id middleware with richer context management.
 */

import crypto from "crypto";

// ── Context types ──────────────────────────────────────────────────────────────

export interface RequestContext {
  requestId: string;
  correlationId: string;
  traceTimestamp: string;
  traceTimestampMs: number;
  tenantId?: string;
  actorId?: string;
  sessionId?: string;
  source?: string; // "api" | "webhook" | "job" | "ai_run"
}

export interface TraceHeaders {
  "X-Request-ID": string;
  "X-Correlation-ID": string;
  "X-Trace-Timestamp": string;
}

// ── ID generation ──────────────────────────────────────────────────────────────

/**
 * Generate a request ID (UUID v4 format).
 */
export function generateRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Generate a correlation ID.
 * Can be provided by an upstream caller via X-Correlation-ID header,
 * or generated fresh if not present.
 */
export function generateCorrelationId(upstream?: string): string {
  if (upstream && isValidCorrelationId(upstream)) return upstream;
  return `corr-${Date.now()}-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * Validate that a correlation ID looks legitimate.
 */
export function isValidCorrelationId(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  if (id.length > 128) return false;
  // Allow UUIDs, our corr-* format, and other reasonable IDs
  return /^[a-zA-Z0-9\-_.]+$/.test(id);
}

/**
 * Validate that a request ID looks legitimate.
 */
export function isValidRequestId(id: string): boolean {
  if (!id || typeof id !== "string") return false;
  if (id.length > 128) return false;
  return /^[a-zA-Z0-9\-_]+$/.test(id);
}

// ── Context builder ────────────────────────────────────────────────────────────

/**
 * Build a fresh request context.
 */
export function buildRequestContext(params?: {
  correlationId?: string;
  tenantId?: string;
  actorId?: string;
  sessionId?: string;
  source?: string;
}): RequestContext {
  const now = Date.now();
  return {
    requestId: generateRequestId(),
    correlationId: generateCorrelationId(params?.correlationId),
    traceTimestamp: new Date(now).toISOString(),
    traceTimestampMs: now,
    tenantId: params?.tenantId,
    actorId: params?.actorId,
    sessionId: params?.sessionId,
    source: params?.source,
  };
}

/**
 * Extract context from incoming HTTP headers.
 */
export function extractContextFromHeaders(headers: Record<string, string | string[] | undefined>): {
  requestId?: string;
  correlationId?: string;
} {
  const getHeader = (key: string): string | undefined => {
    const val = headers[key.toLowerCase()] ?? headers[key];
    return Array.isArray(val) ? val[0] : val;
  };

  const requestId = getHeader("x-request-id");
  const correlationId = getHeader("x-correlation-id");

  return {
    requestId: requestId && isValidRequestId(requestId) ? requestId : undefined,
    correlationId: correlationId && isValidCorrelationId(correlationId) ? correlationId : undefined,
  };
}

/**
 * Build response trace headers from a request context.
 */
export function buildTraceHeaders(ctx: RequestContext): TraceHeaders {
  return {
    "X-Request-ID":    ctx.requestId,
    "X-Correlation-ID": ctx.correlationId,
    "X-Trace-Timestamp": ctx.traceTimestamp,
  };
}

// ── Trace enrichment ───────────────────────────────────────────────────────────

/**
 * Enrich a log entry with trace context.
 */
export function enrichWithContext<T extends Record<string, unknown>>(
  data: T,
  ctx: RequestContext,
): T & { request_id: string; correlation_id: string; trace_timestamp: string } {
  return {
    ...data,
    request_id: ctx.requestId,
    correlation_id: ctx.correlationId,
    trace_timestamp: ctx.traceTimestamp,
  };
}

/**
 * Enrich a webhook delivery payload with trace headers.
 */
export function enrichWebhookPayload(
  payload: Record<string, unknown>,
  ctx: RequestContext,
): Record<string, unknown> {
  return {
    ...payload,
    _trace: {
      request_id: ctx.requestId,
      correlation_id: ctx.correlationId,
      timestamp: ctx.traceTimestamp,
    },
  };
}

/**
 * Enrich a background job with trace context.
 */
export function enrichJobContext(
  jobData: Record<string, unknown>,
  ctx: RequestContext,
): Record<string, unknown> {
  return {
    ...jobData,
    _ctx: {
      request_id: ctx.requestId,
      correlation_id: ctx.correlationId,
      tenant_id: ctx.tenantId,
      source: ctx.source ?? "job",
      enqueued_at: ctx.traceTimestamp,
    },
  };
}

// ── Span-like timing ───────────────────────────────────────────────────────────

export interface TraceSpan {
  spanId: string;
  parentId?: string;
  name: string;
  startMs: number;
  endMs?: number;
  durationMs?: number;
  status: "active" | "completed" | "error";
  metadata: Record<string, unknown>;
}

/**
 * Start a trace span.
 */
export function startSpan(name: string, parentId?: string): TraceSpan {
  return {
    spanId: `span-${crypto.randomBytes(6).toString("hex")}`,
    parentId,
    name,
    startMs: Date.now(),
    status: "active",
    metadata: {},
  };
}

/**
 * End a trace span.
 */
export function endSpan(span: TraceSpan, status: "completed" | "error" = "completed"): TraceSpan {
  const endMs = Date.now();
  return {
    ...span,
    endMs,
    durationMs: endMs - span.startMs,
    status,
  };
}

// ── Context propagation for AI runs ───────────────────────────────────────────

export function buildAiRunContext(params: {
  tenantId: string;
  agentId?: string;
  runId?: string;
}): RequestContext {
  return buildRequestContext({
    tenantId: params.tenantId,
    source: "ai_run",
    actorId: params.agentId,
    sessionId: params.runId,
  });
}
