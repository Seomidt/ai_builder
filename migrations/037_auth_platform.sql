-- ============================================================
-- Phase 37 — Secure Authentication Platform
-- Migration: 037_auth_platform.sql
-- ============================================================

-- ─── auth_sessions ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_sessions (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL,
  tenant_id       UUID,
  session_token   TEXT        NOT NULL UNIQUE,
  device_label    TEXT,
  ip_address      TEXT,
  user_agent      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  revoked_reason  TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_created
  ON auth_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_tenant_created
  ON auth_sessions (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_token
  ON auth_sessions (session_token);

ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_sessions_service_role ON auth_sessions;
CREATE POLICY auth_sessions_service_role ON auth_sessions
  USING (auth.role() = 'service_role');

-- ─── auth_login_attempts ────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_login_attempts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  email_hash      TEXT        NOT NULL,
  tenant_id       UUID,
  ip_address      TEXT,
  user_agent      TEXT,
  success         BOOLEAN     NOT NULL DEFAULT FALSE,
  failure_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_attempts_email_created
  ON auth_login_attempts (email_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_ip_created
  ON auth_login_attempts (ip_address, created_at DESC);

ALTER TABLE auth_login_attempts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_login_attempts_service_role ON auth_login_attempts;
CREATE POLICY auth_login_attempts_service_role ON auth_login_attempts
  USING (auth.role() = 'service_role');

-- ─── auth_password_reset_tokens ─────────────────────────────
CREATE TABLE IF NOT EXISTS auth_password_reset_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL,
  token_hash  TEXT        NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_prt_user_created
  ON auth_password_reset_tokens (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_prt_token
  ON auth_password_reset_tokens (token_hash);

ALTER TABLE auth_password_reset_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_prt_service_role ON auth_password_reset_tokens;
CREATE POLICY auth_prt_service_role ON auth_password_reset_tokens
  USING (auth.role() = 'service_role');

-- ─── auth_email_verification_tokens ─────────────────────────
CREATE TABLE IF NOT EXISTS auth_email_verification_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL,
  token_hash  TEXT        NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_evt_user_created
  ON auth_email_verification_tokens (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_evt_token
  ON auth_email_verification_tokens (token_hash);

ALTER TABLE auth_email_verification_tokens ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_evt_service_role ON auth_email_verification_tokens;
CREATE POLICY auth_evt_service_role ON auth_email_verification_tokens
  USING (auth.role() = 'service_role');

-- ─── auth_mfa_totp ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_mfa_totp (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID        NOT NULL,
  secret_encrypted TEXT        NOT NULL,
  enabled          BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  verified_at      TIMESTAMPTZ,
  last_used_at     TIMESTAMPTZ,
  CONSTRAINT auth_mfa_totp_user_unique UNIQUE (user_id)
);

ALTER TABLE auth_mfa_totp ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_mfa_totp_service_role ON auth_mfa_totp;
CREATE POLICY auth_mfa_totp_service_role ON auth_mfa_totp
  USING (auth.role() = 'service_role');

-- ─── auth_mfa_recovery_codes ────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_mfa_recovery_codes (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL,
  code_hash   TEXT        NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_mfa_rc_user_created
  ON auth_mfa_recovery_codes (user_id, created_at DESC);

ALTER TABLE auth_mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_mfa_rc_service_role ON auth_mfa_recovery_codes;
CREATE POLICY auth_mfa_rc_service_role ON auth_mfa_recovery_codes
  USING (auth.role() = 'service_role');

-- ─── auth_invites ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_invites (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL,
  email       TEXT        NOT NULL,
  token_hash  TEXT        NOT NULL UNIQUE,
  role        TEXT        NOT NULL DEFAULT 'member',
  invited_by  UUID,
  expires_at  TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_invites_tenant_created
  ON auth_invites (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_invites_token
  ON auth_invites (token_hash);

ALTER TABLE auth_invites ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_invites_service_role ON auth_invites;
CREATE POLICY auth_invites_service_role ON auth_invites
  USING (auth.role() = 'service_role');

-- ─── auth_security_events ────────────────────────────────────
CREATE TABLE IF NOT EXISTS auth_security_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID,
  user_id        UUID,
  event_type     TEXT        NOT NULL,
  severity       TEXT        NOT NULL DEFAULT 'info',
  ip_address     TEXT,
  metadata_json  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_auth_sec_events_tenant_created
  ON auth_security_events (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_sec_events_user_created
  ON auth_security_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_sec_events_type_created
  ON auth_security_events (event_type, created_at DESC);

ALTER TABLE auth_security_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS auth_sec_events_service_role ON auth_security_events;
CREATE POLICY auth_sec_events_service_role ON auth_security_events
  USING (auth.role() = 'service_role');
