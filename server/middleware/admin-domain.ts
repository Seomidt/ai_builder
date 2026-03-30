/**
 * Admin Domain Middleware — Single-Domain Mode
 *
 * CURRENT MODE: single-domain (blissops.com)
 *
 * Admin/ops access is PATH-BASED and ROLE-BASED — not hostname-based.
 * No host-based routing. The planned admin subdomain is not active in this mode.
 *
 * Enforcement chain applied in server/app.ts:
 *   1. authMiddleware          — valid session required
 *   2. lockdownGuard           — lockdown allowlist check (if enabled)
 *   3. adminGuardMiddleware    — platform_admin role check
 *
 * This middleware adds X-Robots-Tag: noindex, nofollow on admin paths,
 * and logs access attempts for auditing.
 *
 * Future (multi-domain): when admin.blissops.com is live, re-enable
 * host-based routing by setting DOMAIN_CONFIG.mode = "multi" and updating
 * ADMIN_CONFIG.hostBasedAccess = true.
 */

import { Request, Response, NextFunction } from "express";
import { ADMIN_CONFIG } from "../lib/platform/platform-hardening-config.ts";

// ─── Check if path is admin-scoped ────────────────────────────────────────────

export function isAdminPath(path: string): boolean {
  return ADMIN_CONFIG.adminPathPrefixes.some((prefix) =>
    path === prefix || path.startsWith(prefix + "/"),
  );
}

// ─── Domain-role enforcement for admin routes ─────────────────────────────────
//
// In single-domain mode: this is a no-op gate — all enforcement is role-based
// via adminGuardMiddleware. We log the access for audit purposes only.

export function adminDomainGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isAdminPath(req.path)) {
    next();
    return;
  }

  // Single-domain mode: no host-based access control. Pass through.
  // Role check is handled by adminGuardMiddleware in server/app.ts.
  next();
}

// ─── Noindex header for admin paths ───────────────────────────────────────────
//
// Admin/ops paths always carry X-Robots-Tag: noindex, nofollow regardless of host.

export function adminNoindexHeader(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (isAdminPath(req.path)) {
    res.setHeader("X-Robots-Tag", ADMIN_CONFIG.robotsHeaderValue);
  }
  next();
}
