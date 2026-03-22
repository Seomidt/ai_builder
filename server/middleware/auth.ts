/**
 * Authentication middleware.
 *
 * Hardening (Phase 13.1):
 *   - Demo user only allowed when DEMO_MODE=true in environment.
 *   - If no token and DEMO_MODE != "true": returns 401 Unauthorized.
 *   - Demo users always get role=viewer (never owner), random user ID, tenant=demo-org.
 *   - Invalid tokens no longer fall back to demo user — they return 401.
 *   - Authenticated users keep full role from DB (unchanged behavior).
 */

import { randomUUID, createHmac, timingSafeEqual } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { supabaseAdmin } from "../lib/supabase";
import { db } from "../db";
import { organizationMembers } from "@shared/schema";
import { eq } from "drizzle-orm";
import { mapCurrentUserToCanonicalActor } from "../lib/auth/identity-compat";
import type { ResolvedActor } from "../lib/auth/actor-resolution";

export interface AuthUser {
  id: string;
  email?: string;
  organizationId: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      resolvedActor?: ResolvedActor;
    }
  }
}

// ── Token verification cache ──────────────────────────────────────────────────
// ROOT CAUSE FIX: supabaseAdmin.auth.getUser(token) is a remote network call
// to Supabase Auth API (~200-500ms locally, 3-8 s on mobile/slow networks).
// Without this cache, EVERY API request makes that round-trip. After login,
// /api/auth/session + /api/dashboard/bootstrap fire simultaneously → 2 calls
// in parallel → on mobile: 2 × 7-8 s = 15-16 s perceived login latency.
//
// Fix: verify once per 30 s window per token. Cache the {userId, email} result.
// Request coalescing (tokenInflight) ensures simultaneous requests with the
// same token share a single in-flight Promise instead of each making their
// own network call. The result is written once and served from memory for
// all subsequent requests within the TTL.
//
// Security: tokens are only in server process memory (never persisted).
// Expiry is enforced by TTL (30 s) — well within Supabase's 1-hour JWT window.
// Revoked tokens are caught on the next cache miss (worst-case: 30 s delay,
// same as the existing memberCache TTL — acceptable for this threat model).

// ── Local JWT verification (fast path) ───────────────────────────────────────
// When SUPABASE_JWT_SECRET is set, verifies Supabase HS256 JWTs locally using
// Node.js crypto (< 1ms). No network call to Supabase Auth API required.
//
// How to get the secret:
//   Supabase dashboard → Project Settings → API → JWT Secret
//   Set it as SUPABASE_JWT_SECRET in your environment/secrets.
//
// Falls back to getUser() network call (with cache+coalescing) if not set.

function base64UrlToBuffer(str: string): Buffer {
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function verifyLocalJwt(
  token: string,
  secret: string,
): { id: string; email?: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;
    const signingInput = `${headerB64}.${payloadB64}`;

    // Verify HMAC-SHA256 signature — timing-safe comparison
    const expected = createHmac("sha256", secret)
      .update(signingInput)
      .digest("base64url");
    const expectedBuf = Buffer.from(expected, "utf8");
    const actualBuf   = Buffer.from(sigB64, "utf8");
    if (
      expectedBuf.length !== actualBuf.length ||
      !timingSafeEqual(expectedBuf, actualBuf)
    ) {
      return null;
    }

    // Parse payload
    const payload = JSON.parse(
      base64UrlToBuffer(payloadB64).toString("utf8"),
    ) as Record<string, unknown>;

    // Check expiry
    if (typeof payload.exp === "number" && payload.exp < Math.floor(Date.now() / 1000)) {
      return null; // expired
    }

    if (typeof payload.sub !== "string") return null;

    return {
      id: payload.sub,
      email: typeof payload.email === "string" ? payload.email : undefined,
    };
  } catch {
    return null;
  }
}

// Resolved once on first use — avoids repeated env lookup in hot path
const SUPABASE_JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? null;

if (SUPABASE_JWT_SECRET) {
  console.log("[auth] local JWT verification ENABLED (SUPABASE_JWT_SECRET set) — getUser() bypassed");
} else {
  console.log("[auth] local JWT verification DISABLED — using getUser() with cache+coalescing");
  console.log("[auth] PERF TIP: set SUPABASE_JWT_SECRET to eliminate Supabase Auth API round-trips on every login");
}

interface TokenRecord { userId: string; email?: string; exp: number }
const tokenCache = new Map<string, TokenRecord>();
const tokenInflight = new Map<string, Promise<{ id: string; email?: string } | null>>();
const TOKEN_CACHE_TTL_MS = 30_000;

async function getVerifiedUser(
  token: string,
): Promise<{ id: string; email?: string } | null> {
  // FAST PATH: local JWT verification — ~0ms, no network
  if (SUPABASE_JWT_SECRET) {
    const local = verifyLocalJwt(token, SUPABASE_JWT_SECRET);
    if (local === null) return null; // signature invalid or expired
    return local; // no caching needed — verification is already instant
  }

  // SLOW PATH (cache + coalescing): Supabase getUser() network call
  // 1. Cache hit — skip network call entirely
  const cached = tokenCache.get(token);
  if (cached) {
    if (cached.exp > Date.now()) {
      return { id: cached.userId, email: cached.email };
    }
    tokenCache.delete(token);
  }

  // 2. Coalesce: if another request with the same token is already in-flight,
  //    wait for that Promise instead of making a duplicate network call.
  const inflight = tokenInflight.get(token);
  if (inflight) {
    return inflight;
  }

  // 3. No cache, no in-flight — start the Supabase getUser() network call.
  const t0 = Date.now();
  const promise = supabaseAdmin.auth
    .getUser(token)
    .then(({ data, error }) => {
      const ms = Date.now() - t0;
      if (error || !data.user) {
        console.log(`[auth] getUser() FAILED (${ms}ms)`);
        return null;
      }
      console.log(`[auth] getUser() OK (${ms}ms) — cached for ${TOKEN_CACHE_TTL_MS / 1000}s`);
      const user = { id: data.user.id, email: data.user.email };
      tokenCache.set(token, {
        userId: user.id,
        email: user.email,
        exp: Date.now() + TOKEN_CACHE_TTL_MS,
      });
      return user;
    })
    .finally(() => {
      tokenInflight.delete(token);
    });

  tokenInflight.set(token, promise);
  return promise;
}

// ── Membership cache ─────────────────────────────────────────────────────────
// Caches org + role per userId to avoid a DB round-trip on every request.
// TTL is short enough that role changes propagate within 30 s.

interface MemberRecord { organizationId: string; role: string; exp: number }
const memberCache = new Map<string, MemberRecord>();
const MEMBER_CACHE_TTL_MS = 30_000;

function getCachedMember(userId: string): { organizationId: string; role: string } | null {
  const entry = memberCache.get(userId);
  if (!entry || entry.exp < Date.now()) {
    memberCache.delete(userId);
    return null;
  }
  return { organizationId: entry.organizationId, role: entry.role };
}

function setCachedMember(userId: string, organizationId: string, role: string): void {
  memberCache.set(userId, { organizationId, role, exp: Date.now() + MEMBER_CACHE_TTL_MS });
}

// ── Platform admin email whitelist ────────────────────────────────────────────
// Emails that are granted platform_admin role unconditionally after Supabase
// token verification. Add platform operators here — no DB schema change needed.
// Cached the same way as org members (30 s TTL via memberCache).

const PLATFORM_ADMIN_EMAILS = new Set([
  "seomidt@gmail.com",
]);

// ── Demo mode guard ───────────────────────────────────────────────────────────

function isDemoModeEnabled(): boolean {
  return process.env.DEMO_MODE === "true";
}

function getDemoUser(): AuthUser {
  return {
    id: `demo-${randomUUID()}`,
    email: "demo@example.com",
    organizationId: "demo-org",
    role: "viewer", // Never grant owner privileges to demo users
  };
}

// ── Auth middleware ───────────────────────────────────────────────────────────

// ── Public paths that bypass auth ────────────────────────────────────────────
// These are CI/CD and health-check endpoints that must be accessible without auth.

const PUBLIC_PATHS = [
  "/api/auth/config",
  "/api/waitlist",
  "/api/admin/platform/deploy-health",
  // Phase 29: Recovery & backup admin endpoints (internal tooling — CI/CD, runbooks, monitoring)
  "/api/admin/recovery/backup-status",
  "/api/admin/recovery/trigger-backup",
  "/api/admin/recovery/restore-tenant",
  "/api/admin/recovery/restore-table",
  "/api/admin/recovery/job-recovery",
  "/api/admin/recovery/job-recovery/requeue",
  "/api/admin/recovery/webhook-replay",
  "/api/admin/recovery/stripe-reconcile",
  "/api/admin/recovery/pressure",
  "/api/admin/recovery/brownout",
  "/api/admin/recovery/brownout-history",
];

// ── Internal API secret bypass (validation scripts + CI tooling) ─────────────
// Only active when INTERNAL_API_SECRET is set. Never exposed to clients.

function checkInternalToken(req: Request): boolean {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return false;
  return req.headers["x-internal-token"] === secret;
}

export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  // Only enforce auth on /api/* — all other paths are served by the React SPA
  // which handles client-side route protection via ProtectedRoute.
  if (!req.path.startsWith("/api")) {
    return next();
  }

  // Phase 28: allow specific public paths without authentication
  if (PUBLIC_PATHS.includes(req.path)) {
    return next();
  }

  // Internal tooling bypass (validation scripts, CI)
  if (checkInternalToken(req)) {
    req.user = {
      id: "internal-script",
      email: "internal@blissops.com",
      organizationId: "platform",
      role: "platform_admin",
    };
    return next();
  }

  const authHeader = req.headers.authorization;

  // ── No / malformed Authorization header ──────────────────────────────────
  if (!authHeader) {
    if (!isDemoModeEnabled()) {
      res.status(401).json({
        error_code: "SESSION_REQUIRED",
        message: "Authentication required. Provide an Authorization: Bearer <token> header.",
      });
      return;
    }
    req.user = getDemoUser();
    req.resolvedActor = mapCurrentUserToCanonicalActor(req.user);
    return next();
  }

  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({
      error_code: "INVALID_AUTH_HEADER",
      message: "Malformed Authorization header. Expected format: Bearer <token>.",
    });
    return;
  }

  const token = authHeader.slice(7);

  // ── Empty bearer token (also catches "Bearer   " with only whitespace) ──
  if (!token || !token.trim()) {
    res.status(401).json({
      error_code: "EMPTY_BEARER_TOKEN",
      message: "Authorization header contains an empty token.",
    });
    return;
  }

  // ── Step 1: verify JWT (cached — avoids remote Supabase call per request) ──
  let supabaseUser: { id: string; email?: string } | null = null;
  try {
    supabaseUser = await getVerifiedUser(token);
    if (!supabaseUser) {
      res.status(401).json({
        error_code: "INVALID_SESSION",
        message: "Invalid or expired authentication token. Please sign in again.",
      });
      return;
    }
  } catch (err) {
    console.error("[auth] token verification failed:", err);
    res.status(401).json({
      error_code: "INVALID_SESSION",
      message: "Authentication check failed. Please try again.",
    });
    return;
  }

  // ── Platform admin whitelist: role = platform_admin, but also look up org ────
  // so platform admins can use the tenant surface (create projects, etc.)
  if (supabaseUser.email && PLATFORM_ADMIN_EMAILS.has(supabaseUser.email.toLowerCase())) {
    let organizationId = "blissops-main"; // safe fallback — org exists in DB
    const cachedAdmin = getCachedMember(supabaseUser.id);
    if (cachedAdmin) {
      organizationId = cachedAdmin.organizationId;
    } else {
      try {
        const members = await db
          .select()
          .from(organizationMembers)
          .where(eq(organizationMembers.userId, supabaseUser.id))
          .limit(1);
        if (members[0]) {
          organizationId = members[0].organizationId;
        }
        setCachedMember(supabaseUser.id, organizationId, "platform_admin");
      } catch (dbErr) {
        console.error("[auth] platform admin org lookup failed (using default):", dbErr);
      }
    }
    req.user = {
      id: supabaseUser.id,
      email: supabaseUser.email,
      organizationId,
      role: "platform_admin",
    };
    req.resolvedActor = mapCurrentUserToCanonicalActor(req.user);
    return next();
  }

  // ── Step 2: look up org membership (cached, non-fatal if DB unavailable) ──
  let organizationId = "blissops-main";
  let role = "member";
  const cached = getCachedMember(supabaseUser.id);
  if (cached) {
    organizationId = cached.organizationId;
    role = cached.role;
  } else {
    try {
      const members = await db
        .select()
        .from(organizationMembers)
        .where(eq(organizationMembers.userId, supabaseUser.id))
        .limit(1);
      if (members[0]) {
        organizationId = members[0].organizationId;
        role = members[0].role;
      }
      setCachedMember(supabaseUser.id, organizationId, role);
    } catch (dbErr) {
      console.error("[auth] DB membership lookup failed (using defaults):", dbErr);
      // JWT is valid — let the user in with safe defaults; don't cache failures
    }
  }

  req.user = {
    id: supabaseUser.id,
    email: supabaseUser.email,
    organizationId,
    role,
  };

  // Phase 6: attach canonical resolved actor for permission-code based checks.
  // INV-ID9: backward-compatible — req.user remains untouched.
  req.resolvedActor = mapCurrentUserToCanonicalActor(req.user);

  return next();
}
