/**
 * Canonical URL builders — single source of truth for all cross-surface links.
 *
 * RULE: No component or page should hardcode a hostname string.
 *       Always import helpers from this file.
 *
 * Surface mapping:
 *   marketing  → blissops.com       (prod) | localhost  (dev)
 *   tenant     → app.blissops.com   (prod) | localhost  (dev)
 *   admin      → admin.blissops.com (prod) | admin.localhost (dev)
 */

import {
  getMarketingOrigin,
  getTenantOrigin,
  getAdminOrigin,
} from "@/lib/runtime/domain";

// ─── Marketing URLs ───────────────────────────────────────────────────────────

/** Public marketing home (blissops.com) */
export function getMarketingUrl(path = "/"): string {
  return `${getMarketingOrigin()}${path}`;
}

/** Link to the marketing pricing page */
export function getPricingUrl(): string {
  return getMarketingUrl("/pricing");
}

// ─── Tenant App URLs ──────────────────────────────────────────────────────────

/** Tenant app root or any sub-path (app.blissops.com) */
export function getTenantAppUrl(path = "/"): string {
  return `${getTenantOrigin()}${path}`;
}

/** Tenant login page */
export function getTenantLoginUrl(returnTo?: string): string {
  const base = `${getTenantOrigin()}/auth/login`;
  return returnTo ? `${base}?returnTo=${encodeURIComponent(returnTo)}` : base;
}

/** Post-logout redirect — back to marketing or tenant login */
export function getPostLogoutUrl(): string {
  return getMarketingUrl("/");
}

/** Post-login redirect destination for tenant users */
export function getPostLoginUrl(): string {
  return getTenantAppUrl("/");
}

// ─── Admin App URLs ───────────────────────────────────────────────────────────

/** Admin surface root or any sub-path (admin.blissops.com) */
export function getAdminAppUrl(path = "/ops"): string {
  return `${getAdminOrigin()}${path}`;
}

/** Admin login — uses tenant auth then redirects to admin surface */
export function getAdminLoginUrl(): string {
  return `${getTenantOrigin()}/auth/login?returnTo=${encodeURIComponent(getAdminAppUrl())}`;
}

// ─── Auth redirect helpers ────────────────────────────────────────────────────

/**
 * Redirect marketing host auth attempts to the tenant app login.
 * Called inside MarketingApp when the user navigates to /auth/*.
 */
export function redirectAuthToTenantApp(path = "/auth/login"): void {
  window.location.replace(`${getTenantOrigin()}${path}${window.location.search}`);
}

/**
 * After signOut: redirect to the marketing site.
 */
export function redirectAfterSignOut(): void {
  window.location.replace(getPostLogoutUrl());
}
