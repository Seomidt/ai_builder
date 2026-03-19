/**
 * Phase 7 — Multi-Factor Authentication Service
 * INV-SEC1: MFA secrets must be encrypted at rest.
 * Recovery codes are single-use and stored as SHA-256 hashes only.
 */

import pg from "pg";
import crypto from "crypto";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ─── Encryption helpers (AES-256-GCM) ────────────────────────────────────────
// INV-SEC1: MFA secrets encrypted at rest using AES-256-GCM.
// Key derived from SESSION_SECRET env var via scrypt.

function getDerivedKey(): Buffer {
  const secret = process.env.SESSION_SECRET ?? "fallback-dev-secret-do-not-use-in-prod";
  return crypto.scryptSync(secret, "mfa-salt-v1", 32);
}

function encryptSecret(plaintext: string): string {
  const key = getDerivedKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

function decryptSecret(ciphertext: string): string {
  const key = getDerivedKey();
  const buf = Buffer.from(ciphertext, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const encrypted = buf.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
}

function hashCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

// ─── TOTP helpers ─────────────────────────────────────────────────────────────
// RFC 6238 TOTP — 6 digits, 30-second window, SHA-1 HMAC, ±1 window tolerance.

function totpWindow(secret: string, offsetWindows: number = 0): string {
  const key = Buffer.from(secret.replace(/\s/g, "").toUpperCase(), "base32");
  const counter = Math.floor(Date.now() / 1000 / 30) + offsetWindows;
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter), 0);
  const hmac = crypto.createHmac("sha1", key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac.readUInt32BE(offset) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, "0");
  return code;
}

function generateTotpSecret(): string {
  const bytes = crypto.randomBytes(20);
  const base32Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let result = "";
  let bits = 0;
  let current = 0;
  for (const byte of bytes) {
    current = (current << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      result += base32Chars[(current >> bits) & 0x1f];
    }
  }
  if (bits > 0) result += base32Chars[(current << (5 - bits)) & 0x1f];
  return result;
}

function verifyTotpCode(secret: string, code: string): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  for (const offset of [-1, 0, 1]) {
    if (totpWindow(secret, offset) === code) return true;
  }
  return false;
}

// ─── enableMfaForUser ─────────────────────────────────────────────────────────

export async function enableMfaForUser(params: {
  userId: string;
  methodType: "totp";
}): Promise<{
  methodId: string;
  totpSecret: string;
  totpUri: string;
  note: string;
}> {
  const { userId, methodType } = params;
  const totpSecret = generateTotpSecret();
  const secretEncrypted = encryptSecret(totpSecret);

  const client = getClient();
  await client.connect();
  try {
    const existing = await client.query(
      `SELECT id FROM public.user_mfa_methods WHERE user_id = $1 AND method_type = $2`,
      [userId, methodType],
    );

    let methodId: string;
    if (existing.rows.length > 0) {
      methodId = existing.rows[0].id;
      await client.query(
        `UPDATE public.user_mfa_methods SET secret_encrypted = $1, enabled = false, updated_at = NOW() WHERE id = $2`,
        [secretEncrypted, methodId],
      );
    } else {
      const ins = await client.query(
        `INSERT INTO public.user_mfa_methods (id, user_id, method_type, secret_encrypted, enabled)
         VALUES (gen_random_uuid(), $1, $2, $3, false) RETURNING id`,
        [userId, methodType, secretEncrypted],
      );
      methodId = ins.rows[0].id;
    }

    return {
      methodId,
      totpSecret,
      totpUri: `otpauth://totp/AIBuilder:${userId}?secret=${totpSecret}&issuer=AIBuilder&algorithm=SHA1&digits=6&period=30`,
      note: "INV-SEC1: Secret encrypted at rest. Verify code with verifyMfaCode() before enabling.",
    };
  } finally {
    await client.end();
  }
}

// ─── verifyMfaCode ────────────────────────────────────────────────────────────

export async function verifyMfaCode(params: {
  userId: string;
  code: string;
}): Promise<{ valid: boolean; method?: string; recoveryCodeUsed?: boolean; note: string }> {
  const { userId, code } = params;
  const client = getClient();
  await client.connect();
  try {
    const methods = await client.query(
      `SELECT id, method_type, secret_encrypted, enabled FROM public.user_mfa_methods WHERE user_id = $1`,
      [userId],
    );

    // Try TOTP first
    for (const m of methods.rows) {
      if (m.method_type === "totp" && m.enabled && m.secret_encrypted) {
        const secret = decryptSecret(m.secret_encrypted);
        if (verifyTotpCode(secret, code)) {
          return { valid: true, method: "totp", note: "TOTP code verified." };
        }
      }
    }

    // Try recovery code
    const codeHash = hashCode(code);
    const rcRow = await client.query(
      `SELECT id FROM public.mfa_recovery_codes WHERE user_id = $1 AND code_hash = $2 AND used = false`,
      [userId, codeHash],
    );
    if (rcRow.rows.length > 0) {
      await client.query(
        `UPDATE public.mfa_recovery_codes SET used = true, used_at = NOW() WHERE id = $1`,
        [rcRow.rows[0].id],
      );
      return { valid: true, method: "recovery_code", recoveryCodeUsed: true, note: "Recovery code consumed — single-use." };
    }

    return { valid: false, note: "Code invalid or expired." };
  } finally {
    await client.end();
  }
}

// ─── activateMfaMethod ────────────────────────────────────────────────────────
// Activate after verifying a TOTP code.

export async function activateMfaMethod(params: {
  userId: string;
  methodType: "totp";
  verificationCode: string;
}): Promise<{ activated: boolean; methodId: string; note: string }> {
  const { userId, methodType, verificationCode } = params;
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, secret_encrypted FROM public.user_mfa_methods WHERE user_id = $1 AND method_type = $2`,
      [userId, methodType],
    );
    if (row.rows.length === 0) throw new Error("MFA method not found — call enableMfaForUser first");
    const m = row.rows[0];
    const secret = decryptSecret(m.secret_encrypted);
    if (!verifyTotpCode(secret, verificationCode)) {
      return { activated: false, methodId: m.id, note: "Verification code invalid — not activated." };
    }
    await client.query(
      `UPDATE public.user_mfa_methods SET enabled = true, updated_at = NOW() WHERE id = $1`,
      [m.id],
    );
    return { activated: true, methodId: m.id, note: "MFA method activated and enabled." };
  } finally {
    await client.end();
  }
}

// ─── generateRecoveryCodes ────────────────────────────────────────────────────

export async function generateRecoveryCodes(params: {
  userId: string;
  count?: number;
}): Promise<{ codes: string[]; count: number; note: string }> {
  const { userId, count = 10 } = params;
  const client = getClient();
  await client.connect();
  try {
    await client.query(`DELETE FROM public.mfa_recovery_codes WHERE user_id = $1`, [userId]);

    const plaintextCodes: string[] = [];
    for (let i = 0; i < count; i++) {
      const code = crypto.randomBytes(5).toString("hex").toUpperCase();
      const formatted = `${code.slice(0, 5)}-${code.slice(5)}`;
      plaintextCodes.push(formatted);
      const codeHash = hashCode(formatted);
      await client.query(
        `INSERT INTO public.mfa_recovery_codes (id, user_id, code_hash, used) VALUES (gen_random_uuid(), $1, $2, false)`,
        [userId, codeHash],
      );
    }

    return {
      codes: plaintextCodes,
      count,
      note: "INV-SEC1: Plaintext codes returned once only. Hashes stored in DB. Store these codes securely.",
    };
  } finally {
    await client.end();
  }
}

// ─── disableMfa ───────────────────────────────────────────────────────────────

export async function disableMfa(params: {
  userId: string;
  methodType?: "totp";
}): Promise<{ disabled: boolean; methodsDisabled: number }> {
  const { userId, methodType } = params;
  const client = getClient();
  await client.connect();
  try {
    let q: { rows: any[] };
    if (methodType) {
      q = await client.query(
        `UPDATE public.user_mfa_methods SET enabled = false, updated_at = NOW() WHERE user_id = $1 AND method_type = $2 RETURNING id`,
        [userId, methodType],
      );
    } else {
      q = await client.query(
        `UPDATE public.user_mfa_methods SET enabled = false, updated_at = NOW() WHERE user_id = $1 RETURNING id`,
        [userId],
      );
      await client.query(`DELETE FROM public.mfa_recovery_codes WHERE user_id = $1`, [userId]);
    }
    return { disabled: q.rows.length > 0, methodsDisabled: q.rows.length };
  } finally {
    await client.end();
  }
}

// ─── listUserMfaMethods ───────────────────────────────────────────────────────

export async function listUserMfaMethods(userId: string): Promise<Array<{
  id: string;
  methodType: string;
  enabled: boolean;
  createdAt: Date;
}>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, method_type, enabled, created_at FROM public.user_mfa_methods WHERE user_id = $1 ORDER BY created_at DESC`,
      [userId],
    );
    return row.rows.map((r) => ({
      id: r.id,
      methodType: r.method_type,
      enabled: r.enabled,
      createdAt: r.created_at,
    }));
  } finally {
    await client.end();
  }
}

// ─── isMfaEnabled ────────────────────────────────────────────────────────────

export async function isMfaEnabled(userId: string): Promise<boolean> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id FROM public.user_mfa_methods WHERE user_id = $1 AND enabled = true LIMIT 1`,
      [userId],
    );
    return row.rows.length > 0;
  } finally {
    await client.end();
  }
}
