/**
 * Phase 38 — SOC2 Readiness Evidence Helpers
 * Generates safe, structured JSON snapshots for internal compliance evidence.
 *
 * RULES:
 *  - NO secrets in any export
 *  - NO plaintext tokens
 *  - Safe for storage in audit-exports/ in R2
 */

import { PLATFORM_SECURITY_HEADERS, PLATFORM_CSP_POLICY, buildCspHeader } from "./security-headers";
import { ROUTE_GROUP_POLICIES, getRouteGroupPolicySummary } from "./api-rate-limits";
import { getRateLimitStats }                                from "./rate-limit";
import { getSecurityControlCoverage, getSecurityReadinessChecklist } from "./incident-readiness";
import { redactEnvSnapshot }                               from "./secret-hygiene";

export interface EvidenceExport {
  exportType:  string;
  generatedAt: string;
  version:     string;
  safe:        true;
  data:        Record<string, unknown>;
}

function stamp(exportType: string, data: Record<string, unknown>): EvidenceExport {
  return {
    exportType,
    generatedAt: new Date().toISOString(),
    version:     "phase38",
    safe:        true,
    data,
  };
}

// ── Security control snapshot ─────────────────────────────────────────────────

export function exportSecurityControlSnapshot(): EvidenceExport {
  return stamp("security_control_snapshot", {
    coverage:   getSecurityControlCoverage(),
    checklist:  getSecurityReadinessChecklist(),
    headers: {
      count:    PLATFORM_SECURITY_HEADERS.length,
      headers:  PLATFORM_SECURITY_HEADERS.map(h => ({ name: h.name, description: h.description })),
      cspDirectiveCount: buildCspHeader(PLATFORM_CSP_POLICY).split(";").length,
    },
  });
}

// ── Deploy integrity snapshot ─────────────────────────────────────────────────

export function exportDeployIntegritySnapshot(): EvidenceExport {
  const envKeys = [
    "NODE_ENV", "DATABASE_URL", "SUPABASE_URL", "CF_R2_BUCKET_NAME",
    "SESSION_SECRET", "OPENAI_API_KEY",
  ];

  const envPresence: Record<string, string> = {};
  for (const key of envKeys) {
    envPresence[key] = process.env[key] ? "present" : "MISSING";
  }

  return stamp("deploy_integrity_snapshot", {
    nodeEnv:         process.env.NODE_ENV ?? "unknown",
    envPresence,
    redactedEnv:     redactEnvSnapshot(
      Object.fromEntries(envKeys.map(k => [k, process.env[k]])) as Record<string, string>,
    ),
    snapshotNote: "Full plaintext env values are never exported. Only presence/redacted form.",
  });
}

// ── Auth control snapshot ─────────────────────────────────────────────────────

export function exportAuthControlSnapshot(): EvidenceExport {
  return stamp("auth_control_snapshot", {
    passwordHashing:       "Argon2id (memory: 65536 KB, iterations: 3, parallelism: 4)",
    mfaSupport:            "TOTP — RFC 6238, 30-second windows, 6-digit codes",
    mfaSecretEncryption:   "AES-256-GCM with platform-level key",
    sessionStorage:        "HttpOnly Secure SameSite=Strict cookie",
    bruteForceProtection:  `auth_login: ${ROUTE_GROUP_POLICIES["auth_login"].maxRequests} req/${ROUTE_GROUP_POLICIES["auth_login"].windowMs / 1000}s per IP`,
    passwordResetLimit:    `${ROUTE_GROUP_POLICIES["auth_password_reset"].maxRequests} req/${ROUTE_GROUP_POLICIES["auth_password_reset"].windowMs / 1000}s per IP`,
    mfaChallengeLimit:     `${ROUTE_GROUP_POLICIES["auth_mfa_challenge"].maxRequests} req/${ROUTE_GROUP_POLICIES["auth_mfa_challenge"].windowMs / 1000}s per IP`,
    auditLogging:          "All auth actions logged to auth_security_events with actor_id, ip, metadata",
    inviteOnlyRegistration: true,
    rbacRoles:             ["owner", "admin", "member", "viewer", "platform_admin"],
    tenantIsolation:       "PostgreSQL RLS enforced on all tenant tables",
  });
}

// ── Rate limit snapshot ───────────────────────────────────────────────────────

export function exportRateLimitSnapshot(): EvidenceExport {
  return stamp("rate_limit_snapshot", {
    routeGroups:   getRouteGroupPolicySummary(),
    engineStats:   getRateLimitStats(),
    groupCount:    Object.keys(ROUTE_GROUP_POLICIES).length,
    storageEngine: "in-memory (sliding window)",
    note:          "Production deployments should use Redis-backed rate limiting for persistence across restarts.",
  });
}
