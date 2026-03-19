/**
 * Final Hardening Closeout — Host Allowlist Middleware
 *
 * Production: only canonical blissops.com hosts are accepted.
 * Development/preview: localhost + preview hosts permitted.
 * Rejected hosts return 403 and are logged for diagnostics.
 *
 * Does NOT break:
 * - health checks (/ path always passes)
 * - local development
 * - Replit preview environments
 */

import { Request, Response, NextFunction } from "express";
import {
  isProduction,
  isPreview,
  PRODUCTION_ALLOWED_HOSTS,
  DEV_ALLOWED_HOST_PATTERNS,
  PREVIEW_ALLOWED_HOST_PATTERNS,
  ALWAYS_BLOCKED_HOSTS,
} from "../lib/platform/platform-hardening-config";

// ─── Host extraction ──────────────────────────────────────────────────────────

function extractHost(req: Request): string {
  const raw =
    (req.headers["x-forwarded-host"] as string) ||
    req.headers.host ||
    "";
  return raw.toLowerCase().replace(/:\d+$/, ""); // strip port
}

// ─── Host validation ──────────────────────────────────────────────────────────

function isAllowedHost(host: string, env: ReturnType<typeof import("../lib/platform/platform-hardening-config")["getRuntimeEnv"]>): boolean {
  if (!host) return false;

  if (ALWAYS_BLOCKED_HOSTS.has(host)) return false;

  if (PRODUCTION_ALLOWED_HOSTS.has(host)) return true;

  if (env !== "production") {
    if (DEV_ALLOWED_HOST_PATTERNS.some((p) => host === p || host.endsWith(p))) return true;
    if (PREVIEW_ALLOWED_HOST_PATTERNS.some((p) => host.endsWith(p))) return true;
  }

  return false;
}

// ─── Health check bypass ──────────────────────────────────────────────────────

const ALWAYS_PASS_PATHS = new Set(["/", "/health", "/healthz", "/ping"]);

// ─── Middleware ───────────────────────────────────────────────────────────────

export function hostAllowlistMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const { getRuntimeEnv } = require("../lib/platform/platform-hardening-config") as typeof import("../lib/platform/platform-hardening-config");
  const env  = getRuntimeEnv();
  const host = extractHost(req);

  if (ALWAYS_PASS_PATHS.has(req.path)) {
    next();
    return;
  }

  if (isAllowedHost(host, env)) {
    next();
    return;
  }

  if (env === "production") {
    console.warn(`[host-allowlist] REJECTED host="${host}" path="${req.path}" ip="${req.ip}"`);
    res.status(403).json({
      error_code: "HOST_NOT_ALLOWED",
      message:    "This hostname is not permitted on this origin.",
    });
    return;
  }

  console.debug(`[host-allowlist] Non-production: passing unknown host="${host}"`);
  next();
}

// ─── Exported helpers for testing ─────────────────────────────────────────────

export { extractHost, isAllowedHost };
