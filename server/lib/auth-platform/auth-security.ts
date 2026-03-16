/**
 * Phase 37 — Auth Security / Brute-Force Protection
 *
 * IP and email-based attempt tracking with cooldown escalation.
 * Does NOT permanently lock accounts — always has a recovery path via time.
 */

import { createHash } from "crypto";
import { Client } from "pg";
import { logAuthEvent } from "./auth-audit";

const DB_URL = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL || "";

// Configurable thresholds
const EMAIL_FAILURE_WINDOW_MIN = 15;
const EMAIL_MAX_FAILURES = 10;
const IP_FAILURE_WINDOW_MIN = 15;
const IP_MAX_FAILURES = 30;
const COOLDOWN_WINDOW_MIN = 15;

export function hashEmail(email: string): string {
  return createHash("sha256").update(email.toLowerCase().trim()).digest("hex");
}

export interface LoginAttemptRecord {
  emailHash:     string;
  tenantId?:     string | null;
  ipAddress?:    string | null;
  userAgent?:    string | null;
  success:       boolean;
  failureReason?: string | null;
}

export async function recordLoginAttempt(record: LoginAttemptRecord): Promise<void> {
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    await client.query(
      `INSERT INTO auth_login_attempts
         (email_hash, tenant_id, ip_address, user_agent, success, failure_reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        record.emailHash,
        record.tenantId ?? null,
        record.ipAddress ?? null,
        record.userAgent ?? null,
        record.success,
        record.failureReason ?? null,
      ],
    );
  } finally {
    await client.end().catch(() => {});
  }
}

export interface BruteForceState {
  limited:      boolean;
  failures:     number;
  cooldownUntil?: Date;
}

export async function isEmailLimited(emailHash: string): Promise<BruteForceState> {
  const since = new Date(Date.now() - EMAIL_FAILURE_WINDOW_MIN * 60_000).toISOString();
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    const res = await client.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM auth_login_attempts
       WHERE email_hash = $1 AND success = FALSE AND created_at >= $2`,
      [emailHash, since],
    );
    const failures = Number(res.rows[0]?.cnt ?? 0);
    const limited  = failures >= EMAIL_MAX_FAILURES;
    return {
      limited,
      failures,
      cooldownUntil: limited
        ? new Date(Date.now() + COOLDOWN_WINDOW_MIN * 60_000)
        : undefined,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function isIpLimited(ipAddress: string): Promise<BruteForceState> {
  const since = new Date(Date.now() - IP_FAILURE_WINDOW_MIN * 60_000).toISOString();
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    const res = await client.query<{ cnt: string }>(
      `SELECT COUNT(*) AS cnt FROM auth_login_attempts
       WHERE ip_address = $1 AND success = FALSE AND created_at >= $2`,
      [ipAddress, since],
    );
    const failures = Number(res.rows[0]?.cnt ?? 0);
    const limited  = failures >= IP_MAX_FAILURES;
    return {
      limited,
      failures,
      cooldownUntil: limited
        ? new Date(Date.now() + COOLDOWN_WINDOW_MIN * 60_000)
        : undefined,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export interface AuthSecurityState {
  recentFailures24h:     number;
  suspiciousIps:         string[];
  lockedEmailHashes:     string[];
  cooldownActiveCount:   number;
}

export async function getAuthSecurityState(): Promise<AuthSecurityState> {
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const client = new Client({ connectionString: DB_URL });
  try {
    await client.connect();
    const [failRes, ipRes, emailRes] = await Promise.all([
      client.query<{ cnt: string }>(
        `SELECT COUNT(*) AS cnt FROM auth_login_attempts WHERE success = FALSE AND created_at >= $1`,
        [since24h],
      ),
      client.query<{ ip_address: string; cnt: string }>(
        `SELECT ip_address, COUNT(*) AS cnt FROM auth_login_attempts
         WHERE success = FALSE AND created_at >= $1
         GROUP BY ip_address
         HAVING COUNT(*) >= $2`,
        [since24h, IP_MAX_FAILURES],
      ),
      client.query<{ email_hash: string; cnt: string }>(
        `SELECT email_hash, COUNT(*) AS cnt FROM auth_login_attempts
         WHERE success = FALSE AND created_at >= $1
         GROUP BY email_hash
         HAVING COUNT(*) >= $2`,
        [since24h, EMAIL_MAX_FAILURES],
      ),
    ]);
    return {
      recentFailures24h:   Number(failRes.rows[0]?.cnt ?? 0),
      suspiciousIps:       ipRes.rows.map(r => r.ip_address).filter(Boolean),
      lockedEmailHashes:   emailRes.rows.map(r => r.email_hash),
      cooldownActiveCount: ipRes.rows.length + emailRes.rows.length,
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function detectSuspiciousAuthPatterns(
  emailHash: string,
  ipAddress: string | null,
  tenantId: string | null,
): Promise<boolean> {
  const emailState = await isEmailLimited(emailHash);
  const ipState    = ipAddress ? await isIpLimited(ipAddress) : { limited: false, failures: 0 };

  const suspicious = emailState.failures >= 5 || ipState.failures >= 15;
  if (suspicious) {
    await logAuthEvent({
      eventType: "suspicious_login_detected",
      tenantId,
      ipAddress,
      metadata: {
        emailFailures: emailState.failures,
        ipFailures:    ipState.failures,
      },
    });
  }
  return suspicious;
}
