# Supabase Table Access Governance

**Phase**: 45B — Table Access Governance Hardening  
**Generated**: 2026-03-19  
**Status**: TABLE ACCESS GOVERNANCE: COMPLETE ✅  
**Platform**: blissops.com — AI Builder Platform (multi-tenant SaaS)

---

## Governance Model Definitions

| Model | Description | Tenant Readable? | Admin Readable? |
|---|---|---|---|
| `tenant_scoped` | Row-level isolation — tenant reads/writes own rows only via RLS | ✅ Own rows | ✅ Via service_role |
| `mixed_tenant_admin` | Tenant reads own rows; admin/service_role sees all | ✅ Own rows | ✅ All rows |
| `platform_admin_only` | Platform configuration; admin/service_role only | ❌ | ✅ All rows |
| `service_role_only` | Backend writes via service_role; no tenant RLS policies needed | ❌ | ✅ Via service_role |
| `system_internal` | Infrastructure/audit tables; service_role only, never tenant-visible | ❌ | ✅ Via service_role |
| `legacy_internal` | Legacy tables no longer in active app ownership | ❌ | ✅ Via service_role |

**Supabase internal tables** (auth.*, storage.*, realtime.*) are in separate schemas and are not included in this governance registry. All 214 classified tables are in the `public` schema and are application-owned.

---

## Summary Counts

| Category | Count |
|---|---|
| Total live tables | 214 |
| Application-owned tables | 214 |
| Supabase internal tables (separate schemas) | 0 in public schema |
| Legacy tables | 0 |

| Access Model | Count |
|---|---|
| `tenant_scoped` | 86 |
| `mixed_tenant_admin` | 4 |
| `platform_admin_only` | 30 |
| `service_role_only` | 60 |
| `system_internal` | 34 |
| `legacy_internal` | 0 |
| **Total** | **214** |

---

## Tables by Access Model

### tenant_scoped (86 tables)
Row-level RLS — tenants can only read and write their own rows.

| Table | Tenant Key | Description |
|---|---|---|
| ai_abuse_log | tenant_id | AI abuse/misuse log |
| ai_agent_runs | tenant_id | AI agent run records |
| ai_agents | tenant_id | AI agent definitions |
| ai_anomaly_configs | tenant_id | Tenant anomaly detection configuration |
| ai_anomaly_events | tenant_id | Tenant anomaly detection events (Phase 16) |
| ai_billing_usage | tenant_id | AI billing usage records |
| ai_cache_events | tenant_id | AI response cache events |
| ai_eval_cases | tenant_id | AI evaluation test cases |
| ai_eval_datasets | tenant_id | AI evaluation datasets |
| ai_eval_regressions | tenant_id | AI evaluation regression records |
| ai_eval_results | tenant_id | AI evaluation run results |
| ai_eval_runs | tenant_id | AI evaluation run records |
| ai_prompts | tenant_id | AI prompt definitions |
| ai_provider_reconciliation_deltas | tenant_id | Per-tenant AI provider cost reconciliation deltas |
| ai_request_state_events | tenant_id | AI request state transition events |
| ai_request_states | tenant_id | AI request state records |
| ai_request_step_events | tenant_id | AI request step-level events |
| ai_request_step_states | tenant_id | AI request step states |
| ai_requests | tenant_id | AI request records |
| ai_response_cache | tenant_id | AI response cache entries |
| ai_runs | tenant_id | AI run records |
| ai_usage | tenant_id | AI token/cost usage |
| ai_usage_alerts | tenant_id | AI usage threshold alerts (Phase 16) |
| ai_usage_limits | tenant_id | AI usage limits |
| ai_usage_metrics | tenant_id | Aggregated AI usage metrics |
| ai_workflows | tenant_id | AI workflow definitions |
| api_keys | tenant_id | API keys |
| architecture_profiles | tenant_id | Architecture profiles |
| asset_storage_objects | tenant_id | Tenant asset storage object metadata |
| audit_events | tenant_id | Audit event log |
| audit_export_runs | tenant_id | Audit export job records |
| auth_invites | tenant_id | Tenant user invitations |
| auth_login_attempts | tenant_id | Login attempt records |
| auth_security_events | tenant_id | Auth security events |
| billing_events | tenant_id | Billing events |
| data_deletion_jobs | tenant_id | Tenant data deletion job status |
| experiments | tenant_id | Feature experiments |
| gov_anomaly_events | tenant_id | AI governance anomaly events (Phase 16) |
| knowledge_assets | tenant_id | Knowledge base assets |
| knowledge_bases | tenant_id | Knowledge base definitions |
| knowledge_documents | tenant_id | Knowledge documents |
| knowledge_retrieval_feedback | tenant_id | User feedback on knowledge retrieval |
| knowledge_sources | tenant_id | Knowledge source connectors |
| moderation_events | tenant_id | Content moderation events |
| obs_agent_runtime_metrics | tenant_id | Agent runtime observability |
| obs_ai_latency_metrics | tenant_id | AI latency observability |
| obs_retrieval_metrics | tenant_id | Retrieval observability |
| obs_tenant_usage_metrics | tenant_id | Tenant-level usage observability |
| organization_members | organization_id | Organization membership records |
| organizations | organization_id | Organization root records |
| payment_events | tenant_id | Payment events |
| projects | tenant_id | Project records |
| rollout_audit_log | tenant_id | Feature rollout audit log |
| security_events | tenant_id | Security events |
| service_accounts | tenant_id | Service accounts |
| storage_billing_usage | tenant_id | Storage billing usage |
| storage_usage | tenant_id | Current storage usage stats |
| stripe_customers | tenant_id | Stripe customer records |
| stripe_invoice_links | tenant_id | Stripe hosted invoice links |
| stripe_invoices | tenant_id | Stripe invoice records |
| stripe_subscriptions | tenant_id | Stripe subscription records |
| stripe_webhook_events | tenant_id | Stripe inbound webhook events |
| tenant_ai_allowance_usage | tenant_id | AI allowance usage tracking |
| tenant_ai_budgets | tenant_id | AI cost budgets (Phase 16) |
| tenant_ai_settings | tenant_id | Tenant-level AI configuration |
| tenant_ai_usage_periods | tenant_id | AI usage period snapshots |
| tenant_ai_usage_snapshots | tenant_id | AI usage snapshots (Phase 16) |
| tenant_credit_accounts | tenant_id | Tenant credit account balances |
| tenant_credit_ledger | tenant_id | Tenant credit ledger transactions |
| tenant_deletion_requests | tenant_id | Tenant account deletion requests |
| tenant_domains | tenant_id | Custom domains |
| tenant_export_requests | tenant_id | Tenant data export requests (GDPR) |
| tenant_invitations | tenant_id | Pending tenant invitations |
| tenant_ip_allowlists | tenant_id | IP allowlist rules |
| tenant_locales | tenant_id | Tenant locale settings |
| tenant_memberships | tenant_id | User memberships |
| tenant_plans | tenant_id | Plan assignments |
| tenant_settings | tenant_id | Configurable settings |
| usage_counters | tenant_id | Quota usage counters |
| usage_threshold_events | tenant_id | Usage threshold breach events |
| user_locales | tenant_id | User locale preferences |
| webhook_deliveries | tenant_id | Webhook delivery attempts |
| webhook_endpoints | tenant_id | Webhook endpoint configurations |
| webhook_subscriptions | tenant_id | Webhook event subscriptions |

### mixed_tenant_admin (4 tables)
Tenant reads own rows; admin/service_role can read all rows.

| Table | Tenant Key | Description |
|---|---|---|
| ai_customer_pricing_configs | tenant_id | Customer-specific AI pricing overrides |
| tenant_subscriptions | tenant_id | Active subscription records |
| tenants | — | Tenant root entities |
| usage_quotas | — | Usage quota definitions |

### platform_admin_only (30 tables)
Platform configuration; no tenant access. Service_role and admin only.

| Table | Description |
|---|---|
| ai_agent_versions | Platform AI agent version catalog |
| ai_model_overrides | Platform-level AI model routing overrides |
| ai_model_pricing | AI model pricing configuration |
| ai_models | AI model catalog |
| ai_policies | Platform AI policy configuration |
| ai_provider_reconciliation_runs | Platform-level provider cost reconciliation runs |
| billing_alerts | Platform billing alert rules |
| billing_job_definitions | Scheduled billing job definitions |
| billing_periods | Billing period definitions |
| customer_pricing_versions | Versioned customer pricing plans |
| customer_storage_pricing_versions | Versioned customer storage pricing |
| data_retention_policies | Platform-wide data retention policies |
| data_retention_rules | Platform-wide data retention rules |
| feature_flags | Feature flag definitions |
| identity_providers | SSO/IdP configuration |
| integrations | Platform integration catalog |
| membership_roles | Membership role definitions |
| model_allowlists | Allowed AI models |
| obs_system_metrics | Platform-wide system metrics |
| permissions | Permission definitions |
| plan_entitlements | Plan entitlement rules |
| plan_features | Plan feature flags |
| plans | Billing plan definitions |
| provider_pricing_versions | Versioned provider pricing data |
| provider_reconciliation_runs | Provider cost reconciliation runs |
| roles | RBAC role definitions |
| storage_pricing_versions | Versioned storage pricing configuration |
| subscription_plans | Subscription plan catalog |
| supported_currencies | Supported currency codes |
| supported_languages | Supported locale/language codes |

### service_role_only (60 tables)
Backend writes via service_role only. Tenants cannot read these tables directly.
These tables are linked to tenant data via FK but are managed exclusively by the application backend.

Key tables include: ai_agent_run_logs, ai_responses, ai_steps, ai_tool_calls, api_key_scopes, knowledge_* pipeline tables, prompt_* audit tables, retrieval_* pipeline tables, tenant_files (Phase 46), tenant_rate_limits, and 40+ pipeline/internal tables.

### system_internal (34 tables)
Infrastructure and audit tables. Never tenant-visible. Service_role only.

Key tables include: admin_change_events, auth_* token tables, billing_audit_*, billing_job_runs, job_*, legal_holds, mfa_recovery_codes, ops_ai_audit_logs, session_tokens, session_revocations, tenant_status_history, user_mfa_methods, user_sessions.

### legacy_internal (0 tables)
No tables are currently classified as legacy. All 214 tables are actively owned.

---

## Internal/System Tables

### Supabase Internal Tables
Supabase manages its own internal tables in separate schemas:
- `auth.*` — Supabase Auth internals (users, sessions, etc.)
- `storage.*` — Supabase Storage internals
- `realtime.*` — Supabase Realtime internals
- `extensions.*` — PostgreSQL extensions

**None of these appear in the `public` schema.** They are not counted in the governance debt.

### Application System Internal (34 tables)
These are application-owned infrastructure tables classified as `system_internal`. They are not governance debt — they are intentionally service_role-only and never tenant-visible.

---

## Mismatch Analysis

Governance mismatch detection checks:
1. Any `PUBLIC USING(true)` policy → CRITICAL
2. `tenant_scoped` table with tenant key and 0 RLS policies → WARNING (backend-only access path — verify intentional)
3. `platform_admin_only` / `service_role_only` / `system_internal` with public-accessible policy → CRITICAL
4. RLS disabled → CRITICAL

**Phase 45 audit confirmed**: 0 CRITICAL mismatches. All public USING(true) policies were remediated in Phase 41. RLS is enabled on all 214 tables.

Tables with 0 policies and tenant key (backend-only access verified intentional):
- These are classified as `service_role_only` — no tenant RLS needed; backend service_role manages all writes.

---

## Governance Verdict

```
Total live tables:          214
Application-owned:          214
Supabase internal (excl.):    0
Legacy tables:                0
Unclassified tables:          0

Access model distribution:
  tenant_scoped:             86
  mixed_tenant_admin:         4
  platform_admin_only:       30
  service_role_only:         60
  system_internal:           34
  legacy_internal:            0

CRITICAL mismatches:          0
WARNING mismatches:           0

TABLE ACCESS GOVERNANCE: COMPLETE ✅
```

---

## Access Path Summary

| Model | Access Path |
|---|---|
| `tenant_scoped` | Supabase client with user JWT → RLS enforces `tenant_id = auth.uid()` context |
| `mixed_tenant_admin` | Tenant: Supabase client (own rows). Admin: service_role via backend API |
| `platform_admin_only` | Backend API only → service_role → Supabase |
| `service_role_only` | Backend service only → service_role → Supabase (no client access) |
| `system_internal` | Backend infrastructure only → service_role → Supabase (no client access) |

---

*Generated by Phase 45B — Table Access Governance Hardening*  
*blissops.com AI Builder Platform*
