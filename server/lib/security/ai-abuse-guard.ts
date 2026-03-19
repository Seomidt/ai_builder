/**
 * Phase 44 — AI Abuse Guard
 *
 * Protects AI endpoints from abuse via:
 *   1. Input character cap (INV-AI-ABUSE-1)
 *   2. Burst control: max N requests per sliding window per tenant (INV-AI-ABUSE-2)
 *   3. Token/character budget per tenant per hour (INV-AI-ABUSE-3)
 *   4. Suspicious pattern detection (prompt injection heuristics) (INV-AI-ABUSE-4)
 *
 * INVARIANTS:
 *   INV-AI-ABUSE-1: AI input MUST NOT exceed MAX_INPUT_CHARS characters.
 *                   Prevents memory exhaustion and runaway tokenization cost.
 *   INV-AI-ABUSE-2: Per-tenant burst: max MAX_BURST_REQUESTS in BURST_WINDOW_MS.
 *                   Prevents single tenant from monopolizing GPU capacity.
 *   INV-AI-ABUSE-3: Per-tenant hourly char budget: MAX_HOURLY_CHARS.
 *                   Prevents sustained high-volume abuse within cost limits.
 *   INV-AI-ABUSE-4: Prompt injection patterns are flagged and rejected.
 *                   Prevents adversarial prompt injection via API.
 *   INV-AI-ABUSE-5: Rejection reason is logged via logAiInputRejected; CONTENT is never logged.
 *
 * DESIGN:
 *   - In-memory sliding window counters (Map-based, server-scoped).
 *   - Appropriate for single-instance deploy; multi-instance requires Redis.
 *   - No DB writes on the hot path — all writes are fire-and-forget via logAiInputRejected.
 *   - Exported as both a check function (checkAiInput) and an Express middleware (aiAbuseGuard).
 */

import type { Request, Response, NextFunction } from "express";
import { logAiInputRejected } from "./security-events";

// ── Limits ────────────────────────────────────────────────────────────────────

/** INV-AI-ABUSE-1: Maximum characters per AI input (per request) */
export const MAX_INPUT_CHARS = 32_000;

/** INV-AI-ABUSE-2: Burst window in milliseconds */
export const BURST_WINDOW_MS = 60_000; // 1 minute

/** INV-AI-ABUSE-2: Max requests per tenant per burst window */
export const MAX_BURST_REQUESTS = 20;

/** INV-AI-ABUSE-3: Max input chars per tenant per hour */
export const MAX_HOURLY_CHARS = 500_000;

/** INV-AI-ABUSE-3: Hourly window in milliseconds */
export const HOURLY_WINDOW_MS = 60 * 60_000;

// ── Sliding window state ──────────────────────────────────────────────────────

interface BurstEntry {
  /** Timestamps of requests in the current window (sorted ascending) */
  timestamps: number[];
}

interface HourlyEntry {
  /** Rolling sum of chars in the current window */
  totalChars: number;
  /** Timestamps+sizes for sliding eviction */
  events: { ts: number; chars: number }[];
}

// In-memory maps (never grow unboundedly — eviction below)
const burstMap  = new Map<string, BurstEntry>();
const hourlyMap = new Map<string, HourlyEntry>();

// ── Pattern detection ─────────────────────────────────────────────────────────

/**
 * Prompt injection / jailbreak heuristics.
 * Low false-positive patterns only. This is a first-line guard, NOT a full classifier.
 *
 * INV-AI-ABUSE-4: content is tested but NEVER stored.
 */
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /disregard\s+(all\s+)?previous\s+instructions/i,
  /forget\s+(all\s+)?previous\s+instructions/i,
  /you\s+are\s+now\s+(in\s+)?dan\s+mode/i,
  /\bact\s+as\s+(an?\s+)?(unrestricted|jailbroken|evil|malicious)\b/i,
  /system\s+prompt\s*[:\-]\s*override/i,
  /\[system\]\s*:/i,
  /<\s*\|?system\|?\s*>/i,
  /##\s*system\s+prompt/i,
];

export function detectInjectionPattern(input: string): boolean {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(input)) return true;
  }
  return false;
}

// ── Core check function ───────────────────────────────────────────────────────

export type AiInputRejectionReason =
  | "input_too_long"
  | "burst_limit"
  | "pattern_match"
  | "token_cap";

export interface AiInputCheckResult {
  allowed:          boolean;
  rejectionReason?: AiInputRejectionReason;
  retryAfterMs?:    number;
  inputLengthBytes: number;
}

/**
 * Check whether an AI input from a given tenant is allowed.
 *
 * Call this BEFORE forwarding input to any AI provider.
 * If not allowed, log the rejection and return 429/400 to the caller.
 *
 * @param tenantId  Tenant identifier (used as rate limit key)
 * @param input     The raw AI prompt / message content
 */
export function checkAiInput(tenantId: string, input: string): AiInputCheckResult {
  const now              = Date.now();
  const inputLengthBytes = Buffer.byteLength(input, "utf8");

  // ── 1. Input cap (INV-AI-ABUSE-1) ────────────────────────────────────────
  if (input.length > MAX_INPUT_CHARS) {
    return { allowed: false, rejectionReason: "input_too_long", inputLengthBytes };
  }

  // ── 2. Burst control (INV-AI-ABUSE-2) ────────────────────────────────────
  const burstKey    = `burst:${tenantId}`;
  const burstEntry  = burstMap.get(burstKey) ?? { timestamps: [] };
  const windowStart = now - BURST_WINDOW_MS;
  // Evict old timestamps
  burstEntry.timestamps = burstEntry.timestamps.filter(t => t > windowStart);

  if (burstEntry.timestamps.length >= MAX_BURST_REQUESTS) {
    const oldestInWindow = burstEntry.timestamps[0]!;
    const retryAfterMs   = BURST_WINDOW_MS - (now - oldestInWindow) + 1;
    burstMap.set(burstKey, burstEntry);
    return { allowed: false, rejectionReason: "burst_limit", retryAfterMs, inputLengthBytes };
  }

  // ── 3. Prompt injection patterns (INV-AI-ABUSE-4) ────────────────────────
  if (detectInjectionPattern(input)) {
    return { allowed: false, rejectionReason: "pattern_match", inputLengthBytes };
  }

  // ── 4. Hourly character budget (INV-AI-ABUSE-3) ──────────────────────────
  const hourlyKey   = `hourly:${tenantId}`;
  const hourlyEntry = hourlyMap.get(hourlyKey) ?? { totalChars: 0, events: [] };
  const hourlyStart = now - HOURLY_WINDOW_MS;
  // Evict old events
  const evicted     = hourlyEntry.events.filter(e => e.ts <= hourlyStart);
  const evictedChars = evicted.reduce((s, e) => s + e.chars, 0);
  hourlyEntry.events    = hourlyEntry.events.filter(e => e.ts > hourlyStart);
  hourlyEntry.totalChars = Math.max(0, hourlyEntry.totalChars - evictedChars);

  if (hourlyEntry.totalChars + input.length > MAX_HOURLY_CHARS) {
    hourlyMap.set(hourlyKey, hourlyEntry);
    return { allowed: false, rejectionReason: "token_cap", inputLengthBytes };
  }

  // ── All checks passed — record usage ─────────────────────────────────────
  burstEntry.timestamps.push(now);
  burstMap.set(burstKey, burstEntry);

  hourlyEntry.totalChars += input.length;
  hourlyEntry.events.push({ ts: now, chars: input.length });
  hourlyMap.set(hourlyKey, hourlyEntry);

  return { allowed: true, inputLengthBytes };
}

// ── Reset state (test support) ────────────────────────────────────────────────

/** Reset all in-memory rate limit state. Only for tests — never call in production. */
export function resetAiAbuseState(): void {
  burstMap.clear();
  hourlyMap.clear();
}

// ── Introspection ─────────────────────────────────────────────────────────────

export interface AiAbuseTenantStats {
  tenantId:          string;
  burstCount:        number;
  burstCapacity:     number;
  hourlyCharsUsed:   number;
  hourlyCharsLimit:  number;
  hourlyUtilization: number;
}

export function getAiAbuseTenantStats(tenantId: string): AiAbuseTenantStats {
  const now         = Date.now();

  const burstEntry  = burstMap.get(`burst:${tenantId}`);
  const burstCount  = burstEntry
    ? burstEntry.timestamps.filter(t => t > now - BURST_WINDOW_MS).length
    : 0;

  const hourlyEntry = hourlyMap.get(`hourly:${tenantId}`);
  const hourlyCharsUsed = hourlyEntry
    ? hourlyEntry.events.filter(e => e.ts > now - HOURLY_WINDOW_MS).reduce((s, e) => s + e.chars, 0)
    : 0;

  return {
    tenantId,
    burstCount,
    burstCapacity:     MAX_BURST_REQUESTS,
    hourlyCharsUsed,
    hourlyCharsLimit:  MAX_HOURLY_CHARS,
    hourlyUtilization: hourlyCharsUsed / MAX_HOURLY_CHARS,
  };
}

// ── Express middleware ────────────────────────────────────────────────────────

/**
 * Express middleware that applies AI abuse guards to any route that receives
 * AI prompt input in `req.body.input` or `req.body.message` or `req.body.prompt`.
 *
 * Register on /api/ai/* routes AFTER authMiddleware (tenantId required).
 *
 * On rejection:
 *   - pattern_match, input_too_long → 400 Bad Request
 *   - burst_limit, token_cap        → 429 Too Many Requests
 *   - Security event logged via logAiInputRejected (fire-and-forget)
 */
export function aiAbuseGuard(req: Request, res: Response, next: NextFunction): void {
  const tenantId = (req.user as any)?.organizationId ?? "unknown";
  const ip       = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
                 ?? req.socket.remoteAddress ?? "unknown";
  const requestId = (req as any).requestId ?? null;

  const rawInput: unknown =
    req.body?.input ?? req.body?.message ?? req.body?.prompt ?? req.body?.content;

  // If no AI input field is present, pass through (guard is opt-in per route)
  if (typeof rawInput !== "string") {
    next();
    return;
  }

  const result = checkAiInput(tenantId, rawInput);

  if (!result.allowed) {
    const reason = result.rejectionReason!;

    // Fire-and-forget — INV-AI-ABUSE-5: content never logged
    logAiInputRejected({
      tenantId,
      actorId:         (req.user as any)?.id ?? null,
      inputLengthBytes: result.inputLengthBytes,
      rejectionReason: reason,
      ip,
      requestId,
    }).catch(() => {/* observability-only */});

    const isClientError = reason === "input_too_long" || reason === "pattern_match";
    const status = isClientError ? 400 : 429;

    const body: Record<string, unknown> = {
      error:  isClientError ? "Bad Request" : "Too Many Requests",
      reason: reason === "input_too_long"
        ? `AI input exceeds maximum length of ${MAX_INPUT_CHARS} characters`
        : reason === "pattern_match"
          ? "AI input rejected: potentially malicious pattern detected"
          : reason === "burst_limit"
            ? `Too many AI requests — retry after ${Math.ceil((result.retryAfterMs ?? 60_000) / 1000)}s`
            : "Hourly AI character budget exceeded — retry later",
    };

    if (result.retryAfterMs !== undefined) {
      const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      body.retryAfterSeconds = retryAfterSec;
    }

    res.status(status).json(body);
    return;
  }

  next();
}
