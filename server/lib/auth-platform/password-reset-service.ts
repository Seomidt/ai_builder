/**
 * Phase 37 — Password Reset Service
 *
 * One-time tokens, time-limited (1 hour).
 * Tokens stored as SHA-256 hashes — plaintext never persisted.
 * Generic responses prevent email enumeration.
 */

import { randomBytes, createHash } from "crypto";
import { Client } from "pg";
import { hashPassword } from "./login-service";
import { logAuthEvent } from "./auth-audit";

const DB_URL = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL || "";
const TOKEN_TTL_MS = 60 * 60_000; // 1 hour
const MIN_PASSWORD_LENGTH = 12;

export const GENERIC_RESET_MSG = "If that email exists, a reset link has been sent.";

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function validatePasswordStrength(password: string): { ok: boolean; reason?: string } {
  if (password.length < MIN_PASSWORD_LENGTH)
    return { ok: false, reason: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };

  const WEAK = ["password", "123456789012", "qwertyuiopas", "admin123456789"];
  if (WEAK.some(w => password.toLowerCase().includes(w)))
    return { ok: false, reason: "Password is too common or weak." };

  return { ok: true };
}

export async function requestPasswordReset(params: {
  email:      string;
  ipAddress?: string | null;
  tenantId?:  string | null;
}): Promise<string> {
  const email = params.email.toLowerCase().trim();
  const client = new Client({ connectionString: DB_URL });

  let userId: string | null = null;
  try {
    await client.connect();
    const res = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE email = $1 AND deleted_at IS NULL LIMIT 1`,
      [email],
    );
    if (res.rows.length > 0) {
      userId = res.rows[0].id;
    }
  } finally {
    await client.end().catch(() => {});
  }

  // Always log and return generic message — no user enumeration
  await logAuthEvent({
    eventType: "password_reset_requested",
    userId:    userId,
    tenantId:  params.tenantId ?? null,
    ipAddress: params.ipAddress ?? null,
    metadata:  { emailProvided: true },
  });

  if (!userId) return GENERIC_RESET_MSG;

  const token     = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  const client2 = new Client({ connectionString: DB_URL });
  try {
    await client2.connect();
    // Invalidate previous tokens
    await client2.query(
      `UPDATE auth_password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL`,
      [userId],
    );
    await client2.query(
      `INSERT INTO auth_password_reset_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [userId, tokenHash, expiresAt],
    );
  } finally {
    await client2.end().catch(() => {});
  }

  // In production: send token via email service
  // Here we log that a token was issued (not the token value)
  console.log(`[password-reset] Token issued for user ${userId} — expires ${expiresAt}`);

  return GENERIC_RESET_MSG;
}

export async function verifyResetToken(token: string): Promise<{
  valid: boolean;
  userId?: string;
}> {
  const tokenHash = hashToken(token);
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    const res = await client.query<{ user_id: string }>(
      `SELECT user_id FROM auth_password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
       LIMIT 1`,
      [tokenHash],
    );
    if (res.rows.length === 0) return { valid: false };
    return { valid: true, userId: res.rows[0].user_id };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function resetPassword(params: {
  token:       string;
  newPassword: string;
  confirmPassword: string;
  ipAddress?:  string | null;
}): Promise<{ ok: boolean; error?: string }> {
  if (params.newPassword !== params.confirmPassword) {
    return { ok: false, error: "Passwords do not match." };
  }

  const strength = validatePasswordStrength(params.newPassword);
  if (!strength.ok) return { ok: false, error: strength.reason };

  const verify = await verifyResetToken(params.token);
  if (!verify.valid || !verify.userId) {
    return { ok: false, error: "Invalid or expired reset token." };
  }

  const tokenHash  = hashToken(params.token);
  const passHash   = await hashPassword(params.newPassword);

  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    await client.query(
      `UPDATE auth_password_reset_tokens SET used_at = NOW() WHERE token_hash = $1`,
      [tokenHash],
    );
    await client.query(
      `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
      [passHash, verify.userId],
    );
  } finally {
    await client.end().catch(() => {});
  }

  await logAuthEvent({
    eventType: "password_reset_completed",
    userId:    verify.userId,
    ipAddress: params.ipAddress ?? null,
  });

  return { ok: true };
}
