/**
 * Phase 37 — Auth Audit Logging
 *
 * All auth events are persisted to auth_security_events.
 * Sensitive values (tokens, passwords, secrets) are NEVER logged.
 */

import { Client } from "pg";

const DB_URL = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL || "";

export type AuthEventType =
  | "login_success"
  | "login_failure"
  | "logout"
  | "session_refresh"
  | "password_reset_requested"
  | "password_reset_completed"
  | "email_verification_requested"
  | "email_verified"
  | "invite_created"
  | "invite_accepted"
  | "mfa_enrollment_started"
  | "mfa_enabled"
  | "mfa_challenge_failed"
  | "mfa_challenge_passed"
  | "mfa_disabled"
  | "session_revoked"
  | "all_other_sessions_revoked"
  | "suspicious_login_detected"
  | "rate_limit_triggered"
  | "recovery_code_used";

export type AuthEventSeverity = "info" | "warning" | "critical";

const SEVERITY_MAP: Record<AuthEventType, AuthEventSeverity> = {
  login_success:                "info",
  login_failure:                "warning",
  logout:                       "info",
  session_refresh:              "info",
  password_reset_requested:     "info",
  password_reset_completed:     "info",
  email_verification_requested: "info",
  email_verified:               "info",
  invite_created:               "info",
  invite_accepted:              "info",
  mfa_enrollment_started:       "info",
  mfa_enabled:                  "info",
  mfa_challenge_failed:         "warning",
  mfa_challenge_passed:         "info",
  mfa_disabled:                 "warning",
  session_revoked:              "info",
  all_other_sessions_revoked:   "warning",
  suspicious_login_detected:    "critical",
  rate_limit_triggered:         "warning",
  recovery_code_used:           "warning",
};

export interface AuthEventPayload {
  eventType: AuthEventType;
  tenantId?: string | null;
  userId?: string | null;
  ipAddress?: string | null;
  metadata?: Record<string, unknown>;
}

export async function logAuthEvent(payload: AuthEventPayload): Promise<void> {
  const severity = SEVERITY_MAP[payload.eventType] ?? "info";
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO auth_security_events
         (tenant_id, user_id, event_type, severity, ip_address, metadata_json)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        payload.tenantId ?? null,
        payload.userId ?? null,
        payload.eventType,
        severity,
        payload.ipAddress ?? null,
        payload.metadata ? JSON.stringify(payload.metadata) : null,
      ],
    );
  } catch (err) {
    console.error("[auth-audit] Failed to log auth event:", payload.eventType, err);
  } finally {
    await client.end().catch(() => {});
  }
}

export const logLoginSuccess  = (p: Omit<AuthEventPayload, "eventType">) => logAuthEvent({ ...p, eventType: "login_success"  });
export const logLoginFailure  = (p: Omit<AuthEventPayload, "eventType">) => logAuthEvent({ ...p, eventType: "login_failure"  });
export const logLogout        = (p: Omit<AuthEventPayload, "eventType">) => logAuthEvent({ ...p, eventType: "logout"          });
export const logPasswordResetRequested = (p: Omit<AuthEventPayload, "eventType">) => logAuthEvent({ ...p, eventType: "password_reset_requested" });
export const logPasswordChanged        = (p: Omit<AuthEventPayload, "eventType">) => logAuthEvent({ ...p, eventType: "password_reset_completed" });
export const logMfaEnabled             = (p: Omit<AuthEventPayload, "eventType">) => logAuthEvent({ ...p, eventType: "mfa_enabled"              });
export const logMfaDisabled            = (p: Omit<AuthEventPayload, "eventType">) => logAuthEvent({ ...p, eventType: "mfa_disabled"             });
export const logSessionRevoked         = (p: Omit<AuthEventPayload, "eventType">) => logAuthEvent({ ...p, eventType: "session_revoked"          });
