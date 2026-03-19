#!/usr/bin/env npx tsx
/**
 * Phase 28 — CI/CD & Release Governance — Validation
 * 60 scenarios · 150+ assertions
 */

import * as http from "http";

let passed = 0;
let failed = 0;

// ── Assert helpers ─────────────────────────────────────────────────────────────

function assert(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✔ ${label}`);
    passed++;
  } else {
    console.log(`  ✖ ${label}`);
    failed++;
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  assert(actual === expected, `${label} (got: ${JSON.stringify(actual)})`);
}

function assertNum(v: unknown, label: string): void {
  assert(typeof v === "number" && !isNaN(v as number), `${label} is number`);
}

function assertStr(v: unknown, label: string): void {
  assert(typeof v === "string" && (v as string).length > 0, `${label} is non-empty string`);
}

function assertArr(v: unknown, label: string): void {
  assert(Array.isArray(v), `${label} is array`);
}

function assertBool(v: unknown, label: string): void {
  assert(typeof v === "boolean", `${label} is boolean`);
}

function assertIso(v: unknown, label: string): void {
  assert(typeof v === "string" && !isNaN(Date.parse(v as string)), `${label} is ISO date`);
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function get(path: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: "localhost", port: 5000, path, method: "GET",
        headers: { "Content-Type": "application/json", "x-admin-secret": "admin" } },
      (res) => {
        let data = "";
        res.on("data", c => { data += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: data }); }
        });
      },
    );
    req.on("error", () => resolve({ status: 0, body: null }));
    req.setTimeout(10000, () => { req.destroy(); resolve({ status: 0, body: null }); });
    req.end();
  });
}

// ── Import modules directly for unit-style tests ──────────────────────────────

async function main(): Promise<void> {
  console.log("═══════════════════════════════════════════════════════");
  console.log("Phase 28 — CI/CD & Release Governance — Validation");
  console.log("═══════════════════════════════════════════════════════");

  // ══════════════════════════════════════════════════════════════════════════
  // S01–S10: env-validation module
  // ══════════════════════════════════════════════════════════════════════════

  section("S01: validateEnvironment — registry structure");
  {
    const { ENV_VAR_REGISTRY, validateEnvironment } = await import("./server/lib/startup/env-validation");
    assertArr(ENV_VAR_REGISTRY, "ENV_VAR_REGISTRY");
    assert(ENV_VAR_REGISTRY.length >= 6, "Registry has at least 6 entries");
    assert(ENV_VAR_REGISTRY.every(v => typeof v.name === "string"), "All entries have name");
    assert(ENV_VAR_REGISTRY.every(v => ["critical","recommended","optional"].includes(v.required)), "All entries have valid required level");
    assert(ENV_VAR_REGISTRY.some(v => v.name === "SUPABASE_URL"), "SUPABASE_URL in registry");
    assert(ENV_VAR_REGISTRY.some(v => v.name === "SUPABASE_SERVICE_ROLE_KEY"), "SUPABASE_SERVICE_ROLE_KEY in registry");
  }

  section("S02: validateEnvironment — all vars present");
  {
    const { validateEnvironment, ENV_VAR_REGISTRY } = await import("./server/lib/startup/env-validation");
    const mockEnv: Record<string, string> = {};
    for (const v of ENV_VAR_REGISTRY) mockEnv[v.name] = "mock-value";
    const result = validateEnvironment(ENV_VAR_REGISTRY, mockEnv);
    assertBool(result.valid, "result.valid");
    assert(result.valid === true, "valid when all present");
    assertArr(result.criticalMissing, "criticalMissing");
    assertEq(result.criticalMissing.length, 0, "no criticalMissing");
    assertArr(result.presentVars, "presentVars");
    assertIso(result.checkedAt, "checkedAt");
  }

  section("S03: validateEnvironment — missing critical vars");
  {
    const { validateEnvironment, ENV_VAR_REGISTRY } = await import("./server/lib/startup/env-validation");
    const result = validateEnvironment(ENV_VAR_REGISTRY, {});
    assertBool(result.valid, "result.valid is boolean");
    assert(result.valid === false, "invalid when critical vars missing");
    assert(result.criticalMissing.includes("SUPABASE_URL"), "SUPABASE_URL in criticalMissing");
    assert(result.criticalMissing.includes("SUPABASE_SERVICE_ROLE_KEY"), "SUPABASE_SERVICE_ROLE_KEY in criticalMissing");
    assertArr(result.recommendedMissing, "recommendedMissing");
    assert(result.presentVars.length === 0, "no presentVars when env empty");
  }

  section("S04: validateEnvironment — partial env");
  {
    const { validateEnvironment, ENV_VAR_REGISTRY } = await import("./server/lib/startup/env-validation");
    const partialEnv = {
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service-key",
      SUPABASE_DB_POOL_URL: "postgres://...",
    };
    const result = validateEnvironment(ENV_VAR_REGISTRY, partialEnv);
    assert(result.valid === true, "valid when critical vars present");
    assert(result.criticalMissing.length === 0, "no criticalMissing with partial env");
    assert(result.recommendedMissing.length > 0, "has recommendedMissing");
    assert(result.presentVars.length >= 3, "at least 3 presentVars");
  }

  section("S05: validateEnvironment — STRIPE_SECRET_KEY recommended");
  {
    const { validateEnvironment, ENV_VAR_REGISTRY } = await import("./server/lib/startup/env-validation");
    const stripeSpec = ENV_VAR_REGISTRY.find(v => v.name === "STRIPE_SECRET_KEY");
    assert(stripeSpec !== undefined, "STRIPE_SECRET_KEY in registry");
    assertEq(stripeSpec?.required, "recommended", "STRIPE_SECRET_KEY is recommended not critical");
  }

  section("S06: validateEnvironment — WEBHOOK_SIGNING_SECRET");
  {
    const { validateEnvironment, ENV_VAR_REGISTRY } = await import("./server/lib/startup/env-validation");
    const webhookSpec = ENV_VAR_REGISTRY.find(v => v.name === "WEBHOOK_SIGNING_SECRET");
    assert(webhookSpec !== undefined, "WEBHOOK_SIGNING_SECRET in registry");
    assertEq(webhookSpec?.required, "recommended", "WEBHOOK_SIGNING_SECRET is recommended");
  }

  section("S07: getEnvSummary — returns status per var");
  {
    const { getEnvSummary, ENV_VAR_REGISTRY } = await import("./server/lib/startup/env-validation");
    const mockEnv = { SUPABASE_URL: "https://x.supabase.co" };
    const summary = getEnvSummary(ENV_VAR_REGISTRY, mockEnv);
    assert(typeof summary === "object", "summary is object");
    assertEq(summary["SUPABASE_URL"], "present", "SUPABASE_URL present");
    assert(summary["SUPABASE_SERVICE_ROLE_KEY"]?.startsWith("missing"), "SUPABASE_SERVICE_ROLE_KEY missing");
    assert(summary["STRIPE_SECRET_KEY"] === "missing-recommended", "STRIPE status missing-recommended");
  }

  section("S08: validateEnvironment — empty string treated as missing");
  {
    const { validateEnvironment, ENV_VAR_REGISTRY } = await import("./server/lib/startup/env-validation");
    const emptyEnv = { SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "  " };
    const result = validateEnvironment(ENV_VAR_REGISTRY, emptyEnv);
    assert(result.valid === false, "empty string vars treated as missing");
    assert(result.criticalMissing.includes("SUPABASE_URL"), "empty SUPABASE_URL treated as missing");
  }

  section("S09: validateEnvironment — result shape completeness");
  {
    const { validateEnvironment, ENV_VAR_REGISTRY } = await import("./server/lib/startup/env-validation");
    const result = validateEnvironment(ENV_VAR_REGISTRY, process.env);
    assert("valid" in result, "result has valid");
    assert("criticalMissing" in result, "result has criticalMissing");
    assert("recommendedMissing" in result, "result has recommendedMissing");
    assert("optionalMissing" in result, "result has optionalMissing");
    assert("presentVars" in result, "result has presentVars");
    assert("checkedAt" in result, "result has checkedAt");
  }

  section("S10: validateEnvironment — real process.env");
  {
    const { validateEnvironment, ENV_VAR_REGISTRY } = await import("./server/lib/startup/env-validation");
    const result = validateEnvironment(ENV_VAR_REGISTRY, process.env);
    assertBool(result.valid, "real env result valid is boolean");
    assertIso(result.checkedAt, "real env checkedAt");
    assert(result.presentVars.length > 0, "at least 1 env var present in real env");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S11–S20: migration-guard module
  // ══════════════════════════════════════════════════════════════════════════

  section("S11: scanForDestructiveOps — detects DROP TABLE");
  {
    const { scanForDestructiveOps } = await import("./server/lib/migrations/migration-guard");
    const sql = "ALTER TABLE users ADD COLUMN x text; DROP TABLE old_logs;";
    const results = scanForDestructiveOps(sql);
    assertArr(results, "scanForDestructiveOps returns array");
    const dropTable = results.find(r => r.description.includes("DROP TABLE"));
    assert(dropTable !== undefined, "DROP TABLE check present");
    assert(dropTable?.detected === true, "DROP TABLE detected");
  }

  section("S12: scanForDestructiveOps — detects TRUNCATE");
  {
    const { scanForDestructiveOps } = await import("./server/lib/migrations/migration-guard");
    const results = scanForDestructiveOps("TRUNCATE audit_log;");
    const truncate = results.find(r => r.description.includes("TRUNCATE"));
    assert(truncate?.detected === true, "TRUNCATE detected");
  }

  section("S13: scanForDestructiveOps — safe SQL not flagged");
  {
    const { scanForDestructiveOps } = await import("./server/lib/migrations/migration-guard");
    const safeSql = "ALTER TABLE users ADD COLUMN new_field text NOT NULL DEFAULT '';";
    const results = scanForDestructiveOps(safeSql);
    const destructive = results.filter(r => r.detected);
    assert(destructive.length === 0, "safe ADD COLUMN not flagged as destructive");
  }

  section("S14: scanForDestructiveOps — detects DROP COLUMN");
  {
    const { scanForDestructiveOps } = await import("./server/lib/migrations/migration-guard");
    const results = scanForDestructiveOps("ALTER TABLE users DROP COLUMN old_field;");
    const dropCol = results.find(r => r.description.includes("DROP COLUMN"));
    assert(dropCol?.detected === true, "DROP COLUMN detected");
  }

  section("S15: scanForDestructiveOps — result shape");
  {
    const { scanForDestructiveOps } = await import("./server/lib/migrations/migration-guard");
    const results = scanForDestructiveOps("SELECT 1");
    assert(results.every(r => typeof r.pattern === "string"), "all results have pattern");
    assert(results.every(r => typeof r.description === "string"), "all results have description");
    assert(results.every(r => typeof r.detected === "boolean"), "all results have detected bool");
  }

  section("S16: checkSchemaDrift — returns drift result");
  {
    const { checkSchemaDrift } = await import("./server/lib/migrations/migration-guard");
    const result = await checkSchemaDrift();
    assert("drifted" in result, "result has drifted");
    assert("missingTables" in result, "result has missingTables");
    assertBool(result.drifted, "drifted is boolean");
    assertArr(result.missingTables, "missingTables is array");
  }

  section("S17: checkSchemaDrift — core tables exist");
  {
    const { checkSchemaDrift } = await import("./server/lib/migrations/migration-guard");
    const result = await checkSchemaDrift();
    assert(!result.drifted, "no schema drift — all core tables exist");
    assertEq(result.missingTables.length, 0, "missingTables is empty");
  }

  section("S18: checkPendingMigrations — returns result");
  {
    const { checkPendingMigrations } = await import("./server/lib/migrations/migration-guard");
    const result = await checkPendingMigrations();
    assert("pending" in result, "result has pending");
    assert("applied" in result, "result has applied");
    assertNum(result.pending, "pending");
    assertArr(result.applied, "applied");
    assert(result.pending >= 0, "pending >= 0");
  }

  section("S19: getSchemaVersion — returns version string");
  {
    const { getSchemaVersion } = await import("./server/lib/migrations/migration-guard");
    const ver = await getSchemaVersion();
    assertStr(ver, "schemaVersion");
    assert(ver.startsWith("v28."), "schemaVersion starts with v28.");
  }

  section("S20: runMigrationGuard — full result shape");
  {
    const { runMigrationGuard } = await import("./server/lib/migrations/migration-guard");
    const result = await runMigrationGuard();
    assertBool(result.safe, "safe is boolean");
    assertArr(result.issues, "issues is array");
    assertArr(result.warnings, "warnings is array");
    assertBool(result.schemaDriftDetected, "schemaDriftDetected is boolean");
    assertBool(result.destructiveOpsDetected, "destructiveOpsDetected is boolean");
    assertNum(result.pendingMigrationsCount, "pendingMigrationsCount");
    assertStr(result.schemaVersion, "schemaVersion");
    assertIso(result.checkedAt, "checkedAt");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S21–S30: schema validation script
  // ══════════════════════════════════════════════════════════════════════════

  section("S21: validate-schema — tenant_ai_budgets table");
  {
    const { Client } = await import("pg");
    const client = new Client({
      connectionString: process.env.SUPABASE_DB_POOL_URL,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      const res = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='tenant_ai_budgets'`);
      assert(res.rows.length === 1, "tenant_ai_budgets table exists");
    } finally { await client.end(); }
  }

  section("S22: validate-schema — data_retention_policies table");
  {
    const { Client } = await import("pg");
    const client = new Client({
      connectionString: process.env.SUPABASE_DB_POOL_URL,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      const res = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='data_retention_policies'`);
      assert(res.rows.length === 1, "data_retention_policies table exists");
    } finally { await client.end(); }
  }

  section("S23: validate-schema — legal_holds table");
  {
    const { Client } = await import("pg");
    const client = new Client({
      connectionString: process.env.SUPABASE_DB_POOL_URL,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      const res = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='legal_holds'`);
      assert(res.rows.length === 1, "legal_holds table exists");
    } finally { await client.end(); }
  }

  section("S24: validate-schema — ai_policies columns");
  {
    const { Client } = await import("pg");
    const client = new Client({
      connectionString: process.env.SUPABASE_DB_POOL_URL,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      const res = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='ai_policies'`);
      const cols = res.rows.map((r: any) => r.column_name);
      assert(cols.includes("id"), "ai_policies has id");
      assert(cols.includes("policy_key"), "ai_policies has policy_key");
      assert(cols.includes("enabled"), "ai_policies has enabled (not active)");
      assert(!cols.includes("active"), "ai_policies does NOT have active column");
    } finally { await client.end(); }
  }

  section("S25: validate-schema — moderation_events columns");
  {
    const { Client } = await import("pg");
    const client = new Client({
      connectionString: process.env.SUPABASE_DB_POOL_URL,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      const res = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='moderation_events'`);
      const cols = res.rows.map((r: any) => r.column_name);
      assert(cols.includes("result"), "moderation_events has result");
      assert(cols.includes("policy_key"), "moderation_events has policy_key");
      assert(!cols.includes("action"), "moderation_events does NOT have action column");
    } finally { await client.end(); }
  }

  section("S26: validate-schema — ai_anomaly_events columns");
  {
    const { Client } = await import("pg");
    const client = new Client({
      connectionString: process.env.SUPABASE_DB_POOL_URL,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      const res = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='ai_anomaly_events'`);
      const cols = res.rows.map((r: any) => r.column_name);
      assert(cols.includes("observed_value"), "ai_anomaly_events has observed_value");
      assert(!cols.includes("detected_value"), "ai_anomaly_events does NOT have detected_value");
    } finally { await client.end(); }
  }

  section("S27: validate-schema — security_events columns");
  {
    const { Client } = await import("pg");
    const client = new Client({
      connectionString: process.env.SUPABASE_DB_POOL_URL,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      const res = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='security_events'`);
      const cols = res.rows.map((r: any) => r.column_name);
      assert(cols.includes("event_type"), "security_events has event_type");
      assert(!cols.includes("severity"), "security_events does NOT have severity column");
    } finally { await client.end(); }
  }

  section("S28: validate-schema — tenant_ai_budgets columns");
  {
    const { Client } = await import("pg");
    const client = new Client({
      connectionString: process.env.SUPABASE_DB_POOL_URL,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      const res = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='tenant_ai_budgets'`);
      const cols = res.rows.map((r: any) => r.column_name);
      assert(cols.includes("monthly_budget_usd"), "tenant_ai_budgets has monthly_budget_usd");
      assert(!cols.includes("active"), "tenant_ai_budgets does NOT have active column");
    } finally { await client.end(); }
  }

  section("S29: validate-schema — data_deletion_jobs table");
  {
    const { Client } = await import("pg");
    const client = new Client({
      connectionString: process.env.SUPABASE_DB_POOL_URL,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      const res = await client.query(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename='data_deletion_jobs'`);
      assert(res.rows.length === 1, "data_deletion_jobs table exists");
    } finally { await client.end(); }
  }

  section("S30: validate-schema — drp_policy_key_idx index");
  {
    const { Client } = await import("pg");
    const client = new Client({
      connectionString: process.env.SUPABASE_DB_POOL_URL,
      ssl: { rejectUnauthorized: false },
    });
    await client.connect();
    try {
      const res = await client.query(`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname='drp26_policy_key_idx'`);
      assert(res.rows.length === 1, "drp26_policy_key_idx index exists");
    } finally { await client.end(); }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S31–S40: deploy-health endpoint
  // ══════════════════════════════════════════════════════════════════════════

  section("S31: deploy-health — endpoint registered (not 404)");
  {
    const r = await get("/api/admin/platform/deploy-health");
    assert(r.status !== 404, "deploy-health not 404");
    assert(r.status !== 500, "deploy-health not 500");
  }

  section("S32: deploy-health — top-level shape");
  {
    const r = await get("/api/admin/platform/deploy-health");
    assert("status" in r.body, "body has status");
    assert("schemaVersion" in r.body, "body has schemaVersion");
    assert("migrationStatus" in r.body, "body has migrationStatus");
    assert("environmentValidation" in r.body, "body has environmentValidation");
    assert("checkedAt" in r.body, "body has checkedAt");
  }

  section("S33: deploy-health — status value");
  {
    const r = await get("/api/admin/platform/deploy-health");
    assert(["healthy", "degraded"].includes(r.body.status), "status is healthy or degraded");
  }

  section("S34: deploy-health — schemaVersion format");
  {
    const r = await get("/api/admin/platform/deploy-health");
    assertStr(r.body.schemaVersion, "schemaVersion");
    assert(r.body.schemaVersion.startsWith("v28."), "schemaVersion starts with v28.");
  }

  section("S35: deploy-health — migrationStatus shape");
  {
    const r = await get("/api/admin/platform/deploy-health");
    const ms = r.body.migrationStatus;
    assert(ms !== null && typeof ms === "object", "migrationStatus is object");
    assertBool(ms.safe, "migrationStatus.safe");
    assertNum(ms.pendingCount, "migrationStatus.pendingCount");
    assertBool(ms.schemaDrift, "migrationStatus.schemaDrift");
    assertArr(ms.issues, "migrationStatus.issues");
    assertArr(ms.warnings, "migrationStatus.warnings");
  }

  section("S36: deploy-health — migrationStatus.safe is true (no drift)");
  {
    const r = await get("/api/admin/platform/deploy-health");
    assert(r.body.migrationStatus.safe === true, "migration safe (no drift in deployed schema)");
    assert(r.body.migrationStatus.schemaDrift === false, "no schema drift");
    assertEq(r.body.migrationStatus.pendingCount, 0, "0 pending migrations");
  }

  section("S37: deploy-health — environmentValidation shape");
  {
    const r = await get("/api/admin/platform/deploy-health");
    const ev = r.body.environmentValidation;
    assert(ev !== null && typeof ev === "object", "environmentValidation is object");
    assertBool(ev.valid, "environmentValidation.valid");
    assertArr(ev.criticalMissing, "environmentValidation.criticalMissing");
    assertArr(ev.recommendedMissing, "environmentValidation.recommendedMissing");
    assertNum(ev.presentCount, "environmentValidation.presentCount");
    assertIso(ev.checkedAt, "environmentValidation.checkedAt");
  }

  section("S38: deploy-health — environmentValidation.valid is true");
  {
    const r = await get("/api/admin/platform/deploy-health");
    assert(r.body.environmentValidation.valid === true, "env valid (critical vars present)");
    assertEq(r.body.environmentValidation.criticalMissing.length, 0, "no criticalMissing in deploy env");
  }

  section("S39: deploy-health — checkedAt is ISO date");
  {
    const r = await get("/api/admin/platform/deploy-health");
    assertIso(r.body.checkedAt, "top-level checkedAt");
    assertIso(r.body.environmentValidation.checkedAt, "env checkedAt");
  }

  section("S40: deploy-health — overall healthy in deployed env");
  {
    const r = await get("/api/admin/platform/deploy-health");
    assert(r.status === 200 || r.status === 503, "status is 200 or 503");
    const isHealthy = r.body.migrationStatus?.safe && r.body.environmentValidation?.valid;
    assert(isHealthy === true, "platform healthy: no drift + env valid");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S41–S50: runMigrationGuard assertions
  // ══════════════════════════════════════════════════════════════════════════

  section("S41: runMigrationGuard — safe is true (clean schema)");
  {
    const { runMigrationGuard } = await import("./server/lib/migrations/migration-guard");
    const result = await runMigrationGuard();
    assert(result.safe === true, "migration guard safe");
    assertEq(result.issues.length, 0, "zero issues");
  }

  section("S42: runMigrationGuard — no schema drift");
  {
    const { runMigrationGuard } = await import("./server/lib/migrations/migration-guard");
    const result = await runMigrationGuard();
    assert(result.schemaDriftDetected === false, "no schema drift");
  }

  section("S43: runMigrationGuard — no destructive ops");
  {
    const { runMigrationGuard } = await import("./server/lib/migrations/migration-guard");
    const result = await runMigrationGuard();
    assert(result.destructiveOpsDetected === false, "no destructive ops detected");
  }

  section("S44: runMigrationGuard — pending count is 0");
  {
    const { runMigrationGuard } = await import("./server/lib/migrations/migration-guard");
    const result = await runMigrationGuard();
    assertEq(result.pendingMigrationsCount, 0, "pendingMigrationsCount = 0");
  }

  section("S45: runMigrationGuard — schemaVersion is stable");
  {
    const { runMigrationGuard } = await import("./server/lib/migrations/migration-guard");
    const r1 = await runMigrationGuard();
    const r2 = await runMigrationGuard();
    assert(r1.schemaVersion.split(".")[1] === r2.schemaVersion.split(".")[1], "table count part of version is stable");
  }

  section("S46: runMigrationGuard — checkedAt advances over time");
  {
    const { runMigrationGuard } = await import("./server/lib/migrations/migration-guard");
    const r1 = await runMigrationGuard();
    await new Promise(r => setTimeout(r, 10));
    const r2 = await runMigrationGuard();
    assert(new Date(r2.checkedAt) >= new Date(r1.checkedAt), "checkedAt advances");
  }

  section("S47: scanForDestructiveOps — detects ALTER COLUMN TYPE");
  {
    const { scanForDestructiveOps } = await import("./server/lib/migrations/migration-guard");
    const sql = "ALTER TABLE users ALTER COLUMN email TYPE varchar(500);";
    const results = scanForDestructiveOps(sql);
    const alter = results.find(r => r.description.includes("ALTER COLUMN TYPE"));
    assert(alter?.detected === true, "ALTER COLUMN TYPE detected");
  }

  section("S48: scanForDestructiveOps — detects DROP INDEX");
  {
    const { scanForDestructiveOps } = await import("./server/lib/migrations/migration-guard");
    const results = scanForDestructiveOps("DROP INDEX users_email_idx;");
    const dropIdx = results.find(r => r.description.includes("DROP INDEX"));
    assert(dropIdx?.detected === true, "DROP INDEX detected");
  }

  section("S49: scanForDestructiveOps — multiple issues detected");
  {
    const { scanForDestructiveOps } = await import("./server/lib/migrations/migration-guard");
    const sql = "DROP TABLE old_table; TRUNCATE audit_log; DROP COLUMN x;";
    const results = scanForDestructiveOps(sql);
    const detectedCount = results.filter(r => r.detected).length;
    assert(detectedCount >= 3, `at least 3 destructive ops detected (got ${detectedCount})`);
  }

  section("S50: scanForDestructiveOps — INSERT/UPDATE not flagged");
  {
    const { scanForDestructiveOps } = await import("./server/lib/migrations/migration-guard");
    const sql = "INSERT INTO logs (msg) VALUES ('hello'); UPDATE users SET name='x' WHERE id=1;";
    const results = scanForDestructiveOps(sql);
    assert(results.filter(r => r.detected).length === 0, "INSERT/UPDATE not flagged as destructive");
  }

  // ══════════════════════════════════════════════════════════════════════════
  // S51–S60: CI pipeline file + prior phase regression
  // ══════════════════════════════════════════════════════════════════════════

  section("S51: ci.yml — file exists");
  {
    const { existsSync } = await import("fs");
    assert(existsSync(".github/workflows/ci.yml"), ".github/workflows/ci.yml exists");
  }

  section("S52: ci.yml — contains all 7 pipeline steps");
  {
    const { readFileSync } = await import("fs");
    const yml = readFileSync(".github/workflows/ci.yml", "utf-8");
    assert(yml.includes("typecheck"), "ci.yml has typecheck step");
    assert(yml.includes("lint"), "ci.yml has lint step");
    assert(yml.includes("unit-tests") || yml.includes("unit tests"), "ci.yml has unit-tests step");
    assert(yml.includes("schema-validation") || yml.includes("schema validation"), "ci.yml has schema-validation step");
    assert(yml.includes("migration-verification") || yml.includes("migration verification"), "ci.yml has migration-verification step");
    assert(yml.includes("security-scan") || yml.includes("security scan"), "ci.yml has security-scan step");
    assert(yml.includes("build-verification") || yml.includes("build verification"), "ci.yml has build-verification step");
  }

  section("S53: ci.yml — triggers on push and PR");
  {
    const { readFileSync } = await import("fs");
    const yml = readFileSync(".github/workflows/ci.yml", "utf-8");
    assert(yml.includes("push:"), "ci.yml triggers on push");
    assert(yml.includes("pull_request:"), "ci.yml triggers on pull_request");
  }

  section("S54: ci.yml — uses actions/checkout and setup-node");
  {
    const { readFileSync } = await import("fs");
    const yml = readFileSync(".github/workflows/ci.yml", "utf-8");
    assert(yml.includes("actions/checkout"), "ci.yml uses actions/checkout");
    assert(yml.includes("actions/setup-node"), "ci.yml uses actions/setup-node");
  }

  section("S55: scripts/validate-schema.ts — file exists");
  {
    const { existsSync } = await import("fs");
    assert(existsSync("scripts/validate-schema.ts"), "scripts/validate-schema.ts exists");
  }

  section("S56: scripts/validate-schema.ts — references core tables");
  {
    const { readFileSync } = await import("fs");
    const src = readFileSync("scripts/validate-schema.ts", "utf-8");
    assert(src.includes("tenant_ai_budgets"), "validate-schema references tenant_ai_budgets");
    assert(src.includes("data_retention_policies"), "validate-schema references data_retention_policies");
    assert(src.includes("legal_holds"), "validate-schema references legal_holds");
    assert(src.includes("ai_policies"), "validate-schema references ai_policies");
  }

  section("S57: Phase 27 route regression — ops/system-health still works");
  {
    const r = await get("/api/admin/ops/system-health");
    assert(r.status !== 404, "ops/system-health not 404");
    assert(r.status !== 500, "ops/system-health not 500");
  }

  section("S58: Phase 26 route regression — compliance/retention still works");
  {
    const r = await get("/api/admin/compliance/retention-policies");
    assert(r.status !== 404, "compliance/retention-policies not 404");
    assert(r.status !== 500, "compliance/retention-policies not 500");
  }

  section("S59: Phase 25 route regression — platform/health still works");
  {
    const r = await get("/api/admin/platform/health");
    assert(r.status !== 404, "platform/health not 404");
    assert(r.status !== 500, "platform/health not 500");
  }

  section("S60: deploy-health — concurrent calls are stable");
  {
    const results = await Promise.all([
      get("/api/admin/platform/deploy-health"),
      get("/api/admin/platform/deploy-health"),
      get("/api/admin/platform/deploy-health"),
    ]);
    assert(results.every(r => r.status !== 500), "concurrent deploy-health calls don't 500");
    assert(results.every(r => "schemaVersion" in r.body), "concurrent calls all have schemaVersion");
    const versions = results.map(r => r.body.schemaVersion);
    assert(new Set(versions).size === 1, "schemaVersion consistent across concurrent calls");
  }

  // ── Final summary ─────────────────────────────────────────────────────────

  console.log("\n───────────────────────────────────────────────────────");
  console.log(`Phase 28 validation: ${passed} passed, ${failed} failed`);

  if (failed === 0) {
    console.log("✔ All assertions passed");
    process.exit(0);
  } else {
    console.log(`✖ ${failed} assertion(s) failed`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error("Validation error:", err.message);
  process.exit(1);
});
