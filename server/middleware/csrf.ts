/**
 * Phase 42 — CSRF Protection Middleware
 *
 * Double-submit cookie pattern.
 * - issueCsrfToken()  : generate 32-byte secure token, set as cookie, return value
 * - verifyCsrfToken() : compare cookie and X-CSRF-Token header in constant time
 * - requireCsrf()     : middleware for state-changing cookie-auth routes
 *
 * Pattern:
 *   1. Browser calls GET /api/auth/csrf → sets csrf_token cookie (SameSite=Strict)
 *   2. Browser sends X-CSRF-Token: <token> on every state-changing request
 *   3. requireCsrf compares cookie ↔ header using timingSafeEqual
 *
 * NOT applied to:
 *   - Pure bearer-token API calls (no ambient cookie auth)
 *   - Safe methods (GET, HEAD, OPTIONS)
 */

import crypto from "crypto";
import type { Request, Response, NextFunction } from "express";

export const CSRF_COOKIE_NAME = "csrf_token";
export const CSRF_HEADER_NAME = "x-csrf-token";
export const CSRF_TOKEN_BYTES = 32;

// ── Token lifecycle ────────────────────────────────────────────────────────────

/**
 * Generate a cryptographically secure CSRF token, set it as a cookie on the
 * response, and return the raw token for embedding in the response body.
 *
 * Cookie flags:
 *   - SameSite=Strict — primary CSRF defense: only sent on same-origin navigations
 *   - Secure in production — never sent over HTTP
 *   - HttpOnly=false — browser JS must be able to read it (double-submit pattern)
 *   - Path=/ — available to all routes
 *   - 8 h expiry — longer than a typical session
 */
export function issueCsrfToken(res: Response): string {
  const token = crypto.randomBytes(CSRF_TOKEN_BYTES).toString("hex");
  const isProduction = process.env.NODE_ENV === "production";

  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: false,      // JS must read it for double-submit
    secure: isProduction,
    sameSite: "strict",
    path: "/",
    maxAge: 8 * 60 * 60 * 1000, // 8 hours
  });

  return token;
}

/**
 * Verify that the CSRF token from the cookie and the X-CSRF-Token header match.
 *
 * Returns false if either is missing, or if they don't match.
 * Uses constant-time comparison to prevent timing attacks.
 */
export function verifyCsrfToken(req: Request): boolean {
  const cookieToken  = req.cookies?.[CSRF_COOKIE_NAME] as string | undefined;
  const headerToken  = req.headers[CSRF_HEADER_NAME]   as string | undefined;

  if (!cookieToken || !headerToken) return false;
  if (typeof cookieToken !== "string" || typeof headerToken !== "string") return false;

  try {
    const bufCookie = Buffer.from(cookieToken, "utf8");
    const bufHeader = Buffer.from(headerToken, "utf8");

    // Lengths must match for timingSafeEqual — if not, reject without leaking timing
    if (bufCookie.length !== bufHeader.length) {
      // still run a dummy comparison to avoid length-based timing leak
      crypto.timingSafeEqual(bufCookie, bufCookie);
      return false;
    }

    return crypto.timingSafeEqual(bufCookie, bufHeader);
  } catch {
    return false;
  }
}

/**
 * Express middleware: require a valid CSRF token on state-changing requests.
 *
 * Safe methods (GET, HEAD, OPTIONS, TRACE) pass through unchanged.
 * All other methods require a matching cookie + header pair.
 *
 * Returns 403 on failure with a structured error body.
 */
export function requireCsrf(
  req:  Request,
  res:  Response,
  next: NextFunction,
): void {
  const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

  if (SAFE_METHODS.has(req.method.toUpperCase())) {
    return next();
  }

  if (!verifyCsrfToken(req)) {
    res.status(403).json({
      error:       "CSRF token missing or invalid",
      code:        "CSRF_VIOLATION",
      description: "Include a valid X-CSRF-Token header matching the csrf_token cookie",
    });
    return;
  }

  next();
}

/**
 * Introspect current CSRF config — used by validation scripts.
 */
export function getCsrfConfig(): {
  cookieName:   string;
  headerName:   string;
  tokenBytes:   number;
  sameSite:     string;
  httpOnly:     boolean;
} {
  return {
    cookieName: CSRF_COOKIE_NAME,
    headerName: CSRF_HEADER_NAME,
    tokenBytes: CSRF_TOKEN_BYTES,
    sameSite:   "strict",
    httpOnly:   false,
  };
}
