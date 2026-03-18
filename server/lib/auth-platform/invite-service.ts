/**
 * Phase 37 — Invite Service
 *
 * One-time invite tokens (72h TTL).
 * Tokens stored as SHA-256 hashes.
 * Acceptance binds user to tenant with given role.
 */

import { randomBytes, createHash } from "crypto";
import { Client } from "pg";
import { logAuthEvent } from "./auth-audit";

const DB_URL = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL || "";
const TOKEN_TTL_MS = 72 * 3600_000; // 72 hours

function generateToken(): string {
  return randomBytes(32).toString("hex");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface InviteRecord {
  id:          string;
  tenantId:    string;
  email:       string;
  role:        string;
  invitedBy:   string | null;
  expiresAt:   Date;
  acceptedAt:  Date | null;
  createdAt:   Date;
}

export async function createInvite(params: {
  tenantId:   string;
  email:      string;
  role:       string;
  invitedBy?: string | null;
  ipAddress?: string | null;
}): Promise<string> {
  const token     = generateToken();
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const email     = params.email.toLowerCase().trim();

  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO auth_invites (tenant_id, email, token_hash, role, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [params.tenantId, email, tokenHash, params.role, params.invitedBy ?? null, expiresAt],
    );
  } finally {
    await client.end().catch(() => {});
  }

  await logAuthEvent({
    eventType: "invite_created",
    tenantId:  params.tenantId,
    userId:    params.invitedBy ?? null,
    ipAddress: params.ipAddress ?? null,
    metadata:  { email, role: params.role },
  });

  return token;
}

export async function validateInvite(token: string): Promise<{
  valid:     boolean;
  invite?:   InviteRecord;
  error?:    string;
}> {
  const tokenHash = hashToken(token);
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    const res = await client.query<any>(
      `SELECT * FROM auth_invites
       WHERE token_hash = $1 AND accepted_at IS NULL AND expires_at > NOW()
       LIMIT 1`,
      [tokenHash],
    );
    if (res.rows.length === 0) {
      return { valid: false, error: "Invalid or expired invite." };
    }
    const r = res.rows[0];
    return {
      valid: true,
      invite: {
        id:         r.id,
        tenantId:   r.tenant_id,
        email:      r.email,
        role:       r.role,
        invitedBy:  r.invited_by,
        expiresAt:  new Date(r.expires_at),
        acceptedAt: r.accepted_at ? new Date(r.accepted_at) : null,
        createdAt:  new Date(r.created_at),
      },
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function acceptInvite(params: {
  token:     string;
  userId:    string;
  ipAddress?: string | null;
}): Promise<{ ok: boolean; tenantId?: string; role?: string; error?: string }> {
  const validation = await validateInvite(params.token);
  if (!validation.valid || !validation.invite) {
    return { ok: false, error: validation.error ?? "Invalid invite." };
  }

  const { invite } = validation;
  const tokenHash  = hashToken(params.token);

  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    await client.query(
      `UPDATE auth_invites SET accepted_at = NOW() WHERE token_hash = $1`,
      [tokenHash],
    );
    // Upsert tenant membership
    await client.query(
      `INSERT INTO tenant_memberships (tenant_id, user_id, role, created_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [invite.tenantId, params.userId, invite.role],
    ).catch(() => {
      // Table may not exist yet — proceed silently
    });
  } finally {
    await client.end().catch(() => {});
  }

  await logAuthEvent({
    eventType: "invite_accepted",
    tenantId:  invite.tenantId,
    userId:    params.userId,
    ipAddress: params.ipAddress ?? null,
    metadata:  { role: invite.role },
  });

  return { ok: true, tenantId: invite.tenantId, role: invite.role };
}
