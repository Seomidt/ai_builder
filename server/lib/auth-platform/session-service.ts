/**
 * Phase 37 — Session Service
 *
 * DB-backed sessions with httpOnly cookie delivery.
 * Session tokens are random bytes stored as SHA-256 hashes in the DB.
 */

import { randomBytes, createHash } from "crypto";
import { Client } from "pg";
import { logAuthEvent } from "./auth-audit";
import type { Response } from "express";

const DB_URL    = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL || "";
const IS_PROD   = process.env.NODE_ENV === "production";
const COOKIE_NAME = "auth_session";
const SESSION_TTL_HOURS = 24 * 7; // 7 days absolute
const SESSION_IDLE_HOURS = 24;    // 24h idle timeout

export interface SessionRecord {
  id:           string;
  userId:       string;
  tenantId:     string | null;
  deviceLabel:  string | null;
  ipAddress:    string | null;
  userAgent:    string | null;
  createdAt:    Date;
  lastSeenAt:   Date;
  expiresAt:    Date;
  revokedAt:    Date | null;
  revokedReason: string | null;
}

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure:   IS_PROD,
    sameSite: "lax",
    maxAge:   SESSION_TTL_HOURS * 3600 * 1000,
    path:     "/",
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { httpOnly: true, secure: IS_PROD, sameSite: "lax", path: "/" });
}

export async function createSession(params: {
  userId:      string;
  tenantId?:   string | null;
  deviceLabel?: string | null;
  ipAddress?:  string | null;
  userAgent?:  string | null;
  res:         Response;
}): Promise<string> {
  const token     = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600_000);

  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO auth_sessions
         (user_id, tenant_id, session_token, device_label, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        params.userId,
        params.tenantId ?? null,
        tokenHash,
        params.deviceLabel ?? null,
        params.ipAddress ?? null,
        params.userAgent ?? null,
        expiresAt.toISOString(),
      ],
    );
  } finally {
    await client.end().catch(() => {});
  }

  setSessionCookie(params.res, token);
  return token;
}

export async function resolveSession(token: string): Promise<SessionRecord | null> {
  const tokenHash = hashToken(token);
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    const res = await client.query<any>(
      `SELECT * FROM auth_sessions
       WHERE session_token = $1
         AND revoked_at IS NULL
         AND expires_at > NOW()`,
      [tokenHash],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id:            r.id,
      userId:        r.user_id,
      tenantId:      r.tenant_id,
      deviceLabel:   r.device_label,
      ipAddress:     r.ip_address,
      userAgent:     r.user_agent,
      createdAt:     new Date(r.created_at),
      lastSeenAt:    new Date(r.last_seen_at),
      expiresAt:     new Date(r.expires_at),
      revokedAt:     r.revoked_at ? new Date(r.revoked_at) : null,
      revokedReason: r.revoked_reason,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function touchSession(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    await client.query(
      `UPDATE auth_sessions SET last_seen_at = NOW() WHERE session_token = $1`,
      [tokenHash],
    );
  } finally {
    await client.end().catch(() => {});
  }
}

export async function listUserSessions(userId: string): Promise<SessionRecord[]> {
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    const res = await client.query<any>(
      `SELECT * FROM auth_sessions
       WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > NOW()
       ORDER BY last_seen_at DESC`,
      [userId],
    );
    return res.rows.map(r => ({
      id:            r.id,
      userId:        r.user_id,
      tenantId:      r.tenant_id,
      deviceLabel:   r.device_label,
      ipAddress:     r.ip_address,
      userAgent:     r.user_agent,
      createdAt:     new Date(r.created_at),
      lastSeenAt:    new Date(r.last_seen_at),
      expiresAt:     new Date(r.expires_at),
      revokedAt:     r.revoked_at ? new Date(r.revoked_at) : null,
      revokedReason: r.revoked_reason,
    }));
  } finally {
    await client.end().catch(() => {});
  }
}

export async function revokeSession(params: {
  sessionId: string;
  revokedBy: string;
  reason?:   string;
  ipAddress?: string | null;
  tenantId?:  string | null;
}): Promise<void> {
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    await client.query(
      `UPDATE auth_sessions
       SET revoked_at = NOW(), revoked_reason = $2
       WHERE id = $1 AND revoked_at IS NULL`,
      [params.sessionId, params.reason ?? "user_revoked"],
    );
  } finally {
    await client.end().catch(() => {});
  }
  await logAuthEvent({
    eventType: "session_revoked",
    userId:    params.revokedBy,
    tenantId:  params.tenantId ?? null,
    ipAddress: params.ipAddress ?? null,
    metadata:  { sessionId: params.sessionId, reason: params.reason },
  });
}

export async function revokeAllOtherSessions(params: {
  userId:         string;
  currentToken:   string;
  ipAddress?:     string | null;
  tenantId?:      string | null;
}): Promise<number> {
  const currentHash = hashToken(params.currentToken);
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    const res = await client.query<{ cnt: string }>(
      `UPDATE auth_sessions
       SET revoked_at = NOW(), revoked_reason = 'revoke_all_others'
       WHERE user_id = $1
         AND session_token <> $2
         AND revoked_at IS NULL
       RETURNING id`,
      [params.userId, currentHash],
    );
    const count = res.rowCount ?? 0;
    if (count > 0) {
      await logAuthEvent({
        eventType: "all_other_sessions_revoked",
        userId:    params.userId,
        tenantId:  params.tenantId ?? null,
        ipAddress: params.ipAddress ?? null,
        metadata:  { revokedCount: count },
      });
    }
    return count;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function rotateSession(params: {
  currentToken: string;
  userId:       string;
  tenantId?:    string | null;
  ipAddress?:   string | null;
  userAgent?:   string | null;
  deviceLabel?: string | null;
  res:          Response;
}): Promise<string> {
  const currentHash = hashToken(params.currentToken);
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    await client.query(
      `UPDATE auth_sessions SET revoked_at = NOW(), revoked_reason = 'rotated' WHERE session_token = $1`,
      [currentHash],
    );
  } finally {
    await client.end().catch(() => {});
  }
  return createSession({
    userId:      params.userId,
    tenantId:    params.tenantId,
    ipAddress:   params.ipAddress,
    userAgent:   params.userAgent,
    deviceLabel: params.deviceLabel,
    res:         params.res,
  });
}
