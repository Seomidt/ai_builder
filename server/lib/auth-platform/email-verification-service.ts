/**
 * Phase 37 — Email Verification Service
 *
 * Issues one-time tokens (24h TTL) to verify user email addresses.
 * Tokens stored as SHA-256 hashes — plaintext never persisted.
 */

import { randomBytes, createHash } from "crypto";
import { Client } from "pg";
import { logAuthEvent } from "./auth-audit";

const DB_URL = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL || "";
const TOKEN_TTL_MS = 24 * 3600_000; // 24 hours

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function issueEmailVerification(params: {
  userId:     string;
  tenantId?:  string | null;
  ipAddress?: string | null;
}): Promise<string> {
  const token     = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();

  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    // Invalidate previous tokens
    await client.query(
      `UPDATE auth_email_verification_tokens SET used_at = NOW()
       WHERE user_id = $1 AND used_at IS NULL`,
      [params.userId],
    );
    await client.query(
      `INSERT INTO auth_email_verification_tokens (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)`,
      [params.userId, tokenHash, expiresAt],
    );
  } finally {
    await client.end().catch(() => {});
  }

  await logAuthEvent({
    eventType: "email_verification_requested",
    userId:    params.userId,
    tenantId:  params.tenantId ?? null,
    ipAddress: params.ipAddress ?? null,
  });

  return token;
}

export async function verifyEmailToken(params: {
  token:      string;
  ipAddress?: string | null;
}): Promise<{ ok: boolean; userId?: string; error?: string }> {
  const tokenHash = hashToken(params.token);
  const client = new Client({ connectionString: DB_URL });

  let userId: string | null = null;
  try {
    await client.connect();
    const res = await client.query<{ user_id: string; id: string }>(
      `SELECT id, user_id FROM auth_email_verification_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
       LIMIT 1`,
      [tokenHash],
    );
    if (res.rows.length === 0) {
      return { ok: false, error: "Invalid or expired verification token." };
    }
    userId = res.rows[0].user_id;

    // Mark used
    await client.query(
      `UPDATE auth_email_verification_tokens SET used_at = NOW() WHERE token_hash = $1`,
      [tokenHash],
    );
    // Mark user verified
    await client.query(
      `UPDATE users SET email_verified = TRUE, updated_at = NOW() WHERE id = $1`,
      [userId],
    );
  } finally {
    await client.end().catch(() => {});
  }

  await logAuthEvent({
    eventType: "email_verified",
    userId:    userId!,
    ipAddress: params.ipAddress ?? null,
  });

  return { ok: true, userId: userId! };
}
