/**
 * Phase 25 — Security Metrics & Observability
 * Tracks request latency, error rates, rate limit triggers, security violations,
 * and webhook failure spikes. Exposes aggregated metrics for the health endpoint.
 */

// ── Metric types ───────────────────────────────────────────────────────────────

export interface LatencyRecord {
  endpoint: string;
  method: string;
  latencyMs: number;
  statusCode: number;
  tenantId?: string;
  timestamp: number;
}

export interface ErrorRecord {
  endpoint: string;
  method: string;
  statusCode: number;
  errorCode?: string;
  tenantId?: string;
  timestamp: number;
}

export interface SecurityViolation {
  type: "rate_limit" | "payload_too_large" | "csp_violation" | "auth_failure" | "cors_violation" | "injection_attempt";
  endpoint?: string;
  tenantId?: string;
  ip?: string;
  severity: "low" | "medium" | "high" | "critical";
  detail?: string;
  timestamp: number;
}

export interface WebhookFailureRecord {
  endpointId: string;
  tenantId: string;
  eventType: string;
  httpStatusCode?: number;
  latencyMs?: number;
  timestamp: number;
}

// ── In-memory metrics store ────────────────────────────────────────────────────

const latencyRecords: LatencyRecord[] = [];
const errorRecords: ErrorRecord[] = [];
const securityViolations: SecurityViolation[] = [];
const webhookFailures: WebhookFailureRecord[] = [];
const rateLimitTriggers: Array<{ key: string; policy: string; timestamp: number }> = [];

const MAX_RECORDS = 10_000;

function pruneIfNeeded<T>(arr: T[], max: number = MAX_RECORDS): void {
  if (arr.length > max) arr.splice(0, arr.length - max);
}

// ── Recording ──────────────────────────────────────────────────────────────────

/**
 * Record a request latency measurement.
 */
export function recordLatency(record: Omit<LatencyRecord, "timestamp">): void {
  latencyRecords.push({ ...record, timestamp: Date.now() });
  pruneIfNeeded(latencyRecords);
}

/**
 * Record an API error.
 */
export function recordError(record: Omit<ErrorRecord, "timestamp">): void {
  errorRecords.push({ ...record, timestamp: Date.now() });
  pruneIfNeeded(errorRecords);
}

/**
 * Record a security violation.
 */
export function recordSecurityViolation(violation: Omit<SecurityViolation, "timestamp">): void {
  securityViolations.push({ ...violation, timestamp: Date.now() });
  pruneIfNeeded(securityViolations);
}

/**
 * Record a rate limit trigger.
 */
export function recordRateLimitTrigger(key: string, policy: string): void {
  rateLimitTriggers.push({ key, policy, timestamp: Date.now() });
  pruneIfNeeded(rateLimitTriggers);
}

/**
 * Record a webhook delivery failure.
 */
export function recordWebhookFailure(record: Omit<WebhookFailureRecord, "timestamp">): void {
  webhookFailures.push({ ...record, timestamp: Date.now() });
  pruneIfNeeded(webhookFailures);
}

// ── Aggregation ────────────────────────────────────────────────────────────────

const windowMs = (minutes: number) => Date.now() - minutes * 60_000;

/**
 * Get latency statistics for the last N minutes.
 */
export function getLatencyStats(windowMinutes: number = 5): {
  count: number;
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  byEndpoint: Record<string, { count: number; avgMs: number }>;
} {
  const cutoff = windowMs(windowMinutes);
  const recent = latencyRecords.filter(r => r.timestamp >= cutoff);
  if (recent.length === 0) return { count: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, byEndpoint: {} };

  const latencies = recent.map(r => r.latencyMs).sort((a, b) => a - b);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p = (pct: number) => latencies[Math.floor(latencies.length * pct)] ?? 0;

  const byEndpoint: Record<string, { count: number; avgMs: number }> = {};
  for (const r of recent) {
    const e = byEndpoint[r.endpoint] ?? { count: 0, avgMs: 0 };
    byEndpoint[r.endpoint] = { count: e.count + 1, avgMs: (e.avgMs * e.count + r.latencyMs) / (e.count + 1) };
  }

  return {
    count: latencies.length,
    avgMs: Math.round(avg),
    p50Ms: p(0.5),
    p95Ms: p(0.95),
    p99Ms: p(0.99),
    maxMs: latencies[latencies.length - 1],
    byEndpoint,
  };
}

/**
 * Get error rate statistics.
 */
export function getErrorRateStats(windowMinutes: number = 5): {
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  byStatusCode: Record<number, number>;
  byEndpoint: Record<string, number>;
} {
  const cutoff = windowMs(windowMinutes);
  const totalRequests = latencyRecords.filter(r => r.timestamp >= cutoff).length;
  const recentErrors = errorRecords.filter(r => r.timestamp >= cutoff);

  const byStatusCode: Record<number, number> = {};
  const byEndpoint: Record<string, number> = {};
  for (const e of recentErrors) {
    byStatusCode[e.statusCode] = (byStatusCode[e.statusCode] ?? 0) + 1;
    byEndpoint[e.endpoint] = (byEndpoint[e.endpoint] ?? 0) + 1;
  }

  return {
    totalRequests,
    totalErrors: recentErrors.length,
    errorRate: totalRequests > 0 ? parseFloat((recentErrors.length / totalRequests * 100).toFixed(2)) : 0,
    byStatusCode,
    byEndpoint,
  };
}

/**
 * Get security violation statistics.
 */
export function getSecurityViolationStats(windowMinutes: number = 60): {
  total: number;
  byType: Record<string, number>;
  bySeverity: Record<string, number>;
  recentCritical: SecurityViolation[];
} {
  const cutoff = windowMs(windowMinutes);
  const recent = securityViolations.filter(v => v.timestamp >= cutoff);

  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const v of recent) {
    byType[v.type] = (byType[v.type] ?? 0) + 1;
    bySeverity[v.severity] = (bySeverity[v.severity] ?? 0) + 1;
  }

  return {
    total: recent.length,
    byType,
    bySeverity,
    recentCritical: recent.filter(v => v.severity === "critical").slice(-10),
  };
}

/**
 * Get rate limit trigger statistics.
 */
export function getRateLimitTriggerStats(windowMinutes: number = 15): {
  total: number;
  byPolicy: Record<string, number>;
} {
  const cutoff = windowMs(windowMinutes);
  const recent = rateLimitTriggers.filter(r => r.timestamp >= cutoff);
  const byPolicy: Record<string, number> = {};
  for (const r of recent) {
    byPolicy[r.policy] = (byPolicy[r.policy] ?? 0) + 1;
  }
  return { total: recent.length, byPolicy };
}

/**
 * Detect webhook failure spikes.
 */
export function detectWebhookFailureSpike(windowMinutes: number = 5, threshold: number = 10): {
  spike: boolean;
  failureCount: number;
  threshold: number;
  affectedEndpoints: string[];
} {
  const cutoff = windowMs(windowMinutes);
  const recent = webhookFailures.filter(f => f.timestamp >= cutoff);
  const affectedEndpoints = [...new Set(recent.map(f => f.endpointId))];
  return {
    spike: recent.length >= threshold,
    failureCount: recent.length,
    threshold,
    affectedEndpoints,
  };
}

// ── Health summary ─────────────────────────────────────────────────────────────

export interface SecurityHealthSummary {
  latency: ReturnType<typeof getLatencyStats>;
  errors: ReturnType<typeof getErrorRateStats>;
  violations: ReturnType<typeof getSecurityViolationStats>;
  rateLimits: ReturnType<typeof getRateLimitTriggerStats>;
  webhookFailures: ReturnType<typeof detectWebhookFailureSpike>;
  recordCounts: {
    latency: number;
    errors: number;
    violations: number;
    rateLimits: number;
    webhookFailures: number;
  };
}

/**
 * Get the full security health summary.
 */
export function getSecurityHealthSummary(): SecurityHealthSummary {
  return {
    latency:       getLatencyStats(5),
    errors:        getErrorRateStats(5),
    violations:    getSecurityViolationStats(60),
    rateLimits:    getRateLimitTriggerStats(15),
    webhookFailures: detectWebhookFailureSpike(5),
    recordCounts: {
      latency:       latencyRecords.length,
      errors:        errorRecords.length,
      violations:    securityViolations.length,
      rateLimits:    rateLimitTriggers.length,
      webhookFailures: webhookFailures.length,
    },
  };
}

// ── Reset (for testing) ────────────────────────────────────────────────────────

export function resetMetrics(): void {
  latencyRecords.length = 0;
  errorRecords.length = 0;
  securityViolations.length = 0;
  webhookFailures.length = 0;
  rateLimitTriggers.length = 0;
}
