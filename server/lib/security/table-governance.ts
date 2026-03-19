/**
 * Phase 45B — Table Access Governance
 *
 * Canonical governance registry for all 214 application tables.
 * Provides explicit access model classification, helper predicates,
 * and mismatch detection against live RLS posture.
 *
 * Access Models:
 *   tenant_scoped        — Row-level tenant isolation; tenant reads/writes own rows
 *   mixed_tenant_admin   — Tenant reads own rows; admin/service_role sees all
 *   platform_admin_only  — Platform configuration; admin/service_role only
 *   service_role_only    — Backend writes via service_role; no tenant RLS policies needed
 *   system_internal      — Infrastructure/audit; service_role only, never tenant-visible
 *   legacy_internal      — Legacy tables; no active app ownership
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type GovernanceAccessModel =
  | "tenant_scoped"
  | "mixed_tenant_admin"
  | "platform_admin_only"
  | "service_role_only"
  | "system_internal"
  | "legacy_internal";

export interface GovernanceTableMeta {
  tableName:   string;
  model:       GovernanceAccessModel;
  tenantKey:   string | null;
  description: string;
}

export interface GovernanceMismatch {
  tableName:       string;
  model:           GovernanceAccessModel;
  issue:           string;
  recommendation:  string;
  severity:        "CRITICAL" | "WARNING" | "INFO";
}

export interface GovernanceAuditReport {
  generatedAt:        string;
  totalLiveTables:    number;
  appOwnedCount:      number;
  systemInternalCount: number;
  legacyCount:        number;
  byModel:            Record<GovernanceAccessModel, number>;
  mismatches:         GovernanceMismatch[];
  unclassified:       string[];
  verdict:            "TABLE ACCESS GOVERNANCE: COMPLETE ✅" | "TABLE ACCESS GOVERNANCE: INCOMPLETE ❌";
}

// ─────────────────────────────────────────────────────────────────────────────
// Supabase internal table prefixes — these live in auth/storage/realtime schemas
// but may appear in extensions or event triggers. Not in public schema.
// ─────────────────────────────────────────────────────────────────────────────

const SUPABASE_INTERNAL_PREFIXES = [
  "pg_",
  "sql_",
  "information_schema",
  "_pgsodium",
  "vault",
  "extensions",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// Application table governance registry — all 214 public tables
// ─────────────────────────────────────────────────────────────────────────────

export const TABLE_GOVERNANCE: Record<string, GovernanceTableMeta> = {

  // ══════════════════════════════════════════════════════════════════════════
  // TENANT-SCOPED — Row-level isolation; tenant reads/writes own rows only
  // ══════════════════════════════════════════════════════════════════════════
  ai_abuse_log:                      { tableName: "ai_abuse_log",                      model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI abuse/misuse log — tenant reads own incidents" },
  ai_agent_runs:                     { tableName: "ai_agent_runs",                     model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI agent run records — tenant owns all runs" },
  ai_agents:                         { tableName: "ai_agents",                         model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI agent definitions per tenant" },
  ai_anomaly_configs:                { tableName: "ai_anomaly_configs",                model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Tenant anomaly detection configuration" },
  ai_anomaly_events:                 { tableName: "ai_anomaly_events",                 model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Tenant anomaly detection events (Phase 16)" },
  ai_billing_usage:                  { tableName: "ai_billing_usage",                  model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI billing usage records per tenant" },
  ai_cache_events:                   { tableName: "ai_cache_events",                   model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI response cache events per tenant" },
  ai_eval_cases:                     { tableName: "ai_eval_cases",                     model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI evaluation test cases" },
  ai_eval_datasets:                  { tableName: "ai_eval_datasets",                  model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI evaluation datasets" },
  ai_eval_regressions:               { tableName: "ai_eval_regressions",               model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI evaluation regression records" },
  ai_eval_results:                   { tableName: "ai_eval_results",                   model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI evaluation run results" },
  ai_eval_runs:                      { tableName: "ai_eval_runs",                      model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI evaluation run records" },
  ai_prompts:                        { tableName: "ai_prompts",                        model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI prompt definitions per tenant" },
  ai_provider_reconciliation_deltas: { tableName: "ai_provider_reconciliation_deltas", model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Per-tenant AI provider cost reconciliation deltas" },
  ai_request_state_events:           { tableName: "ai_request_state_events",           model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI request state transition events" },
  ai_request_states:                 { tableName: "ai_request_states",                 model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI request state records" },
  ai_request_step_events:            { tableName: "ai_request_step_events",            model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI request step-level events" },
  ai_request_step_states:            { tableName: "ai_request_step_states",            model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI request step states" },
  ai_requests:                       { tableName: "ai_requests",                       model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI request records — tenant reads own" },
  ai_response_cache:                 { tableName: "ai_response_cache",                 model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI response cache entries per tenant" },
  ai_runs:                           { tableName: "ai_runs",                           model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI run records per tenant" },
  ai_usage:                          { tableName: "ai_usage",                          model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI token/cost usage per tenant" },
  ai_usage_alerts:                   { tableName: "ai_usage_alerts",                   model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI usage threshold alerts (Phase 16)" },
  ai_usage_limits:                   { tableName: "ai_usage_limits",                   model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI usage limits per tenant" },
  ai_usage_metrics:                  { tableName: "ai_usage_metrics",                  model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Aggregated AI usage metrics per tenant" },
  ai_workflows:                      { tableName: "ai_workflows",                      model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI workflow definitions per tenant" },
  api_keys:                          { tableName: "api_keys",                          model: "tenant_scoped",       tenantKey: "tenant_id",       description: "API keys — tenant reads own keys" },
  architecture_profiles:             { tableName: "architecture_profiles",             model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Architecture profiles per tenant" },
  asset_storage_objects:             { tableName: "asset_storage_objects",             model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Tenant asset storage object metadata" },
  audit_events:                      { tableName: "audit_events",                      model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Audit event log — tenant reads own" },
  audit_export_runs:                 { tableName: "audit_export_runs",                 model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Audit export job records" },
  auth_invites:                      { tableName: "auth_invites",                      model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Tenant user invitations" },
  auth_login_attempts:               { tableName: "auth_login_attempts",               model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Login attempt records — tenant reads own" },
  auth_security_events:              { tableName: "auth_security_events",              model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Auth security events per tenant" },
  billing_events:                    { tableName: "billing_events",                    model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Billing events per tenant" },
  data_deletion_jobs:                { tableName: "data_deletion_jobs",                model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Tenant data deletion job status (read-only)" },
  experiments:                       { tableName: "experiments",                       model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Feature experiments per tenant" },
  gov_anomaly_events:                { tableName: "gov_anomaly_events",                model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI governance anomaly events (Phase 16)" },
  knowledge_assets:                  { tableName: "knowledge_assets",                  model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Knowledge base assets per tenant" },
  knowledge_bases:                   { tableName: "knowledge_bases",                   model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Knowledge base definitions per tenant" },
  knowledge_documents:               { tableName: "knowledge_documents",               model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Knowledge documents per tenant" },
  knowledge_retrieval_feedback:      { tableName: "knowledge_retrieval_feedback",      model: "tenant_scoped",       tenantKey: "tenant_id",       description: "User feedback on knowledge retrieval results" },
  knowledge_sources:                 { tableName: "knowledge_sources",                 model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Knowledge source connectors per tenant" },
  moderation_events:                 { tableName: "moderation_events",                 model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Content moderation events per tenant" },
  obs_agent_runtime_metrics:         { tableName: "obs_agent_runtime_metrics",         model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Agent runtime observability per tenant" },
  obs_ai_latency_metrics:            { tableName: "obs_ai_latency_metrics",            model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI latency observability per tenant" },
  obs_retrieval_metrics:             { tableName: "obs_retrieval_metrics",             model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Retrieval observability per tenant" },
  obs_tenant_usage_metrics:          { tableName: "obs_tenant_usage_metrics",          model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Tenant-level usage observability" },
  organization_members:              { tableName: "organization_members",              model: "tenant_scoped",       tenantKey: "organization_id", description: "Organization membership records" },
  organizations:                     { tableName: "organizations",                     model: "tenant_scoped",       tenantKey: "organization_id", description: "Organization (tenant) root records" },
  payment_events:                    { tableName: "payment_events",                    model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Payment events per tenant" },
  projects:                          { tableName: "projects",                          model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Project records per tenant" },
  rollout_audit_log:                 { tableName: "rollout_audit_log",                 model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Feature rollout audit log" },
  security_events:                   { tableName: "security_events",                   model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Security events — tenants read own events" },
  service_accounts:                  { tableName: "service_accounts",                  model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Service accounts per tenant" },
  storage_billing_usage:             { tableName: "storage_billing_usage",             model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Storage billing usage per tenant" },
  storage_usage:                     { tableName: "storage_usage",                     model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Current storage usage stats per tenant" },
  stripe_customers:                  { tableName: "stripe_customers",                  model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Stripe customer records" },
  stripe_invoice_links:              { tableName: "stripe_invoice_links",              model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Stripe hosted invoice links" },
  stripe_invoices:                   { tableName: "stripe_invoices",                   model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Stripe invoice records" },
  stripe_subscriptions:              { tableName: "stripe_subscriptions",              model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Stripe subscription records" },
  stripe_webhook_events:             { tableName: "stripe_webhook_events",             model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Stripe inbound webhook events" },
  tenant_ai_allowance_usage:         { tableName: "tenant_ai_allowance_usage",         model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI allowance usage tracking per tenant" },
  tenant_ai_budgets:                 { tableName: "tenant_ai_budgets",                 model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI cost budgets per tenant (Phase 16)" },
  tenant_ai_settings:                { tableName: "tenant_ai_settings",                model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Tenant-level AI configuration settings" },
  tenant_ai_usage_periods:           { tableName: "tenant_ai_usage_periods",           model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI usage period snapshots per tenant" },
  tenant_ai_usage_snapshots:         { tableName: "tenant_ai_usage_snapshots",         model: "tenant_scoped",       tenantKey: "tenant_id",       description: "AI usage snapshots per tenant (Phase 16)" },
  tenant_credit_accounts:            { tableName: "tenant_credit_accounts",            model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Tenant credit account balances" },
  tenant_credit_ledger:              { tableName: "tenant_credit_ledger",              model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Tenant credit ledger transactions" },
  tenant_deletion_requests:          { tableName: "tenant_deletion_requests",          model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Tenant account deletion requests" },
  tenant_domains:                    { tableName: "tenant_domains",                    model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Custom domains per tenant" },
  tenant_export_requests:            { tableName: "tenant_export_requests",            model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Tenant data export requests (GDPR)" },
  tenant_invitations:                { tableName: "tenant_invitations",                model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Pending tenant invitations" },
  tenant_ip_allowlists:              { tableName: "tenant_ip_allowlists",              model: "tenant_scoped",       tenantKey: "tenant_id",       description: "IP allowlist rules per tenant" },
  tenant_locales:                    { tableName: "tenant_locales",                    model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Tenant locale / i18n settings" },
  tenant_memberships:                { tableName: "tenant_memberships",                model: "tenant_scoped",       tenantKey: "tenant_id",       description: "User memberships per tenant" },
  tenant_plans:                      { tableName: "tenant_plans",                      model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Plan assignments per tenant" },
  tenant_settings:                   { tableName: "tenant_settings",                   model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Configurable settings per tenant" },
  usage_counters:                    { tableName: "usage_counters",                    model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Quota usage counters per tenant" },
  usage_threshold_events:            { tableName: "usage_threshold_events",            model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Usage threshold breach events" },
  user_locales:                      { tableName: "user_locales",                      model: "tenant_scoped",       tenantKey: "tenant_id",       description: "User locale preferences" },
  webhook_deliveries:                { tableName: "webhook_deliveries",                model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Webhook delivery attempt records" },
  webhook_endpoints:                 { tableName: "webhook_endpoints",                 model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Webhook endpoint configurations" },
  webhook_subscriptions:             { tableName: "webhook_subscriptions",             model: "tenant_scoped",       tenantKey: "tenant_id",       description: "Webhook event subscriptions" },

  // ══════════════════════════════════════════════════════════════════════════
  // MIXED — Tenant reads own rows; admin/service_role sees all
  // ══════════════════════════════════════════════════════════════════════════
  ai_customer_pricing_configs:       { tableName: "ai_customer_pricing_configs",       model: "mixed_tenant_admin",  tenantKey: "tenant_id",       description: "Customer-specific AI pricing overrides — admin configures, tenant reads own" },
  tenant_subscriptions:              { tableName: "tenant_subscriptions",              model: "mixed_tenant_admin",  tenantKey: "tenant_id",       description: "Active subscription records — admin manages, tenant reads own" },
  tenants:                           { tableName: "tenants",                           model: "mixed_tenant_admin",  tenantKey: null,              description: "Tenant root entities — admin sees all, tenant sees own record" },
  usage_quotas:                      { tableName: "usage_quotas",                      model: "mixed_tenant_admin",  tenantKey: null,              description: "Usage quota definitions — admin sets, tenant reads own allocation" },

  // ══════════════════════════════════════════════════════════════════════════
  // PLATFORM ADMIN ONLY — Platform configuration; admin/service_role only
  // ══════════════════════════════════════════════════════════════════════════
  ai_agent_versions:                 { tableName: "ai_agent_versions",                 model: "platform_admin_only", tenantKey: null,              description: "Platform AI agent version catalog" },
  ai_model_overrides:                { tableName: "ai_model_overrides",                model: "platform_admin_only", tenantKey: null,              description: "Platform-level AI model routing overrides" },
  ai_model_pricing:                  { tableName: "ai_model_pricing",                  model: "platform_admin_only", tenantKey: null,              description: "AI model pricing configuration" },
  ai_models:                         { tableName: "ai_models",                         model: "platform_admin_only", tenantKey: null,              description: "AI model catalog — platform managed" },
  ai_policies:                       { tableName: "ai_policies",                       model: "platform_admin_only", tenantKey: null,              description: "Platform AI policy configuration — admin only" },
  ai_provider_reconciliation_runs:   { tableName: "ai_provider_reconciliation_runs",   model: "platform_admin_only", tenantKey: null,              description: "Platform-level provider cost reconciliation runs" },
  billing_alerts:                    { tableName: "billing_alerts",                    model: "platform_admin_only", tenantKey: null,              description: "Platform billing alert rules" },
  billing_job_definitions:           { tableName: "billing_job_definitions",           model: "platform_admin_only", tenantKey: null,              description: "Scheduled billing job definitions" },
  billing_periods:                   { tableName: "billing_periods",                   model: "platform_admin_only", tenantKey: null,              description: "Billing period definitions" },
  customer_pricing_versions:         { tableName: "customer_pricing_versions",         model: "platform_admin_only", tenantKey: null,              description: "Versioned customer pricing plans" },
  customer_storage_pricing_versions: { tableName: "customer_storage_pricing_versions", model: "platform_admin_only", tenantKey: null,              description: "Versioned customer storage pricing" },
  data_retention_policies:           { tableName: "data_retention_policies",           model: "platform_admin_only", tenantKey: null,              description: "Platform-wide data retention policies" },
  data_retention_rules:              { tableName: "data_retention_rules",              model: "platform_admin_only", tenantKey: null,              description: "Platform-wide data retention rules" },
  feature_flags:                     { tableName: "feature_flags",                     model: "platform_admin_only", tenantKey: null,              description: "Feature flag definitions — platform managed" },
  identity_providers:                { tableName: "identity_providers",                model: "platform_admin_only", tenantKey: null,              description: "SSO/IdP configuration — platform admin only" },
  integrations:                      { tableName: "integrations",                      model: "platform_admin_only", tenantKey: null,              description: "Platform integration catalog" },
  membership_roles:                  { tableName: "membership_roles",                  model: "platform_admin_only", tenantKey: null,              description: "Membership role definitions" },
  model_allowlists:                  { tableName: "model_allowlists",                  model: "platform_admin_only", tenantKey: null,              description: "Allowed AI models — platform configuration" },
  obs_system_metrics:                { tableName: "obs_system_metrics",                model: "platform_admin_only", tenantKey: null,              description: "Platform-wide system metrics — admin only" },
  permissions:                       { tableName: "permissions",                       model: "platform_admin_only", tenantKey: null,              description: "Permission definitions — platform managed" },
  plan_entitlements:                 { tableName: "plan_entitlements",                 model: "platform_admin_only", tenantKey: null,              description: "Plan entitlement rules" },
  plan_features:                     { tableName: "plan_features",                     model: "platform_admin_only", tenantKey: null,              description: "Plan feature flags" },
  plans:                             { tableName: "plans",                             model: "platform_admin_only", tenantKey: null,              description: "Billing plan definitions" },
  provider_pricing_versions:         { tableName: "provider_pricing_versions",         model: "platform_admin_only", tenantKey: null,              description: "Versioned provider pricing data" },
  provider_reconciliation_runs:      { tableName: "provider_reconciliation_runs",      model: "platform_admin_only", tenantKey: null,              description: "Provider cost reconciliation run records" },
  roles:                             { tableName: "roles",                             model: "platform_admin_only", tenantKey: null,              description: "RBAC role definitions — platform managed" },
  storage_pricing_versions:          { tableName: "storage_pricing_versions",          model: "platform_admin_only", tenantKey: null,              description: "Versioned storage pricing configuration" },
  subscription_plans:                { tableName: "subscription_plans",                model: "platform_admin_only", tenantKey: null,              description: "Subscription plan catalog" },
  supported_currencies:              { tableName: "supported_currencies",              model: "platform_admin_only", tenantKey: null,              description: "Supported currency codes" },
  supported_languages:               { tableName: "supported_languages",               model: "platform_admin_only", tenantKey: null,              description: "Supported locale/language codes" },

  // ══════════════════════════════════════════════════════════════════════════
  // SERVICE ROLE ONLY — Backend writes only; no tenant RLS policies
  // ══════════════════════════════════════════════════════════════════════════
  ai_agent_run_logs:                 { tableName: "ai_agent_run_logs",                 model: "service_role_only",   tenantKey: null,              description: "Agent run structured logs — backend write-only" },
  ai_approvals:                      { tableName: "ai_approvals",                      model: "service_role_only",   tenantKey: null,              description: "AI workflow approvals — managed by backend" },
  ai_artifacts:                      { tableName: "ai_artifacts",                      model: "service_role_only",   tenantKey: null,              description: "AI-generated build artifacts — backend managed" },
  ai_prompt_versions:                { tableName: "ai_prompt_versions",                model: "service_role_only",   tenantKey: null,              description: "Prompt version history — backend immutable writes" },
  ai_responses:                      { tableName: "ai_responses",                      model: "service_role_only",   tenantKey: null,              description: "AI response payloads — backend write-only store" },
  ai_steps:                          { tableName: "ai_steps",                          model: "service_role_only",   tenantKey: null,              description: "AI run step records — backend internal" },
  ai_tool_calls:                     { tableName: "ai_tool_calls",                     model: "service_role_only",   tenantKey: null,              description: "AI tool call records — backend internal" },
  ai_workflow_steps:                 { tableName: "ai_workflow_steps",                 model: "service_role_only",   tenantKey: null,              description: "Workflow step execution records — backend" },
  api_key_scopes:                    { tableName: "api_key_scopes",                    model: "service_role_only",   tenantKey: null,              description: "Scope assignments linked to api_keys — backend only" },
  app_user_profiles:                 { tableName: "app_user_profiles",                 model: "service_role_only",   tenantKey: null,              description: "Application user profile data — backend managed" },
  architecture_agent_configs:        { tableName: "architecture_agent_configs",        model: "service_role_only",   tenantKey: null,              description: "Architecture-level agent configs — backend config" },
  architecture_capability_configs:   { tableName: "architecture_capability_configs",   model: "service_role_only",   tenantKey: null,              description: "Architecture capability definitions — backend config" },
  architecture_policy_bindings:      { tableName: "architecture_policy_bindings",      model: "service_role_only",   tenantKey: null,              description: "Architecture policy binding rules — backend config" },
  architecture_template_bindings:    { tableName: "architecture_template_bindings",    model: "service_role_only",   tenantKey: null,              description: "Architecture template bindings — backend config" },
  architecture_versions:             { tableName: "architecture_versions",             model: "service_role_only",   tenantKey: null,              description: "Architecture version records — backend managed" },
  artifact_dependencies:             { tableName: "artifact_dependencies",             model: "service_role_only",   tenantKey: "tenant_id",       description: "Build artifact dependency graph — backend tracked" },
  document_risk_scores:              { tableName: "document_risk_scores",              model: "service_role_only",   tenantKey: null,              description: "AI document risk scoring — backend computed" },
  document_trust_signals:            { tableName: "document_trust_signals",            model: "service_role_only",   tenantKey: null,              description: "Document trust signal records — backend computed" },
  experiment_variants:               { tableName: "experiment_variants",               model: "service_role_only",   tenantKey: null,              description: "Experiment variant definitions — linked to experiments" },
  ingestion_chunks:                  { tableName: "ingestion_chunks",                  model: "service_role_only",   tenantKey: null,              description: "Knowledge ingestion chunk records — pipeline only" },
  ingestion_documents:               { tableName: "ingestion_documents",               model: "service_role_only",   tenantKey: null,              description: "Knowledge ingestion document records — pipeline" },
  ingestion_embeddings:              { tableName: "ingestion_embeddings",              model: "service_role_only",   tenantKey: null,              description: "Knowledge ingestion embedding vectors — pipeline" },
  invoice_line_items:                { tableName: "invoice_line_items",                model: "service_role_only",   tenantKey: null,              description: "Invoice line item breakdown — backend managed" },
  invoice_payments:                  { tableName: "invoice_payments",                  model: "service_role_only",   tenantKey: null,              description: "Invoice payment records — backend managed" },
  invoices:                          { tableName: "invoices",                          model: "service_role_only",   tenantKey: null,              description: "Invoice records — backend managed via billing service" },
  knowledge_answer_citations:        { tableName: "knowledge_answer_citations",        model: "service_role_only",   tenantKey: null,              description: "Knowledge answer source citations — pipeline" },
  knowledge_answer_runs:             { tableName: "knowledge_answer_runs",             model: "service_role_only",   tenantKey: null,              description: "Knowledge answer generation run records" },
  knowledge_asset_embeddings:        { tableName: "knowledge_asset_embeddings",        model: "service_role_only",   tenantKey: null,              description: "Knowledge asset vector embeddings — pipeline" },
  knowledge_asset_versions:          { tableName: "knowledge_asset_versions",          model: "service_role_only",   tenantKey: null,              description: "Knowledge asset version history — pipeline" },
  knowledge_chunks:                  { tableName: "knowledge_chunks",                  model: "service_role_only",   tenantKey: null,              description: "Knowledge base text chunks — pipeline managed" },
  knowledge_document_versions:       { tableName: "knowledge_document_versions",       model: "service_role_only",   tenantKey: null,              description: "Knowledge document version records — pipeline" },
  knowledge_embeddings:              { tableName: "knowledge_embeddings",              model: "service_role_only",   tenantKey: null,              description: "Knowledge text embeddings — pipeline managed" },
  knowledge_index_entries:           { tableName: "knowledge_index_entries",           model: "service_role_only",   tenantKey: null,              description: "Knowledge index entry records — search pipeline" },
  knowledge_index_state:             { tableName: "knowledge_index_state",             model: "service_role_only",   tenantKey: null,              description: "Knowledge index state tracking — search pipeline" },
  knowledge_retrieval_candidates:    { tableName: "knowledge_retrieval_candidates",    model: "service_role_only",   tenantKey: null,              description: "Candidate retrieval results — pipeline" },
  knowledge_retrieval_quality_signals: { tableName: "knowledge_retrieval_quality_signals", model: "service_role_only", tenantKey: null,            description: "Retrieval quality signal records — pipeline" },
  knowledge_retrieval_runs:          { tableName: "knowledge_retrieval_runs",          model: "service_role_only",   tenantKey: null,              description: "Knowledge retrieval run records — pipeline" },
  knowledge_search_candidates:       { tableName: "knowledge_search_candidates",       model: "service_role_only",   tenantKey: null,              description: "Knowledge search candidate records — pipeline" },
  knowledge_search_runs:             { tableName: "knowledge_search_runs",             model: "service_role_only",   tenantKey: null,              description: "Knowledge search run records — pipeline" },
  knowledge_storage_objects:         { tableName: "knowledge_storage_objects",         model: "service_role_only",   tenantKey: null,              description: "Knowledge base storage object references — pipeline" },
  organization_secrets:              { tableName: "organization_secrets",              model: "service_role_only",   tenantKey: "organization_id", description: "Organization-level secrets — backend only, never tenant-readable" },
  profiles:                          { tableName: "profiles",                          model: "service_role_only",   tenantKey: null,              description: "Supabase auth user profiles — backend managed" },
  prompt_approvals:                  { tableName: "prompt_approvals",                  model: "service_role_only",   tenantKey: null,              description: "Prompt approval workflow records — backend" },
  prompt_change_log:                 { tableName: "prompt_change_log",                 model: "service_role_only",   tenantKey: null,              description: "Prompt change audit log — backend immutable" },
  prompt_policies:                   { tableName: "prompt_policies",                   model: "service_role_only",   tenantKey: null,              description: "Prompt safety/content policies — backend config" },
  prompt_policy_violations:          { tableName: "prompt_policy_violations",          model: "service_role_only",   tenantKey: null,              description: "Prompt policy violation records — backend" },
  prompt_redteam_tests:              { tableName: "prompt_redteam_tests",              model: "service_role_only",   tenantKey: null,              description: "Red team test cases for prompts — backend" },
  prompt_reviews:                    { tableName: "prompt_reviews",                    model: "service_role_only",   tenantKey: null,              description: "Prompt review records — backend approval pipeline" },
  provider_reconciliation_findings:  { tableName: "provider_reconciliation_findings",  model: "service_role_only",   tenantKey: null,              description: "Provider reconciliation finding records — backend" },
  provider_usage_snapshots:          { tableName: "provider_usage_snapshots",          model: "service_role_only",   tenantKey: null,              description: "Provider usage snapshot records — billing pipeline" },
  request_safety_events:             { tableName: "request_safety_events",             model: "service_role_only",   tenantKey: null,              description: "AI request safety scan events — backend" },
  retrieval_cache_entries:           { tableName: "retrieval_cache_entries",           model: "service_role_only",   tenantKey: null,              description: "Retrieval result cache entries — pipeline" },
  retrieval_feedback:                { tableName: "retrieval_feedback",                model: "service_role_only",   tenantKey: null,              description: "General retrieval feedback store — backend" },
  retrieval_metrics:                 { tableName: "retrieval_metrics",                 model: "service_role_only",   tenantKey: null,              description: "Retrieval performance metrics — pipeline" },
  retrieval_queries:                 { tableName: "retrieval_queries",                 model: "service_role_only",   tenantKey: null,              description: "Retrieval query records — pipeline" },
  retrieval_query_metrics:           { tableName: "retrieval_query_metrics",           model: "service_role_only",   tenantKey: null,              description: "Per-query retrieval metrics — pipeline" },
  retrieval_results:                 { tableName: "retrieval_results",                 model: "service_role_only",   tenantKey: null,              description: "Retrieval result records — pipeline" },
  role_permissions:                  { tableName: "role_permissions",                  model: "service_role_only",   tenantKey: null,              description: "RBAC role-permission assignment table — backend config" },
  tenant_files:                      { tableName: "tenant_files",                      model: "service_role_only",   tenantKey: "tenant_id",       description: "Tenant file metadata (Phase 46) — REST API only, no Supabase client" },
  tenant_rate_limits:                { tableName: "tenant_rate_limits",                model: "service_role_only",   tenantKey: "tenant_id",       description: "Rate limit rules per tenant — platform sets, backend enforces" },
  tenant_storage_allowance_usage:    { tableName: "tenant_storage_allowance_usage",    model: "service_role_only",   tenantKey: "tenant_id",       description: "Storage allowance usage tracking — backend computed" },
  feature_flag_assignments:          { tableName: "feature_flag_assignments",          model: "service_role_only",   tenantKey: null,              description: "Feature flag per-tenant/user assignments — backend managed" },

  // ══════════════════════════════════════════════════════════════════════════
  // SYSTEM INTERNAL — Infrastructure/audit tables; never tenant-visible
  // ══════════════════════════════════════════════════════════════════════════
  admin_change_events:               { tableName: "admin_change_events",               model: "system_internal",     tenantKey: null,              description: "Platform admin action audit log — backend only" },
  admin_change_requests:             { tableName: "admin_change_requests",             model: "system_internal",     tenantKey: null,              description: "Platform admin change request queue — backend only" },
  audit_event_metadata:              { tableName: "audit_event_metadata",              model: "system_internal",     tenantKey: null,              description: "Audit event extended metadata — backend only" },
  auth_email_verification_tokens:    { tableName: "auth_email_verification_tokens",    model: "system_internal",     tenantKey: null,              description: "Email verification tokens — backend only, short-lived" },
  auth_mfa_recovery_codes:           { tableName: "auth_mfa_recovery_codes",           model: "system_internal",     tenantKey: null,              description: "MFA recovery codes — backend only, never queryable by clients" },
  auth_mfa_totp:                     { tableName: "auth_mfa_totp",                     model: "system_internal",     tenantKey: null,              description: "TOTP secrets — backend only, encrypted at rest" },
  auth_password_reset_tokens:        { tableName: "auth_password_reset_tokens",        model: "system_internal",     tenantKey: null,              description: "Password reset tokens — backend only, short-lived" },
  auth_sessions:                     { tableName: "auth_sessions",                     model: "system_internal",     tenantKey: "tenant_id",       description: "Auth session records — backend written only" },
  billing_audit_findings:            { tableName: "billing_audit_findings",            model: "system_internal",     tenantKey: "tenant_id",       description: "Billing audit findings — internal audit system" },
  billing_audit_runs:                { tableName: "billing_audit_runs",                model: "system_internal",     tenantKey: null,              description: "Billing audit run records — internal audit system" },
  billing_job_runs:                  { tableName: "billing_job_runs",                  model: "system_internal",     tenantKey: null,              description: "Billing job execution records — backend scheduler" },
  billing_metrics_snapshots:         { tableName: "billing_metrics_snapshots",         model: "system_internal",     tenantKey: null,              description: "Platform billing metrics snapshots — internal" },
  billing_period_tenant_snapshots:   { tableName: "billing_period_tenant_snapshots",   model: "system_internal",     tenantKey: null,              description: "Per-period tenant billing snapshots — internal" },
  billing_recovery_actions:          { tableName: "billing_recovery_actions",          model: "system_internal",     tenantKey: null,              description: "Billing recovery action records — internal" },
  billing_recovery_runs:             { tableName: "billing_recovery_runs",             model: "system_internal",     tenantKey: null,              description: "Billing recovery run records — internal" },
  feature_resolution_events:         { tableName: "feature_resolution_events",         model: "system_internal",     tenantKey: null,              description: "Feature flag resolution event log — internal" },
  job_attempts:                      { tableName: "job_attempts",                      model: "system_internal",     tenantKey: null,              description: "Background job attempt records — internal job queue" },
  job_runs:                          { tableName: "job_runs",                          model: "system_internal",     tenantKey: null,              description: "Background job run records — internal job queue" },
  job_schedules:                     { tableName: "job_schedules",                     model: "system_internal",     tenantKey: null,              description: "Scheduled job definitions — internal cron system" },
  jobs:                              { tableName: "jobs",                              model: "system_internal",     tenantKey: null,              description: "Background job definitions — internal job queue" },
  knowledge_asset_processing_jobs:   { tableName: "knowledge_asset_processing_jobs",   model: "system_internal",     tenantKey: null,              description: "Knowledge asset processing job records — pipeline" },
  knowledge_processing_jobs:         { tableName: "knowledge_processing_jobs",         model: "system_internal",     tenantKey: null,              description: "Knowledge processing job queue — pipeline" },
  legal_holds:                       { tableName: "legal_holds",                       model: "system_internal",     tenantKey: null,              description: "Compliance legal holds — backend only, immutable" },
  margin_tracking_runs:              { tableName: "margin_tracking_runs",              model: "system_internal",     tenantKey: null,              description: "Revenue margin tracking run records — internal" },
  margin_tracking_snapshots:         { tableName: "margin_tracking_snapshots",         model: "system_internal",     tenantKey: null,              description: "Revenue margin snapshots — internal analytics" },
  mfa_recovery_codes:                { tableName: "mfa_recovery_codes",                model: "system_internal",     tenantKey: null,              description: "MFA recovery codes (legacy) — backend only" },
  ops_ai_audit_logs:                 { tableName: "ops_ai_audit_logs",                 model: "system_internal",     tenantKey: null,              description: "Platform AI ops audit log — backend only" },
  service_account_keys:              { tableName: "service_account_keys",              model: "system_internal",     tenantKey: null,              description: "Service account credential store — backend only" },
  session_revocations:               { tableName: "session_revocations",               model: "system_internal",     tenantKey: null,              description: "Session revocation list — backend only" },
  session_tokens:                    { tableName: "session_tokens",                    model: "system_internal",     tenantKey: null,              description: "Session token store — backend only" },
  tenant_status_history:             { tableName: "tenant_status_history",             model: "system_internal",     tenantKey: "tenant_id",       description: "Tenant lifecycle status changes — internal audit" },
  tenant_subscription_events:        { tableName: "tenant_subscription_events",        model: "system_internal",     tenantKey: "tenant_id",       description: "Subscription lifecycle events — internal audit" },
  user_mfa_methods:                  { tableName: "user_mfa_methods",                  model: "system_internal",     tenantKey: null,              description: "User MFA method registrations — backend only" },
  user_sessions:                     { tableName: "user_sessions",                     model: "system_internal",     tenantKey: null,              description: "User session records — backend managed" },
};

// ─────────────────────────────────────────────────────────────────────────────
// Helper predicates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns true for any table belonging to Supabase's own internal schemas.
 * All Supabase-internal tables live in auth.*, storage.*, realtime.* etc.
 * In the public schema there are zero Supabase-internal tables.
 */
export function isSupabaseInternalTable(tableName: string): boolean {
  return SUPABASE_INTERNAL_PREFIXES.some(prefix => tableName.startsWith(prefix));
}

/**
 * Returns true for tables intentionally classified as legacy_internal.
 * None exist in this platform currently — all tables are actively owned.
 */
export function isLegacyTable(tableName: string): boolean {
  const meta = TABLE_GOVERNANCE[tableName];
  return meta?.model === "legacy_internal";
}

/**
 * Returns true for all tables in the TABLE_GOVERNANCE registry
 * that are not Supabase-internal and not legacy.
 */
export function isApplicationOwnedTable(tableName: string): boolean {
  if (isSupabaseInternalTable(tableName)) return false;
  if (isLegacyTable(tableName)) return false;
  return tableName in TABLE_GOVERNANCE;
}

/** Returns governance metadata for a table, or null if unclassified. */
export function getGovernanceMeta(tableName: string): GovernanceTableMeta | null {
  return TABLE_GOVERNANCE[tableName] ?? null;
}

/** Counts tables by access model. */
export function countByModel(): Record<GovernanceAccessModel, number> {
  const counts: Record<GovernanceAccessModel, number> = {
    tenant_scoped:       0,
    mixed_tenant_admin:  0,
    platform_admin_only: 0,
    service_role_only:   0,
    system_internal:     0,
    legacy_internal:     0,
  };
  for (const meta of Object.values(TABLE_GOVERNANCE)) {
    counts[meta.model]++;
  }
  return counts;
}

/** Returns all tables classified under a given model. */
export function getTablesByModel(model: GovernanceAccessModel): GovernanceTableMeta[] {
  return Object.values(TABLE_GOVERNANCE).filter(m => m.model === model);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mismatch detection — governance model vs actual RLS posture
// ─────────────────────────────────────────────────────────────────────────────

export interface LiveRlsRow {
  tableName:           string;
  rlsEnabled:          boolean;
  policyCount:         number;
  hasPublicAlwaysTrue: boolean;
  hasAlwaysTrue:       boolean;
  tenantCols:          string[];
}

export function detectGovernanceMismatches(liveRows: LiveRlsRow[]): GovernanceMismatch[] {
  const mismatches: GovernanceMismatch[] = [];

  for (const row of liveRows) {
    const meta = TABLE_GOVERNANCE[row.tableName];
    if (!meta) continue;

    const { model } = meta;

    // CRITICAL: any public USING(true) is wrong for all governance models
    if (row.hasPublicAlwaysTrue) {
      mismatches.push({
        tableName:      row.tableName,
        model,
        issue:          "PUBLIC USING(true) policy detected — cross-tenant data exposure",
        recommendation: "Drop public USING(true) policy immediately and replace with scoped policy",
        severity:       "CRITICAL",
      });
    }

    // tenant_scoped must not have 0 policies when tenant key is present
    if (model === "tenant_scoped" && row.tenantCols.length > 0 && row.policyCount === 0) {
      mismatches.push({
        tableName:      row.tableName,
        model,
        issue:          "tenant_scoped table has tenant key but 0 RLS policies — relies solely on service_role",
        recommendation: "Verify backend-only access path is intentional; add explicit RLS policy or reclassify as service_role_only",
        severity:       "WARNING",
      });
    }

    // platform_admin_only / service_role_only / system_internal must NOT have public-accessible policies
    if (
      ["platform_admin_only", "service_role_only", "system_internal"].includes(model) &&
      row.hasPublicAlwaysTrue
    ) {
      mismatches.push({
        tableName:      row.tableName,
        model,
        issue:          `${model} table has public-accessible policy — governance model violated`,
        recommendation: "Restrict to service_role or admin role only; drop authenticated/public USING(true)",
        severity:       "CRITICAL",
      });
    }

    // RLS must be enabled for all app tables
    if (!row.rlsEnabled) {
      mismatches.push({
        tableName:      row.tableName,
        model,
        issue:          "RLS is DISABLED — all authenticated users can query this table",
        recommendation: "Enable RLS immediately: ALTER TABLE ... ENABLE ROW LEVEL SECURITY",
        severity:       "CRITICAL",
      });
    }
  }

  return mismatches;
}
