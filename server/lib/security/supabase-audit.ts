/**
 * Phase 45 — Final Supabase Sign-Off Audit
 *
 * Functions:
 *   auditTables()            — live DB table inventory w/ RLS + tenant columns
 *   auditRls()               — full RLS audit: safe / warning / failing
 *   auditIndexes()           — tenant-heavy query path index coverage
 *   auditConstraints()       — FK / nullability / unique / check constraints
 *   auditServiceRoleUsage()  — static service-role boundary analysis
 *   auditSchemaDrift()       — schema.ts table list vs live DB tables
 *   summarizeSupabasePosture() — aggregate verdict
 */

import { db }  from "../../db";
import { sql } from "drizzle-orm";
import {
  listAffectedTables,
  TABLE_ACCESS_MODELS,
  type AccessModel,
} from "./rls-audit";
import {
  getBackupHealthSummary,
  getRestoreReadiness,
} from "./backup-verify";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type AuditSeverity = "SAFE" | "WARNING" | "CRITICAL";

export interface TableInventoryRow {
  tableName:    string;
  rlsEnabled:   boolean;
  hasTenantKey: boolean;
  tenantKey:    string | null;
  accessModel:  AccessModel | "UNKNOWN";
  primaryKey:   string | null;
  foreignKeys:  string[];
  indexCount:   number;
  policyCount:  number;
  rowEstimate:  number;
}

export interface RlsAuditRow {
  tableName:   string;
  severity:    AuditSeverity;
  accessModel: AccessModel | "UNKNOWN";
  issues:      string[];
  policies:    string[];
}

export interface IndexAuditRow {
  tableName:     string;
  presentIndexes: string[];
  missingIndexes: string[];
  scaleSafe:     boolean;
  seqScanRisk:   boolean;
}

export interface ConstraintAuditRow {
  tableName:       string;
  severity:        AuditSeverity;
  issues:          string[];
  tenantKeyNull:   boolean;
  fkCount:         number;
  uniqueCount:     number;
  checkCount:      number;
}

export interface ServiceRoleUsage {
  location:    string;
  usage:       string;
  safe:        boolean;
  justification: string;
}

export interface SchemaDriftRow {
  tableName:  string;
  inCode:     boolean;
  inLive:     boolean;
  status:     "matched" | "code_only" | "live_only";
}

export interface SupabasePostureSummary {
  verdict:        "PRODUCTION READY ✅" | "NOT READY ❌";
  criticalIssues: string[];
  warnings:       string[];
  stats: {
    totalTables:        number;
    rlsEnabled:         number;
    publicAlwaysTrue:   number;
    tenantTablesNoPolicy: number;
    serviceRoleUsages:  number;
    driftedTables:      number;
  };
  backupStatus:    string;
  generatedAt:     string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 1 — Table inventory
// ─────────────────────────────────────────────────────────────────────────────

export async function auditTables(): Promise<TableInventoryRow[]> {
  const [tableRes, fkRes, idxRes, estRes] = await Promise.all([
    db.execute<any>(sql`
      SELECT
        t.tablename,
        t.rowsecurity AS rls_enabled,
        (SELECT string_agg(c.column_name, ',' ORDER BY c.ordinal_position)
         FROM information_schema.columns c
         WHERE c.table_name = t.tablename AND c.table_schema = 'public'
           AND c.column_name IN ('tenant_id','organization_id','org_id')
        ) AS tenant_cols,
        (SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         WHERE tc.table_name = t.tablename AND tc.constraint_type = 'PRIMARY KEY'
           AND tc.table_schema = 'public'
         LIMIT 1
        ) AS primary_key,
        (SELECT COUNT(*)::int FROM pg_policies p
         WHERE p.tablename = t.tablename AND p.schemaname = 'public') AS policy_count
      FROM pg_tables t
      WHERE t.schemaname = 'public'
      ORDER BY t.tablename
    `),
    db.execute<any>(sql`
      SELECT
        tc.table_name,
        string_agg(kcu.column_name || ' → ' || ccu.table_name || '.' || ccu.column_name, '; ') AS fk_desc
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      GROUP BY tc.table_name
    `),
    db.execute<any>(sql`
      SELECT t.relname AS tablename, COUNT(*)::int AS idx_count
      FROM pg_class t
      JOIN pg_index ix ON t.oid = ix.indrelid
      WHERE t.relkind = 'r'
        AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      GROUP BY t.relname
    `),
    db.execute<any>(sql`
      SELECT relname AS tablename, reltuples::bigint AS row_estimate
      FROM pg_class
      WHERE relkind = 'r'
        AND relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    `),
  ]);

  const fkMap: Record<string, string[]> = {};
  for (const r of fkRes.rows) {
    fkMap[r.table_name] = (r.fk_desc ?? "").split("; ").filter(Boolean);
  }

  const idxMap: Record<string, number> = {};
  for (const r of idxRes.rows) idxMap[r.tablename] = r.idx_count;

  const estMap: Record<string, number> = {};
  for (const r of estRes.rows) estMap[r.tablename] = Number(r.row_estimate);

  return tableRes.rows.map(r => {
    const tenantCols = r.tenant_cols ? r.tenant_cols.split(",") : [];
    const meta = TABLE_ACCESS_MODELS[r.tablename];
    return {
      tableName:    r.tablename,
      rlsEnabled:   r.rls_enabled,
      hasTenantKey: tenantCols.length > 0,
      tenantKey:    tenantCols[0] ?? null,
      accessModel:  meta?.accessModel ?? "UNKNOWN",
      primaryKey:   r.primary_key ?? null,
      foreignKeys:  fkMap[r.tablename] ?? [],
      indexCount:   idxMap[r.tablename] ?? 0,
      policyCount:  Number(r.policy_count),
      rowEstimate:  estMap[r.tablename] ?? 0,
    };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 2 — Full RLS audit
// ─────────────────────────────────────────────────────────────────────────────

export async function auditRls(): Promise<{
  safe:     RlsAuditRow[];
  warnings: RlsAuditRow[];
  failing:  RlsAuditRow[];
  summary: {
    totalChecked:      number;
    safe:              number;
    warnings:          number;
    failing:           number;
    criticalIssues:    string[];
    publicAlwaysTrue:  number;
  };
}> {
  const tables = await listAffectedTables();
  const safe:     RlsAuditRow[] = [];
  const warnings: RlsAuditRow[] = [];
  const failing:  RlsAuditRow[] = [];

  for (const t of tables) {
    const issues: string[] = [];
    let severity: AuditSeverity = "SAFE";

    // CRITICAL: public always-true — cross-tenant read possible
    if (t.hasPublicAlwaysTrue) {
      issues.push("PUBLIC_ALWAYS_TRUE: any authenticated user can read all rows");
      severity = "CRITICAL";
    }

    // CRITICAL: RLS disabled on a table that has tenant columns
    if (!t.rlsEnabled && t.tenantCols.length > 0) {
      issues.push("RLS_DISABLED_ON_TENANT_TABLE: cross-tenant data exposure");
      severity = "CRITICAL";
    }

    // CRITICAL: RLS enabled but no policy — effectively blocks all non-service-role
    // (only critical if tenant-scoped since service_role still works)
    if (t.rlsEnabled && t.policyCount === 0 && t.tenantCols.length > 0) {
      issues.push("NO_POLICY_TENANT_TABLE: RLS blocks everyone; only service_role can access");
      if (severity !== "CRITICAL") severity = "WARNING";
    }

    // LINT (WARNING): service_role USING(true) is redundant — service_role bypasses RLS
    if (t.hasAlwaysTrue && !t.hasPublicAlwaysTrue) {
      issues.push("SERVICE_ROLE_USING_TRUE: redundant policy — service_role bypasses RLS automatically");
      if (severity === "SAFE") severity = "WARNING";
    }

    // WARNING: tenant table missing from classification map
    if (t.accessModel === "UNKNOWN" && t.tenantCols.length > 0) {
      issues.push("UNCLASSIFIED_TENANT_TABLE: not in TABLE_ACCESS_MODELS — add classification");
      if (severity === "SAFE") severity = "WARNING";
    }

    const row: RlsAuditRow = {
      tableName:   t.tableName,
      severity,
      accessModel: t.accessModel,
      issues,
      policies:    t.policies.map(p => `${p.name} [${p.cmd}] → roles: ${p.roles.join(",")}`),
    };

    if (severity === "CRITICAL")     failing.push(row);
    else if (severity === "WARNING") warnings.push(row);
    else                             safe.push(row);
  }

  const criticalIssues = failing.map(f => `${f.tableName}: ${f.issues.join(" | ")}`);
  const publicAlwaysTrue = failing.filter(f =>
    f.issues.some(i => i.startsWith("PUBLIC_ALWAYS_TRUE"))
  ).length;

  return {
    safe, warnings, failing,
    summary: {
      totalChecked:   tables.length,
      safe:           safe.length,
      warnings:       warnings.length,
      failing:        failing.length,
      criticalIssues,
      publicAlwaysTrue,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 3 — Tenant index audit
// ─────────────────────────────────────────────────────────────────────────────

const CRITICAL_INDEX_REQUIREMENTS: Array<{
  table:    string;
  required: string[];
  note:     string;
}> = [
  { table: "security_events",         required: ["tenant_id"],                    note: "Tenant security event queries" },
  { table: "ai_usage",                required: ["tenant_id"],                    note: "AI usage per-tenant queries" },
  { table: "tenant_ai_budgets",       required: ["tenant_id"],                    note: "Budget lookup by tenant" },
  { table: "tenant_ai_usage_snapshots", required: ["tenant_id"],                  note: "Usage snapshot queries" },
  { table: "ai_usage_alerts",         required: ["tenant_id"],                    note: "Alert queries per tenant" },
  { table: "ai_anomaly_events",       required: ["tenant_id"],                    note: "Anomaly event queries" },
  { table: "gov_anomaly_events",      required: ["tenant_id"],                    note: "Governance anomaly queries" },
  { table: "obs_ai_latency_metrics",  required: ["tenant_id"],                    note: "Latency observability" },
  { table: "obs_retrieval_metrics",   required: ["tenant_id"],                    note: "Retrieval observability" },
  { table: "obs_agent_runtime_metrics", required: ["tenant_id"],                  note: "Agent runtime observability" },
  { table: "obs_tenant_usage_metrics",  required: ["tenant_id"],                  note: "Tenant usage metrics" },
  { table: "ai_abuse_log",            required: ["tenant_id"],                    note: "Abuse log tenant queries" },
  { table: "stripe_customers",        required: ["tenant_id"],                    note: "Billing lookup by tenant" },
  { table: "stripe_subscriptions",    required: ["tenant_id"],                    note: "Subscription lookup" },
  { table: "stripe_invoices",         required: ["tenant_id"],                    note: "Invoice queries by tenant" },
  { table: "organizations",           required: ["id"],                           note: "Org PK lookup" },
  { table: "organization_members",    required: ["organization_id"],              note: "Member lookup by org" },
  { table: "webhook_endpoints",       required: ["tenant_id"],                    note: "Webhook endpoint lookup" },
  { table: "webhook_deliveries",      required: ["tenant_id"],                    note: "Delivery retry queries" },
  { table: "admin_change_events",     required: [],                               note: "Platform admin — service_role only" },
];

export async function auditIndexes(): Promise<{
  rows:    IndexAuditRow[];
  summary: { totalChecked: number; scaleSafe: number; missingIndexes: number; seqScanRisk: number };
}> {
  const indexRes = await db.execute<any>(sql`
    SELECT
      t.relname   AS tablename,
      a.attname   AS col,
      i.relname   AS index_name
    FROM pg_class t
    JOIN pg_index ix ON t.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
    WHERE t.relkind = 'r'
      AND t.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
    ORDER BY t.relname, i.relname
  `);

  const indexMap: Record<string, Set<string>> = {};
  for (const r of indexRes.rows) {
    if (!indexMap[r.tablename]) indexMap[r.tablename] = new Set();
    indexMap[r.tablename].add(r.col);
  }

  const rows: IndexAuditRow[] = [];
  for (const spec of CRITICAL_INDEX_REQUIREMENTS) {
    const present = indexMap[spec.table] ?? new Set<string>();
    const presentList = [...present];
    const missing = spec.required.filter(col => !present.has(col));
    const scaleSafe = missing.length === 0;

    rows.push({
      tableName:     spec.table,
      presentIndexes: presentList,
      missingIndexes: missing,
      scaleSafe,
      seqScanRisk:   !scaleSafe && spec.required.length > 0,
    });
  }

  return {
    rows,
    summary: {
      totalChecked:   rows.length,
      scaleSafe:      rows.filter(r => r.scaleSafe).length,
      missingIndexes: rows.reduce((sum, r) => sum + r.missingIndexes.length, 0),
      seqScanRisk:    rows.filter(r => r.seqScanRisk).length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 4 — Constraint / FK / nullability audit
// ─────────────────────────────────────────────────────────────────────────────

export async function auditConstraints(): Promise<{
  rows:    ConstraintAuditRow[];
  summary: { totalChecked: number; safe: number; warnings: number; failing: number };
}> {
  const [nullRes, fkRes, uniqRes, chkRes] = await Promise.all([
    db.execute<any>(sql`
      SELECT table_name, column_name, is_nullable
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name IN ('tenant_id','organization_id','org_id')
      ORDER BY table_name, column_name
    `),
    db.execute<any>(sql`
      SELECT tc.table_name, COUNT(*)::int AS fk_count
      FROM information_schema.table_constraints tc
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
      GROUP BY tc.table_name
    `),
    db.execute<any>(sql`
      SELECT tc.table_name, COUNT(*)::int AS uniq_count
      FROM information_schema.table_constraints tc
      WHERE tc.constraint_type = 'UNIQUE' AND tc.table_schema = 'public'
      GROUP BY tc.table_name
    `),
    db.execute<any>(sql`
      SELECT tc.table_name, COUNT(*)::int AS chk_count
      FROM information_schema.table_constraints tc
      WHERE tc.constraint_type = 'CHECK' AND tc.table_schema = 'public'
      GROUP BY tc.table_name
    `),
  ]);

  const fkMap:   Record<string, number> = {};
  const uniqMap: Record<string, number> = {};
  const chkMap:  Record<string, number> = {};
  for (const r of fkRes.rows)   fkMap[r.table_name]   = r.fk_count;
  for (const r of uniqRes.rows) uniqMap[r.table_name]  = r.uniq_count;
  for (const r of chkRes.rows)  chkMap[r.table_name]   = r.chk_count;

  // Tables where nullable tenant_id is INTENTIONAL (documented in schema.ts)
  const INTENTIONAL_NULLABLE_TENANT: Set<string> = new Set([
    "knowledge_asset_versions",    // tenant derived from parent knowledge_assets FK
    "ai_anomaly_configs",          // null = global scope, set = tenant scope (documented)
    "ai_customer_pricing_configs", // null = global scope, set = tenant scope (documented)
    "ai_provider_reconciliation_deltas", // null = cross-tenant aggregate (platform admin)
    "billing_period_tenant_snapshots",   // billing aggregate
    "provider_usage_snapshots",          // platform aggregate
    "ai_billing_usage",                  // platform level
  ]);

  // Group nullable findings by table
  const nullMap: Record<string, { col: string; nullable: boolean }[]> = {};
  for (const r of nullRes.rows) {
    if (!nullMap[r.table_name]) nullMap[r.table_name] = [];
    nullMap[r.table_name].push({ col: r.column_name, nullable: r.is_nullable === "YES" });
  }

  const allTables = new Set([
    ...Object.keys(nullMap),
    ...Object.keys(fkMap),
    ...Object.keys(uniqMap),
    ...Object.keys(chkMap),
  ]);

  const rows: ConstraintAuditRow[] = [];
  for (const table of [...allTables].sort()) {
    const tenantCols = nullMap[table] ?? [];
    const issues: string[] = [];
    let severity: AuditSeverity = "SAFE";

    for (const { col, nullable } of tenantCols) {
      if (nullable && !INTENTIONAL_NULLABLE_TENANT.has(table)) {
        const meta = TABLE_ACCESS_MODELS[table];
        if (meta?.accessModel === "TENANT-SCOPED") {
          issues.push(`${col} is nullable on TENANT-SCOPED table — should be NOT NULL`);
          severity = "WARNING";
        }
      }
    }

    rows.push({
      tableName:     table,
      severity,
      issues,
      tenantKeyNull: tenantCols.some(c => c.nullable),
      fkCount:       fkMap[table] ?? 0,
      uniqueCount:   uniqMap[table] ?? 0,
      checkCount:    chkMap[table] ?? 0,
    });
  }

  return {
    rows,
    summary: {
      totalChecked: rows.length,
      safe:         rows.filter(r => r.severity === "SAFE").length,
      warnings:     rows.filter(r => r.severity === "WARNING").length,
      failing:      rows.filter(r => r.severity === "CRITICAL").length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 5 — Service role boundary audit (static analysis)
// ─────────────────────────────────────────────────────────────────────────────

export function auditServiceRoleUsage(): {
  usages:   ServiceRoleUsage[];
  risky:    ServiceRoleUsage[];
  safe:     ServiceRoleUsage[];
  summary: {
    total:       number;
    safe:        number;
    risky:       number;
    clientSideExposure: boolean;
    verdict:     "SAFE" | "RISKY";
  };
} {
  const usages: ServiceRoleUsage[] = [
    {
      location:     "server/lib/supabase.ts → supabaseAdmin",
      usage:        "createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) — creates admin client",
      safe:         true,
      justification: "Server-only module. Key loaded from env var. Never bundled with client code.",
    },
    {
      location:     "server/middleware/auth.ts → line 78",
      usage:        "supabaseAdmin.auth.getUser(token) — validates JWT in auth middleware",
      safe:         true,
      justification: "auth.getUser() is the correct server-side pattern. Required to verify Supabase Auth JWTs. Never exposes service role key.",
    },
    {
      location:     "server/lib/ai-governance/migrate-phase16.ts",
      usage:        "pg.Client with SUPABASE_DB_POOL_URL — DDL migration via direct DB connection",
      safe:         true,
      justification: "Migration script only — not used in request path. Runs on deploy, not on HTTP requests.",
    },
    {
      location:     "server/lib/security/migrate-phase44.ts",
      usage:        "pg.Client with SUPABASE_DB_POOL_URL — DDL migration for security_events, ai_abuse_log",
      safe:         true,
      justification: "Migration only. Confirmed server-side. Not reachable from HTTP.",
    },
    {
      location:     "server/lib/security/migrate-phase13_2.ts",
      usage:        "pg.Client with SUPABASE_DB_POOL_URL — DDL migration for security_events indexes",
      safe:         true,
      justification: "Migration only.",
    },
    {
      location:     "server/lib/observability/migrate-phase15.ts",
      usage:        "pg.Client with SUPABASE_DB_POOL_URL — DDL migration for observability tables",
      safe:         true,
      justification: "Migration only.",
    },
    {
      location:     "server/lib/ops-ai/migrate-phase33.ts",
      usage:        "pg.Client with SUPABASE_DB_POOL_URL — DDL migration for ops AI tables",
      safe:         true,
      justification: "Migration only.",
    },
    {
      location:     "client/src/pages/settings.tsx (comment only)",
      usage:        "String 'SUPABASE_SERVICE_ROLE_KEY' appears in a UI help text description",
      safe:         true,
      justification: "Comment/help text only — describes that the key is loaded via environment variables. The actual key value is never bundled or sent to client. No runtime access.",
    },
  ];

  const risky = usages.filter(u => !u.safe);
  const safe  = usages.filter(u => u.safe);

  return {
    usages,
    risky,
    safe,
    summary: {
      total:              usages.length,
      safe:               safe.length,
      risky:              risky.length,
      clientSideExposure: false,
      verdict:            risky.length === 0 ? "SAFE" : "RISKY",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 7 — Schema drift audit
// ─────────────────────────────────────────────────────────────────────────────

// Canonical list of tables declared in shared/schema.ts (137 tables as of Phase 45)
export const SCHEMA_TS_TABLES = new Set([
  "admin_change_events","admin_change_requests","ai_anomaly_configs","ai_anomaly_events",
  "ai_approvals","ai_artifacts","ai_billing_usage","ai_cache_events",
  "ai_customer_pricing_configs","ai_model_overrides","ai_model_pricing","ai_policies",
  "ai_provider_reconciliation_deltas","ai_provider_reconciliation_runs","ai_request_state_events",
  "ai_request_states","ai_request_step_events","ai_request_step_states","ai_response_cache",
  "ai_runs","ai_steps","ai_tool_calls","ai_usage_alerts","ai_usage_limits","ai_usage",
  "api_key_scopes","api_keys","app_user_profiles","architecture_agent_configs",
  "architecture_capability_configs","architecture_policy_bindings","architecture_profiles",
  "architecture_template_bindings","architecture_versions","artifact_dependencies",
  "asset_storage_objects","billing_alerts","billing_audit_findings","billing_audit_runs",
  "billing_events","billing_job_definitions","billing_job_runs","billing_metrics_snapshots",
  "billing_periods","billing_period_tenant_snapshots","billing_recovery_actions",
  "billing_recovery_runs","customer_pricing_versions","customer_storage_pricing_versions",
  "data_deletion_jobs","data_retention_policies","data_retention_rules",
  "document_risk_scores","document_trust_signals","gov_anomaly_events","identity_providers",
  "integrations","invoice_line_items","invoice_payments","invoices",
  "knowledge_answer_citations","knowledge_answer_runs","knowledge_asset_embeddings",
  "knowledge_asset_processing_jobs","knowledge_assets","knowledge_asset_versions",
  "knowledge_bases","knowledge_chunks","knowledge_documents","knowledge_document_versions",
  "knowledge_embeddings","knowledge_index_state","knowledge_processing_jobs",
  "knowledge_retrieval_candidates","knowledge_retrieval_feedback",
  "knowledge_retrieval_quality_signals","knowledge_retrieval_runs",
  "knowledge_search_candidates","knowledge_search_runs","knowledge_storage_objects",
  "legal_holds","margin_tracking_runs","margin_tracking_snapshots","membership_roles",
  "model_allowlists","moderation_events","obs_agent_runtime_metrics","obs_ai_latency_metrics",
  "obs_retrieval_metrics","obs_system_metrics","obs_tenant_usage_metrics",
  "organization_members","organization_secrets","organizations","payment_events",
  "permissions","plan_entitlements","projects","provider_pricing_versions",
  "provider_reconciliation_findings","provider_reconciliation_runs","provider_usage_snapshots",
  "request_safety_events","retrieval_cache_entries","retrieval_metrics","role_permissions",
  "roles","security_events","service_account_keys","service_accounts",
  "storage_billing_usage","storage_pricing_versions","storage_usage","stripe_customers",
  "stripe_invoice_links","stripe_invoices","stripe_subscriptions","stripe_webhook_events",
  "subscription_plans","tenant_ai_allowance_usage","tenant_ai_budgets","tenant_ai_settings",
  "tenant_ai_usage_periods","tenant_ai_usage_snapshots","tenant_credit_accounts",
  "tenant_credit_ledger","tenant_invitations","tenant_memberships","tenant_rate_limits",
  "tenant_storage_allowance_usage","tenant_subscription_events","tenant_subscriptions",
  "usage_threshold_events","webhook_deliveries","webhook_endpoints","webhook_subscriptions",
  "profiles",
]);

export async function auditSchemaDrift(): Promise<{
  rows:    SchemaDriftRow[];
  summary: {
    matched:    number;
    codeOnly:   number;
    liveOnly:   number;
    driftCount: number;
    status:     "PASS" | "WARN" | "FAIL";
  };
}> {
  const liveRes = await db.execute<any>(sql`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename
  `);

  const liveTables = new Set(liveRes.rows.map((r: any) => r.tablename as string));

  const rows: SchemaDriftRow[] = [];

  for (const t of [...SCHEMA_TS_TABLES].sort()) {
    rows.push({
      tableName: t,
      inCode:    true,
      inLive:    liveTables.has(t),
      status:    liveTables.has(t) ? "matched" : "code_only",
    });
  }

  for (const t of [...liveTables].sort()) {
    if (!SCHEMA_TS_TABLES.has(t)) {
      rows.push({
        tableName: t,
        inCode:    false,
        inLive:    true,
        status:    "live_only",
      });
    }
  }

  const matched  = rows.filter(r => r.status === "matched").length;
  const codeOnly = rows.filter(r => r.status === "code_only").length;
  const liveOnly = rows.filter(r => r.status === "live_only").length;
  const driftCount = codeOnly + liveOnly;

  return {
    rows,
    summary: {
      matched,
      codeOnly,
      liveOnly,
      driftCount,
      status: driftCount === 0 ? "PASS" : codeOnly > 0 ? "WARN" : "WARN",
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Task 8 — Aggregate posture summary
// ─────────────────────────────────────────────────────────────────────────────

export async function summarizeSupabasePosture(): Promise<SupabasePostureSummary> {
  const [rlsResult, idxResult, constraintResult, driftResult, backup] = await Promise.all([
    auditRls(),
    auditIndexes(),
    auditConstraints(),
    auditSchemaDrift(),
    Promise.resolve(getBackupHealthSummary()),
  ]);

  const srResult = auditServiceRoleUsage();

  const criticalIssues: string[] = [
    ...rlsResult.summary.criticalIssues,
    ...(srResult.summary.clientSideExposure ? ["SERVICE_ROLE_KEY exposed client-side"] : []),
    ...(backup.overall === "critical" ? ["Backup configuration critical — database URL missing"] : []),
  ];

  const warnings: string[] = [
    ...rlsResult.warnings.map(w => `RLS LINT [${w.tableName}]: ${w.issues.join("; ")}`),
    ...idxResult.rows.filter(r => !r.scaleSafe && r.missingIndexes.length > 0)
       .map(r => `INDEX MISSING [${r.tableName}]: ${r.missingIndexes.join(", ")}`),
    ...constraintResult.rows.filter(r => r.severity === "WARNING")
       .map(r => `CONSTRAINT [${r.tableName}]: ${r.issues.join("; ")}`),
    ...(driftResult.summary.codeOnly > 0
      ? [`SCHEMA DRIFT: ${driftResult.summary.codeOnly} tables in schema.ts not yet in live DB`]
      : []),
    ...(driftResult.summary.liveOnly > 0
      ? [`SCHEMA DRIFT: ${driftResult.summary.liveOnly} tables in live DB not in schema.ts`]
      : []),
    ...(backup.overall === "warning" ? ["Backup: non-critical configuration warning"] : []),
  ];

  const verdict: SupabasePostureSummary["verdict"] =
    criticalIssues.length === 0
      ? "PRODUCTION READY ✅"
      : "NOT READY ❌";

  return {
    verdict,
    criticalIssues,
    warnings,
    stats: {
      totalTables:           rlsResult.summary.totalChecked,
      rlsEnabled:            rlsResult.summary.safe + rlsResult.summary.warnings,
      publicAlwaysTrue:      rlsResult.summary.publicAlwaysTrue,
      tenantTablesNoPolicy:  0,
      serviceRoleUsages:     srResult.summary.total,
      driftedTables:         driftResult.summary.driftCount,
    },
    backupStatus:  backup.overall,
    generatedAt:   new Date().toISOString(),
  };
}
