/**
 * Phase 41 — RLS Audit / Explainer
 * Live inspection of RLS policy status across all public tables.
 *
 * Access model classifications:
 *   A = TENANT-SCOPED    — tenant_id / organization_id enforced per row
 *   B = PLATFORM-ADMIN   — service_role only; no authenticated policy needed
 *   C = INTERNAL-SYSTEM  — service_role only; backend writes exclusively
 */

import { db }  from "../../db";
import { sql } from "drizzle-orm";

// ── Access model classification ───────────────────────────────────────────────

export type AccessModel = "TENANT-SCOPED" | "PLATFORM-ADMIN" | "INTERNAL-SYSTEM" | "MIXED" | "UNKNOWN";

export interface TableAccessMeta {
  tableName:    string;
  accessModel:  AccessModel;
  tenantKey:    string | null;
  description:  string;
}

/**
 * Canonical access model for every affected table.
 * Kept as a static map for fast audit queries without DB round-trips.
 */
export const TABLE_ACCESS_MODELS: Record<string, TableAccessMeta> = {
  // ── Tenant-scoped (A) ────────────────────────────────────────────────────
  ai_agent_runs:               { tableName: "ai_agent_runs",               accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "AI agent run records — tenant owns all runs" },
  ai_agents:                   { tableName: "ai_agents",                   accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "AI agent definitions per tenant" },
  ai_anomaly_configs:          { tableName: "ai_anomaly_configs",          accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "Tenant anomaly detection config" },
  ai_anomaly_events:           { tableName: "ai_anomaly_events",           accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "Tenant anomaly events (Phase 3H)" },
  ai_eval_cases:               { tableName: "ai_eval_cases",               accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "AI eval test cases" },
  ai_eval_datasets:            { tableName: "ai_eval_datasets",            accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "AI eval datasets" },
  ai_eval_regressions:         { tableName: "ai_eval_regressions",         accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "AI eval regressions" },
  ai_eval_results:             { tableName: "ai_eval_results",             accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "AI eval results" },
  ai_eval_runs:                { tableName: "ai_eval_runs",                accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "AI eval runs" },
  ai_usage_alerts:             { tableName: "ai_usage_alerts",             accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "AI usage alerts per tenant" },
  data_deletion_jobs:          { tableName: "data_deletion_jobs",          accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "Tenant data deletion job status (read-only)" },
  experiments:                 { tableName: "experiments",                 accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "Tenant experiments" },
  gov_anomaly_events:          { tableName: "gov_anomaly_events",          accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "AI governance anomaly events (Phase 16)" },
  obs_agent_runtime_metrics:   { tableName: "obs_agent_runtime_metrics",   accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "Agent runtime observability per tenant" },
  obs_ai_latency_metrics:      { tableName: "obs_ai_latency_metrics",      accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "AI latency observability per tenant" },
  obs_retrieval_metrics:       { tableName: "obs_retrieval_metrics",       accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "Retrieval observability per tenant" },
  obs_tenant_usage_metrics:    { tableName: "obs_tenant_usage_metrics",    accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "Tenant-level usage observability" },
  security_events:             { tableName: "security_events",             accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "Security events — tenants read own events" },
  stripe_customers:            { tableName: "stripe_customers",            accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "Stripe customer records" },
  stripe_invoices:             { tableName: "stripe_invoices",             accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "Stripe invoices" },
  stripe_subscriptions:        { tableName: "stripe_subscriptions",        accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "Stripe subscriptions" },
  tenant_ai_budgets:           { tableName: "tenant_ai_budgets",           accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "AI cost budgets (Phase 16)" },
  tenant_ai_usage_snapshots:   { tableName: "tenant_ai_usage_snapshots",   accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "AI usage snapshots (Phase 16)" },
  tenant_plans:                { tableName: "tenant_plans",                accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "Tenant plan assignments" },
  usage_counters:              { tableName: "usage_counters",              accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "Quota usage counters" },
  rollout_audit_log:           { tableName: "rollout_audit_log",           accessModel: "TENANT-SCOPED",   tenantKey: "tenant_id",       description: "Feature rollout audit log" },

  // ── Platform-admin (B) ───────────────────────────────────────────────────
  ai_policies:                 { tableName: "ai_policies",                 accessModel: "PLATFORM-ADMIN",  tenantKey: null,              description: "Platform AI policy config — admin only" },
  data_retention_policies:     { tableName: "data_retention_policies",     accessModel: "PLATFORM-ADMIN",  tenantKey: null,              description: "Platform-wide data retention policies" },
  data_retention_rules:        { tableName: "data_retention_rules",        accessModel: "PLATFORM-ADMIN",  tenantKey: null,              description: "Platform-wide data retention rules" },
  model_allowlists:            { tableName: "model_allowlists",            accessModel: "PLATFORM-ADMIN",  tenantKey: null,              description: "Allowed AI models — platform config" },
  plans:                       { tableName: "plans",                       accessModel: "PLATFORM-ADMIN",  tenantKey: null,              description: "Billing plan definitions" },
  plan_entitlements:           { tableName: "plan_entitlements",           accessModel: "PLATFORM-ADMIN",  tenantKey: null,              description: "Billing plan entitlements" },
  subscription_plans:          { tableName: "subscription_plans",          accessModel: "PLATFORM-ADMIN",  tenantKey: null,              description: "Subscription plan catalog" },
  supported_currencies:        { tableName: "supported_currencies",        accessModel: "PLATFORM-ADMIN",  tenantKey: null,              description: "Supported currencies list" },
  supported_languages:         { tableName: "supported_languages",         accessModel: "PLATFORM-ADMIN",  tenantKey: null,              description: "Supported languages list" },
  obs_system_metrics:          { tableName: "obs_system_metrics",          accessModel: "PLATFORM-ADMIN",  tenantKey: null,              description: "Platform-wide system metrics" },

  // ── Internal system (C) ─────────────────────────────────────────────────
  legal_holds:                 { tableName: "legal_holds",                 accessModel: "INTERNAL-SYSTEM", tenantKey: null,              description: "Compliance legal holds — backend only" },
  ops_ai_audit_logs:           { tableName: "ops_ai_audit_logs",           accessModel: "INTERNAL-SYSTEM", tenantKey: null,              description: "Platform AI ops audit log — backend only" },
  admin_change_events:         { tableName: "admin_change_events",         accessModel: "INTERNAL-SYSTEM", tenantKey: null,              description: "Platform admin change events" },
  admin_change_requests:       { tableName: "admin_change_requests",       accessModel: "INTERNAL-SYSTEM", tenantKey: null,              description: "Platform admin change requests" },
  session_tokens:              { tableName: "session_tokens",              accessModel: "INTERNAL-SYSTEM", tenantKey: null,              description: "Session token store — backend only" },
  session_revocations:         { tableName: "session_revocations",         accessModel: "INTERNAL-SYSTEM", tenantKey: null,              description: "Session revocations — backend only" },
  auth_sessions:               { tableName: "auth_sessions",               accessModel: "INTERNAL-SYSTEM", tenantKey: "tenant_id",       description: "Auth sessions — backend written only" },
  mfa_recovery_codes:          { tableName: "mfa_recovery_codes",          accessModel: "INTERNAL-SYSTEM", tenantKey: null,              description: "MFA recovery codes — backend only" },
  billing_job_runs:            { tableName: "billing_job_runs",            accessModel: "INTERNAL-SYSTEM", tenantKey: null,              description: "Billing job run records" },
  service_account_keys:        { tableName: "service_account_keys",        accessModel: "INTERNAL-SYSTEM", tenantKey: null,              description: "Service account credentials" },
};

// ── Live policy inspection ─────────────────────────────────────────────────────

export interface LiveTableStatus {
  tableName:      string;
  rlsEnabled:     boolean;
  policyCount:    number;
  hasAlwaysTrue:  boolean;
  hasPublicAlwaysTrue: boolean;
  policies:       Array<{ name: string; cmd: string; roles: string[]; using: string | null; check: string | null }>;
  tenantCols:     string[];
  accessModel:    AccessModel;
  warningFlags:   string[];
  indexCount:     number;
}

export async function listAffectedTables(): Promise<LiveTableStatus[]> {
  const [policyRes, indexRes] = await Promise.all([
    db.execute<any>(sql`
      SELECT
        t.tablename,
        t.rowsecurity AS rls_enabled,
        (SELECT COUNT(*) FROM pg_policies p WHERE p.tablename = t.tablename AND p.schemaname = 'public')::int AS policy_count,
        (SELECT bool_or(p.qual = 'true' OR p.with_check = 'true')
         FROM pg_policies p WHERE p.tablename = t.tablename AND p.schemaname = 'public') AS has_always_true,
        (SELECT bool_or((p.qual = 'true' OR p.with_check = 'true') AND 'public' = ANY(p.roles))
         FROM pg_policies p WHERE p.tablename = t.tablename AND p.schemaname = 'public') AS has_public_always_true,
        (SELECT string_agg(c.column_name, ',')
         FROM information_schema.columns c
         WHERE c.table_name = t.tablename AND c.table_schema = 'public'
           AND c.column_name IN ('tenant_id','organization_id','org_id')) AS tenant_cols,
        (SELECT jsonb_agg(jsonb_build_object(
           'name', p.policyname, 'cmd', p.cmd, 'roles', p.roles,
           'using', p.qual, 'check', p.with_check
         ))
         FROM pg_policies p WHERE p.tablename = t.tablename AND p.schemaname = 'public') AS policies
      FROM pg_tables t
      WHERE t.schemaname = 'public'
      ORDER BY t.tablename
    `),
    db.execute<any>(sql`
      SELECT t.relname AS tablename, COUNT(*) AS idx_count
      FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      WHERE t.relkind = 'r'
        AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
        AND a.attname IN ('tenant_id','organization_id','org_id')
      GROUP BY t.relname
    `),
  ]);

  const indexMap: Record<string, number> = {};
  for (const r of indexRes.rows) indexMap[r.tablename] = Number(r.idx_count);

  return policyRes.rows.map(r => {
    const meta = TABLE_ACCESS_MODELS[r.tablename];
    const policies = r.policies ?? [];
    const tenantCols = r.tenant_cols ? r.tenant_cols.split(",") : [];
    const warnings: string[] = [];

    if (!r.rls_enabled)             warnings.push("RLS_DISABLED");
    if (r.has_public_always_true)   warnings.push("PUBLIC_ALWAYS_TRUE_CRITICAL");
    if (r.has_always_true && !r.has_public_always_true) warnings.push("SERVICE_ROLE_ALWAYS_TRUE_LINT");
    if (r.rls_enabled && Number(r.policy_count) === 0)  warnings.push("NO_POLICY");
    if (tenantCols.length > 0 && Number(r.policy_count) === 0) warnings.push("TENANT_TABLE_NO_POLICY");

    return {
      tableName:           r.tablename,
      rlsEnabled:          r.rls_enabled,
      policyCount:         Number(r.policy_count),
      hasAlwaysTrue:       r.has_always_true ?? false,
      hasPublicAlwaysTrue: r.has_public_always_true ?? false,
      policies:            policies,
      tenantCols,
      accessModel:         meta?.accessModel ?? "UNKNOWN",
      warningFlags:        warnings,
      indexCount:          indexMap[r.tablename] ?? 0,
    };
  });
}

export async function explainTableAccessModel(tableName: string): Promise<{
  meta:   TableAccessMeta | null;
  live:   LiveTableStatus | null;
  advice: string[];
}> {
  const all  = await listAffectedTables();
  const live = all.find(t => t.tableName === tableName) ?? null;
  const meta = TABLE_ACCESS_MODELS[tableName] ?? null;

  const advice: string[] = [];
  if (live?.hasPublicAlwaysTrue) advice.push("CRITICAL: Drop public USING(true) policy immediately");
  if (live?.hasAlwaysTrue && !live.hasPublicAlwaysTrue) advice.push("LINT: Drop service_role USING(true) — service_role bypasses RLS automatically");
  if (live?.warningFlags.includes("TENANT_TABLE_NO_POLICY")) advice.push("Table has tenant key but no RLS policies — backend-only access via service_role");
  if (!meta) advice.push("Table not classified in TABLE_ACCESS_MODELS — add classification");

  return { meta, live, advice };
}

export async function summarizeRlsPosture(): Promise<{
  totalTables:          number;
  rlsEnabled:           number;
  publicAlwaysTrue:     number;
  serviceRoleAlwaysTrue: number;
  noPolicy:             number;
  tenantTableNoPolicy:  number;
  criticalIssues:       string[];
  lintIssues:           string[];
  generatedAt:          string;
}> {
  const all = await listAffectedTables();
  const criticalIssues: string[] = [];
  const lintIssues:     string[] = [];

  for (const t of all) {
    if (t.hasPublicAlwaysTrue)   criticalIssues.push(`${t.tableName}: public USING(true) — any authenticated user sees all rows`);
    if (t.hasAlwaysTrue && !t.hasPublicAlwaysTrue) lintIssues.push(`${t.tableName}: service_role USING(true) — redundant policy`);
  }

  return {
    totalTables:           all.length,
    rlsEnabled:            all.filter(t => t.rlsEnabled).length,
    publicAlwaysTrue:      all.filter(t => t.hasPublicAlwaysTrue).length,
    serviceRoleAlwaysTrue: all.filter(t => t.hasAlwaysTrue && !t.hasPublicAlwaysTrue).length,
    noPolicy:              all.filter(t => t.rlsEnabled && t.policyCount === 0).length,
    tenantTableNoPolicy:   all.filter(t => t.warningFlags.includes("TENANT_TABLE_NO_POLICY")).length,
    criticalIssues,
    lintIssues,
    generatedAt:           new Date().toISOString(),
  };
}

/**
 * Historical reference: which policies were unsafe before Phase 41
 */
export function listWeakPoliciesBeforeFix(): Array<{ table: string; policy: string; severity: "CRITICAL" | "LINT"; reason: string }> {
  return [
    // CRITICAL — public role USING(true)
    { table: "ai_policies",               policy: "admin_only",                               severity: "CRITICAL", reason: "TO public USING(true): any authenticated user reads all AI policy config" },
    { table: "data_deletion_jobs",        policy: "data_deletion_jobs_admin_bypass",          severity: "CRITICAL", reason: "TO public USING(true): any authenticated user reads all deletion jobs" },
    { table: "data_retention_policies",   policy: "data_retention_policies_admin_bypass",     severity: "CRITICAL", reason: "TO public USING(true): any authenticated user reads all retention policies" },
    { table: "data_retention_rules",      policy: "data_retention_rules_admin_bypass",        severity: "CRITICAL", reason: "TO public USING(true): any authenticated user reads all retention rules" },
    { table: "legal_holds",               policy: "legal_holds_admin_bypass",                 severity: "CRITICAL", reason: "TO public USING(true): any authenticated user reads all legal holds" },
    { table: "model_allowlists",          policy: "admin_only",                               severity: "CRITICAL", reason: "TO public USING(true): any authenticated user reads AI model allowlists" },
    { table: "obs_agent_runtime_metrics", policy: "obs_agent_runtime_metrics_service_role_policy", severity: "CRITICAL", reason: "TO public USING(true): cross-tenant agent metrics visible" },
    { table: "obs_ai_latency_metrics",    policy: "obs_ai_latency_metrics_service_role_policy",    severity: "CRITICAL", reason: "TO public USING(true): cross-tenant AI latency data visible" },
    { table: "obs_retrieval_metrics",     policy: "obs_retrieval_metrics_service_role_policy",      severity: "CRITICAL", reason: "TO public USING(true): cross-tenant retrieval data visible" },
    { table: "obs_system_metrics",        policy: "obs_system_metrics_service_role_policy",         severity: "CRITICAL", reason: "TO public USING(true): platform metrics accessible by all users" },
    { table: "obs_tenant_usage_metrics",  policy: "obs_tenant_usage_metrics_service_role_policy",   severity: "CRITICAL", reason: "TO public USING(true): cross-tenant usage data visible" },
    { table: "security_events",           policy: "se_service_role_policy",                   severity: "CRITICAL", reason: "TO public USING(true): cross-tenant security events visible" },
    // LINT — service_role USING(true)
    { table: "ai_anomaly_events",         policy: "service_role_all_ai_anomaly_events",        severity: "LINT", reason: "TO service_role USING(true): redundant — service_role bypasses RLS" },
    { table: "ai_eval_cases",             policy: "ai_eval_cases_service_role_all",            severity: "LINT", reason: "TO service_role USING(true): redundant" },
    { table: "ai_eval_datasets",          policy: "ai_eval_datasets_service_role_all",         severity: "LINT", reason: "TO service_role USING(true): redundant" },
    { table: "ai_eval_regressions",       policy: "ai_eval_regressions_service_role_all",      severity: "LINT", reason: "TO service_role USING(true): redundant" },
    { table: "ai_eval_results",           policy: "ai_eval_results_service_role_all",          severity: "LINT", reason: "TO service_role USING(true): redundant" },
    { table: "ai_eval_runs",              policy: "ai_eval_runs_service_role_all",              severity: "LINT", reason: "TO service_role USING(true): redundant" },
    { table: "ai_usage_alerts",           policy: "service_role_all_ai_usage_alerts",          severity: "LINT", reason: "TO service_role USING(true): redundant" },
    { table: "gov_anomaly_events",        policy: "service_role_all_gov_anomaly_events",       severity: "LINT", reason: "TO service_role USING(true): redundant" },
    { table: "ops_ai_audit_logs",         policy: "service_role_all_ops_ai_audit_logs",        severity: "LINT", reason: "TO service_role USING(true): redundant" },
    { table: "tenant_ai_budgets",         policy: "service_role_all_tenant_ai_budgets",        severity: "LINT", reason: "TO service_role USING(true): redundant" },
    { table: "tenant_ai_usage_snapshots", policy: "service_role_all_tenant_ai_usage_snapshots", severity: "LINT", reason: "TO service_role USING(true): redundant" },
  ];
}

export async function listCurrentPoliciesAfterFix(): Promise<Array<{
  tableName:  string;
  policies:   Array<{ name: string; cmd: string; roles: string[]; using: string | null }>;
}>> {
  const all = await listAffectedTables();
  return all
    .filter(t => t.policyCount > 0)
    .map(t => ({ tableName: t.tableName, policies: t.policies }));
}
