/**
 * Multi-Domain URL Builders
 * Phase 49 — Domain/Subdomain Architecture
 *
 * All cross-domain URL construction must go through these helpers.
 * No hardcoded hostnames should appear elsewhere in the codebase after this phase.
 */

import { DOMAIN_ROLE, CANONICAL_HOSTS } from "./config";

// ─── Base Origins ─────────────────────────────────────────────────────────────

const ORIGINS = {
  PUBLIC: `https://${CANONICAL_HOSTS[DOMAIN_ROLE.PUBLIC]}`,
  APP:    `https://${CANONICAL_HOSTS[DOMAIN_ROLE.APP]}`,
  ADMIN:  `https://${CANONICAL_HOSTS[DOMAIN_ROLE.ADMIN]}`,
} as const;

// ─── Path Normalisation ───────────────────────────────────────────────────────

function normalisePath(path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return clean === "/" ? clean : clean.replace(/\/+$/, "");
}

// ─── Public Domain ────────────────────────────────────────────────────────────

/**
 * Build a URL for the public marketing domain (blissops.com).
 * No locale prefix unless explicitly supplied.
 */
export function buildPublicUrl(path: string = "/"): string {
  return `${ORIGINS.PUBLIC}${normalisePath(path)}`;
}

/**
 * Build a locale-prefixed URL for the public domain.
 * Used for SEO-safe hreflang, sitemap, and marketing page links.
 *
 * @example buildLocalePublicUrl("da", "/pricing") → "https://blissops.com/da/pricing"
 */
export function buildLocalePublicUrl(locale: string, path: string = "/"): string {
  const cleanPath = normalisePath(path);
  const localePath = cleanPath === "/" ? `/${locale}` : `/${locale}${cleanPath}`;
  return `${ORIGINS.PUBLIC}${localePath}`;
}

// ─── App Domain ───────────────────────────────────────────────────────────────

/**
 * Build a URL for the authenticated app (app.blissops.com).
 * Locale is NEVER injected into app URLs — cookie-based resolution only.
 */
export function buildAppUrl(path: string = "/"): string {
  return `${ORIGINS.APP}${normalisePath(path)}`;
}

// ─── Admin Domain ─────────────────────────────────────────────────────────────

/**
 * Build a URL for the admin/ops surface (admin.blissops.com).
 * Maps to /ops/* paths for now; will route to isolated origin in Phase 52+.
 */
export function buildAdminUrl(path: string = "/ops"): string {
  return `${ORIGINS.ADMIN}${normalisePath(path)}`;
}

// ─── Auth / Callback URLs ─────────────────────────────────────────────────────

/**
 * Build an auth utility URL.
 * Auth callbacks always resolve to app.blissops.com/auth/*.
 * Locale-neutral — never prefixed.
 */
export function buildAuthUrl(path: string): string {
  const clean = normalisePath(path);
  const authPath = clean.startsWith("/auth") ? clean : `/auth${clean}`;
  return `${ORIGINS.APP}${authPath}`;
}

// ─── Specific Auth URLs ───────────────────────────────────────────────────────

/**
 * Build the invite-accept URL for a given token.
 * Used in email notifications and invite workflows.
 */
export function buildInviteUrl(token: string): string {
  return `${ORIGINS.APP}/auth/invite-accept?token=${encodeURIComponent(token)}`;
}

/**
 * Build the password reset confirmation URL for a given token.
 */
export function buildResetPasswordUrl(token: string): string {
  return `${ORIGINS.APP}/auth/password-reset-confirm?token=${encodeURIComponent(token)}`;
}

/**
 * Build the email verification URL for a given token.
 */
export function buildEmailVerifyUrl(token: string): string {
  return `${ORIGINS.APP}/auth/email-verify?token=${encodeURIComponent(token)}`;
}

/**
 * Build the magic link return URL.
 * Used as the `redirectTo` parameter in Supabase magic link requests.
 * Must be registered in Supabase allow-list.
 */
export function buildMagicLinkReturnUrl(returnPath: string = "/"): string {
  const clean = normalisePath(returnPath);
  return `${ORIGINS.APP}/auth/callback?next=${encodeURIComponent(clean)}`;
}

/**
 * Build the OAuth callback URL for a given provider.
 * All OAuth providers must redirect to this stable URL.
 */
export function buildOAuthCallbackUrl(provider?: string): string {
  const query = provider ? `?provider=${encodeURIComponent(provider)}` : "";
  return `${ORIGINS.APP}/auth/callback${query}`;
}

// ─── www Redirect ─────────────────────────────────────────────────────────────

/** Canonical redirect target for www.blissops.com requests */
export function buildWwwRedirectTarget(path: string = "/"): string {
  return buildPublicUrl(path);
}

// ─── Relative URL Guards ──────────────────────────────────────────────────────

/**
 * Returns true if a URL string is an absolute URL to a known platform domain.
 */
export function isPlatformUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return (
      hostname === CANONICAL_HOSTS[DOMAIN_ROLE.PUBLIC] ||
      hostname === CANONICAL_HOSTS[DOMAIN_ROLE.APP] ||
      hostname === CANONICAL_HOSTS[DOMAIN_ROLE.ADMIN]
    );
  } catch {
    return false;
  }
}

/**
 * Safe redirect guard: returns the destination if it is a known platform URL
 * or a relative path, otherwise returns the app home.
 */
export function safeRedirectUrl(destination: string): string {
  if (destination.startsWith("/") && !destination.startsWith("//")) {
    return destination;
  }
  if (isPlatformUrl(destination)) {
    return destination;
  }
  return buildAppUrl("/");
}
