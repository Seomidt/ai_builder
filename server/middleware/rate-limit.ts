/**
 * Phase 13.2 — Global API Rate Limiting
 *
 * Platform-level rate limit: 1000 requests per 15 minutes per actor/IP.
 * This is a broad platform baseline — stricter route-level limits (AI budget,
 * per-operation guards) remain in place and take precedence where applied.
 *
 * INV-SEC-H3: Global API rate limiting must throttle predictably.
 */

import rateLimit from "express-rate-limit";
import type { Request, Response } from "express";

// ── Configuration ─────────────────────────────────────────────────────────────

export const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1_000; // 15 minutes
export const RATE_LIMIT_MAX = 1_000;                  // per window per actor/IP

// ── Key generator ─────────────────────────────────────────────────────────────

/**
 * Key by canonical user ID when authenticated (avoids IP spoofing).
 * Falls back to socket remote address (not req.ip) to avoid IPv6 proxy issues.
 * validate: { trustProxy: false } disables the express-rate-limit IPv6 warning
 * since we are deliberately using socket address for unauthenticated requests.
 */
function rateLimitKeyGenerator(req: Request): string {
  const user = (req as any).user;
  if (user?.id && !user.id.startsWith("demo-")) {
    return `user:${user.id}`;
  }
  // Use socket remote address — avoids req.ip IPv6 normalization issues
  const ip = req.socket?.remoteAddress ?? "unknown";
  return `ip:${ip}`;
}

// ── Global API limiter ────────────────────────────────────────────────────────

export const globalApiLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  // Disable IPv6 proxy validation — we use socket.remoteAddress intentionally
  validate: { trustProxy: false },
  keyGenerator: rateLimitKeyGenerator,
  handler: (req: Request, res: Response) => {
    res.status(429).json({
      error_code: "RATE_LIMIT_EXCEEDED",
      message: "Too many requests. Please retry after 15 minutes.",
      request_id: (req as any).requestId ?? null,
      retry_after_seconds: Math.ceil(RATE_LIMIT_WINDOW_MS / 1_000),
    });
  },
  // Only apply to /api routes
  skip: (req: Request) => !req.path.startsWith("/api"),
});

// ── Rate limit context (for observability) ────────────────────────────────────

export interface RateLimitConfig {
  windowMs: number;
  windowMinutes: number;
  maxRequests: number;
  keyingStrategy: "actor_id_with_ip_fallback";
  appliesTo: "/api/*";
}

export function getRateLimitConfig(): RateLimitConfig {
  return {
    windowMs: RATE_LIMIT_WINDOW_MS,
    windowMinutes: RATE_LIMIT_WINDOW_MS / 60_000,
    maxRequests: RATE_LIMIT_MAX,
    keyingStrategy: "actor_id_with_ip_fallback",
    appliesTo: "/api/*",
  };
}
