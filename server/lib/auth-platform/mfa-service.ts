/**
 * Phase 37 — MFA Service (TOTP)
 *
 * TOTP enrollment, verification, challenge, recovery codes.
 * Secrets stored encrypted (base64 — production should use KMS).
 * Recovery codes shown ONCE, stored as SHA-256 hashes.
 */

import { randomBytes, createHash, createCipheriv, createDecipheriv } from "crypto";
import { Client } from "pg";
import { authenticator } from "otplib";
import { logAuthEvent } from "./auth-audit";

const DB_URL    = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL || "";
const ENC_KEY   = (process.env.SESSION_SECRET ?? "default_dev_key_32bytes_padding!!").slice(0, 32).padEnd(32, "0");
const ALGO      = "aes-256-cbc";
const RC_COUNT  = 10;

authenticator.options = { window: 1 };

function encryptSecret(secret: string): string {
  const iv     = randomBytes(16);
  const cipher = createCipheriv(ALGO, ENC_KEY, iv);
  const enc    = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `${iv.toString("hex")}:${enc.toString("hex")}`;
}

function decryptSecret(encrypted: string): string {
  const [ivHex, encHex] = encrypted.split(":");
  const iv      = Buffer.from(ivHex, "hex");
  const encBuf  = Buffer.from(encHex, "hex");
  const decipher = createDecipheriv(ALGO, ENC_KEY, iv);
  return Buffer.concat([decipher.update(encBuf), decipher.final()]).toString("utf8");
}

function hashCode(code: string): string {
  return createHash("sha256").update(code.toUpperCase().replace(/\s/g, "")).digest("hex");
}

function generateRecoveryCode(): string {
  const bytes = randomBytes(5).toString("hex").toUpperCase();
  return `${bytes.slice(0, 4)}-${bytes.slice(4, 8)}-${bytes.slice(8)}`;
}

export interface TotpEnrollmentPayload {
  secret:   string;
  otpAuthUrl: string;
  qrDataUrl?: string;
}

export async function beginTotpEnrollment(params: {
  userId:     string;
  tenantId?:  string | null;
  accountName?: string;
}): Promise<TotpEnrollmentPayload> {
  const secret     = authenticator.generateSecret();
  const accountName = params.accountName ?? "AI Builder";
  const issuer      = "AI Builder Platform";
  const otpAuthUrl  = authenticator.keyuri(accountName, issuer, secret);

  // Store unenrolled secret
  const encrypted   = encryptSecret(secret);
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO auth_mfa_totp (user_id, secret_encrypted, enabled)
       VALUES ($1, $2, FALSE)
       ON CONFLICT (user_id) DO UPDATE
         SET secret_encrypted = EXCLUDED.secret_encrypted, enabled = FALSE, verified_at = NULL`,
      [params.userId, encrypted],
    );
  } finally {
    await client.end().catch(() => {});
  }

  await logAuthEvent({
    eventType: "mfa_enrollment_started",
    userId:    params.userId,
    tenantId:  params.tenantId ?? null,
  });

  let qrDataUrl: string | undefined;
  try {
    const qrcode = await import("qrcode");
    qrDataUrl = await qrcode.toDataURL(otpAuthUrl);
  } catch {
    // qrcode optional
  }

  return { secret, otpAuthUrl, qrDataUrl };
}

export async function verifyTotpEnrollment(params: {
  userId:    string;
  totpCode:  string;
  tenantId?: string | null;
}): Promise<{ ok: boolean; recoveryCodes?: string[]; error?: string }> {
  const client = new Client({ connectionString: DB_URL });
  let encryptedSecret = "";
  try {
    await client.connect();
    const res = await client.query<{ secret_encrypted: string }>(
      `SELECT secret_encrypted FROM auth_mfa_totp WHERE user_id = $1 LIMIT 1`,
      [params.userId],
    );
    if (res.rows.length === 0) return { ok: false, error: "MFA not initialized." };
    encryptedSecret = res.rows[0].secret_encrypted;
  } finally {
    await client.end().catch(() => {});
  }

  const secret = decryptSecret(encryptedSecret);
  const valid  = authenticator.check(params.totpCode, secret);
  if (!valid) return { ok: false, error: "Invalid TOTP code." };

  // Mark enabled and generate recovery codes
  const recoveryCodes = Array.from({ length: RC_COUNT }, generateRecoveryCode);
  const codeHashes    = recoveryCodes.map(hashCode);

  const client2 = new Client({ connectionString: DB_URL });
  try {
    await client2.connect();
    await client2.query(
      `UPDATE auth_mfa_totp SET enabled = TRUE, verified_at = NOW() WHERE user_id = $1`,
      [params.userId],
    );
    // Remove old codes
    await client2.query(`DELETE FROM auth_mfa_recovery_codes WHERE user_id = $1`, [params.userId]);
    for (const ch of codeHashes) {
      await client2.query(
        `INSERT INTO auth_mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)`,
        [params.userId, ch],
      );
    }
  } finally {
    await client2.end().catch(() => {});
  }

  await logAuthEvent({
    eventType: "mfa_enabled",
    userId:    params.userId,
    tenantId:  params.tenantId ?? null,
  });

  return { ok: true, recoveryCodes };
}

export async function challengeTotp(params: {
  userId:   string;
  totpCode: string;
}): Promise<boolean> {
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    const res = await client.query<{ secret_encrypted: string }>(
      `SELECT secret_encrypted FROM auth_mfa_totp WHERE user_id = $1 AND enabled = TRUE LIMIT 1`,
      [params.userId],
    );
    if (res.rows.length === 0) return false;
    const secret = decryptSecret(res.rows[0].secret_encrypted);
    const valid  = authenticator.check(params.totpCode, secret);
    if (valid) {
      await client.query(
        `UPDATE auth_mfa_totp SET last_used_at = NOW() WHERE user_id = $1`,
        [params.userId],
      );
    }
    return valid;
  } finally {
    await client.end().catch(() => {});
  }
}

export async function generateRecoveryCodes(params: {
  userId:    string;
  tenantId?: string | null;
}): Promise<string[]> {
  const recoveryCodes = Array.from({ length: RC_COUNT }, generateRecoveryCode);
  const codeHashes    = recoveryCodes.map(hashCode);

  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    await client.query(`DELETE FROM auth_mfa_recovery_codes WHERE user_id = $1`, [params.userId]);
    for (const ch of codeHashes) {
      await client.query(
        `INSERT INTO auth_mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)`,
        [params.userId, ch],
      );
    }
  } finally {
    await client.end().catch(() => {});
  }

  return recoveryCodes;
}

export async function useRecoveryCode(params: {
  userId:    string;
  code:      string;
  ipAddress?: string | null;
  tenantId?:  string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const codeHash = hashCode(params.code);
  const client   = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    const res = await client.query<{ id: string }>(
      `SELECT id FROM auth_mfa_recovery_codes
       WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
       LIMIT 1`,
      [params.userId, codeHash],
    );
    if (res.rows.length === 0) return { ok: false, error: "Invalid or already-used recovery code." };
    await client.query(
      `UPDATE auth_mfa_recovery_codes SET used_at = NOW() WHERE id = $1`,
      [res.rows[0].id],
    );
  } finally {
    await client.end().catch(() => {});
  }

  await logAuthEvent({
    eventType: "recovery_code_used",
    userId:    params.userId,
    tenantId:  params.tenantId ?? null,
    ipAddress: params.ipAddress ?? null,
  });

  return { ok: true };
}

export async function disableMfa(params: {
  userId:    string;
  totpCode:  string;
  tenantId?: string | null;
  ipAddress?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const valid = await challengeTotp({ userId: params.userId, totpCode: params.totpCode });
  if (!valid) return { ok: false, error: "Invalid TOTP code. Cannot disable MFA." };

  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    await client.query(
      `UPDATE auth_mfa_totp SET enabled = FALSE, verified_at = NULL WHERE user_id = $1`,
      [params.userId],
    );
    await client.query(`DELETE FROM auth_mfa_recovery_codes WHERE user_id = $1`, [params.userId]);
  } finally {
    await client.end().catch(() => {});
  }

  await logAuthEvent({
    eventType: "mfa_disabled",
    userId:    params.userId,
    tenantId:  params.tenantId ?? null,
    ipAddress: params.ipAddress ?? null,
  });

  return { ok: true };
}
