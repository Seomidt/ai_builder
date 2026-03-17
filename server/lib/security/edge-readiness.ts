/**
 * Phase 38 — Cloudflare Edge Readiness Flags
 * Informational assessment of whether edge protection can be safely enabled.
 * Used in Platform Ops to guide Cloudflare production setup.
 */

export interface EdgeReadiness {
  wafReady:            boolean;
  botProtectionReady:  boolean;
  rateLimitReady:      boolean;
  strictTlsReady:      boolean;
  corsReady:           boolean;
  r2Connected:         boolean;
  tokenConfigured:     boolean;
  overallReady:        boolean;
  notes:               string[];
  generatedAt:         string;
}

export function getEdgeReadiness(): EdgeReadiness {
  const notes: string[] = [];

  const tokenConfigured = !!process.env.CF_API_TOKEN;
  const r2Connected     = !!(
    process.env.CF_R2_ACCOUNT_ID &&
    process.env.CF_R2_ACCESS_KEY_ID &&
    process.env.CF_R2_SECRET_ACCESS_KEY &&
    process.env.CF_R2_BUCKET_NAME
  );
  const strictTlsReady  = process.env.NODE_ENV === "production";
  const rateLimitReady  = true;  // Phase 38 api-rate-limits.ts implemented
  const wafReady        = tokenConfigured && r2Connected;
  const botProtectionReady = tokenConfigured;
  const corsReady       = r2Connected;

  if (!tokenConfigured)   notes.push("CF_API_TOKEN not configured — Cloudflare API management unavailable");
  if (!r2Connected)       notes.push("One or more CF_R2_* credentials missing — R2 storage may be unavailable");
  if (!strictTlsReady)    notes.push("NODE_ENV is not 'production' — HSTS and strict TLS only enforced in production");
  if (!wafReady)          notes.push("WAF readiness requires CF_API_TOKEN to be configured");
  if (!botProtectionReady) notes.push("Bot protection requires CF_API_TOKEN to be configured");

  if (tokenConfigured)   notes.push("CF_API_TOKEN present — Cloudflare API management available");
  if (r2Connected)       notes.push("R2 credentials complete — bucket operations available");
  if (rateLimitReady)    notes.push("Application-level rate limiting active (Phase 38)");
  if (corsReady)         notes.push("CORS can be configured via Cloudflare R2 dashboard");

  const overallReady = tokenConfigured && r2Connected;

  return {
    wafReady,
    botProtectionReady,
    rateLimitReady,
    strictTlsReady,
    corsReady,
    r2Connected,
    tokenConfigured,
    overallReady,
    notes,
    generatedAt: new Date().toISOString(),
  };
}
