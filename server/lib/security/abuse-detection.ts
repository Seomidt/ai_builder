/**
 * Phase 25 — Abuse Detection
 * Detects and flags suspicious API, prompt, webhook, and evaluation abuse.
 */

// ── Abuse event types ──────────────────────────────────────────────────────────

export type AbuseCategory =
  | "api_flooding"
  | "prompt_abuse"
  | "webhook_abuse"
  | "evaluation_abuse"
  | "auth_abuse"
  | "payload_abuse"
  | "scraping"
  | "none";

export type AbuseSeverity = "low" | "medium" | "high" | "critical";

export interface AbuseEvent {
  id: string;
  tenantId?: string;
  ip?: string;
  category: AbuseCategory;
  severity: AbuseSeverity;
  description: string;
  metadata: Record<string, unknown>;
  detectedAt: Date;
  flagged: boolean;
}

// ── In-memory abuse event log ──────────────────────────────────────────────────

let abuseEvents: AbuseEvent[] = [];
let eventIdCounter = 0;

function generateEventId(): string {
  return `abuse-${Date.now()}-${++eventIdCounter}`;
}

// ── Abuse detection rules ──────────────────────────────────────────────────────

// Track request counts for flooding detection
const requestCounters = new Map<string, number[]>(); // key → timestamps array

function recordRequest(key: string): void {
  const now = Date.now();
  const existing = requestCounters.get(key) ?? [];
  // Keep only last 60 seconds of timestamps
  const filtered = existing.filter(ts => now - ts < 60_000);
  filtered.push(now);
  requestCounters.set(key, filtered);
}

function getRequestCount(key: string, windowMs: number = 60_000): number {
  const now = Date.now();
  const timestamps = requestCounters.get(key) ?? [];
  return timestamps.filter(ts => now - ts < windowMs).length;
}

// ── API flooding detection ─────────────────────────────────────────────────────

export interface ApiFloodingCheck {
  flooding: boolean;
  requestsPerMinute: number;
  threshold: number;
  severity: AbuseSeverity;
}

/**
 * Check for API flooding from a tenant or IP.
 */
export function checkApiFlooding(params: {
  tenantId?: string;
  ip?: string;
  endpoint?: string;
  threshold?: number;
}): ApiFloodingCheck {
  const key = params.tenantId
    ? `api:${params.tenantId}:${params.endpoint ?? "*"}`
    : `ip:${params.ip ?? "unknown"}`;
  const threshold = params.threshold ?? 100; // requests per minute

  recordRequest(key);
  const count = getRequestCount(key, 60_000);
  const flooding = count > threshold;

  let severity: AbuseSeverity = "none" as AbuseSeverity;
  if (flooding) {
    if (count > threshold * 5) severity = "critical";
    else if (count > threshold * 3) severity = "high";
    else if (count > threshold * 2) severity = "medium";
    else severity = "low";
  }

  return { flooding, requestsPerMinute: count, threshold, severity };
}

// ── Prompt abuse detection ─────────────────────────────────────────────────────

export interface PromptAbuseCheck {
  abusive: boolean;
  reasons: string[];
  severity: AbuseSeverity;
}

const PROMPT_ABUSE_PATTERNS = [
  { pattern: /(.{10,})\1{5,}/i, reason: "Highly repetitive content (>5x repeat)" },
  { pattern: /(?:[^\s]+\s){500,}/, reason: "Abnormally long single-sentence prompt (>500 words no structure)" },
  { pattern: /([\u0000-\u001f]|\\\d{1,3}){20,}/, reason: "Excessive control/escape characters" },
  { pattern: /\b(eval|exec|system|subprocess|os\.)\s*\(/, reason: "Code injection attempt" },
  // Phase 42 fix: hardened regex handles all dangerous variants:
  //   <script>...</script>        — standard
  //   <SCRIPT>...</SCRIPT>        — uppercase (i flag)
  //   <script >...</script >      — space before >
  //   <script\n>...</script\n>    — newline before >
  //   multi-line script blocks    — [\s\S] instead of .
  // Previous: /<script[\s>].*?<\/script>/is — missed </script > (space before >)
  { pattern: /<script\b[^>]*>[\s\S]*?<\/script\s*>/is, reason: "Script injection attempt" },
  { pattern: /\bSELECT\b.*\bFROM\b.*\bWHERE\b/i, reason: "SQL injection in prompt" },
];

/**
 * Detect prompt abuse patterns (beyond governance safety scanning).
 */
export function checkPromptAbuse(prompt: string, tenantId?: string): PromptAbuseCheck {
  const reasons: string[] = [];

  for (const { pattern, reason } of PROMPT_ABUSE_PATTERNS) {
    if (pattern.test(prompt)) reasons.push(reason);
  }

  // Unusually large prompt (> 10K chars but governance allows it)
  if (prompt.length > 10_000) reasons.push(`Oversized prompt: ${prompt.length} chars`);

  // Rapid identical-prompt detection
  if (tenantId) {
    const key = `prompt:${tenantId}:${Buffer.from(prompt.slice(0, 100)).toString("base64")}`;
    recordRequest(key);
    const count = getRequestCount(key, 60_000);
    if (count > 10) reasons.push(`Same prompt submitted ${count} times in 60s (farming)`);
  }

  const abusive = reasons.length > 0;
  let severity: AbuseSeverity = "none" as AbuseSeverity;
  if (abusive) {
    if (reasons.length >= 3) severity = "critical";
    else if (reasons.length === 2) severity = "high";
    else severity = "medium";
  }

  return { abusive, reasons, severity };
}

// ── Webhook abuse detection ────────────────────────────────────────────────────

export interface WebhookUrlCheck {
  safe: boolean;
  issues: string[];
}

const PRIVATE_IP_RANGES = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^::1$/,
  /^fc00:/,
  /^fe80:/,
  /^0\.0\.0\.0$/,
  /^169\.254\./,     // link-local
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // shared address space
];

/**
 * Validate a webhook target URL for security.
 */
export function validateWebhookUrl(url: string): WebhookUrlCheck {
  const issues: string[] = [];

  try {
    const parsed = new URL(url);

    // HTTPS only
    if (parsed.protocol !== "https:") {
      issues.push(`Webhook must use HTTPS (got ${parsed.protocol})`);
    }

    // Reject private IP targets
    const hostname = parsed.hostname;
    for (const pattern of PRIVATE_IP_RANGES) {
      if (pattern.test(hostname)) {
        issues.push(`Private/internal IP target rejected: ${hostname}`);
        break;
      }
    }

    // Reject suspicious ports
    const port = parseInt(parsed.port || (parsed.protocol === "https:" ? "443" : "80"));
    if (![443, 8443].includes(port) && parsed.port !== "") {
      issues.push(`Non-standard port: ${port} (expected 443 or 8443)`);
    }

    // Maximum URL length
    if (url.length > 2048) {
      issues.push(`URL too long: ${url.length} chars (max 2048)`);
    }

    // No credentials in URL
    if (parsed.username || parsed.password) {
      issues.push("URL must not contain credentials");
    }

  } catch {
    issues.push("Invalid URL format");
  }

  return { safe: issues.length === 0, issues };
}

/**
 * Check for webhook endpoint abuse (too many failures).
 */
export function checkWebhookEndpointAbuse(endpointId: string, recentFailures: number): {
  shouldDisable: boolean;
  severity: AbuseSeverity;
  reason?: string;
} {
  if (recentFailures >= 20) {
    return { shouldDisable: true, severity: "critical", reason: `${recentFailures} consecutive failures — endpoint disabled` };
  }
  if (recentFailures >= 10) {
    return { shouldDisable: false, severity: "high", reason: `${recentFailures} failures — endpoint at risk` };
  }
  if (recentFailures >= 5) {
    return { shouldDisable: false, severity: "medium", reason: `${recentFailures} failures — monitor endpoint` };
  }
  return { shouldDisable: false, severity: "low" };
}

// ── Evaluation abuse detection ─────────────────────────────────────────────────

export interface EvaluationAbuseCheck {
  abusive: boolean;
  requestsPerMinute: number;
  severity: AbuseSeverity;
}

/**
 * Detect evaluation API abuse (bulk automated evaluations).
 */
export function checkEvaluationAbuse(tenantId: string, threshold: number = 30): EvaluationAbuseCheck {
  const key = `eval:${tenantId}`;
  recordRequest(key);
  const count = getRequestCount(key, 60_000);
  const abusive = count > threshold;
  const severity: AbuseSeverity = !abusive ? "none" as AbuseSeverity
    : count > threshold * 5 ? "critical"
    : count > threshold * 2 ? "high"
    : "medium";
  return { abusive, requestsPerMinute: count, severity };
}

// ── Abuse event management ─────────────────────────────────────────────────────

/**
 * Log an abuse event.
 */
export function logAbuseEvent(params: {
  tenantId?: string;
  ip?: string;
  category: AbuseCategory;
  severity: AbuseSeverity;
  description: string;
  metadata?: Record<string, unknown>;
}): AbuseEvent {
  const event: AbuseEvent = {
    id: generateEventId(),
    tenantId: params.tenantId,
    ip: params.ip,
    category: params.category,
    severity: params.severity,
    description: params.description,
    metadata: params.metadata ?? {},
    detectedAt: new Date(),
    flagged: params.severity === "high" || params.severity === "critical",
  };
  abuseEvents.push(event);
  // Keep last 1000 events in memory
  if (abuseEvents.length > 1000) abuseEvents = abuseEvents.slice(-1000);
  return event;
}

/**
 * Get recent abuse events.
 */
export function getAbuseEvents(params?: {
  tenantId?: string;
  category?: AbuseCategory;
  severity?: AbuseSeverity;
  limit?: number;
  flaggedOnly?: boolean;
}): AbuseEvent[] {
  let events = [...abuseEvents];
  if (params?.tenantId) events = events.filter(e => e.tenantId === params.tenantId);
  if (params?.category) events = events.filter(e => e.category === params.category);
  if (params?.severity) events = events.filter(e => e.severity === params.severity);
  if (params?.flaggedOnly) events = events.filter(e => e.flagged);
  return events.slice(-(params?.limit ?? 50)).reverse();
}

/**
 * Get abuse summary stats.
 */
export function getAbuseStats(): {
  total: number;
  flagged: number;
  byCategory: Record<string, number>;
  bySeverity: Record<string, number>;
} {
  const byCategory: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  let flagged = 0;

  for (const e of abuseEvents) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
    bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
    if (e.flagged) flagged++;
  }

  return { total: abuseEvents.length, flagged, byCategory, bySeverity };
}

/**
 * Clear abuse event log (for testing).
 */
export function clearAbuseEvents(): void {
  abuseEvents = [];
  requestCounters.clear();
}
