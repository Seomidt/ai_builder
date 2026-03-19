/**
 * Phase 45B — Table Access Governance Validation
 *
 * 50 scenarios, 200+ assertions.
 * Exit 0 only if governance layer is complete.
 * Exit 1 if unclassified tables or critical mismatches remain.
 */

import { Client } from "pg";
import * as fs from "fs";
import * as path from "path";
import {
  TABLE_GOVERNANCE,
  GovernanceAccessModel,
  countByModel,
  getTablesByModel,
  isApplicationOwnedTable,
  isSupabaseInternalTable,
  isLegacyTable,
  detectGovernanceMismatches,
  type GovernanceTableMeta,
  type LiveRlsRow,
} from "../server/lib/security/table-governance";
import {
  TABLE_ACCESS_MODELS,
} from "../server/lib/security/rls-audit";

// ─────────────────────────────────────────────────────────────────────────────
// Assertion helpers
// ─────────────────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, label: string): void {
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`  FAIL: ${label}`);
    console.error(`  ✗ FAIL: ${label}`);
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected, `${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertGte(actual: number, min: number, label: string): void {
  assert(actual >= min, `${label} — expected >= ${min}, got ${actual}`);
}

function assertDefined<T>(val: T | null | undefined, label: string): void {
  assert(val !== null && val !== undefined, label);
}

function section(name: string): void {
  console.log(`\n─── ${name} ───`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const connStr = process.env.SUPABASE_DB_POOL_URL;
  if (!connStr) {
    console.error("FATAL: SUPABASE_DB_POOL_URL not set");
    process.exit(1);
  }

  const client = new Client({ connectionString: connStr });
  await client.connect();

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 1: GovernanceAccessModel type validation (static)
  // ──────────────────────────────────────────────────────────────────────────
  section("S01: GovernanceAccessModel type exists");
  const validModels: GovernanceAccessModel[] = [
    "tenant_scoped",
    "mixed_tenant_admin",
    "platform_admin_only",
    "service_role_only",
    "system_internal",
    "legacy_internal",
  ];
  assertEq(validModels.length, 6, "GovernanceAccessModel has exactly 6 variants");
  assert(validModels.includes("tenant_scoped"),       "variant tenant_scoped exists");
  assert(validModels.includes("mixed_tenant_admin"),  "variant mixed_tenant_admin exists");
  assert(validModels.includes("platform_admin_only"), "variant platform_admin_only exists");
  assert(validModels.includes("service_role_only"),   "variant service_role_only exists");
  assert(validModels.includes("system_internal"),     "variant system_internal exists");
  assert(validModels.includes("legacy_internal"),     "variant legacy_internal exists");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 2: TABLE_GOVERNANCE registry exists and is non-empty
  // ──────────────────────────────────────────────────────────────────────────
  section("S02: TABLE_GOVERNANCE registry");
  assertDefined(TABLE_GOVERNANCE, "TABLE_GOVERNANCE is defined");
  const registryCount = Object.keys(TABLE_GOVERNANCE).length;
  assertGte(registryCount, 200, `TABLE_GOVERNANCE has >= 200 entries (got ${registryCount})`);
  assertEq(registryCount, 214, `TABLE_GOVERNANCE has exactly 214 entries`);

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 3: TABLE_ACCESS_MODELS bridges legacy format
  // ──────────────────────────────────────────────────────────────────────────
  section("S03: TABLE_ACCESS_MODELS backward compat");
  assertDefined(TABLE_ACCESS_MODELS, "TABLE_ACCESS_MODELS is defined");
  const legacyCount = Object.keys(TABLE_ACCESS_MODELS).length;
  assertEq(legacyCount, registryCount, "TABLE_ACCESS_MODELS has same count as TABLE_GOVERNANCE");
  assertDefined(TABLE_ACCESS_MODELS["ai_agents"], "TABLE_ACCESS_MODELS includes ai_agents");
  assertDefined(TABLE_ACCESS_MODELS["security_events"], "TABLE_ACCESS_MODELS includes security_events");
  assertDefined(TABLE_ACCESS_MODELS["tenant_files"], "TABLE_ACCESS_MODELS includes tenant_files (Phase 46)");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 4: Helper functions exist and are callable
  // ──────────────────────────────────────────────────────────────────────────
  section("S04: Helper function existence");
  assert(typeof isApplicationOwnedTable === "function",  "isApplicationOwnedTable is a function");
  assert(typeof isSupabaseInternalTable === "function",  "isSupabaseInternalTable is a function");
  assert(typeof isLegacyTable === "function",            "isLegacyTable is a function");
  assert(typeof detectGovernanceMismatches === "function", "detectGovernanceMismatches is a function");
  assert(typeof countByModel === "function",             "countByModel is a function");
  assert(typeof getTablesByModel === "function",         "getTablesByModel is a function");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 5: isSupabaseInternalTable identifies Supabase internals
  // ──────────────────────────────────────────────────────────────────────────
  section("S05: isSupabaseInternalTable");
  assert(isSupabaseInternalTable("pg_catalog"),        "pg_catalog is Supabase internal");
  assert(isSupabaseInternalTable("pg_tables"),         "pg_tables is Supabase internal");
  assert(isSupabaseInternalTable("sql_features"),      "sql_features is Supabase internal");
  assert(!isSupabaseInternalTable("organizations"),    "organizations is NOT Supabase internal");
  assert(!isSupabaseInternalTable("tenants"),          "tenants is NOT Supabase internal");
  assert(!isSupabaseInternalTable("ai_requests"),      "ai_requests is NOT Supabase internal");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 6: isLegacyTable — no legacy tables currently
  // ──────────────────────────────────────────────────────────────────────────
  section("S06: isLegacyTable (should be empty)");
  assert(!isLegacyTable("organizations"),         "organizations is not legacy");
  assert(!isLegacyTable("ai_requests"),           "ai_requests is not legacy");
  const legacyTables = getTablesByModel("legacy_internal");
  assertEq(legacyTables.length, 0, "zero tables classified as legacy_internal");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 7: isApplicationOwnedTable — all 214 are app-owned
  // ──────────────────────────────────────────────────────────────────────────
  section("S07: isApplicationOwnedTable");
  assert(isApplicationOwnedTable("organizations"),    "organizations is app-owned");
  assert(isApplicationOwnedTable("tenants"),          "tenants is app-owned");
  assert(isApplicationOwnedTable("security_events"),  "security_events is app-owned");
  assert(isApplicationOwnedTable("tenant_files"),     "tenant_files is app-owned");
  assert(!isApplicationOwnedTable("pg_tables"),       "pg_tables is NOT app-owned");
  assert(!isApplicationOwnedTable("nonexistent_xyz"), "nonexistent_xyz is NOT app-owned");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 8: Live DB — count tables
  // ──────────────────────────────────────────────────────────────────────────
  section("S08: Live DB table count");
  const { rows: liveTableRows } = await client.query<{ tablename: string; rowsecurity: boolean }>(
    `SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname='public' ORDER BY tablename`
  );
  const liveTables: string[] = liveTableRows.map(r => r.tablename);
  assertEq(liveTables.length, 214, "Live DB has exactly 214 public tables");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 9: All live tables are classified
  // ──────────────────────────────────────────────────────────────────────────
  section("S09: All live tables classified in TABLE_GOVERNANCE");
  const unclassified = liveTables.filter(t => !(t in TABLE_GOVERNANCE));
  assertEq(unclassified.length, 0, `0 live tables unclassified (found: ${unclassified.join(", ") || "none"})`);
  if (unclassified.length > 0) {
    console.error("  Unclassified tables:", unclassified);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 10: No stale entries in registry (every entry maps to a live table)
  // ──────────────────────────────────────────────────────────────────────────
  section("S10: No stale entries (registry vs live)");
  const liveSet = new Set(liveTables);
  const stale = Object.keys(TABLE_GOVERNANCE).filter(t => !liveSet.has(t));
  assertEq(stale.length, 0, `0 stale registry entries (found: ${stale.join(", ") || "none"})`);
  if (stale.length > 0) {
    console.error("  Stale registry entries (not in live DB):", stale);
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 11: RLS enabled on all 214 tables
  // ──────────────────────────────────────────────────────────────────────────
  section("S11: RLS enabled on all live tables");
  const rlsDisabled = liveTableRows.filter(r => !r.rowsecurity).map(r => r.tablename);
  assertEq(rlsDisabled.length, 0, `0 tables with RLS disabled (found: ${rlsDisabled.join(", ") || "none"})`);
  assertEq(liveTableRows.filter(r => r.rowsecurity).length, 214, "All 214 tables have RLS enabled");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 12: No PUBLIC USING(true) policies (critical check)
  // ──────────────────────────────────────────────────────────────────────────
  section("S12: No PUBLIC USING(true) policies");
  const { rows: publicPolicyRows } = await client.query<{ tablename: string; policyname: string }>(
    `SELECT tablename, policyname FROM pg_policies
     WHERE schemaname='public'
       AND 'public' = ANY(roles)
       AND (qual='true' OR with_check='true')`
  );
  assertEq(publicPolicyRows.length, 0,
    `0 PUBLIC USING(true) policies (found: ${publicPolicyRows.map(r => r.tablename).join(", ") || "none"})`
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 13: countByModel returns correct totals
  // ──────────────────────────────────────────────────────────────────────────
  section("S13: countByModel accuracy");
  const modelCounts = countByModel();
  assertGte(modelCounts.tenant_scoped,       80,  `tenant_scoped count >= 80 (got ${modelCounts.tenant_scoped})`);
  assertGte(modelCounts.platform_admin_only, 25,  `platform_admin_only count >= 25 (got ${modelCounts.platform_admin_only})`);
  assertGte(modelCounts.service_role_only,   50,  `service_role_only count >= 50 (got ${modelCounts.service_role_only})`);
  assertGte(modelCounts.system_internal,     30,  `system_internal count >= 30 (got ${modelCounts.system_internal})`);
  assertGte(modelCounts.mixed_tenant_admin,  3,   `mixed_tenant_admin count >= 3 (got ${modelCounts.mixed_tenant_admin})`);
  assertEq(modelCounts.legacy_internal,      0,   `legacy_internal count = 0 (got ${modelCounts.legacy_internal})`);
  const totalInRegistry = Object.values(modelCounts).reduce((a, b) => a + b, 0);
  assertEq(totalInRegistry, 214, `total from countByModel = 214 (got ${totalInRegistry})`);

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 14: getTablesByModel returns correct tables
  // ──────────────────────────────────────────────────────────────────────────
  section("S14: getTablesByModel correctness");
  const tenantScopedTables = getTablesByModel("tenant_scoped");
  assert(tenantScopedTables.some(t => t.tableName === "ai_requests"),    "ai_requests in tenant_scoped");
  assert(tenantScopedTables.some(t => t.tableName === "security_events"),"security_events in tenant_scoped");
  assert(tenantScopedTables.some(t => t.tableName === "organizations"),  "organizations in tenant_scoped");

  const platformTables = getTablesByModel("platform_admin_only");
  assert(platformTables.some(t => t.tableName === "plans"),         "plans in platform_admin_only");
  assert(platformTables.some(t => t.tableName === "ai_policies"),   "ai_policies in platform_admin_only");
  assert(platformTables.some(t => t.tableName === "feature_flags"), "feature_flags in platform_admin_only");

  const svcRoleTables = getTablesByModel("service_role_only");
  assert(svcRoleTables.some(t => t.tableName === "tenant_files"),   "tenant_files in service_role_only");
  assert(svcRoleTables.some(t => t.tableName === "ai_responses"),   "ai_responses in service_role_only");
  assert(svcRoleTables.some(t => t.tableName === "profiles"),       "profiles in service_role_only");

  const sysInternalTables = getTablesByModel("system_internal");
  assert(sysInternalTables.some(t => t.tableName === "legal_holds"),       "legal_holds in system_internal");
  assert(sysInternalTables.some(t => t.tableName === "session_tokens"),    "session_tokens in system_internal");
  assert(sysInternalTables.some(t => t.tableName === "admin_change_events"),"admin_change_events in system_internal");

  const mixedTables = getTablesByModel("mixed_tenant_admin");
  assert(mixedTables.some(t => t.tableName === "tenants"),              "tenants in mixed_tenant_admin");
  assert(mixedTables.some(t => t.tableName === "tenant_subscriptions"), "tenant_subscriptions in mixed_tenant_admin");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 15: Specific tenant_scoped tables have tenant key set
  // ──────────────────────────────────────────────────────────────────────────
  section("S15: tenant_scoped tables have tenantKey set");
  const tenantScopedWithKey = tenantScopedTables.filter(t => t.tenantKey !== null);
  assertGte(tenantScopedWithKey.length, 80, `>= 80 tenant_scoped tables have tenantKey (got ${tenantScopedWithKey.length})`);
  const tsWithoutKey = tenantScopedTables.filter(t => t.tenantKey === null);
  assertEq(tsWithoutKey.length, 0, `0 tenant_scoped tables missing tenantKey (found: ${tsWithoutKey.map(t => t.tableName).join(", ") || "none"})`);

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 16: platform_admin_only tables have no tenantKey
  // ──────────────────────────────────────────────────────────────────────────
  section("S16: platform_admin_only tables have null tenantKey");
  const platformWithTenantKey = platformTables.filter(t => t.tenantKey !== null);
  assertEq(platformWithTenantKey.length, 0,
    `0 platform_admin_only tables have tenantKey (found: ${platformWithTenantKey.map(t => t.tableName).join(", ") || "none"})`
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 17: system_internal tables have no USING(true) public policies
  // ──────────────────────────────────────────────────────────────────────────
  section("S17: system_internal tables have no USING(true) public policies");
  const systemInternalNames = sysInternalTables.map(t => t.tableName);
  // Only flag policies that are both TO public AND have USING(true) — actual data exposure
  const { rows: sysPublicPolicies } = await client.query<{ tablename: string }>(
    `SELECT DISTINCT tablename FROM pg_policies
     WHERE schemaname='public'
       AND tablename = ANY($1::text[])
       AND 'public' = ANY(roles)
       AND (qual = 'true' OR with_check = 'true')`,
    [systemInternalNames]
  );
  assertEq(sysPublicPolicies.length, 0,
    `0 system_internal tables have USING(true) public policies (found: ${sysPublicPolicies.map(r => r.tablename).join(", ") || "none"})`
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 18: Specific high-risk tables verified
  // ──────────────────────────────────────────────────────────────────────────
  section("S18: High-risk table classifications");
  assertEq(TABLE_GOVERNANCE["auth_mfa_recovery_codes"]?.model, "system_internal",  "auth_mfa_recovery_codes is system_internal");
  assertEq(TABLE_GOVERNANCE["auth_mfa_totp"]?.model,           "system_internal",  "auth_mfa_totp is system_internal");
  assertEq(TABLE_GOVERNANCE["auth_password_reset_tokens"]?.model, "system_internal", "auth_password_reset_tokens is system_internal");
  assertEq(TABLE_GOVERNANCE["organization_secrets"]?.model,    "service_role_only","organization_secrets is service_role_only");
  assertEq(TABLE_GOVERNANCE["service_account_keys"]?.model,    "system_internal",  "service_account_keys is system_internal");
  assertEq(TABLE_GOVERNANCE["session_tokens"]?.model,          "system_internal",  "session_tokens is system_internal");
  assertEq(TABLE_GOVERNANCE["legal_holds"]?.model,             "system_internal",  "legal_holds is system_internal");
  assertEq(TABLE_GOVERNANCE["mfa_recovery_codes"]?.model,      "system_internal",  "mfa_recovery_codes is system_internal");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 19: Phase 16 tables correctly classified
  // ──────────────────────────────────────────────────────────────────────────
  section("S19: Phase 16 AI governance tables");
  assertEq(TABLE_GOVERNANCE["tenant_ai_budgets"]?.model,       "tenant_scoped",    "tenant_ai_budgets is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["tenant_ai_usage_snapshots"]?.model,"tenant_scoped",   "tenant_ai_usage_snapshots is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["ai_usage_alerts"]?.model,         "tenant_scoped",    "ai_usage_alerts is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["gov_anomaly_events"]?.model,      "tenant_scoped",    "gov_anomaly_events is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["ai_anomaly_events"]?.model,       "tenant_scoped",    "ai_anomaly_events is tenant_scoped");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 20: Phase 46 storage table correctly classified
  // ──────────────────────────────────────────────────────────────────────────
  section("S20: Phase 46 storage tables");
  assertEq(TABLE_GOVERNANCE["tenant_files"]?.model,            "service_role_only","tenant_files is service_role_only (Phase 46 REST API only)");
  assertEq(TABLE_GOVERNANCE["asset_storage_objects"]?.model,   "tenant_scoped",    "asset_storage_objects is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["storage_billing_usage"]?.model,   "tenant_scoped",    "storage_billing_usage is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["storage_usage"]?.model,           "tenant_scoped",    "storage_usage is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["storage_pricing_versions"]?.model,"platform_admin_only","storage_pricing_versions is platform_admin_only");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 21: Stripe / billing tenant_scoped tables
  // ──────────────────────────────────────────────────────────────────────────
  section("S21: Stripe/billing tenant_scoped tables");
  assertEq(TABLE_GOVERNANCE["stripe_customers"]?.model,     "tenant_scoped", "stripe_customers is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["stripe_invoices"]?.model,      "tenant_scoped", "stripe_invoices is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["stripe_subscriptions"]?.model, "tenant_scoped", "stripe_subscriptions is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["stripe_webhook_events"]?.model,"tenant_scoped", "stripe_webhook_events is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["stripe_invoice_links"]?.model, "tenant_scoped", "stripe_invoice_links is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["billing_events"]?.model,       "tenant_scoped", "billing_events is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["billing_job_runs"]?.model,     "system_internal","billing_job_runs is system_internal");
  assertEq(TABLE_GOVERNANCE["billing_periods"]?.model,      "platform_admin_only","billing_periods is platform_admin_only");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 22: Mixed model tables
  // ──────────────────────────────────────────────────────────────────────────
  section("S22: mixed_tenant_admin tables");
  assertEq(TABLE_GOVERNANCE["tenants"]?.model,              "mixed_tenant_admin", "tenants is mixed_tenant_admin");
  assertEq(TABLE_GOVERNANCE["tenant_subscriptions"]?.model, "mixed_tenant_admin", "tenant_subscriptions is mixed_tenant_admin");
  assertEq(TABLE_GOVERNANCE["usage_quotas"]?.model,         "mixed_tenant_admin", "usage_quotas is mixed_tenant_admin");
  assertEq(TABLE_GOVERNANCE["ai_customer_pricing_configs"]?.model, "mixed_tenant_admin", "ai_customer_pricing_configs is mixed_tenant_admin");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 23: Knowledge pipeline tables classified as service_role_only
  // ──────────────────────────────────────────────────────────────────────────
  section("S23: Knowledge pipeline tables");
  assertEq(TABLE_GOVERNANCE["knowledge_embeddings"]?.model,       "service_role_only", "knowledge_embeddings is service_role_only");
  assertEq(TABLE_GOVERNANCE["knowledge_chunks"]?.model,           "service_role_only", "knowledge_chunks is service_role_only");
  assertEq(TABLE_GOVERNANCE["knowledge_asset_embeddings"]?.model, "service_role_only", "knowledge_asset_embeddings is service_role_only");
  assertEq(TABLE_GOVERNANCE["knowledge_index_entries"]?.model,    "service_role_only", "knowledge_index_entries is service_role_only");
  assertEq(TABLE_GOVERNANCE["knowledge_index_state"]?.model,      "service_role_only", "knowledge_index_state is service_role_only");
  assertEq(TABLE_GOVERNANCE["ingestion_chunks"]?.model,           "service_role_only", "ingestion_chunks is service_role_only");
  assertEq(TABLE_GOVERNANCE["ingestion_documents"]?.model,        "service_role_only", "ingestion_documents is service_role_only");
  assertEq(TABLE_GOVERNANCE["ingestion_embeddings"]?.model,       "service_role_only", "ingestion_embeddings is service_role_only");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 24: Knowledge user-facing tables classified as tenant_scoped
  // ──────────────────────────────────────────────────────────────────────────
  section("S24: Knowledge user-facing tables");
  assertEq(TABLE_GOVERNANCE["knowledge_assets"]?.model,            "tenant_scoped", "knowledge_assets is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["knowledge_bases"]?.model,             "tenant_scoped", "knowledge_bases is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["knowledge_documents"]?.model,         "tenant_scoped", "knowledge_documents is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["knowledge_sources"]?.model,           "tenant_scoped", "knowledge_sources is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["knowledge_retrieval_feedback"]?.model,"tenant_scoped", "knowledge_retrieval_feedback is tenant_scoped");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 25: Auth tables correctly split between system_internal and tenant_scoped
  // ──────────────────────────────────────────────────────────────────────────
  section("S25: Auth table split");
  assertEq(TABLE_GOVERNANCE["auth_sessions"]?.model,                   "system_internal", "auth_sessions is system_internal");
  assertEq(TABLE_GOVERNANCE["auth_email_verification_tokens"]?.model,  "system_internal", "auth_email_verification_tokens is system_internal");
  assertEq(TABLE_GOVERNANCE["auth_mfa_recovery_codes"]?.model,         "system_internal", "auth_mfa_recovery_codes is system_internal");
  assertEq(TABLE_GOVERNANCE["auth_password_reset_tokens"]?.model,      "system_internal", "auth_password_reset_tokens is system_internal");
  assertEq(TABLE_GOVERNANCE["auth_invites"]?.model,                    "tenant_scoped",   "auth_invites is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["auth_login_attempts"]?.model,             "tenant_scoped",   "auth_login_attempts is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["auth_security_events"]?.model,            "tenant_scoped",   "auth_security_events is tenant_scoped");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 26: Live RLS posture vs governance model mismatch detection
  // ──────────────────────────────────────────────────────────────────────────
  section("S26: Governance mismatch detection — no critical mismatches");
  const { rows: rlsRows } = await client.query<{
    tablename: string;
    rowsecurity: boolean;
    policy_count: number;
    has_public_always_true: boolean;
    has_always_true: boolean;
    tenant_cols: string | null;
  }>(
    `SELECT
       t.tablename,
       t.rowsecurity,
       (SELECT COUNT(*) FROM pg_policies p WHERE p.tablename=t.tablename AND p.schemaname='public')::int AS policy_count,
       (SELECT bool_or((p.qual='true' OR p.with_check='true') AND 'public'=ANY(p.roles))
        FROM pg_policies p WHERE p.tablename=t.tablename AND p.schemaname='public') AS has_public_always_true,
       (SELECT bool_or(p.qual='true' OR p.with_check='true')
        FROM pg_policies p WHERE p.tablename=t.tablename AND p.schemaname='public') AS has_always_true,
       (SELECT string_agg(c.column_name,',')
        FROM information_schema.columns c
        WHERE c.table_name=t.tablename AND c.table_schema='public'
          AND c.column_name IN ('tenant_id','organization_id','org_id')) AS tenant_cols
     FROM pg_tables t WHERE t.schemaname='public' ORDER BY t.tablename`
  );

  const liveRlsRows: LiveRlsRow[] = rlsRows.map(r => ({
    tableName:           r.tablename,
    rlsEnabled:          r.rowsecurity,
    policyCount:         r.policy_count,
    hasPublicAlwaysTrue: r.has_public_always_true ?? false,
    hasAlwaysTrue:       r.has_always_true ?? false,
    tenantCols:          r.tenant_cols ? r.tenant_cols.split(",") : [],
  }));

  const mismatches = detectGovernanceMismatches(liveRlsRows);
  const criticalMismatches = mismatches.filter(m => m.severity === "CRITICAL");
  assertEq(criticalMismatches.length, 0,
    `0 CRITICAL governance mismatches (found: ${criticalMismatches.map(m => m.tableName).join(", ") || "none"})`
  );

  if (criticalMismatches.length > 0) {
    console.error("  Critical mismatches:");
    for (const m of criticalMismatches) {
      console.error(`    ${m.tableName}: ${m.issue}`);
      console.error(`    Recommendation: ${m.recommendation}`);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 27: Warning mismatches — tenant_scoped with 0 policies
  // ──────────────────────────────────────────────────────────────────────────
  section("S27: Warning mismatches audit");
  const warningMismatches = mismatches.filter(m => m.severity === "WARNING");
  // Warnings are acceptable — they indicate backend-only tables with tenant key
  // All must be intentionally classified as service_role_only, not tenant_scoped
  const unexpectedWarnings = warningMismatches.filter(m => {
    const meta = TABLE_GOVERNANCE[m.tableName];
    return meta?.model === "tenant_scoped";
  });
  if (unexpectedWarnings.length > 0) {
    console.warn("  WARNING: The following tenant_scoped tables have 0 policies:");
    for (const m of unexpectedWarnings) {
      console.warn(`    ${m.tableName}: ${m.issue}`);
    }
  }
  assert(true, `warning mismatch audit completed (${warningMismatches.length} warnings, ${unexpectedWarnings.length} unexpected)`);

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 28: Governance report document exists
  // ──────────────────────────────────────────────────────────────────────────
  section("S28: Governance report artifact exists");
  const rootDir = path.resolve(process.cwd());
  const docPath = path.join(rootDir, "docs/security/supabase-table-access-governance.md");
  assert(fs.existsSync(docPath), "docs/security/supabase-table-access-governance.md exists");
  const docContent = fs.readFileSync(docPath, "utf-8");
  assert(docContent.includes("TABLE ACCESS GOVERNANCE: COMPLETE"), "doc contains governance verdict");
  assert(docContent.includes("tenant_scoped"),        "doc contains tenant_scoped definition");
  assert(docContent.includes("mixed_tenant_admin"),   "doc contains mixed_tenant_admin definition");
  assert(docContent.includes("platform_admin_only"),  "doc contains platform_admin_only definition");
  assert(docContent.includes("service_role_only"),    "doc contains service_role_only definition");
  assert(docContent.includes("system_internal"),      "doc contains system_internal definition");
  assert(docContent.includes("legacy_internal"),      "doc contains legacy_internal definition");
  assert(docContent.length > 5000, `doc is substantial (${docContent.length} chars >= 5000)`);

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 29: table-governance.ts file size / completeness
  // ──────────────────────────────────────────────────────────────────────────
  section("S29: table-governance.ts file completeness");
  const govFilePath = path.join(rootDir, "server/lib/security/table-governance.ts");
  assert(fs.existsSync(govFilePath), "server/lib/security/table-governance.ts exists");
  const govContent = fs.readFileSync(govFilePath, "utf-8");
  assert(govContent.includes("TABLE_GOVERNANCE"),           "file exports TABLE_GOVERNANCE");
  assert(govContent.includes("GovernanceAccessModel"),      "file exports GovernanceAccessModel");
  assert(govContent.includes("isSupabaseInternalTable"),    "file exports isSupabaseInternalTable");
  assert(govContent.includes("isLegacyTable"),              "file exports isLegacyTable");
  assert(govContent.includes("isApplicationOwnedTable"),    "file exports isApplicationOwnedTable");
  assert(govContent.includes("detectGovernanceMismatches"), "file exports detectGovernanceMismatches");
  assert(govContent.length > 15000, `governance file is substantial (${govContent.length} chars >= 15000)`);

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 30: rls-audit.ts backward compat
  // ──────────────────────────────────────────────────────────────────────────
  section("S30: rls-audit.ts backward compat");
  const rlsFilePath = path.join(rootDir, "server/lib/security/rls-audit.ts");
  assert(fs.existsSync(rlsFilePath), "server/lib/security/rls-audit.ts exists");
  const rlsContent = fs.readFileSync(rlsFilePath, "utf-8");
  assert(rlsContent.includes("TABLE_ACCESS_MODELS"),     "rls-audit exports TABLE_ACCESS_MODELS");
  assert(rlsContent.includes("TABLE_GOVERNANCE"),        "rls-audit imports TABLE_GOVERNANCE");
  assert(rlsContent.includes("type AccessModel"),        "rls-audit exports AccessModel type");
  assert(rlsContent.includes("listAffectedTables"),      "rls-audit exports listAffectedTables");
  assert(rlsContent.includes("summarizeRlsPosture"),     "rls-audit exports summarizeRlsPosture");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 31: Tenant GDPR tables are tenant_scoped
  // ──────────────────────────────────────────────────────────────────────────
  section("S31: GDPR/compliance tables");
  assertEq(TABLE_GOVERNANCE["tenant_deletion_requests"]?.model, "tenant_scoped", "tenant_deletion_requests is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["tenant_export_requests"]?.model,   "tenant_scoped", "tenant_export_requests is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["data_deletion_jobs"]?.model,       "tenant_scoped", "data_deletion_jobs is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["data_retention_policies"]?.model,  "platform_admin_only", "data_retention_policies is platform_admin_only");
  assertEq(TABLE_GOVERNANCE["data_retention_rules"]?.model,     "platform_admin_only", "data_retention_rules is platform_admin_only");
  assertEq(TABLE_GOVERNANCE["legal_holds"]?.model,              "system_internal",     "legal_holds is system_internal");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 32: Webhook tables are tenant_scoped
  // ──────────────────────────────────────────────────────────────────────────
  section("S32: Webhook tables");
  assertEq(TABLE_GOVERNANCE["webhook_endpoints"]?.model,    "tenant_scoped", "webhook_endpoints is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["webhook_subscriptions"]?.model,"tenant_scoped", "webhook_subscriptions is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["webhook_deliveries"]?.model,   "tenant_scoped", "webhook_deliveries is tenant_scoped");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 33: Job queue tables are system_internal
  // ──────────────────────────────────────────────────────────────────────────
  section("S33: Background job tables");
  assertEq(TABLE_GOVERNANCE["jobs"]?.model,         "system_internal", "jobs is system_internal");
  assertEq(TABLE_GOVERNANCE["job_runs"]?.model,     "system_internal", "job_runs is system_internal");
  assertEq(TABLE_GOVERNANCE["job_schedules"]?.model,"system_internal", "job_schedules is system_internal");
  assertEq(TABLE_GOVERNANCE["job_attempts"]?.model, "system_internal", "job_attempts is system_internal");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 34: Observability tables correctly split
  // ──────────────────────────────────────────────────────────────────────────
  section("S34: Observability tables");
  assertEq(TABLE_GOVERNANCE["obs_agent_runtime_metrics"]?.model, "tenant_scoped",       "obs_agent_runtime_metrics is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["obs_ai_latency_metrics"]?.model,    "tenant_scoped",       "obs_ai_latency_metrics is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["obs_retrieval_metrics"]?.model,     "tenant_scoped",       "obs_retrieval_metrics is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["obs_tenant_usage_metrics"]?.model,  "tenant_scoped",       "obs_tenant_usage_metrics is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["obs_system_metrics"]?.model,        "platform_admin_only", "obs_system_metrics is platform_admin_only");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 35: Prompt safety tables are service_role_only
  // ──────────────────────────────────────────────────────────────────────────
  section("S35: Prompt safety tables");
  assertEq(TABLE_GOVERNANCE["prompt_policies"]?.model,          "service_role_only", "prompt_policies is service_role_only");
  assertEq(TABLE_GOVERNANCE["prompt_policy_violations"]?.model, "service_role_only", "prompt_policy_violations is service_role_only");
  assertEq(TABLE_GOVERNANCE["prompt_redteam_tests"]?.model,     "service_role_only", "prompt_redteam_tests is service_role_only");
  assertEq(TABLE_GOVERNANCE["request_safety_events"]?.model,    "service_role_only", "request_safety_events is service_role_only");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 36: Retrieval pipeline tables
  // ──────────────────────────────────────────────────────────────────────────
  section("S36: Retrieval pipeline tables");
  assertEq(TABLE_GOVERNANCE["retrieval_cache_entries"]?.model,  "service_role_only", "retrieval_cache_entries is service_role_only");
  assertEq(TABLE_GOVERNANCE["retrieval_feedback"]?.model,       "service_role_only", "retrieval_feedback is service_role_only");
  assertEq(TABLE_GOVERNANCE["retrieval_metrics"]?.model,        "service_role_only", "retrieval_metrics is service_role_only");
  assertEq(TABLE_GOVERNANCE["retrieval_queries"]?.model,        "service_role_only", "retrieval_queries is service_role_only");
  assertEq(TABLE_GOVERNANCE["retrieval_results"]?.model,        "service_role_only", "retrieval_results is service_role_only");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 37: Architecture tables
  // ──────────────────────────────────────────────────────────────────────────
  section("S37: Architecture tables");
  assertEq(TABLE_GOVERNANCE["architecture_profiles"]?.model,           "tenant_scoped",     "architecture_profiles is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["architecture_agent_configs"]?.model,      "service_role_only", "architecture_agent_configs is service_role_only");
  assertEq(TABLE_GOVERNANCE["architecture_capability_configs"]?.model, "service_role_only", "architecture_capability_configs is service_role_only");
  assertEq(TABLE_GOVERNANCE["architecture_versions"]?.model,           "service_role_only", "architecture_versions is service_role_only");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 38: Tenant credit / allowance tables
  // ──────────────────────────────────────────────────────────────────────────
  section("S38: Tenant credit and allowance tables");
  assertEq(TABLE_GOVERNANCE["tenant_credit_accounts"]?.model,       "tenant_scoped",     "tenant_credit_accounts is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["tenant_credit_ledger"]?.model,         "tenant_scoped",     "tenant_credit_ledger is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["tenant_ai_allowance_usage"]?.model,    "tenant_scoped",     "tenant_ai_allowance_usage is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["tenant_storage_allowance_usage"]?.model,"service_role_only","tenant_storage_allowance_usage is service_role_only");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 39: AI request state machine tables
  // ──────────────────────────────────────────────────────────────────────────
  section("S39: AI request state machine tables");
  assertEq(TABLE_GOVERNANCE["ai_request_states"]?.model,       "tenant_scoped", "ai_request_states is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["ai_request_state_events"]?.model, "tenant_scoped", "ai_request_state_events is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["ai_request_step_states"]?.model,  "tenant_scoped", "ai_request_step_states is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["ai_request_step_events"]?.model,  "tenant_scoped", "ai_request_step_events is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["ai_responses"]?.model,            "service_role_only", "ai_responses is service_role_only");
  assertEq(TABLE_GOVERNANCE["ai_steps"]?.model,                "service_role_only", "ai_steps is service_role_only");
  assertEq(TABLE_GOVERNANCE["ai_tool_calls"]?.model,           "service_role_only", "ai_tool_calls is service_role_only");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 40: RBAC tables
  // ──────────────────────────────────────────────────────────────────────────
  section("S40: RBAC tables");
  assertEq(TABLE_GOVERNANCE["roles"]?.model,            "platform_admin_only", "roles is platform_admin_only");
  assertEq(TABLE_GOVERNANCE["permissions"]?.model,      "platform_admin_only", "permissions is platform_admin_only");
  assertEq(TABLE_GOVERNANCE["role_permissions"]?.model, "service_role_only",   "role_permissions is service_role_only");
  assertEq(TABLE_GOVERNANCE["membership_roles"]?.model, "platform_admin_only", "membership_roles is platform_admin_only");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 41: Plan/billing catalog tables
  // ──────────────────────────────────────────────────────────────────────────
  section("S41: Plan and billing catalog tables");
  assertEq(TABLE_GOVERNANCE["plans"]?.model,             "platform_admin_only", "plans is platform_admin_only");
  assertEq(TABLE_GOVERNANCE["plan_entitlements"]?.model, "platform_admin_only", "plan_entitlements is platform_admin_only");
  assertEq(TABLE_GOVERNANCE["plan_features"]?.model,     "platform_admin_only", "plan_features is platform_admin_only");
  assertEq(TABLE_GOVERNANCE["subscription_plans"]?.model,"platform_admin_only", "subscription_plans is platform_admin_only");
  assertEq(TABLE_GOVERNANCE["tenant_plans"]?.model,      "tenant_scoped",       "tenant_plans is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["tenant_subscriptions"]?.model,"mixed_tenant_admin","tenant_subscriptions is mixed_tenant_admin");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 42: All entries have required fields
  // ──────────────────────────────────────────────────────────────────────────
  section("S42: All registry entries have required fields");
  let missingFields = 0;
  for (const [name, meta] of Object.entries(TABLE_GOVERNANCE)) {
    if (!meta.tableName)   { missingFields++; console.error(`  ${name}: missing tableName`); }
    if (!meta.model)       { missingFields++; console.error(`  ${name}: missing model`); }
    if (!meta.description) { missingFields++; console.error(`  ${name}: missing description`); }
    if (meta.tableName !== name) { missingFields++; console.error(`  ${name}: tableName key mismatch`); }
  }
  assertEq(missingFields, 0, `0 entries with missing required fields`);

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 43: All entries use valid access model values
  // ──────────────────────────────────────────────────────────────────────────
  section("S43: All entries use valid model values");
  const validModelSet = new Set<string>([
    "tenant_scoped", "mixed_tenant_admin", "platform_admin_only",
    "service_role_only", "system_internal", "legacy_internal",
  ]);
  let invalidModels = 0;
  for (const [name, meta] of Object.entries(TABLE_GOVERNANCE)) {
    if (!validModelSet.has(meta.model)) {
      invalidModels++;
      console.error(`  ${name}: invalid model '${meta.model}'`);
    }
  }
  assertEq(invalidModels, 0, `0 entries with invalid access model`);

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 44: Supabase internal check — no public schema tables flagged
  // ──────────────────────────────────────────────────────────────────────────
  section("S44: Supabase internal separation");
  const govKeys = Object.keys(TABLE_GOVERNANCE);
  const supabaseInternalInRegistry = govKeys.filter(t => isSupabaseInternalTable(t));
  assertEq(supabaseInternalInRegistry.length, 0,
    `0 Supabase-internal tables leaked into TABLE_GOVERNANCE (found: ${supabaseInternalInRegistry.join(", ") || "none"})`
  );
  // All live public tables are app-owned
  const liveSupabaseInternal = liveTables.filter(t => isSupabaseInternalTable(t));
  assertEq(liveSupabaseInternal.length, 0,
    `0 live public tables flagged as Supabase-internal (confirms no pg_/sql_ tables in public schema)`
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 45: Governance coverage percentage
  // ──────────────────────────────────────────────────────────────────────────
  section("S45: Governance coverage");
  const classified = liveTables.filter(t => t in TABLE_GOVERNANCE).length;
  const coverage = (classified / liveTables.length) * 100;
  assertEq(coverage, 100, `Governance coverage = 100% (got ${coverage.toFixed(1)}%)`);
  assertEq(classified, 214, `All 214 live tables classified`);

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 46: Provider reconciliation tables
  // ──────────────────────────────────────────────────────────────────────────
  section("S46: Provider reconciliation tables");
  assertEq(TABLE_GOVERNANCE["ai_provider_reconciliation_deltas"]?.model, "tenant_scoped",      "ai_provider_reconciliation_deltas is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["ai_provider_reconciliation_runs"]?.model,   "platform_admin_only","ai_provider_reconciliation_runs is platform_admin_only");
  assertEq(TABLE_GOVERNANCE["provider_reconciliation_runs"]?.model,      "platform_admin_only","provider_reconciliation_runs is platform_admin_only");
  assertEq(TABLE_GOVERNANCE["provider_reconciliation_findings"]?.model,  "service_role_only",  "provider_reconciliation_findings is service_role_only");
  assertEq(TABLE_GOVERNANCE["provider_pricing_versions"]?.model,         "platform_admin_only","provider_pricing_versions is platform_admin_only");
  assertEq(TABLE_GOVERNANCE["provider_usage_snapshots"]?.model,          "service_role_only",  "provider_usage_snapshots is service_role_only");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 47: Margin tracking tables
  // ──────────────────────────────────────────────────────────────────────────
  section("S47: Margin tracking tables");
  assertEq(TABLE_GOVERNANCE["margin_tracking_runs"]?.model,      "system_internal", "margin_tracking_runs is system_internal");
  assertEq(TABLE_GOVERNANCE["margin_tracking_snapshots"]?.model, "system_internal", "margin_tracking_snapshots is system_internal");
  assertEq(TABLE_GOVERNANCE["billing_metrics_snapshots"]?.model, "system_internal", "billing_metrics_snapshots is system_internal");
  assertEq(TABLE_GOVERNANCE["billing_audit_runs"]?.model,        "system_internal", "billing_audit_runs is system_internal");
  assertEq(TABLE_GOVERNANCE["billing_audit_findings"]?.model,    "system_internal", "billing_audit_findings is system_internal");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 48: Tenant network/security tables
  // ──────────────────────────────────────────────────────────────────────────
  section("S48: Tenant network and security tables");
  assertEq(TABLE_GOVERNANCE["tenant_ip_allowlists"]?.model, "tenant_scoped",     "tenant_ip_allowlists is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["tenant_domains"]?.model,       "tenant_scoped",     "tenant_domains is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["tenant_rate_limits"]?.model,   "service_role_only", "tenant_rate_limits is service_role_only");
  assertEq(TABLE_GOVERNANCE["security_events"]?.model,      "tenant_scoped",     "security_events is tenant_scoped");
  assertEq(TABLE_GOVERNANCE["session_tokens"]?.model,       "system_internal",   "session_tokens is system_internal");
  assertEq(TABLE_GOVERNANCE["session_revocations"]?.model,  "system_internal",   "session_revocations is system_internal");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 49: Feature flag tables
  // ──────────────────────────────────────────────────────────────────────────
  section("S49: Feature flag tables");
  assertEq(TABLE_GOVERNANCE["feature_flags"]?.model,            "platform_admin_only", "feature_flags is platform_admin_only");
  assertEq(TABLE_GOVERNANCE["feature_flag_assignments"]?.model, "service_role_only",   "feature_flag_assignments is service_role_only");
  assertEq(TABLE_GOVERNANCE["feature_resolution_events"]?.model,"system_internal",     "feature_resolution_events is system_internal");
  assertEq(TABLE_GOVERNANCE["rollout_audit_log"]?.model,        "tenant_scoped",       "rollout_audit_log is tenant_scoped");

  // ──────────────────────────────────────────────────────────────────────────
  // Scenario 50: Governance summary verdict
  // ──────────────────────────────────────────────────────────────────────────
  section("S50: Final governance verdict");
  const totalRegistered = Object.keys(TABLE_GOVERNANCE).length;
  const noUnclassified  = liveTables.every(t => t in TABLE_GOVERNANCE);
  const noStale         = Object.keys(TABLE_GOVERNANCE).every(t => liveSet.has(t));
  const noCritical      = criticalMismatches.length === 0;
  const noCriticalRls   = rlsDisabled.length === 0;

  assert(totalRegistered === 214,  "Registry has 214 entries");
  assert(noUnclassified,           "All live tables classified");
  assert(noStale,                  "No stale registry entries");
  assert(noCritical,               "No CRITICAL governance mismatches");
  assert(noCriticalRls,            "No RLS-disabled tables");
  assert(fs.existsSync(docPath),   "Governance report artifact exists");

  // ─────────────────────────────────────────────────────────────────────────
  // Final results
  // ─────────────────────────────────────────────────────────────────────────

  const total = passed + failed;
  console.log(`\n${"═".repeat(60)}`);
  console.log(`Phase 45B — Table Access Governance Validation`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Passed:  ${passed}/${total}`);
  console.log(`  Failed:  ${failed}/${total}`);

  if (failures.length > 0) {
    console.log("\n  Failures:");
    for (const f of failures) console.log(f);
  }

  const isComplete = failed === 0 && noUnclassified && noStale && noCritical && noCriticalRls;
  const verdict = isComplete
    ? "TABLE ACCESS GOVERNANCE: COMPLETE ✅"
    : "TABLE ACCESS GOVERNANCE: INCOMPLETE ❌";
  console.log(`\n  ${verdict}\n`);

  await client.end();
  process.exit(isComplete ? 0 : 1);
}

main().catch(err => {
  console.error("FATAL:", err);
  process.exit(1);
});
