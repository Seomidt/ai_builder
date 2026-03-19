/**
 * Final Production Lock — Host Allowlist Middleware
 *
 * Production: ONLY canonical blissops.com hosts accepted.
 *   Explicit NODE_ENV === 'production' gating — no implicit fallback.
 *   localhost, *.vercel.app, *.replit.dev → 403 in production.
 *
 * Development/preview: localhost + preview hosts permitted.
 * Rejected hosts return 403 and are logged for diagnostics.
 *
 * Does NOT break:
 * - health checks (/health, /ping always pass)
 * - local development
 * - Replit preview environments
 */

import { Request, Response, NextFunction } from "express";
import {
  PRODUCTION_ALLOWED_HOSTS,
  DEV_ALLOWED_HOST_PATTERNS,
  PREVIEW_ALLOWED_HOST_PATTERNS,
} from "../lib/platform/platform-hardening-config";

// ─── Environment detection (explicit NODE_ENV check) ─────────────────────────

function isProductionEnv(): boolean {
  return process.env.NODE_ENV === "production";
}

// ─── Host extraction ──────────────────────────────────────────────────────────

function extractHost(req: Request): string {
  const raw =
    (req.headers["x-forwarded-host"] as string) ||
    req.headers.host ||
    "";
  return raw.toLowerCase().replace(/:\d+$/, ""); // strip port
}

// ─── Explicit production block patterns ───────────────────────────────────────

const PRODUCTION_BLOCKED_SUFFIXES = [
  ".vercel.app",
  ".replit.dev",
  ".replit.app",
  ".repl.co",
  ".netlify.app",
];

const PRODUCTION_BLOCKED_EXACT = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
]);

function isExplicitlyBlockedInProduction(host: string): boolean {
  if (PRODUCTION_BLOCKED_EXACT.has(host)) return true;
  if (PRODUCTION_BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return true;
  return false;
}

// ─── Host validation ──────────────────────────────────────────────────────────

export function isAllowedHost(host: string): boolean {
  if (!host) return false;

  if (isProductionEnv()) {
    // Production: explicit block list first
    if (isExplicitlyBlockedInProduction(host)) return false;
    // Production: only canonical hosts allowed
    return PRODUCTION_ALLOWED_HOSTS.has(host);
  }

  // Non-production: canonical hosts always allowed
  if (PRODUCTION_ALLOWED_HOSTS.has(host)) return true;

  // Non-production: dev patterns allowed
  if (DEV_ALLOWED_HOST_PATTERNS.some((p) => host === p || host.endsWith(p))) return true;

  // Non-production: preview patterns allowed
  if (PREVIEW_ALLOWED_HOST_PATTERNS.some((p) => host.endsWith(p))) return true;

  // Non-production: pass unknown hosts (dev flexibility)
  return true;
}

// ─── Health check bypass ──────────────────────────────────────────────────────

const ALWAYS_PASS_PATHS = new Set(["/", "/health", "/healthz", "/ping"]);

// ─── Middleware ───────────────────────────────────────────────────────────────

export function hostAllowlistMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (ALWAYS_PASS_PATHS.has(req.path)) {
    next();
    return;
  }

  const host = extractHost(req);

  if (isAllowedHost(host)) {
    next();
    return;
  }

  console.warn(`[host-allowlist] REJECTED host="${host}" path="${req.path}" env="${process.env.NODE_ENV}" ip="${req.ip}"`);
  res.status(403).json({
    error_code: "HOST_NOT_ALLOWED",
    message:    "This hostname is not permitted on this origin.",
  });
}

// ─── Exported helpers ─────────────────────────────────────────────────────────

export { extractHost };
