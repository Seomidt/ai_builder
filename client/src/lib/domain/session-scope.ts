/**
 * Session / Cookie Scope Strategy
 * Phase 49 — Domain/Subdomain Architecture
 *
 * Defines the correct cookie and session model for the multi-domain platform.
 * The goal is to keep privileged session data scoped as tightly as possible.
 */

import { DOMAIN_ROLE, ROOT_DOMAIN, CANONICAL_HOSTS } from "./config";

// ─── Cookie Scope Decision ────────────────────────────────────────────────────

/**
 * DECISION: App-scoped cookies, NOT root-domain cookies.
 *
 * Rationale:
 * - app.blissops.com hosts the authenticated SPA + auth callbacks
 * - admin.blissops.com is currently the same SPA deployment (ops routes)
 *   → will migrate to isolated deployment in Phase 52+
 * - public blissops.com is unauthenticated; sharing cookies is unnecessary
 *
 * Cookie scope options considered:
 *
 * Option A: .blissops.com (root domain — all subdomains share)
 *   Pros: SSO between app + admin without token exchange
 *   Cons: public domain receives privileged session cookie (CSRF risk),
 *         token leakage if public domain is compromised
 *
 * Option B: app.blissops.com (app-only — DEFAULT CHOICE)
 *   Pros: minimal scope, public cannot read/send session token,
 *         clean CSRF boundary, simpler logout
 *   Cons: admin.blissops.com cannot read app session cookie directly
 *         → mitigated: admin is same deployment until Phase 52 isolation
 *
 * Option C: Per-subdomain isolation (app + admin separate tokens)
 *   Pros: maximum isolation
 *   Cons: requires cross-domain token handoff for shared sessions
 *         → deferred to Phase 52+ after Cloudflare origin wiring
 *
 * CHOSEN: Option B. App-scoped cookies for now.
 */

// ─── Cookie Config Constants ──────────────────────────────────────────────────

export const SESSION_COOKIE = {
  /** Supabase auth session (managed by Supabase JS SDK) */
  SUPABASE_SESSION: "sb-access-token",

  /** Locale preference (set by Phase 48 i18n) */
  LOCALE: "blissops_locale",

  /** CSRF double-submit token */
  CSRF:   "blissops_csrf",
} as const;

export const COOKIE_SCOPE = {
  /**
   * Preferred scope for privileged cookies.
   * Use app.blissops.com — NOT .blissops.com (root wildcard).
   */
  APP_ONLY:       CANONICAL_HOSTS[DOMAIN_ROLE.APP],

  /**
   * Root-domain scope (.blissops.com).
   * Only use for non-sensitive, cross-subdomain cookies (e.g. locale preference).
   * NEVER use for session/auth tokens.
   */
  ROOT_DOMAIN:    `.${ROOT_DOMAIN}`,
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
 *
 * Note: SameSite=None requires Secure=true and is ONLY for cross-site embeds.
 * This platform does NOT embed in third-party iframes — never use None.
 */
export const SAMESITE_POLICY: Record<keyof typeof SESSION_COOKIE, "Strict" | "Lax"> = {
  SUPABASE_SESSION: "Lax",
  LOCALE:           "Lax",
  CSRF:             "Strict",
};

// ─── Auth Callback Flow ───────────────────────────────────────────────────────

/**
 * Auth callback paths — all callbacks MUST resolve to app.blissops.com.
 *
 * These paths are registered in Supabase allow-list:
 *   - https://app.blissops.com/auth/callback
 *   - https://app.blissops.com/auth/invite-accept
 *   - https://app.blissops.com/auth/email-verify
 *   - https://app.blissops.com/auth/password-reset-confirm
 *   - https://app.blissops.com/auth/mfa-challenge
 *
 * NEVER locale-prefix these paths.
 * NEVER move these to admin.blissops.com or blissops.com.
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
 * 1. Call supabase.auth.signOut() — clears Supabase session from localStorage + cookies
 * 2. Delete blissops_csrf cookie (domain: app.blissops.com)
 * 3. Delete blissops_locale only if the logout is a full account removal (NOT standard logout)
 * 4. Redirect to https://app.blissops.com/auth/login
 *
 * Cross-subdomain note:
 * If admin.blissops.com ever gets an isolated session, a logout on app must
 * also invalidate the admin session. Until Phase 52 isolation this is implicit
 * (same deployment = same token in memory).
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
 * Assessment of which cookies need cross-subdomain scope (.blissops.com)
 * vs app-only scope (app.blissops.com).
 */
export const CROSS_SUBDOMAIN_ASSESSMENT: CrossSubdomainAssessment[] = [
  {
    required:   false,
    cookieName: SESSION_COOKIE.SUPABASE_SESSION,
    scope:      COOKIE_SCOPE.APP_ONLY,
    reason:     "Session token must NOT be shared with public domain. App-scoped is correct.",
  },
  {
    required:   false,
    cookieName: SESSION_COOKIE.CSRF,
    scope:      COOKIE_SCOPE.APP_ONLY,
    reason:     "CSRF must be strictly scoped. Never root-domain.",
  },
  {
    required:   true,
    cookieName: SESSION_COOKIE.LOCALE,
    scope:      COOKIE_SCOPE.ROOT_DOMAIN,
    reason:     "Locale preference is benign and ideally consistent across public + app domains.",
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
