/**
 * domain-config.ts — Single Source of Truth for Current Domain Mode
 *
 * CURRENT LIVE PRODUCTION:
 *   blissops.com = entire authenticated application (tenant + admin, path-based)
 *   www.blissops.com = 301 redirect to blissops.com
 *
 * NOT ACTIVE:
 *   app.blissops.com — planned, not live
 *   admin.blissops.com — planned, not live
 *
 * Change DOMAIN_CONFIG.mode to "multi" only when subdomains are fully provisioned.
 */

export type DomainMode = "single" | "multi";

// Railway API service public URL — injected via RAILWAY_PUBLIC_DOMAIN env var at runtime
const RAILWAY_HOST = process.env.RAILWAY_PUBLIC_DOMAIN ?? "";

export const DOMAIN_CONFIG = {
  mode: "single" as DomainMode,
  primaryDomain: "blissops.com",
  redirectHosts: ["www.blissops.com"],
  allowHosts: [
    "blissops.com",
    "www.blissops.com",
    // Railway: allow its own public domain so Express host-allowlist passes
    ...(RAILWAY_HOST ? [RAILWAY_HOST] : []),
  ],
  blockPreviewHosts: true,

  // Future-only targets. Not active in runtime yet.
  plannedSubdomains: {
    app: "app.blissops.com",
    admin: "admin.blissops.com",
  },
} as const;
