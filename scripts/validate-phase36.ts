/**
 * Phase 36 — Release Integrity & Deploy Health
 * Validation Script
 *
 * Run: npx ts-node scripts/validate-phase36.ts
 */

import * as fs from "fs";
import * as path from "path";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.error(`  ✗ FAIL: ${message}`);
  }
}

function fileExists(filePath: string): boolean {
  return fs.existsSync(path.join(process.cwd(), filePath));
}

function fileContains(filePath: string, pattern: string): boolean {
  try {
    const content = fs.readFileSync(path.join(process.cwd(), filePath), "utf-8");
    return content.includes(pattern);
  } catch {
    return false;
  }
}

// ─── PART 1: env-validator.ts ─────────────────────────────────────────────
console.log("\n[Part 1] server/lib/platform/env-validator.ts");

assert(fileExists("server/lib/platform/env-validator.ts"),                         "env-validator.ts exists");
assert(fileContains("server/lib/platform/env-validator.ts", "SUPABASE_URL"),        "SUPABASE_URL listed in REQUIRED");
assert(fileContains("server/lib/platform/env-validator.ts", "SUPABASE_ANON_KEY"),   "SUPABASE_ANON_KEY listed in REQUIRED");
assert(fileContains("server/lib/platform/env-validator.ts", "OPENAI_API_KEY"),      "OPENAI_API_KEY listed in REQUIRED");
assert(fileContains("server/lib/platform/env-validator.ts", "SESSION_SECRET"),      "SESSION_SECRET listed in REQUIRED");
assert(fileContains("server/lib/platform/env-validator.ts", "SENTRY_DSN"),          "SENTRY_DSN listed in OPTIONAL");
assert(fileContains("server/lib/platform/env-validator.ts", "POSTHOG_KEY"),         "POSTHOG_KEY listed in OPTIONAL");
assert(fileContains("server/lib/platform/env-validator.ts", "R2_BUCKET"),           "R2_BUCKET listed in OPTIONAL");
assert(fileContains("server/lib/platform/env-validator.ts", "EnvValidationResult"), "EnvValidationResult type exported");
assert(fileContains("server/lib/platform/env-validator.ts", "requiredOk"),          "requiredOk in result shape");
assert(fileContains("server/lib/platform/env-validator.ts", "missingRequired"),     "missingRequired in result shape");
assert(fileContains("server/lib/platform/env-validator.ts", "optionalWarnings"),    "optionalWarnings in result shape");
assert(fileContains("server/lib/platform/env-validator.ts", "validateEnv"),         "validateEnv() exported");
assert(fileContains("server/lib/platform/env-validator.ts", "assertEnv"),           "assertEnv() exported");

// ─── PART 2: schema-validator.ts ──────────────────────────────────────────
console.log("\n[Part 2] server/lib/platform/schema-validator.ts");

assert(fileExists("server/lib/platform/schema-validator.ts"),                              "schema-validator.ts exists");
assert(fileContains("server/lib/platform/schema-validator.ts", "tenants"),                 "tenants in CRITICAL_TABLES");
assert(fileContains("server/lib/platform/schema-validator.ts", "tenant_ai_budgets"),       "tenant_ai_budgets in CRITICAL_TABLES");
assert(fileContains("server/lib/platform/schema-validator.ts", "tenant_ai_usage_snapshots"), "tenant_ai_usage_snapshots in CRITICAL_TABLES");
assert(fileContains("server/lib/platform/schema-validator.ts", "ai_usage_alerts"),         "ai_usage_alerts in CRITICAL_TABLES");
assert(fileContains("server/lib/platform/schema-validator.ts", "gov_anomaly_events"),      "gov_anomaly_events in CRITICAL_TABLES");
assert(fileContains("server/lib/platform/schema-validator.ts", "ops_ai_audit_logs"),       "ops_ai_audit_logs in CRITICAL_TABLES");
assert(fileContains("server/lib/platform/schema-validator.ts", '"id"'),                   "tenants.id in REQUIRED_COLUMNS");
assert(fileContains("server/lib/platform/schema-validator.ts", '"language"'),              "tenants.language in REQUIRED_COLUMNS");
assert(fileContains("server/lib/platform/schema-validator.ts", '"locale"'),                "tenants.locale in REQUIRED_COLUMNS");
assert(fileContains("server/lib/platform/schema-validator.ts", '"currency"'),              "tenants.currency in REQUIRED_COLUMNS");
assert(fileContains("server/lib/platform/schema-validator.ts", '"timezone"'),              "tenants.timezone in REQUIRED_COLUMNS");
assert(fileContains("server/lib/platform/schema-validator.ts", "idx_usage_tenant_created"),    "idx_usage_tenant_created in REQUIRED_INDEXES");
assert(fileContains("server/lib/platform/schema-validator.ts", "idx_alerts_tenant_created"),   "idx_alerts_tenant_created in REQUIRED_INDEXES");
assert(fileContains("server/lib/platform/schema-validator.ts", "idx_anomaly_tenant_created"),  "idx_anomaly_tenant_created in REQUIRED_INDEXES");
assert(fileContains("server/lib/platform/schema-validator.ts", "idx_audit_tenant_created"),    "idx_audit_tenant_created in REQUIRED_INDEXES");
assert(fileContains("server/lib/platform/schema-validator.ts", "idx_webhooks_tenant_created"), "idx_webhooks_tenant_created in REQUIRED_INDEXES");
assert(fileContains("server/lib/platform/schema-validator.ts", "idx_jobs_tenant_created"),     "idx_jobs_tenant_created in REQUIRED_INDEXES");
assert(fileContains("server/lib/platform/schema-validator.ts", "SchemaValidationResult"),      "SchemaValidationResult type exported");
assert(fileContains("server/lib/platform/schema-validator.ts", "schemaValid"),                 "schemaValid in result shape");
assert(fileContains("server/lib/platform/schema-validator.ts", "missingTables"),               "missingTables in result shape");
assert(fileContains("server/lib/platform/schema-validator.ts", "missingColumns"),              "missingColumns in result shape");
assert(fileContains("server/lib/platform/schema-validator.ts", "missingIndexes"),              "missingIndexes in result shape");
assert(fileContains("server/lib/platform/schema-validator.ts", "validateSchema"),              "validateSchema() exported");
assert(fileContains("server/lib/platform/schema-validator.ts", "information_schema.tables"),   "queries information_schema.tables");
assert(fileContains("server/lib/platform/schema-validator.ts", "information_schema.columns"),  "queries information_schema.columns");
assert(fileContains("server/lib/platform/schema-validator.ts", "pg_indexes"),                  "queries pg_indexes");

// ─── PART 3: deploy-health.ts ─────────────────────────────────────────────
console.log("\n[Part 3] server/lib/platform/deploy-health.ts");

assert(fileExists("server/lib/platform/deploy-health.ts"),                                  "deploy-health.ts exists");
assert(fileContains("server/lib/platform/deploy-health.ts", "env-validator"),               "imports env-validator");
assert(fileContains("server/lib/platform/deploy-health.ts", "schema-validator"),            "imports schema-validator");
assert(fileContains("server/lib/platform/deploy-health.ts", "DeployHealthReport"),          "DeployHealthReport type exported");
assert(fileContains("server/lib/platform/deploy-health.ts", "DeployStatus"),                "DeployStatus type exported");
assert(fileContains("server/lib/platform/deploy-health.ts", "healthy"),                     "status: healthy variant");
assert(fileContains("server/lib/platform/deploy-health.ts", "warning"),                     "status: warning variant");
assert(fileContains("server/lib/platform/deploy-health.ts", "critical"),                    "status: critical variant");
assert(fileContains("server/lib/platform/deploy-health.ts", "appVersion"),                  "appVersion in report");
assert(fileContains("server/lib/platform/deploy-health.ts", "gitCommit"),                   "gitCommit in report");
assert(fileContains("server/lib/platform/deploy-health.ts", "VERCEL_GIT_COMMIT_SHA"),       "reads VERCEL_GIT_COMMIT_SHA");
assert(fileContains("server/lib/platform/deploy-health.ts", "VERCEL_ENV"),                  "reads VERCEL_ENV");
assert(fileContains("server/lib/platform/deploy-health.ts", "queueStatus"),                 "queueStatus in report");
assert(fileContains("server/lib/platform/deploy-health.ts", "webhookStatus"),               "webhookStatus in report");
assert(fileContains("server/lib/platform/deploy-health.ts", "backupStatus"),                "backupStatus in report");
assert(fileContains("server/lib/platform/deploy-health.ts", "warnings"),                    "warnings array in report");
assert(fileContains("server/lib/platform/deploy-health.ts", "getDeployHealth"),             "getDeployHealth() exported");

// ─── PART 4: post-deploy-check.ts ─────────────────────────────────────────
console.log("\n[Part 4] server/lib/platform/post-deploy-check.ts");

assert(fileExists("server/lib/platform/post-deploy-check.ts"),                             "post-deploy-check.ts exists");
assert(fileContains("server/lib/platform/post-deploy-check.ts", "runPostDeployCheck"),     "runPostDeployCheck() exported");
assert(fileContains("server/lib/platform/post-deploy-check.ts", "validateEnv"),            "calls validateEnv");
assert(fileContains("server/lib/platform/post-deploy-check.ts", "validateSchema"),         "calls validateSchema");
assert(fileContains("server/lib/platform/post-deploy-check.ts", "getDeployHealth"),        "calls getDeployHealth");
assert(fileContains("server/lib/platform/post-deploy-check.ts", "SENTRY_DSN"),             "Sentry hook checks for SENTRY_DSN");
assert(fileContains("server/lib/platform/post-deploy-check.ts", "POSTHOG_KEY"),            "PostHog hook checks for POSTHOG_KEY");
assert(fileContains("server/lib/platform/post-deploy-check.ts", "deploy_integrity_failure"), "emits Sentry deploy_integrity_failure");
assert(fileContains("server/lib/platform/post-deploy-check.ts", "deploy_health_warning"),  "emits PostHog deploy_health_warning");
assert(fileContains("server/lib/platform/post-deploy-check.ts", "PostDeployCheckResult"),  "PostDeployCheckResult type exported");
assert(fileContains("server/lib/platform/post-deploy-check.ts", "passed"),                 "passed field in result");
assert(fileContains("server/lib/platform/post-deploy-check.ts", "critical"),               "critical status possible");

// ─── PART 5: Admin route ──────────────────────────────────────────────────
console.log("\n[Part 5] Admin route /api/admin/platform/deploy-health");

assert(fileContains("server/routes/admin.ts", "/api/admin/platform/deploy-health"),        "route registered in admin.ts");
assert(fileContains("server/routes/admin.ts", "isPlatformAdmin"),                          "route guarded by isPlatformAdmin");
assert(fileContains("server/routes/admin.ts", "getDeployHealth"),                          "route calls getDeployHealth");
assert(fileContains("server/routes/admin.ts", "deploy-health"),                            "import path references deploy-health");

// ─── PART 6: UI Components ────────────────────────────────────────────────
console.log("\n[Part 6] UI Components");

assert(fileExists("client/src/components/ops/ConfigCheckRow.tsx"),                         "ConfigCheckRow.tsx exists");
assert(fileContains("client/src/components/ops/ConfigCheckRow.tsx", "ConfigCheckRow"),     "ConfigCheckRow exported");
assert(fileContains("client/src/components/ops/ConfigCheckRow.tsx", "data-testid"),        "ConfigCheckRow has testId support");
assert(fileContains("client/src/components/ops/ConfigCheckRow.tsx", "ok"),                 "ConfigCheckRow supports ok status");
assert(fileContains("client/src/components/ops/ConfigCheckRow.tsx", "error"),              "ConfigCheckRow supports error status");
assert(fileContains("client/src/components/ops/ConfigCheckRow.tsx", "warning"),            "ConfigCheckRow supports warning status");

assert(fileExists("client/src/components/ops/EnvStatusTable.tsx"),                         "EnvStatusTable.tsx exists");
assert(fileContains("client/src/components/ops/EnvStatusTable.tsx", "EnvStatusTable"),     "EnvStatusTable exported");
assert(fileContains("client/src/components/ops/EnvStatusTable.tsx", "presentRequired"),    "EnvStatusTable accepts presentRequired");
assert(fileContains("client/src/components/ops/EnvStatusTable.tsx", "missingRequired"),    "EnvStatusTable accepts missingRequired");
assert(fileContains("client/src/components/ops/EnvStatusTable.tsx", "optionalWarnings"),   "EnvStatusTable accepts optionalWarnings");
assert(fileContains("client/src/components/ops/EnvStatusTable.tsx", "Skeleton"),           "EnvStatusTable has loading skeleton");
assert(fileContains("client/src/components/ops/EnvStatusTable.tsx", "ConfigCheckRow"),     "EnvStatusTable reuses ConfigCheckRow");

assert(fileExists("client/src/components/ops/SchemaStatusTable.tsx"),                      "SchemaStatusTable.tsx exists");
assert(fileContains("client/src/components/ops/SchemaStatusTable.tsx", "SchemaStatusTable"), "SchemaStatusTable exported");
assert(fileContains("client/src/components/ops/SchemaStatusTable.tsx", "missingTables"),   "SchemaStatusTable accepts missingTables");
assert(fileContains("client/src/components/ops/SchemaStatusTable.tsx", "missingColumns"),  "SchemaStatusTable accepts missingColumns");
assert(fileContains("client/src/components/ops/SchemaStatusTable.tsx", "missingIndexes"),  "SchemaStatusTable accepts missingIndexes");
assert(fileContains("client/src/components/ops/SchemaStatusTable.tsx", "Skeleton"),        "SchemaStatusTable has loading skeleton");
assert(fileContains("client/src/components/ops/SchemaStatusTable.tsx", "ConfigCheckRow"),  "SchemaStatusTable reuses ConfigCheckRow");

// ─── PART 7: Release Health Page ──────────────────────────────────────────
console.log("\n[Part 7] client/src/pages/ops/release.tsx");

assert(fileExists("client/src/pages/ops/release.tsx"),                                     "release.tsx exists");
assert(fileContains("client/src/pages/ops/release.tsx", "OpsNav"),                         "release.tsx renders OpsNav");
assert(fileContains("client/src/pages/ops/release.tsx", "EnvStatusTable"),                 "release.tsx renders EnvStatusTable");
assert(fileContains("client/src/pages/ops/release.tsx", "SchemaStatusTable"),              "release.tsx renders SchemaStatusTable");
assert(fileContains("client/src/pages/ops/release.tsx", "ConfigCheckRow"),                 "release.tsx renders ConfigCheckRow");
assert(fileContains("client/src/pages/ops/release.tsx", "MetricCard"),                     "release.tsx renders MetricCard");
assert(fileContains("client/src/pages/ops/release.tsx", "StatusPill"),                     "release.tsx renders StatusPill");
assert(fileContains("client/src/pages/ops/release.tsx", "/api/admin/platform/deploy-health"), "release.tsx fetches deploy-health API");
assert(fileContains("client/src/pages/ops/release.tsx", "useQuery"),                       "release.tsx uses useQuery");
assert(fileContains("client/src/pages/ops/release.tsx", "refetchInterval"),                "release.tsx uses refetchInterval");
assert(fileContains("client/src/pages/ops/release.tsx", "data-testid"),                    "release.tsx has testId attributes");
assert(fileContains("client/src/pages/ops/release.tsx", "release-health-page"),            "release.tsx has page-level testId");
assert(fileContains("client/src/pages/ops/release.tsx", "btn-refresh-deploy-health"),      "release.tsx has refresh button testId");
assert(fileContains("client/src/pages/ops/release.tsx", "queueStatus"),                    "release.tsx displays queue status");
assert(fileContains("client/src/pages/ops/release.tsx", "webhookStatus"),                  "release.tsx displays webhook status");
assert(fileContains("client/src/pages/ops/release.tsx", "backupStatus"),                   "release.tsx displays backup status");

// ─── PART 8: Sidebar / Navigation ─────────────────────────────────────────
console.log("\n[Part 8] Navigation integration");

assert(fileContains("client/src/components/ops/OpsNav.tsx", "/ops/release"),              "OpsNav has /ops/release href");
assert(fileContains("client/src/components/ops/OpsNav.tsx", "Release Health"),            "OpsNav has 'Release Health' label");
assert(fileContains("client/src/components/ops/OpsNav.tsx", "ShieldCheck"),               "OpsNav imports ShieldCheck icon");
assert(fileContains("client/src/App.tsx", "/ops/release"),                                "App.tsx registers /ops/release route");
assert(fileContains("client/src/App.tsx", "OpsRelease"),                                  "App.tsx imports OpsRelease component");

// ─── SUMMARY ──────────────────────────────────────────────────────────────
console.log(`\n${"═".repeat(60)}`);
console.log(`Phase 36 Validation — ${passed + failed} assertions`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

if (failures.length > 0) {
  console.error("\nFailed assertions:");
  failures.forEach(f => console.error(`  ✗ ${f}`));
  process.exit(1);
} else {
  console.log("\n✓ All assertions passed — Phase 36 complete");
  process.exit(0);
}
