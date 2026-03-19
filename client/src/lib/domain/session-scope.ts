/**
 * Session / Cookie Scope Strategy
 * Phase 49 — Domain/Subdomain Architecture
 *
 * CURRENT MODE: single-domain (blissops.com)
 * All session and cookie logic targets blissops.com.
 */

import { DOMAIN_ROLE, ROOT_DOMAIN, CANONICAL_HOSTS } from "./config";

// ─── Cookie Scope Decision ────────────────────────────────────────────────────

/**
 * SINGLE-DOMAIN MODE: blissops.com hosts everything.
 *
 * Cookie scope: blissops.com (exact host, no leading dot).
 * No cross-subdomain sharing needed — there are no active subdomains.
 *
 * Supabase session is stored in localStorage by the JS SDK (not a cookie).
 * Custom cookies (CSRF, locale) are scoped to blissops.com.
 *
 * Future (multi-domain):
 *   - CSRF + session: app.blissops.com (app-only)
 *   - Locale: .blissops.com (root domain, benign)
 */

// ─── Cookie Config Constants ──────────────────────────────────────────────────

export const SESSION_COOKIE = {
  /** Supabase auth session key (managed by Supabase JS SDK in localStorage) */
  SUPABASE_SESSION: "blissops_auth",

  /** Locale preference (set by Phase 48 i18n) */
  LOCALE: "blissops_locale",

  /** CSRF double-submit token */
  CSRF:   "blissops_csrf",
} as const;

export const COOKIE_SCOPE = {
  /**
   * Single-domain: all cookies scoped to blissops.com.
   * No leading dot — no cross-subdomain leakage (no subdomains are active).
   */
  APP_ONLY:    CANONICAL_HOSTS[DOMAIN_ROLE.APP],

  /**
   * Root-domain scope (.blissops.com).
   * Reserved for future use when subdomains go live.
   * Currently unused — single-domain mode needs no root-domain cookies.
   */
  ROOT_DOMAIN: `.${ROOT_DOMAIN}`,
} as const;

// ─── SameSite Implications ────────────────────────────────────────────────────

/**
 * SameSite policy recommendations by cookie type.
 *
 * | Cookie        | SameSite   | Reason                                    |
 * |---------------|------------|-------------------------------------------|
 * | Supabase auth | Lax        | SDK default; safe for top-level nav       |
 * | CSRF token    | Strict     | Must not be sent on cross-site requests   |
 * | Locale pref   | Lax        | Benign; can tolerate top-level nav sends  |
 */
export const SAMESITE_POLICY: Record<keyof typeof SESSION_COOKIE, "Strict" | "Lax"> = {
  SUPABASE_SESSION: "Lax",
  LOCALE:           "Lax",
  CSRF:             "Strict",
};

// ─── Auth Callback Flow ───────────────────────────────────────────────────────

/**
 * Auth callback paths — all resolve to blissops.com/auth/*.
 *
 * Registered in Supabase allow-list:
 *   - https://blissops.com/auth/callback
 *   - https://blissops.com/auth/invite-accept
 *   - https://blissops.com/auth/email-verify
 *   - https://blissops.com/auth/password-reset-confirm
 *   - https://blissops.com/auth/mfa-challenge
 *
 * NEVER locale-prefix these paths.
 */
export const AUTH_CALLBACK_PATHS = [
  "/auth/callback",
  "/auth/invite-accept",
  "/auth/email-verify",
  "/auth/password-reset-confirm",
  "/auth/mfa-challenge",
] as const;

export type AuthCallbackPath = (typeof AUTH_CALLBACK_PATHS)[number];

export function isAuthCallbackPath(path: string): boolean {
  const normalised = path.replace(/\/+$/, "");
  return AUTH_CALLBACK_PATHS.includes(normalised as AuthCallbackPath);
}

// ─── Logout Strategy ─────────────────────────────────────────────────────────

/**
 * Logout must:
 * 1. Call supabase.auth.signOut() — clears localStorage session
 * 2. Delete blissops_csrf cookie (domain: blissops.com)
 * 3. Redirect to https://blissops.com/auth/login
 */
export interface LogoutConfig {
  clearLocale: boolean;
  redirectTo:  string;
  clearCsrf:   boolean;
}

export const STANDARD_LOGOUT: LogoutConfig = {
  clearLocale: false,
  redirectTo:  `https://${CANONICAL_HOSTS[DOMAIN_ROLE.APP]}/auth/login`,
  clearCsrf:   true,
};

// ─── Cross-Subdomain Cookie Assessment ───────────────────────────────────────

export interface CrossSubdomainAssessment {
  required:    boolean;
  reason:      string;
  cookieName:  string;
  scope:       string;
}

/**
 * Single-domain mode: no cross-subdomain cookies needed.
 * All cookies stay on blissops.com.
 */
export const CROSS_SUBDOMAIN_ASSESSMENT: CrossSubdomainAssessment[] = [
  {
    required:   false,
    cookieName: SESSION_COOKIE.SUPABASE_SESSION,
    scope:      COOKIE_SCOPE.APP_ONLY,
    reason:     "Session token stored in localStorage by Supabase SDK. No cookie cross-domain needed.",
  },
  {
    required:   false,
    cookieName: SESSION_COOKIE.CSRF,
    scope:      COOKIE_SCOPE.APP_ONLY,
    reason:     "CSRF must be strictly scoped. Single-domain — blissops.com only.",
  },
  {
    required:   false,
    cookieName: SESSION_COOKIE.LOCALE,
    scope:      COOKIE_SCOPE.APP_ONLY,
    reason:     "Single-domain mode: locale cookie stays on blissops.com. No subdomain sharing needed.",
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Return the recommended cookie Domain attribute for a given cookie name */
export function getCookieScopeForName(cookieName: string): string {
  const assessment = CROSS_SUBDOMAIN_ASSESSMENT.find((a) => a.cookieName === cookieName);
  return assessment?.scope ?? COOKIE_SCOPE.APP_ONLY;
}

/** True if the given cookie should use root-domain scope */
export function requiresRootDomainScope(cookieName: string): boolean {
  const assessment = CROSS_SUBDOMAIN_ASSESSMENT.find((a) => a.cookieName === cookieName);
  return assessment?.required ?? false;
}
