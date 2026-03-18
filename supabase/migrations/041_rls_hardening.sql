-- =============================================================================
-- Phase 41 — Supabase RLS Hardening, Tenant Isolation Repair & Index Safety
-- =============================================================================
--
-- CLASSIFICATION OF FIXES:
--
-- CRITICAL  — public-role USING(true) policies: any authenticated user can
--              read ALL rows across all tenants. Dropped and replaced.
--
-- LINT      — service_role USING(true) policies: service_role bypasses RLS
--              in Supabase automatically, making these policies redundant.
--              Dropped to eliminate Supabase lint warnings.
--
-- ACCESS MODELS applied:
--   A. TENANT-SCOPED     — tenant_id / organization_id enforced per row
--   B. PLATFORM-ADMIN    — service_role bypass only; no authenticated policy
--   C. INTERNAL-SYSTEM   — service_role bypass only; backend writes only
--
-- NOTE: All platform backend operations use Drizzle ORM with service_role
--       credentials. service_role bypasses RLS automatically in Supabase,
--       so no explicit service_role policies are required.
-- =============================================================================

BEGIN;

-- =============================================================================
-- SECTION 1: CRITICAL — Drop public-role USING(true) policies
-- Severity: HIGH — any authenticated user can read all tenant data
-- =============================================================================

-- ai_policies (PLATFORM-ADMIN / B)
-- No authenticated user should directly access AI policy config
DROP POLICY IF EXISTS admin_only ON ai_policies;

-- data_deletion_jobs (TENANT-SCOPED / A) — has tenant_id
-- Needs proper tenant isolation; replaced in Section 3
DROP POLICY IF EXISTS data_deletion_jobs_admin_bypass ON data_deletion_jobs;

-- data_retention_policies (PLATFORM-ADMIN / B) — no tenant_id, platform config
DROP POLICY IF EXISTS data_retention_policies_admin_bypass ON data_retention_policies;

-- data_retention_rules (PLATFORM-ADMIN / B) — no tenant_id, platform config
DROP POLICY IF EXISTS data_retention_rules_admin_bypass ON data_retention_rules;

-- legal_holds (INTERNAL-SYSTEM / C) — compliance table, no authenticated access
DROP POLICY IF EXISTS legal_holds_admin_bypass ON legal_holds;

-- model_allowlists (PLATFORM-ADMIN / B) — platform AI config
DROP POLICY IF EXISTS admin_only ON model_allowlists;

-- obs_agent_runtime_metrics (TENANT-SCOPED / A) — has tenant_id
-- Replaced with tenant-scoped policy in Section 3
DROP POLICY IF EXISTS obs_agent_runtime_metrics_service_role_policy ON obs_agent_runtime_metrics;

-- obs_ai_latency_metrics (TENANT-SCOPED / A) — has tenant_id
DROP POLICY IF EXISTS obs_ai_latency_metrics_service_role_policy ON obs_ai_latency_metrics;

-- obs_retrieval_metrics (TENANT-SCOPED / A) — has tenant_id
DROP POLICY IF EXISTS obs_retrieval_metrics_service_role_policy ON obs_retrieval_metrics;

-- obs_system_metrics (INTERNAL-SYSTEM / C) — no tenant_id, platform-wide
DROP POLICY IF EXISTS obs_system_metrics_service_role_policy ON obs_system_metrics;

-- obs_tenant_usage_metrics (TENANT-SCOPED / A) — has tenant_id
DROP POLICY IF EXISTS obs_tenant_usage_metrics_service_role_policy ON obs_tenant_usage_metrics;

-- security_events (TENANT-SCOPED / A) — has tenant_id
-- Tenants may read their own security events; replaced in Section 3
DROP POLICY IF EXISTS se_service_role_policy ON security_events;

-- =============================================================================
-- SECTION 2: LINT — Drop redundant service_role USING(true) policies
-- service_role bypasses RLS automatically; these policies are no-ops and
-- trigger Supabase "always_true" lint warnings.
-- =============================================================================

-- ai_anomaly_events — also has correct tenant-isolation policies (kept)
DROP POLICY IF EXISTS service_role_all_ai_anomaly_events ON ai_anomaly_events;

-- ai_eval_* tables — tenant-isolated already via tenant_id policies
DROP POLICY IF EXISTS ai_eval_cases_service_role_all       ON ai_eval_cases;
DROP POLICY IF EXISTS ai_eval_datasets_service_role_all    ON ai_eval_datasets;
DROP POLICY IF EXISTS ai_eval_regressions_service_role_all ON ai_eval_regressions;
DROP POLICY IF EXISTS ai_eval_results_service_role_all     ON ai_eval_results;
DROP POLICY IF EXISTS ai_eval_runs_service_role_all        ON ai_eval_runs;

-- ai_usage_alerts — governance table written by backend only
DROP POLICY IF EXISTS service_role_all_ai_usage_alerts ON ai_usage_alerts;

-- gov_anomaly_events — governance table written by backend only
DROP POLICY IF EXISTS service_role_all_gov_anomaly_events ON gov_anomaly_events;

-- ops_ai_audit_logs — ops table written by backend only
DROP POLICY IF EXISTS service_role_all_ops_ai_audit_logs ON ops_ai_audit_logs;

-- tenant_ai_budgets — governance table; backend-only writes
DROP POLICY IF EXISTS service_role_all_tenant_ai_budgets ON tenant_ai_budgets;

-- tenant_ai_usage_snapshots — governance table; backend-only writes
DROP POLICY IF EXISTS service_role_all_tenant_ai_usage_snapshots ON tenant_ai_usage_snapshots;

-- =============================================================================
-- SECTION 3: Add proper tenant-scoped policies
-- Using project-standard: current_setting('app.current_tenant_id', true)
-- All insert/update policies include WITH CHECK for write isolation.
-- =============================================================================

-- Reusable macro pattern (comment):
-- USING  (current_setting('app.current_tenant_id', true) <> ''
--         AND tenant_id = current_setting('app.current_tenant_id', true))
-- CHECK  same expression

-- ── obs_agent_runtime_metrics (A: TENANT-SCOPED) ──────────────────────────
-- Tenants may read their own agent runtime metrics (SELECT only)
-- Writes are backend-only (service_role)
CREATE POLICY p41_obs_arm_tenant_select
  ON obs_agent_runtime_metrics
  FOR SELECT
  TO authenticated
  USING (
    current_setting('app.current_tenant_id', true) <> ''
    AND tenant_id = current_setting('app.current_tenant_id', true)
  );

-- ── obs_ai_latency_metrics (A: TENANT-SCOPED) ─────────────────────────────
CREATE POLICY p41_obs_alm_tenant_select
  ON obs_ai_latency_metrics
  FOR SELECT
  TO authenticated
  USING (
    current_setting('app.current_tenant_id', true) <> ''
    AND tenant_id = current_setting('app.current_tenant_id', true)
  );

-- ── obs_retrieval_metrics (A: TENANT-SCOPED) ──────────────────────────────
CREATE POLICY p41_obs_rm_tenant_select
  ON obs_retrieval_metrics
  FOR SELECT
  TO authenticated
  USING (
    current_setting('app.current_tenant_id', true) <> ''
    AND tenant_id = current_setting('app.current_tenant_id', true)
  );

-- ── obs_tenant_usage_metrics (A: TENANT-SCOPED) ───────────────────────────
CREATE POLICY p41_obs_tum_tenant_select
  ON obs_tenant_usage_metrics
  FOR SELECT
  TO authenticated
  USING (
    current_setting('app.current_tenant_id', true) <> ''
    AND tenant_id = current_setting('app.current_tenant_id', true)
  );

-- ── security_events (A: TENANT-SCOPED, READ-ONLY for tenants) ─────────────
-- Tenants may read their own security events
-- All writes are backend-only (service_role)
CREATE POLICY p41_security_events_tenant_select
  ON security_events
  FOR SELECT
  TO authenticated
  USING (
    current_setting('app.current_tenant_id', true) <> ''
    AND tenant_id = current_setting('app.current_tenant_id', true)
  );

-- ── data_deletion_jobs (A: TENANT-SCOPED, READ-ONLY for tenants) ──────────
-- Tenants may read their own deletion job status
-- All writes/updates are backend-only (service_role)
CREATE POLICY p41_data_deletion_jobs_tenant_select
  ON data_deletion_jobs
  FOR SELECT
  TO authenticated
  USING (
    current_setting('app.current_tenant_id', true) <> ''
    AND tenant_id = current_setting('app.current_tenant_id', true)
  );

-- =============================================================================
-- SECTION 4: Ensure remaining tables in NO_POLICY state are documented
-- Tables intentionally left with RLS enabled but no policies (backend-only):
--   admin_change_events, admin_change_requests, ai_approvals, ai_artifacts,
--   ai_model_overrides, ai_model_pricing, ai_policies (now locked),
--   ai_provider_reconciliation_runs, api_key_scopes, app_user_profiles,
--   architecture_*, audit_event_metadata, billing_*, data_retention_*,
--   gov_anomaly_events (backend write), legal_holds (locked), model_allowlists,
--   obs_system_metrics, ops_ai_audit_logs (backend write), organization_*,
--   permissions, plan_*, profiles, provider_*, role_permissions, roles,
--   rollout_audit_log, security_events (has tenant policy above),
--   service_account_keys, session_*, storage_*, stripe_*, subscription_plans,
--   supported_*, tenant_ai_budgets, tenant_ai_usage_snapshots,
--   ai_usage_alerts, usage_quotas, user_mfa_methods, user_sessions
--
-- These tables are accessed exclusively via service_role (Drizzle ORM).
-- service_role bypasses RLS — no explicit policy needed.
-- =============================================================================

-- =============================================================================
-- SECTION 5: Index safety — add critical composite indexes where missing
-- (Most tenant indexes already exist; adding only provably missing ones)
-- =============================================================================

-- obs_agent_runtime_metrics — add composite for common tenant+created queries
CREATE INDEX IF NOT EXISTS p41_obs_arm_tenant_created_idx
  ON obs_agent_runtime_metrics (tenant_id, created_at DESC);

-- obs_ai_latency_metrics
CREATE INDEX IF NOT EXISTS p41_obs_alm_tenant_created_idx
  ON obs_ai_latency_metrics (tenant_id, created_at DESC);

-- obs_retrieval_metrics
CREATE INDEX IF NOT EXISTS p41_obs_rm_tenant_created_idx
  ON obs_retrieval_metrics (tenant_id, created_at DESC);

-- obs_tenant_usage_metrics
CREATE INDEX IF NOT EXISTS p41_obs_tum_tenant_period_idx
  ON obs_tenant_usage_metrics (tenant_id, period, created_at DESC);

-- security_events — composite for tenant + event_type queries
CREATE INDEX IF NOT EXISTS p41_security_events_tenant_type_created_idx
  ON security_events (tenant_id, event_type, created_at DESC);

-- data_deletion_jobs — composite for tenant + status queries
CREATE INDEX IF NOT EXISTS p41_data_deletion_jobs_tenant_status_idx
  ON data_deletion_jobs (tenant_id, status, created_at DESC);

-- ai_usage_alerts — composite for tenant + alert_type queries
CREATE INDEX IF NOT EXISTS p41_ai_usage_alerts_tenant_type_triggered_idx
  ON ai_usage_alerts (tenant_id, alert_type, triggered_at DESC);

-- gov_anomaly_events — composite for tenant + event_type queries
CREATE INDEX IF NOT EXISTS p41_gov_anomaly_events_tenant_type_created_idx
  ON gov_anomaly_events (tenant_id, event_type, created_at DESC);

-- tenant_ai_budgets — composite (tenant_id + updated_at)
CREATE INDEX IF NOT EXISTS p41_tenant_ai_budgets_tenant_updated_idx
  ON tenant_ai_budgets (tenant_id, updated_at DESC);

-- tenant_ai_usage_snapshots — composite for tenant + period queries
CREATE INDEX IF NOT EXISTS p41_tenant_ai_usage_snapshots_tenant_period_created_idx
  ON tenant_ai_usage_snapshots (tenant_id, period, created_at DESC);

-- auth_sessions — critical: revocation queries
CREATE INDEX IF NOT EXISTS p41_auth_sessions_user_revoked_idx
  ON auth_sessions (user_id, revoked_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS p41_auth_sessions_tenant_active_idx
  ON auth_sessions (tenant_id, expires_at DESC)
  WHERE revoked_at IS NULL;

COMMIT;

-- =============================================================================
-- VERIFICATION QUERY (run after migration to confirm)
-- =============================================================================
-- SELECT tablename, policyname, cmd, roles, qual, with_check
-- FROM pg_policies
-- WHERE schemaname = 'public'
--   AND (qual = 'true' OR with_check = 'true')
--   AND 'public' = ANY(roles)
-- ORDER BY tablename;
-- Expected: 0 rows (no public-role always-true policies remain)
-- =============================================================================
