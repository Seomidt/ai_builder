/**
 * Final Production Lock — Admin Domain Isolation Middleware
 *
 * Enforces that admin routes (/ops/*, /api/admin/*) are only accessible
 * from admin.blissops.com.
 *
 * Wrong-host behaviour:
 *   - GET page requests → 302 redirect to https://admin.blissops.com (UX only)
 *   - API routes / mutating requests → 403 (no redirect, ever)
 *   - Access control: redirect is NOT access control — auth still required after redirect
 *
 * X-Robots-Tag: noindex, nofollow is set on all admin domain responses.
 * Does not break local development (localhost/replit bypass in non-production).
 */

import { Request, Response, NextFunction } from "express";
import {
  ADMIN_CONFIG,
} from "../lib/platform/platform-hardening-config";

// ─── Environment detection (explicit NODE_ENV) ────────────────────────────────

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

// ─── Host extraction ──────────────────────────────────────────────────────────

function extractHost(req: Request): string {
  const raw =
    (req.headers["x-forwarded-host"] as string) ||
    req.headers.host ||
    "";
  return raw.toLowerCase().replace(/:\d+$/, "");
}

// ─── Check if path is admin-scoped ────────────────────────────────────────────

export function isAdminPath(path: string): boolean {
  return ADMIN_CONFIG.adminPathPrefixes.some((prefix) =>
    path === prefix || path.startsWith(prefix + "/"),
  );
}

// ─── Check if this is an API route (never redirect, always 403) ───────────────

function isApiRoute(path: string): boolean {
  return path.startsWith("/api/");
}

// ─── Check if method is mutating (never redirect) ─────────────────────────────

function isMutatingMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

// ─── Check if host is local dev ───────────────────────────────────────────────

function isLocalDev(host: string): boolean {
  if (isProductionEnv()) return false;
  return (
    host === "localhost" ||
    host.startsWith("127.") ||
    host === "0.0.0.0" ||
    host.endsWith(".replit.dev") ||
    host.endsWith(".replit.app") ||
    host.endsWith(".repl.co")
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

  // Always allow local dev
  if (isLocalDev(host)) {
    next();
    return;
  }

  // Correct host — allow through
  if (host === ADMIN_CONFIG.canonicalHost) {
    next();
    return;
  }

  // Wrong host — log the attempt
  console.warn(
    `[admin-domain] Admin path "${req.path}" attempted from non-admin host="${host}" method="${req.method}"`,
  );

  // API routes and mutating methods → always 403, never redirect
  if (isApiRoute(req.path) || isMutatingMethod(req.method)) {
    res.status(403).json({
      error_code: "ADMIN_HOST_REQUIRED",
      message:    "Admin routes are only accessible from the admin domain.",
    });
    return;
  }

  // GET page requests from wrong host → redirect to admin domain (UX only)
  const targetUrl = `https://${ADMIN_CONFIG.canonicalHost}${req.path}${req.search ?? ""}`;
  res.redirect(302, targetUrl);
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
