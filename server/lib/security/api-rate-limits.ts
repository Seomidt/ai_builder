/**
 * Phase 38 — API Rate Limiting (Route-Group Based)
 * Enforces per-route-group, per-IP, and per-tenant rate limits.
 *
 * Route groups:
 *   /api/auth/*     — strict IP-based limits
 *   /api/admin/*    — stricter admin limits
 *   /api/r2/*       — tenant-aware, signed-URL bucket separate
 *   /api/webhooks/* — webhook bucket
 *   /api/tenant/*   — tenant API
 *   /api/ai/*       — AI request limits
 *
 * Returns standardized structure:
 *   { allowed, retryAfterSeconds, reason }
 */

import { checkRateLimit, RATE_LIMIT_POLICIES, type RateLimitPolicy } from "./rate-limit";

// ── Route group definitions ────────────────────────────────────────────────────

export type RouteGroup =
  | "auth_login"
  | "auth_password_reset"
  | "auth_mfa_challenge"
  | "auth_invite"
  | "auth_general"
  | "admin_general"
  | "admin_sensitive"
  | "r2_general"
  | "r2_signed_url"
  | "webhooks"
  | "tenant_api"
  | "ai_general";

export interface RouteGroupPolicy {
  group:         RouteGroup;
  maxRequests:   number;
  windowMs:      number;
  keyStrategy:   "ip" | "tenant" | "ip+tenant" | "global";
  description:   string;
}

export const ROUTE_GROUP_POLICIES: Record<RouteGroup, RouteGroupPolicy> = {
  auth_login: {
    group: "auth_login", maxRequests: 5, windowMs: 60_000,
    keyStrategy: "ip", description: "Login: 5 attempts per IP per minute",
  },
  auth_password_reset: {
    group: "auth_password_reset", maxRequests: 3, windowMs: 15 * 60_000,
    keyStrategy: "ip", description: "Password reset: 3 per IP per 15 minutes",
  },
  auth_mfa_challenge: {
    group: "auth_mfa_challenge", maxRequests: 10, windowMs: 5 * 60_000,
    keyStrategy: "ip", description: "MFA challenge: 10 per IP per 5 minutes",
  },
  auth_invite: {
    group: "auth_invite", maxRequests: 5, windowMs: 60 * 60_000,
    keyStrategy: "ip", description: "Invite acceptance: 5 per IP per hour",
  },
  auth_general: {
    group: "auth_general", maxRequests: 30, windowMs: 60_000,
    keyStrategy: "ip", description: "Auth general: 30 per IP per minute",
  },
  admin_general: {
    group: "admin_general", maxRequests: 200, windowMs: 60_000,
    keyStrategy: "ip+tenant", description: "Admin: 200 per IP+tenant per minute",
  },
  admin_sensitive: {
    group: "admin_sensitive", maxRequests: 20, windowMs: 60_000,
    keyStrategy: "ip+tenant", description: "Admin sensitive: 20 per IP+tenant per minute",
  },
  r2_general: {
    group: "r2_general", maxRequests: 200, windowMs: 60_000,
    keyStrategy: "tenant", description: "R2 general: 200 per tenant per minute",
  },
  r2_signed_url: {
    group: "r2_signed_url", maxRequests: 30, windowMs: 60_000,
    keyStrategy: "tenant", description: "Signed URL generation: 30 per tenant per minute",
  },
  webhooks: {
    group: "webhooks", maxRequests: 100, windowMs: 60_000,
    keyStrategy: "ip", description: "Webhooks: 100 per IP per minute",
  },
  tenant_api: {
    group: "tenant_api", maxRequests: 500, windowMs: 60_000,
    keyStrategy: "tenant", description: "Tenant API: 500 per tenant per minute",
  },
  ai_general: {
    group: "ai_general", maxRequests: 60, windowMs: 60_000,
    keyStrategy: "tenant", description: "AI API: 60 per tenant per minute",
  },
};

// ── Standardized result ───────────────────────────────────────────────────────

export interface RateLimitResult {
  allowed:            boolean;
  retryAfterSeconds:  number | null;
  reason:             string;
  group:              RouteGroup;
  key:                string;
}

// ── Core check function ───────────────────────────────────────────────────────

export function checkRouteGroupLimit(
  group:    RouteGroup,
  ip:       string,
  tenantId: string = "unknown",
): RateLimitResult {
  const policy = ROUTE_GROUP_POLICIES[group];
  if (!policy) {
    return { allowed: true, retryAfterSeconds: null, reason: "no policy", group, key: "" };
  }

  const key = buildKey(group, policy.keyStrategy, ip, tenantId);

  // Map to the existing checkRateLimit infrastructure
  const rlPolicy: RateLimitPolicy = {
    name:        policy.description,
    maxRequests: policy.maxRequests,
    windowMs:    policy.windowMs,
    type:        policy.keyStrategy === "ip" ? "ip" :
                 policy.keyStrategy === "tenant" ? "tenant" : "global",
  };

  const result = checkRateLimit(key, rlPolicy);

  return {
    allowed:           result.allowed,
    retryAfterSeconds: result.allowed ? null : Math.ceil(result.retryAfterMs / 1000),
    reason:            result.allowed ? "ok" : `Rate limit exceeded: ${policy.description}`,
    group,
    key,
  };
}

function buildKey(
  group:    RouteGroup,
  strategy: RouteGroupPolicy["keyStrategy"],
  ip:       string,
  tenantId: string,
): string {
  const safeIp     = (ip || "unknown").replace(/[^a-zA-Z0-9.:_-]/g, "");
  const safeTenant = (tenantId || "unknown").replace(/[^a-zA-Z0-9_-]/g, "");

  switch (strategy) {
    case "ip":          return `rl:${group}:ip:${safeIp}`;
    case "tenant":      return `rl:${group}:tenant:${safeTenant}`;
    case "ip+tenant":   return `rl:${group}:ip+tenant:${safeIp}:${safeTenant}`;
    default:            return `rl:${group}:global`;
  }
}

// ── Path-to-group router ──────────────────────────────────────────────────────

export function routePathToGroup(path: string, method = "GET"): RouteGroup | null {
  if (path.startsWith("/api/auth/login"))          return "auth_login";
  if (path.startsWith("/api/auth/reset"))          return "auth_password_reset";
  if (path.startsWith("/api/auth/mfa"))            return "auth_mfa_challenge";
  if (path.startsWith("/api/auth/invite"))         return "auth_invite";
  if (path.startsWith("/api/auth/"))               return "auth_general";
  if (path.startsWith("/api/admin/security") ||
      path.startsWith("/api/admin/users") ||
      path.startsWith("/api/admin/audit"))         return "admin_sensitive";
  if (path.startsWith("/api/admin/"))              return "admin_general";
  if (path.startsWith("/api/r2/upload-url") ||
      path.startsWith("/api/r2/url") ||
      path.startsWith("/api/r2/multipart"))        return "r2_signed_url";
  if (path.startsWith("/api/r2/"))                 return "r2_general";
  if (path.startsWith("/api/webhooks/") ||
      path.startsWith("/api/webhook/"))            return "webhooks";
  if (path.startsWith("/api/ai/"))                 return "ai_general";
  if (path.startsWith("/api/tenant/"))             return "tenant_api";
  return null;
}

// ── Middleware factory ────────────────────────────────────────────────────────

import type { Request, Response, NextFunction } from "express";

export function createRouteGroupRateLimiter() {
  return function routeGroupRateLimiter(req: Request, res: Response, next: NextFunction) {
    const group = routePathToGroup(req.path, req.method);
    if (!group) return next();

    const ip       = (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim()
                   ?? req.socket.remoteAddress ?? "unknown";
    const tenantId = (req.user as any)?.organizationId ?? "unknown";

    const result = checkRouteGroupLimit(group, ip, tenantId);

    // Set standard rate limit headers
    const policy = ROUTE_GROUP_POLICIES[group];
    res.setHeader("X-RateLimit-Group",     group);
    res.setHeader("X-RateLimit-Limit",     String(policy.maxRequests));
    if (!result.allowed) {
      res.setHeader("Retry-After", String(result.retryAfterSeconds ?? 60));
      return res.status(429).json({
        error:             "Too Many Requests",
        reason:            result.reason,
        retryAfterSeconds: result.retryAfterSeconds,
        group,
      });
    }

    next();
  };
}

// ── Stats for dashboard ───────────────────────────────────────────────────────

export function getRouteGroupPolicySummary() {
  return Object.values(ROUTE_GROUP_POLICIES).map(p => ({
    group:        p.group,
    maxRequests:  p.maxRequests,
    windowSec:    Math.round(p.windowMs / 1000),
    keyStrategy:  p.keyStrategy,
    description:  p.description,
  }));
}
