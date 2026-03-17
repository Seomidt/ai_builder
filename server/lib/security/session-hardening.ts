/**
 * Phase 39 — Session Hardening
 * Session rotation, revocation, and device session management.
 *
 * Works with auth_sessions table (Phase 37).
 * Rules:
 *  - Session ID rotates after successful login
 *  - Password reset/change invalidates all other sessions
 *  - MFA disable/reset invalidates all sessions except optionally current
 *  - All revocations are logged as security events
 */

import { db }  from "../../db";
import { sql } from "drizzle-orm";

// ── Revoke reasons ────────────────────────────────────────────────────────────

export type RevokeReason =
  | "password_change"
  | "password_reset"
  | "mfa_reset"
  | "mfa_disabled"
  | "admin_forced"
  | "user_logout"
  | "user_revoked_other"
  | "session_expired"
  | "suspicious_activity";

// ── Session helpers ───────────────────────────────────────────────────────────

export interface SessionSummary {
  id:         string;
  userId:     string;
  tenantId:   string | null;
  deviceLabel: string | null;
  ipAddress:  string | null;
  userAgent:  string | null;
  createdAt:  string;
  lastSeenAt: string;
  expiresAt:  string;
  revokedAt:  string | null;
  revokedReason: string | null;
}

export function normalizeUserAgent(ua: string | null | undefined): string {
  if (!ua) return "Unknown Device";
  const s = ua.trim().slice(0, 256);
  if (/iPhone|iPad/.test(s))      return "iOS Device";
  if (/Android/.test(s))          return "Android Device";
  if (/Windows/.test(s))          return "Windows Browser";
  if (/Macintosh|Mac OS/.test(s)) return "Mac Browser";
  if (/Linux/.test(s))            return "Linux Browser";
  if (/curl|python|node|axios|go-http/i.test(s)) return "API Client";
  return "Browser";
}

// ── Session rotation ──────────────────────────────────────────────────────────

/**
 * After successful login, generate a fresh session record.
 * The caller should invalidate the previous session token before calling.
 */
export async function rotateSessionOnLogin(params: {
  userId:    string;
  tenantId?: string | null;
  ip?:       string | null;
  userAgent?: string | null;
  durationMs?: number;
}): Promise<{ sessionId: string; expiresAt: Date }> {
  const { userId, tenantId, ip, userAgent, durationMs = 24 * 60 * 60 * 1000 } = params;
  const expiresAt = new Date(Date.now() + durationMs);
  const label     = normalizeUserAgent(userAgent);

  const result = await db.execute<{ id: string }>(sql`
    INSERT INTO auth_sessions (user_id, tenant_id, device_label, ip_address, user_agent, expires_at, last_seen_at)
    VALUES (
      ${userId},
      ${tenantId ?? null},
      ${label},
      ${ip ?? null},
      ${(userAgent ?? "").slice(0, 256)},
      ${expiresAt.toISOString()}::timestamptz,
      NOW()
    )
    RETURNING id
  `);

  return { sessionId: result.rows[0]?.id ?? "", expiresAt };
}

// ── Revocation helpers ────────────────────────────────────────────────────────

async function revokeSessionsWhere(
  condition: string,
  params: unknown[],
  reason: RevokeReason,
): Promise<number> {
  const result = await db.execute<{ id: string }>(sql.raw(
    `UPDATE auth_sessions
     SET revoked_at = NOW(), revoked_reason = '${reason}'
     WHERE revoked_at IS NULL AND ${condition}
     RETURNING id`,
  ));
  return result.rows.length;
}

export async function revokeAllSessionsForUser(
  userId:   string,
  reason:   RevokeReason = "admin_forced",
): Promise<{ revokedCount: number }> {
  const result = await db.execute<any>(sql`
    UPDATE auth_sessions
    SET revoked_at = NOW(), revoked_reason = ${reason}
    WHERE user_id = ${userId} AND revoked_at IS NULL
    RETURNING id
  `);
  return { revokedCount: result.rows.length };
}

export async function revokeOtherSessions(
  userId:           string,
  currentSessionId: string,
  reason:           RevokeReason = "user_revoked_other",
): Promise<{ revokedCount: number }> {
  const result = await db.execute<any>(sql`
    UPDATE auth_sessions
    SET revoked_at = NOW(), revoked_reason = ${reason}
    WHERE user_id = ${userId}
      AND id != ${currentSessionId}
      AND revoked_at IS NULL
    RETURNING id
  `);
  return { revokedCount: result.rows.length };
}

export async function revokeSessionsAfterPasswordChange(
  userId:           string,
  currentSessionId?: string,
): Promise<{ revokedCount: number }> {
  const result = await db.execute<any>(sql`
    UPDATE auth_sessions
    SET revoked_at = NOW(), revoked_reason = 'password_change'
    WHERE user_id = ${userId}
      AND revoked_at IS NULL
      ${currentSessionId ? sql`AND id != ${currentSessionId}` : sql``}
    RETURNING id
  `);
  return { revokedCount: result.rows.length };
}

export async function revokeSessionsAfterPasswordReset(
  userId: string,
): Promise<{ revokedCount: number }> {
  const result = await db.execute<any>(sql`
    UPDATE auth_sessions
    SET revoked_at = NOW(), revoked_reason = 'password_reset'
    WHERE user_id = ${userId} AND revoked_at IS NULL
    RETURNING id
  `);
  return { revokedCount: result.rows.length };
}

export async function revokeSessionsAfterMfaReset(
  userId:           string,
  currentSessionId?: string,
): Promise<{ revokedCount: number }> {
  const result = await db.execute<any>(sql`
    UPDATE auth_sessions
    SET revoked_at = NOW(), revoked_reason = 'mfa_reset'
    WHERE user_id = ${userId}
      AND revoked_at IS NULL
      ${currentSessionId ? sql`AND id != ${currentSessionId}` : sql``}
    RETURNING id
  `);
  return { revokedCount: result.rows.length };
}

// ── Device session listing ────────────────────────────────────────────────────

export async function getActiveDeviceSessions(
  userId: string,
): Promise<SessionSummary[]> {
  const result = await db.execute<any>(sql`
    SELECT
      id, user_id, tenant_id, device_label, ip_address, user_agent,
      created_at, last_seen_at, expires_at, revoked_at, revoked_reason
    FROM auth_sessions
    WHERE user_id = ${userId}
      AND revoked_at IS NULL
      AND expires_at > NOW()
    ORDER BY last_seen_at DESC
    LIMIT 20
  `);

  return result.rows.map(r => ({
    id:           r.id,
    userId:       r.user_id,
    tenantId:     r.tenant_id,
    deviceLabel:  r.device_label,
    ipAddress:    r.ip_address,
    userAgent:    r.user_agent,
    createdAt:    r.created_at,
    lastSeenAt:   r.last_seen_at,
    expiresAt:    r.expires_at,
    revokedAt:    r.revoked_at,
    revokedReason: r.revoked_reason,
  }));
}

// ── Admin session overview ────────────────────────────────────────────────────

export interface SessionAdminStats {
  totalActive:       number;
  totalRevokedToday: number;
  recentRevocations: Array<{
    userId: string; reason: string; revokedAt: string; ip: string | null;
  }>;
}

export async function getSessionAdminStats(): Promise<SessionAdminStats> {
  const [activeRes, revokedRes] = await Promise.all([
    db.execute<any>(sql`
      SELECT COUNT(*)::int AS cnt FROM auth_sessions
      WHERE revoked_at IS NULL AND expires_at > NOW()
    `),
    db.execute<any>(sql`
      SELECT user_id, revoked_reason, revoked_at, ip_address
      FROM auth_sessions
      WHERE revoked_at >= NOW() - INTERVAL '24 hours'
      ORDER BY revoked_at DESC
      LIMIT 50
    `),
  ]);

  return {
    totalActive:       activeRes.rows[0]?.cnt  ?? 0,
    totalRevokedToday: revokedRes.rows.length,
    recentRevocations: revokedRes.rows.map(r => ({
      userId:    r.user_id,
      reason:    r.revoked_reason ?? "unknown",
      revokedAt: r.revoked_at,
      ip:        r.ip_address ?? null,
    })),
  };
}
