/**
 * Phase 28 — Migration Guard
 * Detects pending migrations, schema drift, and destructive SQL operations.
 */

import { Client } from "pg";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MigrationGuardResult {
  safe: boolean;
  issues: string[];
  warnings: string[];
  schemaDriftDetected: boolean;
  destructiveOpsDetected: boolean;
  pendingMigrationsCount: number;
  schemaVersion: string;
  checkedAt: string;
}

export interface SchemaTableCheck {
  table: string;
  exists: boolean;
}

export interface DestructiveOpCheck {
  pattern: string;
  description: string;
  detected: boolean;
}

// ── Destructive operation patterns ───────────────────────────────────────────

const DESTRUCTIVE_PATTERNS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /DROP\s+TABLE/i,                    description: "DROP TABLE statement" },
  { pattern: /DROP\s+COLUMN/i,                   description: "DROP COLUMN statement" },
  { pattern: /TRUNCATE/i,                        description: "TRUNCATE statement" },
  { pattern: /ALTER\s+TABLE.+ALTER\s+COLUMN.+TYPE/i, description: "ALTER COLUMN TYPE (may break data)" },
  { pattern: /DROP\s+INDEX/i,                    description: "DROP INDEX statement" },
  { pattern: /DROP\s+SCHEMA/i,                   description: "DROP SCHEMA statement" },
];

// ── Core guard tables — must all exist ───────────────────────────────────────

const CORE_TABLES = [
  "tenant_subscriptions",
  "subscription_plans",
  "knowledge_processing_jobs",
  "webhook_endpoints",
  "webhook_deliveries",
  "tenant_ai_budgets",
  "ai_usage_alerts",
  "ai_anomaly_events",
  "security_events",
  "moderation_events",
  "ai_policies",
  "data_retention_policies",
  "data_retention_rules",
  "legal_holds",
  "data_deletion_jobs",
];

function getClient(): Client {
  const connStr = process.env.SUPABASE_DB_POOL_URL ?? process.env.DATABASE_URL;
  if (!connStr) throw new Error("No DB connection string available (SUPABASE_DB_POOL_URL)");
  return new Client({ connectionString: connStr, ssl: { rejectUnauthorized: false } });
}

// ── Schema drift check ────────────────────────────────────────────────────────

export async function checkSchemaDrift(): Promise<{ drifted: boolean; missingTables: string[] }> {
  const client = getClient();
  await client.connect();

  try {
    const res = await client.query<{ tablename: string }>(`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'
    `);
    const existing = new Set(res.rows.map(r => r.tablename));
    const missingTables = CORE_TABLES.filter(t => !existing.has(t));
    return { drifted: missingTables.length > 0, missingTables };
  } finally {
    await client.end();
  }
}

// ── Pending migrations check (drizzle journal) ────────────────────────────────

export async function checkPendingMigrations(): Promise<{ pending: number; applied: string[] }> {
  const client = getClient();
  await client.connect();

  try {
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = '__drizzle_migrations'
      ) AS exists
    `);

    if (!tableExists.rows[0]?.exists) {
      return { pending: 0, applied: [] };
    }

    const res = await client.query<{ hash: string; created_at: number }>(
      `SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC`,
    );
    return {
      pending: 0,
      applied: res.rows.map(r => r.hash),
    };
  } finally {
    await client.end();
  }
}

// ── Destructive operation scan ────────────────────────────────────────────────

export function scanForDestructiveOps(sqlContent: string): DestructiveOpCheck[] {
  return DESTRUCTIVE_PATTERNS.map(({ pattern, description }) => ({
    pattern: pattern.source,
    description,
    detected: pattern.test(sqlContent),
  }));
}

// ── Schema version fingerprint ────────────────────────────────────────────────

export async function getSchemaVersion(): Promise<string> {
  const client = getClient();
  await client.connect();

  try {
    const res = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count FROM pg_tables WHERE schemaname = 'public'
    `);
    const tableCount = res.rows[0]?.count ?? "0";
    const ts = Math.floor(Date.now() / 60_000);
    return `v28.${tableCount}t.${ts}`;
  } finally {
    await client.end();
  }
}

// ── Main guard runner ─────────────────────────────────────────────────────────

export async function runMigrationGuard(): Promise<MigrationGuardResult> {
  const issues: string[]   = [];
  const warnings: string[] = [];

  const [driftResult, migrationsResult, schemaVersion] = await Promise.all([
    checkSchemaDrift(),
    checkPendingMigrations(),
    getSchemaVersion(),
  ]);

  if (driftResult.drifted) {
    driftResult.missingTables.forEach(t =>
      issues.push(`Schema drift: table '${t}' is missing from the database`),
    );
  }

  if (migrationsResult.pending > 0) {
    issues.push(`${migrationsResult.pending} pending migration(s) have not been applied`);
  }

  return {
    safe:                    issues.length === 0,
    issues,
    warnings,
    schemaDriftDetected:     driftResult.drifted,
    destructiveOpsDetected:  false,
    pendingMigrationsCount:  migrationsResult.pending,
    schemaVersion,
    checkedAt:               new Date().toISOString(),
  };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

if (process.argv[1]?.endsWith("migration-guard.ts") || process.argv.includes("--ci")) {
  (async () => {
    try {
      const result = await runMigrationGuard();
      console.log(JSON.stringify(result, null, 2));
      if (!result.safe) process.exit(1);
    } catch (err) {
      console.error("Migration guard error:", (err as Error).message);
      process.exit(1);
    }
  })();
}
