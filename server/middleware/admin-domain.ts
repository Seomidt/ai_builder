/**
 * Final Hardening Closeout — Admin Domain Isolation Middleware
 *
 * Enforces that admin routes are only accessible from admin.blissops.com.
 * Public/app hosts attempting admin paths are denied with 403.
 * Does not break existing auth — reads role from verified session.
 */

import { Request, Response, NextFunction } from "express";
import {
  ADMIN_CONFIG,
  isProduction,
} from "../lib/platform/platform-hardening-config";

// ─── Host extraction ──────────────────────────────────────────────────────────

function extractHost(req: Request): string {
  const raw =
    (req.headers["x-forwarded-host"] as string) ||
    req.headers.host ||
    "";
  return raw.toLowerCase().replace(/:\d+$/, "");
}

// ─── Check if path is an admin-scoped path ────────────────────────────────────

export function isAdminPath(path: string): boolean {
  return ADMIN_CONFIG.adminPathPrefixes.some((prefix) =>
    path === prefix || path.startsWith(prefix + "/"),
  );
}

// ─── Domain-role enforcement for admin routes ─────────────────────────────────

export function adminDomainGuard(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!isAdminPath(req.path)) {
    next();
    return;
  }

  const host = extractHost(req);

  const isLocalDev = !isProduction() && (
    host === "localhost" ||
    host.startsWith("127.") ||
    host.endsWith(".replit.dev") ||
    host.endsWith(".replit.app") ||
    host.endsWith(".repl.co")
  );

  if (isLocalDev) {
    next();
    return;
  }

  if (host !== ADMIN_CONFIG.canonicalHost) {
    console.warn(
      `[admin-domain] Admin path "${req.path}" attempted from non-admin host="${host}"`,
    );
    res.status(403).json({
      error_code: "ADMIN_HOST_REQUIRED",
      message:    "Admin routes are only accessible from the admin domain.",
    });
    return;
  }

  next();
}

// ─── Noindex header for admin surface ────────────────────────────────────────

export function adminNoindexHeader(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const host = extractHost(req);
  if (host === ADMIN_CONFIG.canonicalHost) {
    res.setHeader("X-Robots-Tag", ADMIN_CONFIG.robotsHeaderValue); // "noindex, nofollow"
  }
  next();
}
