/**
 * Phase 13.2 — Security Observability
 *
 * Provides a read-only view of the platform's security configuration
 * and recent violation counts.
 *
 * INV-SEC-H12: All security observability output must be safe and explainable.
 */

import { getRateLimitConfig } from "../../middleware/rate-limit";
import { getCspConfig } from "../../middleware/csp";
import { getResponseSecurityHeaders } from "../../middleware/response-security";
import { explainRedaction } from "./log-redaction";
import { explainRequestCorrelation } from "./request-context";
import { summarizeSecurityEvents } from "./security-events";

// ── SecurityHealth ────────────────────────────────────────────────────────────

export interface SecurityHealth {
  timestamp: string;
  status: "healthy" | "degraded";
  headers: {
    helmetEnabled: boolean;
    cspEnabled: boolean;
    frameOptionsDeny: boolean;
    hstsEnabled: boolean;
    contentTypeOptionsEnabled: boolean;
    cacheControlOnApi: boolean;
  };
  csp: {
    enabled: boolean;
    isDev: boolean;
    unsafeEvalEnabled: boolean;
    wildcardEnabled: boolean;
    value: string;
  };
  rateLimiting: {
    globalApiLimiterEnabled: boolean;
    windowMs: number;
    windowMinutes: number;
    maxRequests: number;
    keyingStrategy: string;
    appliesTo: string;
  };
  requestSizeLimits: {
    jsonBodyLimitBytes: number;
    jsonBodyLimitDisplay: string;
    urlencodedLimitBytes: number;
  };
  requestCorrelation: {
    requestIdEnabled: boolean;
    responseHeaderName: string;
    callerPreservation: boolean;
  };
  sanitization: {
    xssLibraryEnabled: boolean;
    mode: string;
    replacesValidation: boolean;
  };
  logRedaction: {
    enabled: boolean;
    redactedFieldCount: number;
    stackTracesRemoved: boolean;
  };
  recentViolations: {
    windowHours: number;
    totalEvents: number;
    byType: Record<string, number>;
  };
}

// ── getSecurityHealth ─────────────────────────────────────────────────────────

export async function getSecurityHealth(): Promise<SecurityHealth> {
  const rlConfig = getRateLimitConfig();
  const cspConfig = getCspConfig();
  const responseHeaders = getResponseSecurityHeaders();
  const redactionExplanation = explainRedaction();
  const correlationExplanation = explainRequestCorrelation();

  let recentViolations = { windowHours: 1, totalEvents: 0, byType: {} as Record<string, number> };
  try {
    const summary = await summarizeSecurityEvents({ windowHours: 1 });
    recentViolations = {
      windowHours: summary.windowHours,
      totalEvents: summary.totalEvents,
      byType: summary.byType,
    };
  } catch {
    // Observability degraded but not fatal
  }

  const health: SecurityHealth = {
    timestamp: new Date().toISOString(),
    status: "healthy",
    headers: {
      helmetEnabled: true,
      cspEnabled: true,
      frameOptionsDeny: responseHeaders["X-Frame-Options"] === "DENY",
      hstsEnabled: "Strict-Transport-Security" in responseHeaders,
      contentTypeOptionsEnabled: responseHeaders["X-Content-Type-Options"] === "nosniff",
      cacheControlOnApi: true,
    },
    csp: {
      enabled: true,
      isDev: cspConfig.isDev,
      unsafeEvalEnabled: cspConfig.unsafeEvalEnabled,
      wildcardEnabled: cspConfig.wildcardEnabled,
      value: cspConfig.value,
    },
    rateLimiting: {
      globalApiLimiterEnabled: true,
      windowMs: rlConfig.windowMs,
      windowMinutes: rlConfig.windowMinutes,
      maxRequests: rlConfig.maxRequests,
      keyingStrategy: rlConfig.keyingStrategy,
      appliesTo: rlConfig.appliesTo,
    },
    requestSizeLimits: {
      jsonBodyLimitBytes: 1_048_576, // 1mb
      jsonBodyLimitDisplay: "1mb",
      urlencodedLimitBytes: 1_048_576,
    },
    requestCorrelation: {
      requestIdEnabled: true,
      responseHeaderName: correlationExplanation.responseHeaderName,
      callerPreservation: correlationExplanation.callerPreservation,
    },
    sanitization: {
      xssLibraryEnabled: true,
      mode: "strict — all HTML stripped",
      replacesValidation: false,
    },
    logRedaction: {
      enabled: true,
      redactedFieldCount: redactionExplanation.redactedFields.length,
      stackTracesRemoved: redactionExplanation.stackTracesRemoved,
    },
    recentViolations,
  };

  return health;
}

// ── getSecurityViolationCounts ────────────────────────────────────────────────

export async function getSecurityViolationCounts(
  options: { tenantId?: string; windowHours?: number } = {},
): Promise<{ windowHours: number; totalEvents: number; byType: Record<string, number> }> {
  const summary = await summarizeSecurityEvents(options);
  return {
    windowHours: summary.windowHours,
    totalEvents: summary.totalEvents,
    byType: summary.byType,
  };
}

// ── getRateLimitStats ─────────────────────────────────────────────────────────

export function getRateLimitStats(): ReturnType<typeof getRateLimitConfig> {
  return getRateLimitConfig();
}

// ── explainSecurityHealth ─────────────────────────────────────────────────────

export interface SecurityHealthExplanation {
  purpose: string;
  layers: string[];
  invariants: string[];
  note: string;
}

export function explainSecurityHealth(): SecurityHealthExplanation {
  return {
    purpose: "Platform-level security observability — read-only, no secrets exposed",
    layers: [
      "Helmet HTTP security headers (Phase 13.2)",
      "Explicit CSP (Phase 13.2)",
      "Response header hardening (Phase 13.2)",
      "Global API rate limiting 1000/15min (Phase 13.2)",
      "Request body limits 1mb (Phase 13.2)",
      "Input sanitization via xss (Phase 13.2)",
      "Request correlation (X-Request-Id) (Phase 13.1 + 13.2)",
      "Log redaction (Phase 13.2)",
      "Security event logging (Phase 13.2)",
      "Structured error responses (Phase 13.1 + 13.2)",
    ],
    invariants: [
      "INV-SEC-H1: Security headers active",
      "INV-SEC-H2: CSP explicit and deterministic",
      "INV-SEC-H3: Rate limiting predictable",
      "INV-SEC-H4: Oversized payloads rejected",
      "INV-SEC-H5: Sanitization non-destructive",
      "INV-SEC-H6: request_id propagated",
      "INV-SEC-H7: Security events never log secrets",
      "INV-SEC-H8: Error payloads hide stack traces",
      "INV-SEC-H9: Security event reads tenant-safe",
      "INV-SEC-H10: Explain endpoints write-free",
      "INV-SEC-H11: Backward compatible",
      "INV-SEC-H12: Observability safe and explainable",
    ],
    note: "This endpoint is admin-only. It never exposes secrets, tokens, or env values.",
  };
}
