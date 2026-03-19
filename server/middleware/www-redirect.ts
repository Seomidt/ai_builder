/**
 * www → apex redirect middleware
 * Phase Next — Domain/Subdomain Architecture Hardening
 *
 * Ensures www.blissops.com always redirects to blissops.com (apex).
 * 301 Permanent redirect — canonical is the apex domain.
 * Health-check paths are bypassed to avoid monitoring issues.
 */

import { Request, Response, NextFunction } from "express";
import { PUBLIC_CANONICAL_HOST } from "../lib/platform/platform-hardening-config";

const WWW_HOST = `www.${PUBLIC_CANONICAL_HOST}`;

const BYPASS_PATHS = new Set(["/health", "/healthz", "/ping"]);

function extractHost(req: Request): string {
  const raw =
    (req.headers["x-forwarded-host"] as string) ||
    req.headers.host ||
    "";
  return raw.toLowerCase().replace(/:\d+$/, "");
}

export function wwwRedirectMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const host = extractHost(req);

  if (host !== WWW_HOST) {
    next();
    return;
  }

  if (BYPASS_PATHS.has(req.path)) {
    next();
    return;
  }

  const target = `https://${PUBLIC_CANONICAL_HOST}${req.path}${req.search ?? ""}`;
  res.redirect(301, target);
}
