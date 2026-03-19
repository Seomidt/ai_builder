#!/usr/bin/env npx tsx
/**
 * Phase 28 — Schema Validation Script
 * Verifies tables, columns, RLS policies, and indexes exist in the database.
 * Exit code 0 = all checks pass. Exit code 1 = failures detected.
 */

import { Client } from "pg";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TableSpec {
  table: string;
  requiredColumns: string[];
  rlsRequired?: boolean;
  indexes?: string[];
}

interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
}

// ── Schema specification ──────────────────────────────────────────────────────

const SCHEMA_SPEC: TableSpec[] = [
  // Phase 16 — AI Cost Governance
  {
    table: "tenant_ai_budgets",
    requiredColumns: ["id", "tenant_id", "monthly_budget_usd", "daily_budget_usd", "created_at"],
    rlsRequired: false,
    indexes: ["tab_tenant_idx"],
  },
  {
    table: "ai_usage_alerts",
    requiredColumns: ["id", "tenant_id", "alert_type", "threshold_value", "current_value", "created_at"],
    rlsRequired: false,
    indexes: ["aua_tenant_idx"],
  },
  {
    table: "ai_anomaly_events",
    requiredColumns: ["id", "tenant_id", "event_type", "observed_value", "created_at"],
    rlsRequired: false,
  },
  {
    table: "tenant_ai_usage_snapshots",
    requiredColumns: ["id", "tenant_id", "snapshot_date", "created_at"],
    rlsRequired: false,
  },
  // Phase 26 — Compliance & Retention
  {
    table: "data_retention_policies",
    requiredColumns: ["id", "policy_key", "table_name", "retention_days", "active", "created_at"],
    rlsRequired: false,
    indexes: ["drp26_policy_key_idx"],
  },
  {
    table: "data_retention_rules",
    requiredColumns: ["id", "policy_id", "rule_type", "active", "created_at"],
    rlsRequired: false,
  },
  {
    table: "legal_holds",
    requiredColumns: ["id", "tenant_id", "hold_type", "active", "created_at"],
    rlsRequired: false,
    indexes: ["lh_tenant_idx"],
  },
  {
    table: "data_deletion_jobs",
    requiredColumns: ["id", "tenant_id", "policy_id", "status", "created_at"],
    rlsRequired: false,
    indexes: ["ddj_tenant_idx"],
  },
  // Core platform tables
  {
    table: "tenant_subscriptions",
    requiredColumns: ["id", "tenant_id", "status", "created_at"],
    rlsRequired: false,
  },
  {
    table: "subscription_plans",
    requiredColumns: ["id", "plan_code", "plan_name", "created_at"],
    rlsRequired: false,
  },
  {
    table: "knowledge_processing_jobs",
    requiredColumns: ["id", "tenant_id", "job_type", "status", "created_at"],
    rlsRequired: false,
  },
  {
    table: "webhook_endpoints",
    requiredColumns: ["id", "tenant_id", "url", "active", "created_at"],
    rlsRequired: false,
  },
  {
    table: "webhook_deliveries",
    requiredColumns: ["id", "endpoint_id", "status", "created_at"],
    rlsRequired: false,
  },
  {
    table: "security_events",
    requiredColumns: ["id", "tenant_id", "event_type", "created_at"],
    rlsRequired: false,
  },
  {
    table: "moderation_events",
    requiredColumns: ["id", "tenant_id", "event_type", "result", "created_at"],
    rlsRequired: false,
  },
  {
    table: "ai_policies",
    requiredColumns: ["id", "policy_key", "enabled", "created_at"],
    rlsRequired: false,
  },
];

// ── DB helpers ────────────────────────────────────────────────────────────────

function getClient(): Client {
  const connStr = process.env.SUPABASE_DB_POOL_URL ?? process.env.DATABASE_URL;
  if (!connStr) throw new Error("No connection string: set SUPABASE_DB_POOL_URL");
  return new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
}

async function getExistingTables(client: Client): Promise<Set<string>> {
  const res = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  return new Set(res.rows.map(r => r.tablename));
}

async function getTableColumns(client: Client, table: string): Promise<Set<string>> {
  const res = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
    [table],
  );
  return new Set(res.rows.map(r => r.column_name));
}

async function getRlsTables(client: Client): Promise<Set<string>> {
  const res = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND rowsecurity=TRUE`,
  );
  return new Set(res.rows.map(r => r.tablename));
}

async function getIndexes(client: Client): Promise<Set<string>> {
  const res = await client.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname='public'`,
  );
  return new Set(res.rows.map(r => r.indexname));
}

// ── Runner ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const client = getClient();
  await client.connect();

  const results: CheckResult[] = [];

  try {
    const [existingTables, rlsTables, existingIndexes] = await Promise.all([
      getExistingTables(client),
      getRlsTables(client),
      getIndexes(client),
    ]);

    for (const spec of SCHEMA_SPEC) {
      // Table exists
      if (!existingTables.has(spec.table)) {
        results.push({ name: `table:${spec.table}`, passed: false, message: `Table '${spec.table}' does not exist` });
        continue;
      }
      results.push({ name: `table:${spec.table}`, passed: true, message: `Table '${spec.table}' exists` });

      // Required columns
      const cols = await getTableColumns(client, spec.table);
      for (const col of spec.requiredColumns) {
        const present = cols.has(col);
        results.push({
          name:    `column:${spec.table}.${col}`,
          passed:  present,
          message: present ? `Column '${spec.table}.${col}' present` : `MISSING column '${spec.table}.${col}'`,
        });
      }

      // RLS
      if (spec.rlsRequired) {
        const hasRls = rlsTables.has(spec.table);
        results.push({
          name:    `rls:${spec.table}`,
          passed:  hasRls,
          message: hasRls ? `RLS enabled on '${spec.table}'` : `RLS NOT enabled on '${spec.table}'`,
        });
      }

      // Indexes
      for (const idx of spec.indexes ?? []) {
        const present = existingIndexes.has(idx);
        results.push({
          name:    `index:${idx}`,
          passed:  present,
          message: present ? `Index '${idx}' exists` : `MISSING index '${idx}'`,
        });
      }
    }
  } finally {
    await client.end();
  }

  // ── Report ────────────────────────────────────────────────────────────────
  const passed  = results.filter(r => r.passed);
  const failed  = results.filter(r => !r.passed);

  console.log("\n═══════════════════════════════════════════════════════");
  console.log("Schema Validation — AI Builder Platform");
  console.log("═══════════════════════════════════════════════════════\n");

  for (const r of results) {
    const icon = r.passed ? "✔" : "✖";
    console.log(`  ${icon} ${r.message}`);
  }

  console.log(`\n───────────────────────────────────────────────────────`);
  console.log(`Passed: ${passed.length} / ${results.length}`);

  if (failed.length > 0) {
    console.log(`\nFAILED CHECKS (${failed.length}):`);
    for (const f of failed) {
      console.log(`  ✖ ${f.message}`);
    }
    process.exit(1);
  } else {
    console.log("✔ All schema checks passed");
    process.exit(0);
  }
}

main().catch(err => {
  console.error("Schema validation error:", err.message);
  process.exit(1);
});
