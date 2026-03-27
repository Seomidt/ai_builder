/**
 * Runtime domain detection — determines which app surface to render.
 *
 * CANONICAL DOMAIN MODEL (production-grade SaaS):
 *   blissops.com          → MarketingApp  (public landing / marketing site)
 *   www.blissops.com      → MarketingApp  (same as above)
 *   app.blissops.com      → TenantApp     (authenticated product surface)
 *   admin.blissops.com    → AdminApp      (platform operations surface)
 *
 * LOCAL DEV EQUIVALENTS:
 *   localhost             → TenantApp     (most common dev scenario, documented)
 *   app.localhost         → TenantApp     (explicit tenant-surface dev)
 *   admin.localhost       → AdminApp      (admin surface dev)
 *   (no marketing localhost — use blissops.com staging or code-split)
 *
 * AUTH:
 *   - Session cookie domain ".blissops.com" — shared across app + admin
 *   - Marketing host has no authenticated shell
 *   - Auth routes on marketing host redirect → app.blissops.com/auth/*
 *
 * SECURITY:
 *   Domain == UI surface selection ONLY.
 *   Backend authorization (AdminRoute + /api/auth/session) is MANDATORY.
 *   NEVER trust hostname for access control decisions.
 */

export type AppContext = "marketing" | "tenant" | "admin";

/**
 * Determine which application surface to render based on the hostname.
 */
export function getAppContext(hostname: string): AppContext {
  const h = hostname.toLowerCase().replace(/:\d+$/, ""); // strip port

  if (h.startsWith("admin."))                               return "admin";
  if (h.startsWith("app."))                                 return "tenant";
  if (h === "blissops.com" || h === "www.blissops.com")     return "marketing";

  // localhost and *.localhost → tenant (development default)
  // Use admin.localhost or app.localhost for explicit surface targeting
  if (h === "localhost" || h === "127.0.0.1" || h.endsWith(".localhost")) return "tenant";

  // Any blissops.com variant not already matched (e.g. preview.blissops.com) → marketing
  if (h.includes("blissops.com")) return "marketing";

  // Replit preview/dev URLs → tenant (development preview surface)
  // Auth is still enforced by ProtectedRoute — this only controls which shell renders.
  if (h.includes(".replit.dev") || h.includes(".repl.co") || h.includes(".picard.replit.dev") || h.includes(".id.replit.app")) return "tenant";

  // All other hostnames (Vercel preview, CI/staging URLs) → marketing
  // These environments are used to preview the public marketing surface.
  // Tenant auth flows operate exclusively on app.blissops.com — not on preview URLs.
  return "marketing";
}

/**
 * Returns the cookie domain for cross-subdomain session sharing.
 *
 * Extracts the root domain (last two parts) so:
 *   app.blissops.com   → .blissops.com  (shared with admin)
 *   admin.blissops.com → .blissops.com
 *   blissops.com       → .blissops.com
 *   localhost          → ""  (no domain attr, scoped to localhost)
 *   app.localhost      → ""
 */
export function getAuthCookieDomain(hostname = window.location.hostname): string {
  const h = hostname.toLowerCase().replace(/:\d+$/, "");
  if (h === "localhost" || h === "127.0.0.1") return "";
  if (h.endsWith(".localhost")) return ""; // app.localhost / admin.localhost
  // Replit preview domains (.replit.dev, .riker.replit.dev, .repl.co etc.)
  // are public suffixes — browsers reject domain-scoped cookies on them.
  // Return empty string so cookie is scoped to the exact origin instead.
  if (h.includes(".replit.dev") || h.includes(".repl.co") || h.includes(".replit.app")) return "";
  const parts = h.split(".");
  if (parts.length <= 2) return `.${h}`;               // already a root domain
  return `.${parts.slice(-2).join(".")}`;              // e.g. .blissops.com
}

// ─── Origin builders ─────────────────────────────────────────────────────────
// Used internally by urls.ts — prefer importing from urls.ts in components.

function _devPort(): string {
  return typeof window !== "undefined" ? `:${window.location.port || "5000"}` : ":5000";
}

/** Raw origin for the marketing/public surface */
export function getMarketingOrigin(hostname = window.location.hostname): string {
  const h = hostname.toLowerCase();
  if (h.startsWith("localhost") || h.startsWith("127.")) return `http://localhost${_devPort()}`;
  if (h.endsWith(".localhost")) return `http://localhost${_devPort()}`;
  const root = h.split(".").slice(-2).join(".");
  return `https://${root}`;
}

/** Raw origin for the tenant product surface */
export function getTenantOrigin(hostname = window.location.hostname): string {
  const h = hostname.toLowerCase();
  if (h.startsWith("localhost") || h.startsWith("127.")) return `http://localhost${_devPort()}`;
  if (h.endsWith(".localhost")) return `http://app.localhost${_devPort()}`;
  const root = h.split(".").slice(-2).join(".");
  return `https://app.${root}`;
}

/** Raw origin for the admin surface */
export function getAdminOrigin(hostname = window.location.hostname): string {
  const h = hostname.toLowerCase();
  if (h.startsWith("localhost") || h.startsWith("127.")) return `http://admin.localhost${_devPort()}`;
  if (h.endsWith(".localhost")) return `http://admin.localhost${_devPort()}`;
  const root = h.split(".").slice(-2).join(".");
  return `https://admin.${root}`;
}
