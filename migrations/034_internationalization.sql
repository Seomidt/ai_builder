-- Phase 34: Internationalization + Database Performance Pass
-- Run: psql "$SUPABASE_DB_POOL_URL" -f migrations/034_internationalization.sql

-- PART 1: Extend tenants with locale columns

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS locale   TEXT DEFAULT 'en-US',
  ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD',
  ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'UTC';

-- Locale lookup index
CREATE INDEX IF NOT EXISTS idx_tenants_locale
  ON tenants (language, locale);

-- PART 2: Tenant query performance composite indexes

-- AI usage snapshots
CREATE INDEX IF NOT EXISTS idx_usage_tenant_created
  ON tenant_ai_usage_snapshots (tenant_id, created_at DESC);

-- AI alerts (uses triggered_at, not created_at)
CREATE INDEX IF NOT EXISTS idx_alerts_tenant_created
  ON ai_usage_alerts (tenant_id, triggered_at DESC);

-- Anomaly events
CREATE INDEX IF NOT EXISTS idx_anomaly_tenant_created
  ON gov_anomaly_events (tenant_id, created_at DESC);

-- Audit events
CREATE INDEX IF NOT EXISTS idx_audit_tenant_created
  ON audit_events (tenant_id, created_at DESC);

-- Webhook deliveries
CREATE INDEX IF NOT EXISTS idx_webhooks_tenant_created
  ON webhook_deliveries (tenant_id, created_at DESC);

-- Jobs
CREATE INDEX IF NOT EXISTS idx_jobs_tenant_created
  ON jobs (tenant_id, created_at DESC);
