/**
 * Emergency Production Lockdown Guard
 *
 * When LOCKDOWN_ENABLED=true, only users whose normalized email appears
 * in LOCKDOWN_ALLOWLIST (comma-separated) are permitted to access
 * protected surfaces.
 *
 * Enforcement model:
 *   - No session (anonymous)  → 401
 *   - Session, email NOT listed → 403
 *   - Session, email listed    → next()
 *   - LOCKDOWN_ENABLED != "true" → next() (guard is off)
 *
 * Bypass paths: CI/CD health-checks and recovery endpoints that must
 * remain accessible without auth (same set as authMiddleware.PUBLIC_PATHS).
 *
 * Email normalization: trim + lowercase before comparison.
 *
 * Single source of truth — register once in server/index.ts after authMiddleware.
 * Do NOT duplicate this logic in individual routes.
 */

import type { Request, Response, NextFunction } from "express";

// ── Bypass paths ──────────────────────────────────────────────────────────────
// Must stay in sync with authMiddleware PUBLIC_PATHS + robots.txt endpoint.

const LOCKDOWN_BYPASS_PATHS: readonly string[] = [
  "/api/auth/config",
  "/api/waitlist",
  "/api/early-access",
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
  "/robots.txt",
  "/api/security/csp-report",
  "/health",
  "/healthz",
  "/ping",
];

// ── Config ────────────────────────────────────────────────────────────────────

export interface LockdownConfig {
  enabled: boolean;
  allowlist: ReadonlySet<string>;
}

/**
 * Reads LOCKDOWN_ENABLED and LOCKDOWN_ALLOWLIST from environment.
 * Normalizes all emails in the allowlist.
 * Called once at module load — no runtime re-reads.
 */
export function resolveLockdownConfig(): LockdownConfig {
  const enabled = process.env.LOCKDOWN_ENABLED === "true";

  const raw = process.env.LOCKDOWN_ALLOWLIST ?? "";
  const allowlist = new Set(
    raw
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );

  return { enabled, allowlist };
}

// Resolved once at module import — changes require restart (intentional).
const config: LockdownConfig = resolveLockdownConfig();

// ── Guard ─────────────────────────────────────────────────────────────────────

/**
 * Returns true if the normalized email is in the lockdown allowlist.
 * Email is trimmed + lowercased before comparison.
 */
export function isEmailAllowlisted(email: string | undefined): boolean {
  if (!email) return false;
  return config.allowlist.has(email.trim().toLowerCase());
}

/**
 * Returns true if lockdown is currently active.
 */
export function isLockdownEnabled(): boolean {
  return config.enabled;
}

/**
 * Emergency production lockdown middleware.
 *
 * When LOCKDOWN_ENABLED=true:
 *   - CI/CD bypass paths are allowed through unconditionally
 *   - Anonymous requests → 401
 *   - Authenticated users not in allowlist → 403
 *   - Allowlisted users → next()
 *
 * When LOCKDOWN_ENABLED=false or not set:
 *   - Guard is transparent (calls next() immediately)
 */
export function lockdownGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // Guard is off — transparent pass-through
  if (!config.enabled) {
    return next();
  }

  // Only enforce lockdown on /api/* routes — React SPA handles client-side protection
  if (!req.path.startsWith("/api")) {
    return next();
  }

  // Internal tooling bypass (validation scripts, CI) — same check as authMiddleware
  const internalSecret = process.env.INTERNAL_API_SECRET;
  if (internalSecret && req.headers["x-internal-token"] === internalSecret) {
    return next();
  }

  // Bypass CI/CD health-check and public paths
  if ((LOCKDOWN_BYPASS_PATHS as readonly string[]).includes(req.path)) {
    return next();
  }

  // No authenticated user — 401
  if (!req.user?.id) {
    res.status(401).json({
      error_code: "UNAUTHORIZED",
      message: "Authentication required.",
    });
    return;
  }

  // Authenticated but email not in allowlist — 403
  if (!isEmailAllowlisted(req.user.email)) {
    res.status(403).json({
      error_code: "LOCKDOWN_FORBIDDEN",
      message: "Access denied. This platform is in emergency lockdown.",
    });
    return;
  }

  // Allowlisted user — proceed
  next();
}

// Re-export config for validation script
export { config as lockdownConfig, LOCKDOWN_BYPASS_PATHS };
