/**
 * Phase 36 — Schema Integrity Validator
 *
 * Detects schema drift by verifying critical tables, columns and indexes
 * exist in the connected database.
 *
 * All queries are read-only.
 */

import { Client } from "pg";

const DB_URL =
  process.env.SUPABASE_DB_POOL_URL ||
  process.env.DATABASE_URL ||
  "";

export const CRITICAL_TABLES: readonly string[] = [
  "tenants",
  "tenant_ai_budgets",
  "tenant_ai_usage_snapshots",
  "ai_usage_alerts",
  "gov_anomaly_events",
  "ops_ai_audit_logs",
  "jobs",
  "webhook_deliveries",
  "webhook_endpoints",
  "invoices",
] as const;

export const REQUIRED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "tenants", column: "id" },
  { table: "tenants", column: "created_at" },
  { table: "tenants", column: "language" },
  { table: "tenants", column: "locale" },
  { table: "tenants", column: "currency" },
  { table: "tenants", column: "timezone" },
  { table: "tenants", column: "lifecycle_status" },
  { table: "jobs",    column: "status" },
  { table: "jobs",    column: "job_type" },
  { table: "jobs",    column: "tenant_id" },
  { table: "webhook_deliveries", column: "status" },
  { table: "webhook_deliveries", column: "tenant_id" },
  { table: "ai_usage_alerts",    column: "triggered_at" },
  { table: "ai_usage_alerts",    column: "usage_percent" },
] as const;

export const REQUIRED_INDEXES: readonly string[] = [
  "idx_usage_tenant_created",
  "idx_alerts_tenant_created",
  "idx_anomaly_tenant_created",
  "idx_audit_tenant_created",
  "idx_webhooks_tenant_created",
  "idx_jobs_tenant_created",
] as const;

export interface SchemaValidationResult {
  schemaValid: boolean;
  missingTables: string[];
  missingColumns: string[];
  missingIndexes: string[];
  presentTables: string[];
  presentIndexes: string[];
  checkedAt: string;
}

export async function validateSchema(): Promise<SchemaValidationResult> {
  const client = new Client({ connectionString: DB_URL });

  try {
    await client.connect();

    const [tableRes, columnRes, indexRes] = await Promise.all([
      // Check table existence
      client.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public'
           AND table_name = ANY($1::text[])`,
        [Array.from(CRITICAL_TABLES)],
      ),
      // Check column existence
      client.query<{ table_name: string; column_name: string }>(
        `SELECT table_name, column_name
         FROM information_schema.columns
         WHERE table_schema = 'public'`,
      ),
      // Check index existence
      client.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname = ANY($1::text[])`,
        [Array.from(REQUIRED_INDEXES)],
      ),
    ]);

    const presentTables = new Set(tableRes.rows.map(r => r.table_name));
    const presentCols   = new Set(
      columnRes.rows.map(r => `${r.table_name}.${r.column_name}`),
    );
    const presentIndexes = new Set(indexRes.rows.map(r => r.indexname));

    const missingTables = CRITICAL_TABLES.filter(t => !presentTables.has(t));
    const missingColumns = REQUIRED_COLUMNS
      .filter(c => !presentCols.has(`${c.table}.${c.column}`))
      .map(c => `${c.table}.${c.column}`);
    const missingIndexes = REQUIRED_INDEXES.filter(i => !presentIndexes.has(i));

    return {
      schemaValid:  missingTables.length === 0 && missingColumns.length === 0 && missingIndexes.length === 0,
      missingTables,
      missingColumns,
      missingIndexes,
      presentTables:  Array.from(presentTables),
      presentIndexes: Array.from(presentIndexes),
      checkedAt: new Date().toISOString(),
    };
  } finally {
    await client.end().catch(() => {});
  }
}
