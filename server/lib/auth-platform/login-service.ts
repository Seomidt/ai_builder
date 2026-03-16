/**
 * Phase 37 — Login Service
 *
 * Handles email/password authentication, MFA challenge, logout and refresh.
 * NEVER reveals whether an email exists in failure messages.
 */

import { Client } from "pg";
import * as argon2 from "argon2";
import {
  createSession, revokeSession, touchSession, resolveSession,
  setSessionCookie, clearSessionCookie,
} from "./session-service";
import { hashEmail, recordLoginAttempt, isEmailLimited, isIpLimited } from "./auth-security";
import { logAuthEvent, logLoginSuccess, logLoginFailure, logLogout } from "./auth-audit";
import type { Response, Request } from "express";

const DB_URL = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL || "";

export const GENERIC_AUTH_ERROR = "Invalid credentials.";
export const RATE_LIMIT_ERROR   = "Too many attempts. Please try again later.";

export interface LoginResult {
  ok:          boolean;
  error?:      string;
  mfaRequired?: boolean;
  sessionToken?: string;
  userId?:     string;
  pendingMfaToken?: string;
}

export interface MfaLoginResult {
  ok:     boolean;
  error?: string;
  sessionToken?: string;
}

async function lookupUserByEmail(email: string): Promise<{
  id: string; passwordHash: string; tenantId: string | null; mfaEnabled: boolean;
} | null> {
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    const res = await client.query<any>(
      `SELECT u.id, u.password_hash, u.tenant_id,
              COALESCE((SELECT enabled FROM auth_mfa_totp WHERE user_id = u.id LIMIT 1), FALSE) AS mfa_enabled
       FROM users u
       WHERE u.email = $1 AND u.deleted_at IS NULL
       LIMIT 1`,
      [email.toLowerCase().trim()],
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id:           r.id,
      passwordHash: r.password_hash,
      tenantId:     r.tenant_id,
      mfaEnabled:   Boolean(r.mfa_enabled),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function loginWithPassword(params: {
  email:      string;
  password:   string;
  ipAddress:  string | null;
  userAgent:  string | null;
  res:        Response;
}): Promise<LoginResult> {
  const emailHash = hashEmail(params.email);

  // Brute-force checks
  const [emailState, ipState] = await Promise.all([
    isEmailLimited(emailHash),
    params.ipAddress ? isIpLimited(params.ipAddress) : Promise.resolve({ limited: false, failures: 0 }),
  ]);

  if (emailState.limited || ipState.limited) {
    await logAuthEvent({
      eventType: "rate_limit_triggered",
      ipAddress: params.ipAddress,
      metadata:  { emailHash, trigger: emailState.limited ? "email" : "ip" },
    });
    return { ok: false, error: RATE_LIMIT_ERROR };
  }

  const user = await lookupUserByEmail(params.email);

  // Always hash-verify to prevent timing attacks
  let passwordOk = false;
  if (user?.passwordHash) {
    try {
      passwordOk = await argon2.verify(user.passwordHash, params.password);
    } catch {
      passwordOk = false;
    }
  } else {
    // Dummy verify to equalise timing
    await argon2.hash("dummy_timing_equaliser_xk38q").catch(() => {});
  }

  if (!user || !passwordOk) {
    await recordLoginAttempt({
      emailHash,
      tenantId:      user?.tenantId ?? null,
      ipAddress:     params.ipAddress,
      userAgent:     params.userAgent,
      success:       false,
      failureReason: "bad_credentials",
    });
    await logLoginFailure({
      ipAddress: params.ipAddress,
      metadata:  { reason: "bad_credentials" },
    });
    return { ok: false, error: GENERIC_AUTH_ERROR };
  }

  await recordLoginAttempt({
    emailHash,
    tenantId:  user.tenantId,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    success:   true,
  });

  if (user.mfaEnabled) {
    // Require MFA — don't issue full session yet
    return {
      ok:          true,
      mfaRequired: true,
      userId:      user.id,
      pendingMfaToken: Buffer.from(JSON.stringify({
        userId:    user.id,
        tenantId:  user.tenantId,
        exp:       Date.now() + 5 * 60_000, // 5 min
      })).toString("base64"),
    };
  }

  const token = await createSession({
    userId:    user.id,
    tenantId:  user.tenantId,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    deviceLabel: deriveDeviceLabel(params.userAgent),
    res:       params.res,
  });

  await logLoginSuccess({
    userId:    user.id,
    tenantId:  user.tenantId,
    ipAddress: params.ipAddress,
    metadata:  { mfa: false },
  });

  return { ok: true, sessionToken: token, userId: user.id };
}

export async function completeMfaLogin(params: {
  pendingMfaToken: string;
  totpCode:        string;
  ipAddress:       string | null;
  userAgent:       string | null;
  res:             Response;
}): Promise<MfaLoginResult> {
  let payload: { userId: string; tenantId: string | null; exp: number };
  try {
    payload = JSON.parse(Buffer.from(params.pendingMfaToken, "base64").toString());
  } catch {
    return { ok: false, error: GENERIC_AUTH_ERROR };
  }

  if (Date.now() > payload.exp) {
    return { ok: false, error: "MFA session expired. Please log in again." };
  }

  // Inline verify to avoid circular dep — real projects would share
  const { challengeTotp } = await import("./mfa-service");
  const mfaOk = await challengeTotp({ userId: payload.userId, totpCode: params.totpCode });

  if (!mfaOk) {
    await logAuthEvent({
      eventType: "mfa_challenge_failed",
      userId:    payload.userId,
      tenantId:  payload.tenantId,
      ipAddress: params.ipAddress,
    });
    return { ok: false, error: GENERIC_AUTH_ERROR };
  }

  const token = await createSession({
    userId:    payload.userId,
    tenantId:  payload.tenantId,
    ipAddress: params.ipAddress,
    userAgent: params.userAgent,
    deviceLabel: deriveDeviceLabel(params.userAgent),
    res:       params.res,
  });

  await logAuthEvent({
    eventType: "mfa_challenge_passed",
    userId:    payload.userId,
    tenantId:  payload.tenantId,
    ipAddress: params.ipAddress,
  });
  await logLoginSuccess({
    userId:    payload.userId,
    tenantId:  payload.tenantId,
    ipAddress: params.ipAddress,
    metadata:  { mfa: true },
  });

  return { ok: true, sessionToken: token };
}

export async function logout(params: {
  sessionToken: string;
  userId:       string;
  tenantId?:    string | null;
  ipAddress?:   string | null;
  res:          Response;
}): Promise<void> {
  const session = await resolveSession(params.sessionToken);
  if (session) {
    await revokeSession({
      sessionId: session.id,
      revokedBy: params.userId,
      reason:    "logout",
      ipAddress: params.ipAddress,
      tenantId:  params.tenantId,
    });
  }
  clearSessionCookie(params.res);
  await logLogout({
    userId:    params.userId,
    tenantId:  params.tenantId ?? null,
    ipAddress: params.ipAddress ?? null,
  });
}

export async function refreshSession(params: {
  sessionToken: string;
  res:          Response;
}): Promise<{ ok: boolean; error?: string }> {
  const session = await resolveSession(params.sessionToken);
  if (!session) return { ok: false, error: "Session not found or expired." };

  // Touch to update last_seen
  await touchSession(params.sessionToken);
  setSessionCookie(params.res, params.sessionToken);

  await logAuthEvent({
    eventType: "session_refresh",
    userId:    session.userId,
    tenantId:  session.tenantId,
    ipAddress: session.ipAddress,
  });

  return { ok: true };
}

function deriveDeviceLabel(userAgent: string | null): string {
  if (!userAgent) return "Unknown device";
  if (userAgent.includes("Mobile")) return "Mobile browser";
  if (userAgent.includes("Chrome")) return "Chrome browser";
  if (userAgent.includes("Firefox")) return "Firefox browser";
  if (userAgent.includes("Safari")) return "Safari browser";
  return "Web browser";
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  return argon2.verify(hash, password);
}
