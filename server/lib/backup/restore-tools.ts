/**
 * Phase 29 — Restore Tools
 * Dry-run restore planning for single-tenant, single-table, and full-database scenarios.
 * Does NOT execute destructive operations — generates restore plans for operator review.
 */

import { Client } from "pg";

// ── Types ─────────────────────────────────────────────────────────────────────

export type RestoreType   = "single_tenant" | "single_table" | "full_database";
export type RestoreStatus = "planned" | "validated" | "blocked" | "not_applicable";

export interface RestorePlan {
  planId:       string;
  restoreType:  RestoreType;
  status:       RestoreStatus;
  targetTenantId?: string;
  targetTable?:    string;
  estimatedRows:   number;
  blockers:        string[];
  steps:           string[];
  warningMessages: string[];
  dryRun:          boolean;
  createdAt:       string;
}

export interface TenantRestoreEligibility {
  tenantId:   string;
  eligible:   boolean;
  issues:     string[];
  tableCount: number;
  rowCount:   number;
}

export interface TableRestoreEligibility {
  tableName:  string;
  eligible:   boolean;
  rowCount:   number;
  issues:     string[];
  hasIndexes: boolean;
  hasFk:      boolean;
}

export interface FullDbRestorePlan {
  eligible:         boolean;
  estimatedMinutes: number;
  requiredSteps:    string[];
  blockers:         string[];
  pitrAvailable:    boolean;
}

// ── DB helper ─────────────────────────────────────────────────────────────────

function getClient(): Client {
  return new Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

function planId(): string {
  return `rp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── Single-tenant restore ─────────────────────────────────────────────────────

export async function planTenantRestore(
  tenantId: string,
  dryRun = true,
): Promise<RestorePlan> {
  const client = getClient();
  await client.connect();
  const blockers: string[]  = [];
  const steps:    string[]  = [];
  const warnings: string[]  = [];
  let estimatedRows = 0;

  try {
    // Check legal holds
    const holdRes = await client.query<{ cnt: string }>(`
      SELECT COUNT(*)::text AS cnt FROM legal_holds
      WHERE tenant_id = $1 AND active = TRUE
    `, [tenantId]);
    const holds = parseInt(holdRes.rows[0]?.cnt ?? "0", 10);
    if (holds > 0) {
      blockers.push(`${holds} active legal hold(s) — restore may violate hold requirements`);
    }

    // Estimate affected rows across key tables
    const tenantTables = [
      "knowledge_processing_jobs",
      "webhook_deliveries",
      "moderation_events",
      "security_events",
    ];

    for (const t of tenantTables) {
      try {
        const r = await client.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM ${t} WHERE tenant_id = $1`,
          [tenantId],
        );
        estimatedRows += parseInt(r.rows[0]?.cnt ?? "0", 10);
      } catch { /* table may not have tenant_id */ }
    }

    steps.push("1. Verify legal hold status — confirm restore is permitted");
    steps.push("2. Snapshot current tenant state (pre-restore checkpoint)");
    steps.push("3. Pause all active jobs for tenant");
    steps.push("4. Restore tenant data from PITR target timestamp");
    steps.push("5. Validate referential integrity post-restore");
    steps.push("6. Resume tenant jobs and verify connectivity");
    steps.push("7. Notify tenant of restore completion");

    if (holds > 0) warnings.push("Legal hold active — get legal sign-off before proceeding");

    return {
      planId:        planId(),
      restoreType:   "single_tenant",
      status:        blockers.length > 0 ? "blocked" : "planned",
      targetTenantId: tenantId,
      estimatedRows,
      blockers,
      steps,
      warningMessages: warnings,
      dryRun,
      createdAt:     new Date().toISOString(),
    };
  } finally {
    await client.end();
  }
}

// ── Single-table restore ──────────────────────────────────────────────────────

export async function planTableRestore(
  tableName: string,
  dryRun = true,
): Promise<RestorePlan> {
  const client  = getClient();
  await client.connect();
  const blockers: string[] = [];
  const steps:    string[] = [];
  const warnings: string[] = [];

  try {
    // Verify table exists
    const existsRes = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = $1
      ) AS exists
    `, [tableName]);

    if (!existsRes.rows[0]?.exists) {
      blockers.push(`Table '${tableName}' does not exist`);
      return {
        planId:         planId(),
        restoreType:    "single_table",
        status:         "blocked",
        targetTable:    tableName,
        estimatedRows:  0,
        blockers,
        steps:          [],
        warningMessages: [],
        dryRun,
        createdAt:      new Date().toISOString(),
      };
    }

    const rowRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM ${tableName}`,
    );
    const estimatedRows = parseInt(rowRes.rows[0]?.cnt ?? "0", 10);

    // Check for foreign key dependencies
    const fkRes = await client.query<{ cnt: string }>(`
      SELECT COUNT(*)::text AS cnt
      FROM information_schema.table_constraints
      WHERE constraint_type = 'FOREIGN KEY'
        AND (table_name = $1 OR constraint_name LIKE $2)
      `, [tableName, `%${tableName}%`]);
    const hasFk = parseInt(fkRes.rows[0]?.cnt ?? "0", 10) > 0;
    if (hasFk) warnings.push("Table has foreign key constraints — restore order matters");

    steps.push(`1. Export current '${tableName}' data to staging (pre-restore snapshot)`);
    steps.push(`2. Disable triggers and FK checks on '${tableName}'`);
    steps.push(`3. TRUNCATE '${tableName}' (within transaction)`);
    steps.push(`4. INSERT restored rows from PITR source`);
    steps.push(`5. Re-enable constraints and verify count (expected: ~${estimatedRows})`);
    steps.push("6. Run ANALYZE to update query planner statistics");

    return {
      planId:         planId(),
      restoreType:    "single_table",
      status:         "planned",
      targetTable:    tableName,
      estimatedRows,
      blockers,
      steps,
      warningMessages: warnings,
      dryRun,
      createdAt:      new Date().toISOString(),
    };
  } finally {
    await client.end();
  }
}

// ── Full database restore ─────────────────────────────────────────────────────

export async function planFullDbRestore(): Promise<FullDbRestorePlan> {
  const client = getClient();
  await client.connect();
  const blockers: string[] = [];

  try {
    // Check active legal holds globally
    const holdRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM legal_holds WHERE active = TRUE`,
    );
    const holds = parseInt(holdRes.rows[0]?.cnt ?? "0", 10);
    if (holds > 0) {
      blockers.push(`${holds} active legal hold(s) must be resolved before full restore`);
    }

    // Estimate table count
    const tableRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM pg_tables WHERE schemaname = 'public'`,
    );
    const tableCount = parseInt(tableRes.rows[0]?.cnt ?? "0", 10);

    return {
      eligible:         blockers.length === 0,
      estimatedMinutes: Math.max(5, Math.ceil(tableCount / 10) * 2),
      requiredSteps: [
        "1. Open incident channel — notify all on-call engineers",
        "2. Put platform in maintenance mode (disable ingress)",
        "3. Create current state snapshot for forensic analysis",
        "4. Identify PITR target timestamp with data team",
        "5. Initiate Supabase PITR restore from dashboard or API",
        "6. Wait for restore to complete — monitor progress",
        "7. Run validate-schema.ts to verify all tables and indexes",
        "8. Run validate-phase28.ts (migration guard) to confirm no drift",
        "9. Smoke test critical paths: auth, billing, AI inference",
        "10. Disable maintenance mode and monitor error rates",
      ],
      blockers,
      pitrAvailable: true,
    };
  } finally {
    await client.end();
  }
}

// ── Eligibility checks ────────────────────────────────────────────────────────

export async function checkTenantRestoreEligibility(
  tenantId: string,
): Promise<TenantRestoreEligibility> {
  const plan = await planTenantRestore(tenantId);
  return {
    tenantId,
    eligible:   plan.status !== "blocked",
    issues:     plan.blockers,
    tableCount: 4,
    rowCount:   plan.estimatedRows,
  };
}

export async function checkTableRestoreEligibility(
  tableName: string,
): Promise<TableRestoreEligibility> {
  const client = getClient();
  await client.connect();
  const issues: string[] = [];

  try {
    const existsRes = await client.query<{ exists: boolean }>(`
      SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name=$1
      ) AS exists
    `, [tableName]);

    if (!existsRes.rows[0]?.exists) {
      return { tableName, eligible: false, rowCount: 0, issues: [`Table '${tableName}' not found`], hasIndexes: false, hasFk: false };
    }

    const rowRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM ${tableName}`,
    );
    const rowCount = parseInt(rowRes.rows[0]?.cnt ?? "0", 10);

    const idxRes = await client.query<{ cnt: string }>(
      `SELECT COUNT(*)::text AS cnt FROM pg_indexes WHERE schemaname='public' AND tablename=$1`,
      [tableName],
    );
    const hasIndexes = parseInt(idxRes.rows[0]?.cnt ?? "0", 10) > 0;

    const fkRes = await client.query<{ cnt: string }>(`
      SELECT COUNT(*)::text AS cnt FROM information_schema.table_constraints
      WHERE constraint_type='FOREIGN KEY' AND table_name=$1
    `, [tableName]);
    const hasFk = parseInt(fkRes.rows[0]?.cnt ?? "0", 10) > 0;

    return { tableName, eligible: true, rowCount, issues, hasIndexes, hasFk };
  } finally {
    await client.end();
  }
}
