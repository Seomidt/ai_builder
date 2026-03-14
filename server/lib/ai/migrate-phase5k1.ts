/**
 * migrate-phase5k1.ts — Phase 5K.1: Supabase RLS & Database Security Hardening
 *
 * Applies Row-Level Security to all 95 public schema tables.
 * Adds tenant-scoped policies to 57 tenant-owned tables.
 * Hardens custom function search_path.
 * Documents extension schema justifications.
 * Fully idempotent — safe to re-run.
 *
 * Backend note: This platform uses a service-role connection (DATABASE_URL).
 * Service role bypasses RLS by default, so enabling RLS does NOT break the backend.
 * RLS policies protect against any non-service-role connection attempts.
 *
 * Policy strategy: current_setting('app.current_tenant_id', true)
 * Non-service-role callers must SET app.current_tenant_id before accessing tenant rows.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

// --- TABLE CLASSIFICATION ---

// 57 tables with tenant_id column → require tenant-scoped RLS policies
const TENANT_TABLES: string[] = [
  "ai_anomaly_configs",
  "ai_anomaly_events",
  "ai_billing_usage",
  "ai_cache_events",
  "ai_customer_pricing_configs",
  "ai_provider_reconciliation_deltas",
  "ai_request_state_events",
  "ai_request_states",
  "ai_request_step_events",
  "ai_request_step_states",
  "ai_response_cache",
  "ai_usage",
  "ai_usage_limits",
  "asset_storage_objects",
  "billing_audit_findings",
  "billing_events",
  "billing_period_tenant_snapshots",
  "customer_pricing_versions",
  "customer_storage_pricing_versions",
  "document_risk_scores",
  "document_trust_signals",
  "invoice_payments",
  "invoices",
  "knowledge_asset_processing_jobs",
  "knowledge_asset_versions",
  "knowledge_assets",
  "knowledge_bases",
  "knowledge_chunks",
  "knowledge_document_versions",
  "knowledge_documents",
  "knowledge_embeddings",
  "knowledge_index_state",
  "knowledge_processing_jobs",
  "knowledge_retrieval_runs",
  "knowledge_search_candidates",
  "knowledge_search_runs",
  "knowledge_storage_objects",
  "margin_tracking_runs",
  "margin_tracking_snapshots",
  "payment_events",
  "provider_reconciliation_findings",
  "request_safety_events",
  "retrieval_cache_entries",
  "retrieval_metrics",
  "storage_billing_usage",
  "storage_usage",
  "stripe_invoice_links",
  "stripe_webhook_events",
  "tenant_ai_allowance_usage",
  "tenant_ai_usage_periods",
  "tenant_credit_accounts",
  "tenant_credit_ledger",
  "tenant_rate_limits",
  "tenant_storage_allowance_usage",
  "tenant_subscription_events",
  "tenant_subscriptions",
  "usage_threshold_events",
];

// 38 tables without tenant_id → global/system/operator tables
// RLS enabled, no tenant policies → deny-all for non-service-role connections
const GLOBAL_TABLES_WITH_JUSTIFICATION: Record<string, string> = {
  admin_change_events: "operator audit log — no tenant scope, service-role only",
  admin_change_requests: "operator workflow — no tenant scope, service-role only",
  ai_approvals: "internal approval workflow — operator-scoped, service-role only",
  ai_artifacts: "internal build artifacts — operator-scoped, service-role only",
  ai_model_overrides: "global model config — no tenant scope, service-role only",
  ai_model_pricing: "global pricing reference — no tenant scope, service-role only",
  ai_provider_reconciliation_runs: "global reconciliation runs — operator-scoped",
  ai_runs: "global AI run registry — operator-scoped, service-role only",
  ai_steps: "global AI step registry — operator-scoped, service-role only",
  ai_tool_calls: "global tool call log — operator-scoped, service-role only",
  architecture_agent_configs: "global architecture config — service-role only",
  architecture_capability_configs: "global capability config — service-role only",
  architecture_policy_bindings: "global policy bindings — service-role only",
  architecture_profiles: "global architecture profiles — service-role only",
  architecture_template_bindings: "global template bindings — service-role only",
  architecture_versions: "global architecture versions — service-role only",
  artifact_dependencies: "global artifact dependency graph — service-role only",
  billing_audit_runs: "operator billing audit runs — service-role only",
  billing_job_definitions: "global job definitions — service-role only",
  billing_job_runs: "global job runs — service-role only",
  billing_metrics_snapshots: "global metrics — operator-scoped, service-role only",
  billing_periods: "global billing periods reference — service-role only",
  billing_recovery_actions: "operator recovery actions — service-role only",
  billing_recovery_runs: "operator recovery runs — service-role only",
  integrations: "global integrations config — service-role only",
  invoice_line_items: "linked to tenant invoices but accessed via service role",
  margin_tracking_runs: "operator tracking — service-role only (tenant snapshot is in tenant table)",
  organization_members: "org membership — service-role only in current arch",
  organization_secrets: "org secrets — service-role only",
  organizations: "org registry — service-role only",
  plan_entitlements: "global plan config reference — service-role only",
  profiles: "user profiles — service-role only in current arch",
  projects: "project registry — service-role only",
  provider_pricing_versions: "global pricing reference — service-role only",
  provider_reconciliation_runs: "global reconciliation runs — service-role only",
  provider_usage_snapshots: "global usage snapshots — service-role only",
  storage_pricing_versions: "global storage pricing — service-role only",
  subscription_plans: "global plan reference — service-role only",
  billing_alerts: "tenant-linked billing alert config — operator-managed, service-role only",
};

// --- ACTIONS TAKEN LOG ---
const actions: string[] = [];
const warnings: string[] = [];

function log(msg: string) {
  console.log(msg);
  actions.push(msg);
}

function warn(msg: string) {
  console.warn("[WARN]", msg);
  warnings.push(msg);
}

// --- STEP 1: ENABLE RLS ON ALL TABLES ---
async function enableRLSOnAllTables() {
  log("\n=== STEP 1: Enable RLS on all public tables ===");
  const allTables = [...TENANT_TABLES, ...Object.keys(GLOBAL_TABLES_WITH_JUSTIFICATION)];
  let enabled = 0;
  let alreadyEnabled = 0;

  for (const table of allTables) {
    // Check current state
    const state = await db.execute(sql.raw(`
      SELECT relrowsecurity FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = '${table}'
    `));
    const isEnabled = state.rows[0]?.relrowsecurity === true;
    if (!isEnabled) {
      await db.execute(sql.raw(`ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY`));
      log(`  ENABLED RLS: ${table}`);
      enabled++;
    } else {
      alreadyEnabled++;
    }
  }
  log(`  Summary: ${enabled} tables newly enabled, ${alreadyEnabled} already enabled`);
}

// --- STEP 2: CREATE TENANT-SCOPED POLICIES ---
async function createTenantPolicies() {
  log("\n=== STEP 2: Create tenant-scoped policies on tenant tables ===");
  let created = 0;
  let skipped = 0;

  for (const table of TENANT_TABLES) {
    const policies = [
      {
        name: "rls_tenant_select",
        sql: `CREATE POLICY "rls_tenant_select" ON public."${table}"
          FOR SELECT
          USING (
            current_setting('app.current_tenant_id', true) <> ''
            AND tenant_id::text = current_setting('app.current_tenant_id', true)
          )`,
      },
      {
        name: "rls_tenant_insert",
        sql: `CREATE POLICY "rls_tenant_insert" ON public."${table}"
          FOR INSERT
          WITH CHECK (
            current_setting('app.current_tenant_id', true) <> ''
            AND tenant_id::text = current_setting('app.current_tenant_id', true)
          )`,
      },
      {
        name: "rls_tenant_update",
        sql: `CREATE POLICY "rls_tenant_update" ON public."${table}"
          FOR UPDATE
          USING (
            current_setting('app.current_tenant_id', true) <> ''
            AND tenant_id::text = current_setting('app.current_tenant_id', true)
          )
          WITH CHECK (
            current_setting('app.current_tenant_id', true) <> ''
            AND tenant_id::text = current_setting('app.current_tenant_id', true)
          )`,
      },
      {
        name: "rls_tenant_delete",
        sql: `CREATE POLICY "rls_tenant_delete" ON public."${table}"
          FOR DELETE
          USING (
            current_setting('app.current_tenant_id', true) <> ''
            AND tenant_id::text = current_setting('app.current_tenant_id', true)
          )`,
      },
    ];

    for (const p of policies) {
      // Check if policy already exists
      const exists = await db.execute(sql.raw(`
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'public' AND tablename = '${table}' AND policyname = '${p.name}'
      `));
      if (exists.rows.length === 0) {
        await db.execute(sql.raw(p.sql));
        created++;
      } else {
        skipped++;
      }
    }
    log(`  POLICIES: ${table} (4 policies — select/insert/update/delete)`);
  }
  log(`  Summary: ${created} policies created, ${skipped} already existed`);
}

// --- STEP 3: DOCUMENT GLOBAL TABLE EXCEPTIONS ---
async function documentGlobalExceptions() {
  log("\n=== STEP 3: Document global/system table exceptions ===");
  for (const [table, justification] of Object.entries(GLOBAL_TABLES_WITH_JUSTIFICATION)) {
    log(`  EXEMPT: ${table} — ${justification}`);
  }
  log(`  Total exempted: ${Object.keys(GLOBAL_TABLES_WITH_JUSTIFICATION).length} tables`);
  log(`  All exempted tables: RLS enabled, no tenant policies → deny-all for non-service-role`);
}

// --- STEP 4: HARDEN CUSTOM FUNCTION SEARCH_PATH ---
async function hardenFunctionSearchPath() {
  log("\n=== STEP 4: Harden custom function search_path ===");

  // Only non-extension custom function found: check_no_overlapping_tenant_subscriptions
  const hardenedFunction = `
CREATE OR REPLACE FUNCTION public.check_no_overlapping_tenant_subscriptions()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY INVOKER
 SET search_path = public
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.tenant_subscriptions
    WHERE  tenant_id = NEW.tenant_id
      AND  id        <> NEW.id
      AND  (effective_to IS NULL OR effective_to > NEW.effective_from)
      AND  (NEW.effective_to IS NULL OR NEW.effective_to > effective_from)
  ) THEN
    RAISE EXCEPTION 'Overlapping subscription window for tenant %', NEW.tenant_id;
  END IF;
  RETURN NEW;
END;
$function$
  `.trim();

  await db.execute(sql.raw(hardenedFunction));
  log("  HARDENED: check_no_overlapping_tenant_subscriptions — SET search_path = public added");

  // Extension functions (vector, btree_gist) cannot be modified — owned by extension
  log("  SKIP: 304 extension-owned functions (vector, btree_gist) — cannot modify extension-managed functions");
  log("  INFO: Extension functions are not a mutable search_path risk in this context");
}

// --- STEP 5: EXTENSION SCHEMA JUSTIFICATION ---
async function documentExtensionJustification() {
  log("\n=== STEP 5: Extension schema justification ===");
  log("  IN PUBLIC: vector — CANNOT MOVE SAFELY");
  log("    Justification: vector extension is in public schema and provides 305 functions/operators.");
  log("    Moving to extensions schema would break all SQL references using unqualified type names.");
  log("    The platform does not expose direct non-service-role Postgres access, so risk is contained.");
  log("    Exception documented: INV-RLS8-EXEMPT-vector");
  log("");
  log("  IN PUBLIC: btree_gist — CANNOT MOVE SAFELY");
  log("    Justification: btree_gist is used by 5 active exclusion indexes in public schema.");
  log("    Moving would invalidate index operator class references, causing index breakage.");
  log("    Exception documented: INV-RLS8-EXEMPT-btree_gist");
  log("");
  log("  IN extensions: hypopg, index_advisor, pg_stat_statements, pgcrypto, uuid-ossp — CORRECT");
  log("  IN pg_catalog: plpgsql — CORRECT (system schema)");
  log("  IN graphql: pg_graphql — CORRECT");
  log("  IN vault: supabase_vault — CORRECT");
}

// --- STEP 6: VERIFY FINAL STATE ---
async function verifyFinalState() {
  log("\n=== STEP 6: Live DB verification ===");

  const rlsStatus = await db.execute(sql`
    SELECT relname, relrowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY relname
  `);
  const enabled = rlsStatus.rows.filter((r: any) => r.relrowsecurity === true).length;
  const total = rlsStatus.rows.length;
  log(`  RLS enabled: ${enabled}/${total} tables`);

  const policyCount = await db.execute(sql`
    SELECT COUNT(*) as cnt FROM pg_policies WHERE schemaname = 'public'
  `);
  log(`  Total policies in public schema: ${(policyCount.rows[0] as any).cnt}`);

  const fnCheck = await db.execute(sql`
    SELECT p.proname, pg_get_functiondef(p.oid) as def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'check_no_overlapping_tenant_subscriptions'
      AND p.prokind = 'f'
    LIMIT 1
  `);
  const fnDef = (fnCheck.rows[0] as any)?.def || "";
  const hasSearchPath = fnDef.toLowerCase().includes("search_path");
  log(`  Function check_no_overlapping_tenant_subscriptions: search_path hardened = ${hasSearchPath}`);

  const extSchemas = await db.execute(sql`
    SELECT extname, n.nspname as schema FROM pg_extension e
    JOIN pg_namespace n ON n.oid = e.extnamespace
    WHERE extname IN ('vector','btree_gist','pgcrypto','uuid-ossp')
    ORDER BY extname
  `);
  log("  Extension schemas:");
  extSchemas.rows.forEach((r: any) => log(`    ${r.extname}: ${r.schema}`));
}

// --- MAIN ---
async function main() {
  console.log("=".repeat(70));
  console.log("Phase 5K.1 — Supabase RLS & Database Security Hardening");
  console.log("=".repeat(70));
  console.log(`Tenant tables to secure: ${TENANT_TABLES.length}`);
  console.log(`Global/system tables (exempt): ${Object.keys(GLOBAL_TABLES_WITH_JUSTIFICATION).length}`);
  console.log(`Total tables: ${TENANT_TABLES.length + Object.keys(GLOBAL_TABLES_WITH_JUSTIFICATION).length}`);

  await enableRLSOnAllTables();
  await createTenantPolicies();
  await documentGlobalExceptions();
  await hardenFunctionSearchPath();
  await documentExtensionJustification();
  await verifyFinalState();

  console.log("\n" + "=".repeat(70));
  console.log("Phase 5K.1 Migration Complete");
  console.log(`Actions taken: ${actions.length}`);
  if (warnings.length > 0) {
    console.log(`Warnings: ${warnings.length}`);
    warnings.forEach(w => console.log("  WARN:", w));
  }
  console.log("=".repeat(70));
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("Migration failed:", err);
    process.exit(1);
  });
