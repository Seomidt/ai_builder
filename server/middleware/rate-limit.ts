/**
 * Phase 7 — Rate Limiting Middleware
 * INV-SEC5: Rate limits must return deterministic responses.
 * In-memory sliding window per IP + per tenant.
 */

import type { Request, Response, NextFunction } from "express";

interface WindowEntry {
  timestamps: number[];
}

const ipWindows = new Map<string, WindowEntry>();
const tenantWindows = new Map<string, WindowEntry>();

function getClientIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string") return forwarded.split(",")[0].trim();
  return req.socket?.remoteAddress ?? "unknown";
}

function isRateLimited(
  store: Map<string, WindowEntry>,
  key: string,
  limit: number,
  windowMs: number,
): { limited: boolean; remaining: number; resetMs: number } {
  const now = Date.now();
  let entry = store.get(key);
  if (!entry) {
    entry = { timestamps: [] };
    store.set(key, entry);
  }

  // Purge old entries outside window
  entry.timestamps = entry.timestamps.filter((t) => now - t < windowMs);

  const count = entry.timestamps.length;
  const remaining = Math.max(0, limit - count - 1);
  const oldestInWindow = entry.timestamps[0] ?? now;
  const resetMs = oldestInWindow + windowMs - now;

  if (count >= limit) {
    return { limited: true, remaining: 0, resetMs: Math.max(0, resetMs) };
  }

  entry.timestamps.push(now);
  return { limited: false, remaining, resetMs: Math.max(0, resetMs) };
}

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  keyPrefix?: string;
  perTenant?: boolean;
  message?: string;
}

export function rateLimit(opts: RateLimitOptions) {
  const { limit, windowMs, keyPrefix = "default", perTenant = false, message = "Too many requests" } = opts;

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = getClientIp(req);
    const ipKey = `${keyPrefix}:ip:${ip}`;
    const retryAfterSec = Math.ceil(windowMs / 1000);

    const ipResult = isRateLimited(ipWindows, ipKey, limit, windowMs);

    res.setHeader("X-RateLimit-Limit", limit);
    res.setHeader("X-RateLimit-Remaining", ipResult.remaining);
    res.setHeader("X-RateLimit-Reset", Math.ceil((Date.now() + ipResult.resetMs) / 1000));

    if (ipResult.limited) {
      res.setHeader("Retry-After", Math.ceil(ipResult.resetMs / 1000) || retryAfterSec);
      res.status(429).json({
        error: message,
        retryAfterSeconds: Math.ceil(ipResult.resetMs / 1000) || retryAfterSec,
        reasonCode: "RATE_LIMITED",
        note: "INV-SEC5: Deterministic rate-limit response.",
      });
      return;
    }

    // Per-tenant rate limit (additive with per-IP)
    if (perTenant) {
      const tenantId = (req as any).user?.organizationId ?? (req as any).resolvedActor?.tenantId ?? "unknown";
      const tenantKey = `${keyPrefix}:tenant:${tenantId}`;
      const tenantResult = isRateLimited(tenantWindows, tenantKey, limit * 5, windowMs);
      if (tenantResult.limited) {
        res.setHeader("Retry-After", Math.ceil(tenantResult.resetMs / 1000) || retryAfterSec);
        res.status(429).json({
          error: `Tenant rate limit exceeded: ${message}`,
          retryAfterSeconds: Math.ceil(tenantResult.resetMs / 1000) || retryAfterSec,
          reasonCode: "TENANT_RATE_LIMITED",
          note: "INV-SEC5: Deterministic rate-limit response.",
        });
        return;
      }
    }

    next();
  };
}

// ─── Pre-configured limiters ──────────────────────────────────────────────────

export const loginRateLimit = rateLimit({
  limit: 10,
  windowMs: 15 * 60 * 1000,
  keyPrefix: "login",
  message: "Too many login attempts. Please try again in 15 minutes.",
});

export const apiRateLimit = rateLimit({
  limit: 200,
  windowMs: 60 * 1000,
  keyPrefix: "api",
  perTenant: true,
  message: "API rate limit exceeded.",
});

export const aiQueryRateLimit = rateLimit({
  limit: 30,
  windowMs: 60 * 1000,
  keyPrefix: "ai",
  perTenant: true,
  message: "AI query rate limit exceeded.",
});

export const adminRateLimit = rateLimit({
  limit: 100,
  windowMs: 60 * 1000,
  keyPrefix: "admin",
  message: "Admin rate limit exceeded.",
});

// ─── explainRateLimitState ────────────────────────────────────────────────────

export function explainRateLimitState(): {
  activeIpWindows: number;
  activeTenantWindows: number;
  limits: Record<string, { limit: number; windowMs: number }>;
  note: string;
} {
  return {
    activeIpWindows: ipWindows.size,
    activeTenantWindows: tenantWindows.size,
    limits: {
      login: { limit: 10, windowMs: 15 * 60 * 1000 },
      api: { limit: 200, windowMs: 60 * 1000 },
      aiQuery: { limit: 30, windowMs: 60 * 1000 },
      admin: { limit: 100, windowMs: 60 * 1000 },
    },
    note: "INV-SEC5: In-memory sliding window per IP + per tenant. No external dependency.",
  };
}
