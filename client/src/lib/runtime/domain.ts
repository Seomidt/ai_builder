/**
 * Runtime domain detection — determines which app surface to render.
 *
 * Separation model:
 *   blissops.com          → tenant product surface
 *   admin.blissops.com    → platform admin surface
 *
 * Local dev:
 *   localhost             → tenant surface
 *   admin.localhost       → admin surface
 *   admin.localhost:*     → admin surface
 *
 * SECURITY NOTE:
 *   Domain == UI selection ONLY.
 *   All backend authorization is still enforced server-side.
 *   AdminRoute + /api/auth/session role check remain mandatory.
 *   NEVER trust hostname for access control decisions.
 */

export type AppContext = "admin" | "tenant";

/**
 * Determine which application surface to render based on the hostname.
 */
export function getAppContext(hostname: string): AppContext {
  const h = hostname.toLowerCase().replace(/:\d+$/, ""); // strip port
  if (h.startsWith("admin.")) return "admin";
  return "tenant";
}

/**
 * Returns true when the current origin is the admin surface.
 */
export function isAdminDomain(hostname = window.location.hostname): boolean {
  return getAppContext(hostname) === "admin";
}

/**
 * Returns the cookie domain for cross-subdomain session sharing.
 *
 * - Production: .blissops.com (covers blissops.com + admin.blissops.com)
 * - Local dev: empty string (cookie scoped to localhost, no domain needed)
 */
export function getAuthCookieDomain(hostname = window.location.hostname): string {
  const h = hostname.toLowerCase().replace(/:\d+$/, "");
  if (h === "localhost" || h === "127.0.0.1") return "";
  // Strip leading admin. to get root domain
  const root = h.replace(/^admin\./, "");
  return `.${root}`;
}

/**
 * Build a URL on the tenant domain preserving the current path if needed.
 */
export function getTenantOrigin(hostname = window.location.hostname): string {
  const h = hostname.toLowerCase();
  if (h.startsWith("localhost") || h.startsWith("127.")) return "http://localhost:5000";
  const root = h.replace(/^admin\./, "");
  return `https://${root}`;
}

/**
 * Build a URL on the admin domain.
 */
export function getAdminOrigin(hostname = window.location.hostname): string {
  const h = hostname.toLowerCase();
  if (h.startsWith("localhost") || h.startsWith("127.")) return "http://admin.localhost:5000";
  const root = h.replace(/^admin\./, "");
  return `https://admin.${root}`;
}
