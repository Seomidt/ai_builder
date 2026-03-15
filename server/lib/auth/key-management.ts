/**
 * Phase 6 — API Key & Service Account Key Management
 * INV-ID5: Keys must never be stored in plaintext.
 * INV-ID7: Revoked/expired keys must fail closed.
 */

import pg from "pg";
import crypto from "crypto";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

const KEY_PREFIX_LENGTH = 8;
const KEY_SECRET_BYTES = 32;

function generateKeyParts(): { prefix: string; secret: string; fullKey: string; hash: string } {
  const secret = crypto.randomBytes(KEY_SECRET_BYTES).toString("hex");
  const prefix = secret.slice(0, KEY_PREFIX_LENGTH);
  const fullKey = `sk_${prefix}_${secret}`;
  const hash = crypto.createHash("sha256").update(fullKey).digest("hex");
  return { prefix: `sk_${prefix}`, secret, fullKey, hash };
}

// ─── Service Accounts ─────────────────────────────────────────────────────────

export async function createServiceAccount(params: {
  tenantId: string;
  name: string;
  description?: string;
  createdBy?: string;
}): Promise<{ serviceAccountId: string; tenantId: string; name: string }> {
  const { tenantId, name, description, createdBy } = params;
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `INSERT INTO public.service_accounts (id, tenant_id, name, description, service_account_status, created_by)
       VALUES (gen_random_uuid(), $1, $2, $3, 'active', $4) RETURNING id`,
      [tenantId, name, description ?? null, createdBy ?? null],
    );
    return { serviceAccountId: row.rows[0].id, tenantId, name };
  } finally {
    await client.end();
  }
}

// ─── createServiceAccountKey ──────────────────────────────────────────────────
// INV-ID5: Only prefix + hash stored. Plaintext returned once.

export async function createServiceAccountKey(params: {
  serviceAccountId: string;
  expiresAt?: Date;
  createdBy?: string;
}): Promise<{
  keyId: string;
  keyPrefix: string;
  plaintextKey: string;
  note: string;
}> {
  const { serviceAccountId, expiresAt, createdBy } = params;
  const { prefix, fullKey, hash } = generateKeyParts();

  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `INSERT INTO public.service_account_keys
         (id, service_account_id, key_prefix, key_hash, key_status, expires_at, created_by)
       VALUES (gen_random_uuid(), $1, $2, $3, 'active', $4, $5)
       RETURNING id`,
      [serviceAccountId, prefix, hash, expiresAt ?? null, createdBy ?? null],
    );
    return {
      keyId: row.rows[0].id,
      keyPrefix: prefix,
      plaintextKey: fullKey,
      note: "INV-ID5: Plaintext returned once. Hash stored only. Rotation requires explicit createServiceAccountKey call.",
    };
  } finally {
    await client.end();
  }
}

// ─── revokeServiceAccountKey ──────────────────────────────────────────────────

export async function revokeServiceAccountKey(keyId: string): Promise<{ revoked: boolean; idempotent: boolean }> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, key_status FROM public.service_account_keys WHERE id = $1`,
      [keyId],
    );
    if (row.rows.length === 0) return { revoked: false, idempotent: false };
    if (row.rows[0].key_status === "revoked") return { revoked: true, idempotent: true };

    await client.query(
      `UPDATE public.service_account_keys SET key_status = 'revoked', revoked_at = NOW() WHERE id = $1`,
      [keyId],
    );
    return { revoked: true, idempotent: false };
  } finally {
    await client.end();
  }
}

// ─── verifyPresentedServiceAccountKey ────────────────────────────────────────
// INV-ID7: Revoked/expired keys fail closed.

export async function verifyPresentedServiceAccountKey(params: {
  presentedKey: string;
  tenantId: string;
}): Promise<{
  valid: boolean;
  serviceAccountId?: string;
  keyId?: string;
  denialReason?: string;
}> {
  const { presentedKey, tenantId } = params;
  const keyHash = crypto.createHash("sha256").update(presentedKey).digest("hex");
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT sak.id, sak.service_account_id, sak.key_status, sak.expires_at,
              sa.tenant_id, sa.service_account_status
       FROM public.service_account_keys sak
       JOIN public.service_accounts sa ON sa.id = sak.service_account_id
       WHERE sak.key_hash = $1`,
      [keyHash],
    );
    if (row.rows.length === 0) return { valid: false, denialReason: "Key not found" };
    const k = row.rows[0];
    if (k.tenant_id !== tenantId) return { valid: false, denialReason: "Tenant mismatch" };
    if (k.key_status !== "active") return { valid: false, denialReason: `Key status: ${k.key_status}` };
    if (k.expires_at && new Date(k.expires_at) < new Date()) {
      return { valid: false, denialReason: "Key expired" };
    }
    if (k.service_account_status !== "active") return { valid: false, denialReason: "Service account not active" };

    await client.query(`UPDATE public.service_account_keys SET last_used_at = NOW() WHERE id = $1`, [k.id]);
    return { valid: true, serviceAccountId: k.service_account_id, keyId: k.id };
  } finally {
    await client.end();
  }
}

// ─── API Keys ─────────────────────────────────────────────────────────────────

export async function createApiKey(params: {
  tenantId: string;
  name: string;
  createdBy?: string;
  expiresAt?: Date;
  permissionIds?: string[];
}): Promise<{
  keyId: string;
  keyPrefix: string;
  plaintextKey: string;
  permissionsBound: number;
  note: string;
}> {
  const { tenantId, name, createdBy, expiresAt, permissionIds } = params;
  const { prefix, fullKey, hash } = generateKeyParts();

  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `INSERT INTO public.api_keys
         (id, tenant_id, name, key_prefix, key_hash, api_key_status, created_by, expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, 'active', $5, $6)
       RETURNING id`,
      [tenantId, name, prefix, hash, createdBy ?? null, expiresAt ?? null],
    );
    const keyId = row.rows[0].id;

    let permissionsBound = 0;
    if (permissionIds && permissionIds.length > 0) {
      for (const permId of permissionIds) {
        await client.query(
          `INSERT INTO public.api_key_scopes (id, api_key_id, permission_id)
           VALUES (gen_random_uuid(), $1, $2) ON CONFLICT DO NOTHING`,
          [keyId, permId],
        );
        permissionsBound++;
      }
    }

    return {
      keyId,
      keyPrefix: prefix,
      plaintextKey: fullKey,
      permissionsBound,
      note: "INV-ID5: Plaintext returned once at creation only. Hash stored only.",
    };
  } finally {
    await client.end();
  }
}

export async function revokeApiKey(keyId: string): Promise<{ revoked: boolean; idempotent: boolean }> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(`SELECT id, api_key_status FROM public.api_keys WHERE id = $1`, [keyId]);
    if (row.rows.length === 0) return { revoked: false, idempotent: false };
    if (row.rows[0].api_key_status === "revoked") return { revoked: true, idempotent: true };
    await client.query(
      `UPDATE public.api_keys SET api_key_status = 'revoked', revoked_at = NOW() WHERE id = $1`,
      [keyId],
    );
    return { revoked: true, idempotent: false };
  } finally {
    await client.end();
  }
}

// ─── verifyPresentedApiKey ────────────────────────────────────────────────────

export async function verifyPresentedApiKey(params: {
  presentedKey: string;
  tenantId: string;
}): Promise<{
  valid: boolean;
  keyId?: string;
  permissionCodes?: string[];
  denialReason?: string;
}> {
  const { presentedKey, tenantId } = params;
  const keyHash = crypto.createHash("sha256").update(presentedKey).digest("hex");
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, tenant_id, api_key_status, expires_at FROM public.api_keys WHERE key_hash = $1`,
      [keyHash],
    );
    if (row.rows.length === 0) return { valid: false, denialReason: "API key not found" };
    const k = row.rows[0];
    if (k.tenant_id !== tenantId) return { valid: false, denialReason: "Tenant mismatch" };
    if (k.api_key_status !== "active") return { valid: false, denialReason: `Key status: ${k.api_key_status}` };
    if (k.expires_at && new Date(k.expires_at) < new Date()) return { valid: false, denialReason: "Key expired" };

    await client.query(`UPDATE public.api_keys SET last_used_at = NOW() WHERE id = $1`, [k.id]);

    const scopeRow = await client.query(
      `SELECT p.permission_code FROM public.api_key_scopes aks
       JOIN public.permissions p ON p.id = aks.permission_id
       WHERE aks.api_key_id = $1 AND p.lifecycle_state = 'active'`,
      [k.id],
    );
    return { valid: true, keyId: k.id, permissionCodes: scopeRow.rows.map((r) => r.permission_code) };
  } finally {
    await client.end();
  }
}

// ─── listTenantApiKeys ────────────────────────────────────────────────────────

export async function listTenantApiKeys(tenantId: string): Promise<Array<{
  id: string;
  name: string;
  keyPrefix: string;
  apiKeyStatus: string;
  expiresAt: Date | null;
  createdAt: Date;
}>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, name, key_prefix, api_key_status, expires_at, created_at
       FROM public.api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return row.rows.map((r) => ({
      id: r.id,
      name: r.name,
      keyPrefix: r.key_prefix,
      apiKeyStatus: r.api_key_status,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    }));
  } finally {
    await client.end();
  }
}

// ─── listTenantServiceAccounts ────────────────────────────────────────────────

export async function listTenantServiceAccounts(tenantId: string): Promise<Array<{
  id: string;
  name: string;
  serviceAccountStatus: string;
  createdAt: Date;
}>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, name, service_account_status, created_at
       FROM public.service_accounts WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    );
    return row.rows.map((r) => ({
      id: r.id,
      name: r.name,
      serviceAccountStatus: r.service_account_status,
      createdAt: r.created_at,
    }));
  } finally {
    await client.end();
  }
}

// ─── explainKeyState ──────────────────────────────────────────────────────────

export async function explainKeyState(keyId: string, keyType: "api_key" | "service_account_key"): Promise<{
  keyId: string;
  keyType: string;
  status: string | null;
  isActive: boolean;
  isExpired: boolean;
  isRevoked: boolean;
  note: string;
}> {
  const client = getClient();
  await client.connect();
  try {
    const table = keyType === "api_key" ? "api_keys" : "service_account_keys";
    const statusCol = keyType === "api_key" ? "api_key_status" : "key_status";
    const row = await client.query(
      `SELECT ${statusCol} as status, expires_at, revoked_at FROM public.${table} WHERE id = $1`,
      [keyId],
    );
    if (row.rows.length === 0) {
      return { keyId, keyType, status: null, isActive: false, isExpired: false, isRevoked: false, note: "Key not found." };
    }
    const k = row.rows[0];
    const isExpired = k.expires_at ? new Date(k.expires_at) < new Date() : false;
    const isRevoked = k.status === "revoked";
    return {
      keyId,
      keyType,
      status: k.status,
      isActive: k.status === "active" && !isExpired,
      isExpired,
      isRevoked,
      note: "INV-ID7: Revoked/expired keys fail closed. INV-ID8: Read-only explain.",
    };
  } finally {
    await client.end();
  }
}
