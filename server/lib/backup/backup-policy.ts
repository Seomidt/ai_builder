/**
 * Phase 29 — Backup Policy
 * Defines backup schedules, retention windows, and encryption requirements.
 */

import { Client } from "pg";

// ── Types ─────────────────────────────────────────────────────────────────────

export type BackupFrequency = "hourly" | "daily" | "weekly" | "monthly";
export type BackupScope     = "full" | "incremental" | "tenant" | "table";

export interface BackupPolicy {
  policyId:          string;
  name:              string;
  frequency:         BackupFrequency;
  scope:             BackupScope;
  retentionDays:     number;
  encryptionRequired: boolean;
  compressionEnabled: boolean;
  targetTables:      string[];
  enabled:           boolean;
  createdAt:         string;
}

export interface BackupRetentionRule {
  scope:         BackupScope;
  retentionDays: number;
  minCopies:     number;
  encryptAtRest: boolean;
}

export interface EncryptionValidationResult {
  valid:             boolean;
  algorithm:         string;
  keyRotationDue:    boolean;
  lastRotatedAt:     string | null;
  issues:            string[];
}

export interface BackupPolicySummary {
  totalPolicies:   number;
  enabledPolicies: number;
  policies:        BackupPolicy[];
  retentionRules:  BackupRetentionRule[];
  checkedAt:       string;
}

// ── Default policy registry ───────────────────────────────────────────────────

export const DEFAULT_BACKUP_POLICIES: BackupPolicy[] = [
  {
    policyId:           "bp-daily-full",
    name:               "Daily Full Backup",
    frequency:          "daily",
    scope:              "full",
    retentionDays:      30,
    encryptionRequired: true,
    compressionEnabled: true,
    targetTables:       [],
    enabled:            true,
    createdAt:          new Date().toISOString(),
  },
  {
    policyId:           "bp-hourly-incremental",
    name:               "Hourly Incremental Backup",
    frequency:          "hourly",
    scope:              "incremental",
    retentionDays:      7,
    encryptionRequired: true,
    compressionEnabled: true,
    targetTables:       [],
    enabled:            true,
    createdAt:          new Date().toISOString(),
  },
  {
    policyId:           "bp-weekly-tenant",
    name:               "Weekly Per-Tenant Snapshot",
    frequency:          "weekly",
    scope:              "tenant",
    retentionDays:      90,
    encryptionRequired: true,
    compressionEnabled: false,
    targetTables:       [],
    enabled:            true,
    createdAt:          new Date().toISOString(),
  },
  {
    policyId:           "bp-monthly-archive",
    name:               "Monthly Archive",
    frequency:          "monthly",
    scope:              "full",
    retentionDays:      365,
    encryptionRequired: true,
    compressionEnabled: true,
    targetTables:       [],
    enabled:            true,
    createdAt:          new Date().toISOString(),
  },
];

export const RETENTION_RULES: BackupRetentionRule[] = [
  { scope: "full",        retentionDays: 30,  minCopies: 2, encryptAtRest: true },
  { scope: "incremental", retentionDays: 7,   minCopies: 3, encryptAtRest: true },
  { scope: "tenant",      retentionDays: 90,  minCopies: 1, encryptAtRest: true },
  { scope: "table",       retentionDays: 14,  minCopies: 1, encryptAtRest: false },
];

// ── Encryption validation ─────────────────────────────────────────────────────

export function validateBackupEncryption(): EncryptionValidationResult {
  const issues: string[] = [];
  const keyRotationDays  = 90;
  const lastRotated      = process.env.BACKUP_KEY_LAST_ROTATED ?? null;
  let   keyRotationDue   = false;

  if (!process.env.BACKUP_ENCRYPTION_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    issues.push("No backup encryption key configured (BACKUP_ENCRYPTION_KEY missing)");
  }

  if (lastRotated) {
    const daysSinceRotation = Math.floor(
      (Date.now() - new Date(lastRotated).getTime()) / 86_400_000,
    );
    if (daysSinceRotation > keyRotationDays) {
      keyRotationDue = true;
      issues.push(`Encryption key last rotated ${daysSinceRotation}d ago — rotation due every ${keyRotationDays}d`);
    }
  }

  return {
    valid:          issues.length === 0,
    algorithm:      "AES-256-GCM",
    keyRotationDue,
    lastRotatedAt:  lastRotated,
    issues,
  };
}

// ── Policy helpers ────────────────────────────────────────────────────────────

export function getPolicyById(id: string): BackupPolicy | undefined {
  return DEFAULT_BACKUP_POLICIES.find(p => p.policyId === id);
}

export function getEnabledPolicies(): BackupPolicy[] {
  return DEFAULT_BACKUP_POLICIES.filter(p => p.enabled);
}

export function getRetentionForScope(scope: BackupScope): BackupRetentionRule | undefined {
  return RETENTION_RULES.find(r => r.scope === scope);
}

export function isRetentionCompliant(
  backupAgedays: number,
  scope: BackupScope,
): boolean {
  const rule = getRetentionForScope(scope);
  if (!rule) return true;
  return backupAgedays <= rule.retentionDays;
}

// ── Summary ───────────────────────────────────────────────────────────────────

export async function getBackupPolicySummary(): Promise<BackupPolicySummary> {
  return {
    totalPolicies:   DEFAULT_BACKUP_POLICIES.length,
    enabledPolicies: getEnabledPolicies().length,
    policies:        DEFAULT_BACKUP_POLICIES,
    retentionRules:  RETENTION_RULES,
    checkedAt:       new Date().toISOString(),
  };
}

// ── DB-level policy metadata ──────────────────────────────────────────────────

export async function getDbBackupMetadata(): Promise<{
  dbSizeBytes:       number;
  tableCount:        number;
  estimatedBackupMb: number;
  checkedAt:         string;
}> {
  const client = new Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const sizeRes  = await client.query<{ size: string }>(`
      SELECT pg_database_size(current_database())::text AS size
    `);
    const countRes = await client.query<{ cnt: string }>(`
      SELECT COUNT(*)::text AS cnt FROM pg_tables WHERE schemaname='public'
    `);

    const sizeBytes = parseInt(sizeRes.rows[0]?.size ?? "0", 10);
    const tableCount = parseInt(countRes.rows[0]?.cnt ?? "0", 10);

    return {
      dbSizeBytes:       sizeBytes,
      tableCount,
      estimatedBackupMb: Math.ceil(sizeBytes / (1024 * 1024)),
      checkedAt:         new Date().toISOString(),
    };
  } finally {
    await client.end();
  }
}
