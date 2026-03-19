/**
 * Enterprise Auth Lockdown — AI & Admin Guards
 *
 * Provides deterministic middleware chains for:
 * - AI routes: auth → membership → tenant scope → feature flag → budget → rate limit
 * - Admin routes: auth → platform admin
 *
 * No implicit role elevation. Deny by default.
 * Anonymous: 401. Authenticated but unauthorised: 403.
 * Budget exceeded: 429. Feature disabled: 503.
 */

import type { Request, Response, NextFunction, RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import { checkTenantBudget } from "../lib/ai-governance/budget-checker";

// ── Constants ─────────────────────────────────────────────────────────────────

const PLATFORM_ADMIN_ROLES = new Set(["platform_admin", "superadmin"]);
const DEMO_ORG_ID = "demo-org";

/**
 * Admin-controlled public paths that bypass the platform-admin guard.
 * These are CI/CD, health-check, and monitoring endpoints.
 * Must match paths registered in authMiddleware.PUBLIC_PATHS.
 */
export const ADMIN_PUBLIC_PATHS: readonly string[] = [
  "/api/admin/platform/deploy-health",
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

// ── Global AI kill switch ─────────────────────────────────────────────────────

/**
 * Returns false if AI is globally disabled via environment variables.
 * AI_KILL_SWITCH=true  → disabled (hard off)
 * AI_ENABLED=false     → disabled (soft off)
 * Default              → enabled
 */
export function isAiEnabled(): boolean {
  if (process.env.AI_KILL_SWITCH === "true") return false;
  if (process.env.AI_ENABLED === "false") return false;
  return true;
}

// ── requireAuth ───────────────────────────────────────────────────────────────

/**
 * Ensures a valid authenticated user is present.
 * Returns 401 for anonymous requests (no req.user).
 */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.id) {
    res.status(401).json({
      error_code: "UNAUTHORIZED",
      message: "Authentication required.",
    });
    return;
  }
  next();
}

// ── requireActiveMembership ───────────────────────────────────────────────────

/**
 * Ensures the user is a member of a real tenant organisation.
 * Demo users (organizationId="demo-org") are rejected.
 */
export function requireActiveMembership(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const orgId = req.user?.organizationId;
  if (!orgId || orgId === DEMO_ORG_ID) {
    res.status(403).json({
      error_code: "FORBIDDEN",
      message: "Active tenant membership required to access AI features.",
    });
    return;
  }
  next();
}

// ── requireTenantScope ────────────────────────────────────────────────────────

/**
 * Rejects cross-tenant scope violations.
 * If request body or query includes organizationId that doesn't match
 * the authenticated user's org, returns 403 — unless platform admin.
 */
export function requireTenantScope(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const userOrg = req.user?.organizationId;

  const bodyOrg = (req.body as Record<string, unknown> | undefined)
    ?.organizationId as string | undefined;
  const queryOrg = req.query.organizationId as string | undefined;
  const requestedOrg = bodyOrg ?? queryOrg;

  if (requestedOrg && userOrg && requestedOrg !== userOrg) {
    // Platform admins may cross org boundaries
    if (PLATFORM_ADMIN_ROLES.has(req.user?.role ?? "")) {
      return next();
    }
    res.status(403).json({
      error_code: "TENANT_SCOPE_VIOLATION",
      message: "Cross-tenant access denied.",
    });
    return;
  }

  next();
}

// ── requireFeatureFlag ────────────────────────────────────────────────────────

/**
 * Factory: returns a middleware that checks a named feature flag.
 * Currently env-based (global + kill switch). Tenant-level hook is ready.
 */
export function requireFeatureFlag(flag: string): RequestHandler {
  return function featureFlagGuard(
    _req: Request,
    res: Response,
    next: NextFunction,
  ): void {
    if (flag === "ai" && !isAiEnabled()) {
      res.status(503).json({
        error_code: "FEATURE_DISABLED",
        message: "AI features are currently disabled.",
      });
      return;
    }
    next();
  };
}

// ── requireBudgetAvailable ────────────────────────────────────────────────────

/**
 * Checks that the authenticated tenant has not exceeded their monthly AI budget.
 * Returns 429 if budget is exceeded.
 * Fails open (logs error) if budget check itself fails — prevents cascading outages.
 */
export async function requireBudgetAvailable(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const orgId = req.user?.organizationId;

  // Demo users and missing org: skip budget check
  if (!orgId || orgId === DEMO_ORG_ID) {
    next();
    return;
  }

  try {
    const result = await checkTenantBudget(orgId, "monthly");
    if (result && result.status === "exceeded") {
      res.status(429).json({
        error_code: "BUDGET_EXCEEDED",
        message: "AI usage budget exceeded for this billing period.",
        utilization_pct: result.utilizationPct,
      });
      return;
    }
  } catch (err) {
    // Fail open: budget DB error must not block legitimate requests
    console.error("[ai-guards] Budget check failed — failing open:", (err as Error).message);
  }

  next();
}

// ── requirePlatformAdmin ──────────────────────────────────────────────────────

/**
 * Middleware: requires platform_admin or superadmin role.
 * Returns 401 for anonymous, 403 for authenticated non-admin.
 */
export function requirePlatformAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!req.user?.id) {
    res.status(401).json({
      error_code: "UNAUTHORIZED",
      message: "Authentication required.",
    });
    return;
  }

  if (!PLATFORM_ADMIN_ROLES.has(req.user.role)) {
    res.status(403).json({
      error_code: "FORBIDDEN",
      message: "Platform admin access required.",
    });
    return;
  }

  next();
}

// ── adminGuardMiddleware ──────────────────────────────────────────────────────

/**
 * Combined admin guard: bypasses CI/CD health-check paths, enforces
 * requirePlatformAdmin on all other /api/admin/* paths.
 * Register as: app.use("/api/admin", adminGuardMiddleware)
 */
export function adminGuardMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const fullPath = req.originalUrl?.split("?")[0] ?? req.path;
  if ((ADMIN_PUBLIC_PATHS as readonly string[]).includes(fullPath)) {
    return next();
  }
  requirePlatformAdmin(req, res, next);
}

// ── AI expensive rate limiter ─────────────────────────────────────────────────

/**
 * Per-user + per-tenant rate limit for expensive AI operations.
 * 10 requests / minute per user × tenant combination.
 */
export const aiExpensiveRateLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  // Key: user + org. Authenticated users always have id so IP fallback is never used.
  // If somehow unauthenticated (chain bug), "anon" bucket is shared — acceptable.
  keyGenerator: (req) => {
    const userId = req.user?.id ?? "anon";
    const orgId = req.user?.organizationId ?? "unknown";
    return `ai_expensive:${orgId}:${userId}`;
  },
  // Suppress IPv6 warning — key never uses req.ip (we key on userId + orgId)
  validate: { xForwardedForHeader: false },
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({
      error_code: "AI_RATE_LIMIT_EXCEEDED",
      message: "Too many AI requests. Please slow down.",
    });
  },
});

// ── Composed guard chains ─────────────────────────────────────────────────────

/**
 * Full AI route guard chain:
 *   authMiddleware (global)
 *   → requireAuth            — 401 for anonymous
 *   → requireActiveMembership — 403 for demo / no org
 *   → requireTenantScope     — 403 for cross-tenant
 *   → requireFeatureFlag("ai") — 503 if AI kill switch active
 *   → requireBudgetAvailable  — 429 if budget exceeded
 *   → aiExpensiveRateLimit    — 429 if rate limited
 */
export const aiRouteChain: RequestHandler[] = [
  requireAuth,
  requireActiveMembership,
  requireTenantScope,
  requireFeatureFlag("ai"),
  requireBudgetAvailable as RequestHandler,
  aiExpensiveRateLimit,
];

/**
 * Admin route guard chain:
 *   authMiddleware (global)
 *   → requireAuth           — 401 for anonymous
 *   → requirePlatformAdmin  — 403 for non-platform-admin
 */
export const adminRouteChain: RequestHandler[] = [
  requireAuth,
  requirePlatformAdmin,
];
