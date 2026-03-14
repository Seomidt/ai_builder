/**
 * run-phase5k1-migration.ts
 * Executes the Phase 5K.1 migration on a SINGLE database connection
 * to avoid deadlocks caused by multi-connection lock ordering conflicts.
 */

import pg from "pg";

const { Client } = pg;

const TENANT_TABLES = [
  "ai_anomaly_configs","ai_anomaly_events","ai_billing_usage","ai_cache_events",
  "ai_customer_pricing_configs","ai_provider_reconciliation_deltas","ai_request_state_events",
  "ai_request_states","ai_request_step_events","ai_request_step_states","ai_response_cache",
  "ai_usage","ai_usage_limits","asset_storage_objects","billing_audit_findings","billing_events",
  "billing_period_tenant_snapshots","customer_pricing_versions","customer_storage_pricing_versions",
  "document_risk_scores","document_trust_signals","invoice_payments","invoices",
  "knowledge_asset_processing_jobs","knowledge_asset_versions","knowledge_assets","knowledge_bases",
  "knowledge_chunks","knowledge_document_versions","knowledge_documents","knowledge_embeddings",
  "knowledge_index_state","knowledge_processing_jobs","knowledge_retrieval_runs",
  "knowledge_search_candidates","knowledge_search_runs","knowledge_storage_objects",
  "margin_tracking_runs","margin_tracking_snapshots","payment_events","provider_reconciliation_findings",
  "request_safety_events","retrieval_cache_entries","retrieval_metrics","storage_billing_usage",
  "storage_usage","stripe_invoice_links","stripe_webhook_events","tenant_ai_allowance_usage",
  "tenant_ai_usage_periods","tenant_credit_accounts","tenant_credit_ledger","tenant_rate_limits",
  "tenant_storage_allowance_usage","tenant_subscription_events","tenant_subscriptions","usage_threshold_events",
];

const GLOBAL_TABLES = [
  "admin_change_events","admin_change_requests","ai_approvals","ai_artifacts","ai_model_overrides",
  "ai_model_pricing","ai_provider_reconciliation_runs","ai_runs","ai_steps","ai_tool_calls",
  "architecture_agent_configs","architecture_capability_configs","architecture_policy_bindings",
  "architecture_profiles","architecture_template_bindings","architecture_versions","artifact_dependencies",
  "billing_audit_runs","billing_job_definitions","billing_job_runs","billing_metrics_snapshots",
  "billing_periods","billing_recovery_actions","billing_recovery_runs","integrations","invoice_line_items",
  "organization_members","organization_secrets","organizations","plan_entitlements","profiles","projects",
  "provider_pricing_versions","provider_reconciliation_runs","provider_usage_snapshots",
  "storage_pricing_versions","subscription_plans","billing_alerts",
];

async function main() {
  const connectionString = process.env.SUPABASE_DB_POOL_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("No DB connection string");

  const client = new Client({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  console.log("Connected to database (single connection mode)");

  // Set lock_timeout to avoid indefinite waits
  await client.query("SET lock_timeout = '10s'");

  const cond = `current_setting('app.current_tenant_id', true) <> '' AND tenant_id::text = current_setting('app.current_tenant_id', true)`;

  // Step 1: Enable RLS on all tables
  console.log(`\nEnabling RLS on ${TENANT_TABLES.length + GLOBAL_TABLES.length} tables...`);
  for (const table of [...TENANT_TABLES, ...GLOBAL_TABLES]) {
    await client.query(`ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY`);
    process.stdout.write(".");
  }
  console.log("\nRLS enabled on all tables.");

  // Step 2: Create tenant policies
  console.log(`\nCreating tenant policies on ${TENANT_TABLES.length} tenant tables...`);
  for (const table of TENANT_TABLES) {
    await client.query(`DROP POLICY IF EXISTS "rls_tenant_select" ON public."${table}"`);
    await client.query(`DROP POLICY IF EXISTS "rls_tenant_insert" ON public."${table}"`);
    await client.query(`DROP POLICY IF EXISTS "rls_tenant_update" ON public."${table}"`);
    await client.query(`DROP POLICY IF EXISTS "rls_tenant_delete" ON public."${table}"`);
    await client.query(`CREATE POLICY "rls_tenant_select" ON public."${table}" FOR SELECT USING (${cond})`);
    await client.query(`CREATE POLICY "rls_tenant_insert" ON public."${table}" FOR INSERT WITH CHECK (${cond})`);
    await client.query(`CREATE POLICY "rls_tenant_update" ON public."${table}" FOR UPDATE USING (${cond}) WITH CHECK (${cond})`);
    await client.query(`CREATE POLICY "rls_tenant_delete" ON public."${table}" FOR DELETE USING (${cond})`);
    process.stdout.write(".");
  }
  console.log("\nTenant policies created.");

  // Step 3: Harden function search_path
  console.log("\nHardening function search_path...");
  await client.query(`
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
  `);
  console.log("Function hardened: check_no_overlapping_tenant_subscriptions");

  // Step 4: Verify
  const rlsCheck = await client.query(`
    SELECT COUNT(*) as cnt FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity = true
  `);
  const policyCheck = await client.query(`
    SELECT COUNT(*) as cnt FROM pg_policies WHERE schemaname = 'public' AND policyname LIKE 'rls_tenant_%'
  `);
  const fnCheck = await client.query(`
    SELECT pg_get_functiondef(p.oid) as def FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'check_no_overlapping_tenant_subscriptions' AND p.prokind = 'f' LIMIT 1
  `);
  const fnDef = fnCheck.rows[0]?.def || "";

  console.log("\n=== VERIFICATION ===");
  console.log(`Tables with RLS enabled: ${rlsCheck.rows[0].cnt}`);
  console.log(`Tenant RLS policies: ${policyCheck.rows[0].cnt}`);
  console.log(`Function search_path hardened: ${fnDef.includes("search_path")}`);

  await client.end();
  console.log("\nPhase 5K.1 migration complete.");
}

main().then(() => process.exit(0)).catch(err => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
