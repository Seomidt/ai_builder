/**
 * Phase 7 — Session Management Service
 * INV-SEC2: Session tokens must be hashed.
 * INV-SEC3: Revoked sessions must never validate.
 */

import pg from "pg";
import crypto from "crypto";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function generateToken(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(32).toString("hex")}`;
}

const SESSION_TTL_HOURS = 24;
const REFRESH_TTL_DAYS = 30;

// ─── Security events helper ───────────────────────────────────────────────────

async function logSecurityEvent(
  client: pg.Client,
  params: {
    tenantId?: string;
    userId?: string;
    eventType: string;
    ipAddress?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  try {
    await client.query(
      `INSERT INTO public.security_events (id, tenant_id, user_id, event_type, ip_address, metadata)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5)`,
      [params.tenantId ?? null, params.userId ?? null, params.eventType, params.ipAddress ?? null, params.metadata ? JSON.stringify(params.metadata) : null],
    );
  } catch {
    // best-effort; don't fail session ops for logging failures
  }
}

// ─── createSession ────────────────────────────────────────────────────────────

export async function createSession(params: {
  userId: string;
  tenantId?: string;
  deviceName?: string;
  ipAddress?: string;
  userAgent?: string;
  ttlHours?: number;
}): Promise<{
  sessionId: string;
  sessionToken: string;
  refreshToken: string;
  expiresAt: Date;
  note: string;
}> {
  const { userId, tenantId, deviceName, ipAddress, userAgent, ttlHours = SESSION_TTL_HOURS } = params;
  const sessionToken = generateToken("sess");
  const refreshToken = generateToken("ref");
  const sessionTokenHash = hashToken(sessionToken);
  const refreshTokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000);
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000);

  const client = getClient();
  await client.connect();
  try {
    const sess = await client.query(
      `INSERT INTO public.user_sessions
         (id, user_id, session_token_hash, device_name, ip_address, user_agent, expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6) RETURNING id`,
      [userId, sessionTokenHash, deviceName ?? null, ipAddress ?? null, userAgent ?? null, expiresAt],
    );
    const sessionId = sess.rows[0].id;

    await client.query(
      `INSERT INTO public.session_tokens (id, session_id, refresh_token_hash, expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3)`,
      [sessionId, refreshTokenHash, refreshExpiresAt],
    );

    await logSecurityEvent(client, {
      tenantId,
      userId,
      eventType: "session_created",
      ipAddress,
      metadata: { deviceName, userAgent, sessionId },
    });

    return {
      sessionId,
      sessionToken,
      refreshToken,
      expiresAt,
      note: "INV-SEC2: Token hashes stored only. Plaintext returned once.",
    };
  } finally {
    await client.end();
  }
}

// ─── validateSession ──────────────────────────────────────────────────────────
// INV-SEC3: Revoked sessions must never validate.

export async function validateSession(sessionToken: string): Promise<{
  valid: boolean;
  sessionId?: string;
  userId?: string;
  expiresAt?: Date;
  denialReason?: string;
}> {
  const tokenHash = hashToken(sessionToken);
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT id, user_id, expires_at, revoked_at FROM public.user_sessions WHERE session_token_hash = $1`,
      [tokenHash],
    );
    if (row.rows.length === 0) return { valid: false, denialReason: "Session not found" };
    const s = row.rows[0];
    if (s.revoked_at) return { valid: false, denialReason: "Session revoked" };
    if (new Date(s.expires_at) < new Date()) return { valid: false, denialReason: "Session expired" };

    // Check session_revocations table too (INV-SEC3)
    const rev = await client.query(
      `SELECT id FROM public.session_revocations WHERE session_id = $1`,
      [s.id],
    );
    if (rev.rows.length > 0) return { valid: false, denialReason: "Session explicitly revoked" };

    return { valid: true, sessionId: s.id, userId: s.user_id, expiresAt: s.expires_at };
  } finally {
    await client.end();
  }
}

// ─── rotateSessionToken ───────────────────────────────────────────────────────

export async function rotateSessionToken(params: {
  refreshToken: string;
  ipAddress?: string;
}): Promise<{
  valid: boolean;
  newSessionToken?: string;
  newRefreshToken?: string;
  expiresAt?: Date;
  denialReason?: string;
}> {
  const { refreshToken, ipAddress } = params;
  const refreshTokenHash = hashToken(refreshToken);
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT st.id as token_id, st.session_id, st.expires_at as ref_expires,
              us.user_id, us.revoked_at, us.expires_at as sess_expires
       FROM public.session_tokens st
       JOIN public.user_sessions us ON us.id = st.session_id
       WHERE st.refresh_token_hash = $1`,
      [refreshTokenHash],
    );
    if (row.rows.length === 0) return { valid: false, denialReason: "Refresh token not found" };
    const t = row.rows[0];

    if (t.revoked_at) return { valid: false, denialReason: "Session revoked" };
    if (new Date(t.ref_expires) < new Date()) return { valid: false, denialReason: "Refresh token expired" };
    if (new Date(t.sess_expires) < new Date()) return { valid: false, denialReason: "Session expired" };

    const revCheck = await client.query(
      `SELECT id FROM public.session_revocations WHERE session_id = $1`,
      [t.session_id],
    );
    if (revCheck.rows.length > 0) return { valid: false, denialReason: "Session revoked" };

    // Rotate: issue new session token + refresh token
    const newSessionToken = generateToken("sess");
    const newRefreshToken = generateToken("ref");
    const newSessionHash = hashToken(newSessionToken);
    const newRefreshHash = hashToken(newRefreshToken);
    const newSessionExpires = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
    const newRefreshExpires = new Date(Date.now() + REFRESH_TTL_DAYS * 24 * 3600 * 1000);

    await client.query(
      `UPDATE public.user_sessions SET session_token_hash = $1, expires_at = $2, ip_address = $3 WHERE id = $4`,
      [newSessionHash, newSessionExpires, ipAddress ?? null, t.session_id],
    );
    await client.query(`DELETE FROM public.session_tokens WHERE id = $1`, [t.token_id]);
    await client.query(
      `INSERT INTO public.session_tokens (id, session_id, refresh_token_hash, expires_at)
       VALUES (gen_random_uuid(), $1, $2, $3)`,
      [t.session_id, newRefreshHash, newRefreshExpires],
    );

    return {
      valid: true,
      newSessionToken,
      newRefreshToken,
      expiresAt: newSessionExpires,
    };
  } finally {
    await client.end();
  }
}

// ─── revokeSession ────────────────────────────────────────────────────────────

export async function revokeSession(params: {
  sessionId: string;
  revokedBy?: string;
  reason?: string;
  tenantId?: string;
}): Promise<{ revoked: boolean; idempotent: boolean }> {
  const { sessionId, revokedBy, reason, tenantId } = params;
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(`SELECT id, user_id, revoked_at FROM public.user_sessions WHERE id = $1`, [sessionId]);
    if (row.rows.length === 0) return { revoked: false, idempotent: false };

    const existing = await client.query(`SELECT id FROM public.session_revocations WHERE session_id = $1`, [sessionId]);
    if (existing.rows.length > 0) return { revoked: true, idempotent: true };

    await client.query(
      `UPDATE public.user_sessions SET revoked_at = NOW() WHERE id = $1`,
      [sessionId],
    );
    await client.query(
      `INSERT INTO public.session_revocations (id, session_id, revoked_by, reason)
       VALUES (gen_random_uuid(), $1, $2, $3)`,
      [sessionId, revokedBy ?? null, reason ?? "explicit_revocation"],
    );

    await logSecurityEvent(client, {
      tenantId,
      userId: row.rows[0].user_id,
      eventType: "session_revoked",
      metadata: { sessionId, reason },
    });

    return { revoked: true, idempotent: false };
  } finally {
    await client.end();
  }
}

// ─── revokeAllSessionsForUser ─────────────────────────────────────────────────

export async function revokeAllSessionsForUser(params: {
  userId: string;
  revokedBy?: string;
  reason?: string;
  tenantId?: string;
}): Promise<{ revokedCount: number }> {
  const { userId, revokedBy, reason, tenantId } = params;
  const client = getClient();
  await client.connect();
  try {
    const sessions = await client.query(
      `SELECT id FROM public.user_sessions WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );

    let revokedCount = 0;
    for (const s of sessions.rows) {
      const existing = await client.query(`SELECT id FROM public.session_revocations WHERE session_id = $1`, [s.id]);
      if (existing.rows.length > 0) continue;

      await client.query(`UPDATE public.user_sessions SET revoked_at = NOW() WHERE id = $1`, [s.id]);
      await client.query(
        `INSERT INTO public.session_revocations (id, session_id, revoked_by, reason)
         VALUES (gen_random_uuid(), $1, $2, $3)`,
        [s.id, revokedBy ?? null, reason ?? "logout_all"],
      );
      revokedCount++;
    }

    if (revokedCount > 0) {
      await logSecurityEvent(client, {
        tenantId,
        userId,
        eventType: "session_revoked",
        metadata: { revokedCount, reason: reason ?? "logout_all" },
      });
    }

    return { revokedCount };
  } finally {
    await client.end();
  }
}

// ─── listUserSessions ─────────────────────────────────────────────────────────

export async function listUserSessions(userId: string): Promise<Array<{
  id: string;
  deviceName: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  expiresAt: Date;
  isRevoked: boolean;
  isExpired: boolean;
}>> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `SELECT us.id, us.device_name, us.ip_address, us.user_agent, us.created_at, us.expires_at, us.revoked_at,
              sr.id as revocation_id
       FROM public.user_sessions us
       LEFT JOIN public.session_revocations sr ON sr.session_id = us.id
       WHERE us.user_id = $1 ORDER BY us.created_at DESC`,
      [userId],
    );
    return row.rows.map((r) => ({
      id: r.id,
      deviceName: r.device_name,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      isRevoked: !!r.revoked_at || !!r.revocation_id,
      isExpired: new Date(r.expires_at) < new Date(),
    }));
  } finally {
    await client.end();
  }
}

// ─── detectNewDevice ──────────────────────────────────────────────────────────

export async function detectNewDevice(params: {
  userId: string;
  deviceName?: string;
  ipAddress?: string;
  userAgent?: string;
}): Promise<{
  isNewDevice: boolean;
  knownDevices: number;
  note: string;
}> {
  const { userId, deviceName, ipAddress, userAgent } = params;
  const client = getClient();
  await client.connect();
  try {
    const knownRow = await client.query(
      `SELECT COUNT(DISTINCT COALESCE(device_name, ip_address, user_agent)) as cnt
       FROM public.user_sessions WHERE user_id = $1 AND revoked_at IS NULL`,
      [userId],
    );
    const knownDevices = parseInt(knownRow.rows[0].cnt ?? "0", 10);

    const matchRow = await client.query(
      `SELECT id FROM public.user_sessions
       WHERE user_id = $1 AND (
         (device_name IS NOT NULL AND device_name = $2) OR
         (ip_address IS NOT NULL AND ip_address = $3)
       ) LIMIT 1`,
      [userId, deviceName ?? null, ipAddress ?? null],
    );

    const isNewDevice = matchRow.rows.length === 0;
    return { isNewDevice, knownDevices, note: "INV-SEC8: Device detection is read-only. No writes." };
  } finally {
    await client.end();
  }
}

// ─── logSecurityEventExternal ─────────────────────────────────────────────────

export async function logSecurityEventExternal(params: {
  tenantId?: string;
  userId?: string;
  eventType: string;
  ipAddress?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ eventId: string }> {
  const client = getClient();
  await client.connect();
  try {
    const row = await client.query(
      `INSERT INTO public.security_events (id, tenant_id, user_id, event_type, ip_address, metadata)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5) RETURNING id`,
      [params.tenantId ?? null, params.userId ?? null, params.eventType, params.ipAddress ?? null, params.metadata ? JSON.stringify(params.metadata) : null],
    );
    return { eventId: row.rows[0].id };
  } finally {
    await client.end();
  }
}
