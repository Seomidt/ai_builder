/**
 * Phase 46 — Storage Reconciliation / Orphan Protection
 *
 * Detects mismatches between DB metadata and actual R2 objects.
 * Runs as a background admin check, not on the critical path.
 */

import { db }                    from "../../db";
import { sql }                   from "drizzle-orm";
import { listObjects, objectExists } from "../r2/r2-service";

export interface ReconciliationResult {
  checkedAt:                string;
  metadataWithoutObject:    string[];   // DB row exists, R2 object missing
  objectWithoutMetadata:    string[];   // R2 object exists, no DB row
  deletedMetadataWithLive:  string[];   // soft-deleted DB row, but R2 object still present (scheduled)
  liveMetadataFailedUpload: string[];   // upload_status=pending, stale (> threshold)
  totalChecked:             number;
  anomalyCount:             number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual checks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find DB metadata rows where the R2 object does NOT exist.
 * These are orphan metadata rows — upload may have failed or object deleted externally.
 *
 * NOTE: Checks in batches to avoid R2 API rate limits.
 * Only checks non-deleted files with upload_status = 'uploaded'.
 */
export async function findMetadataWithoutObject(
  organizationId?: string,
  limit = 50,
): Promise<string[]> {
  const orgFilter = organizationId
    ? sql`AND organization_id = ${organizationId}`
    : sql``;

  const rows = await db.execute<any>(sql`
    SELECT id, object_key
    FROM   tenant_files
    WHERE  deleted_at     IS NULL
      AND  upload_status  = 'uploaded'
      ${orgFilter}
    ORDER  BY created_at ASC
    LIMIT  ${limit}
  `);

  const missing: string[] = [];
  for (const row of rows.rows) {
    const exists = await objectExists(row.object_key as string);
    if (!exists) missing.push(row.id as string);
  }

  return missing;
}

/**
 * Find R2 objects under a prefix that have no corresponding DB metadata row.
 * Checks by scanning R2 and looking up object_key in tenant_files.
 *
 * Only checks org/{organizationId}/* prefixes if provided.
 */
export async function findObjectWithoutMetadata(
  organizationId?: string,
  limit = 200,
): Promise<string[]> {
  const prefix = organizationId ? `org/${organizationId}/` : "";
  const objects = await listObjects(prefix, limit);

  const orphans: string[] = [];
  for (const obj of objects) {
    const result = await db.execute<any>(sql`
      SELECT id FROM tenant_files WHERE object_key = ${obj.key} LIMIT 1
    `);
    if (result.rows.length === 0) {
      orphans.push(obj.key);
    }
  }

  return orphans;
}

/**
 * Find files that are soft-deleted in DB but whose R2 object still exists.
 * These are expected during the hard-delete window — but if overdue, they're anomalies.
 *
 * Only flags rows where delete_scheduled_at is past but R2 object still present.
 */
export async function detectDeletedMetadataWithLiveObject(
  limit = 50,
): Promise<string[]> {
  const rows = await db.execute<any>(sql`
    SELECT id, object_key
    FROM   tenant_files
    WHERE  deleted_at           IS NOT NULL
      AND  delete_scheduled_at  IS NOT NULL
      AND  delete_scheduled_at  < now() - interval '1 hour'
      AND  metadata->>'r2_hard_deleted_at' IS NULL
    ORDER  BY delete_scheduled_at ASC
    LIMIT  ${limit}
  `);

  const overdue: string[] = [];
  for (const row of rows.rows) {
    const exists = await objectExists(row.object_key as string);
    if (exists) overdue.push(row.id as string);
  }

  return overdue;
}

/**
 * Find metadata rows with upload_status = 'pending' that are stale (older than threshold).
 * These indicate abandoned uploads that were never confirmed.
 */
export async function detectLiveMetadataWithFailedUpload(
  staleDurationMinutes = 60,
  limit = 100,
): Promise<string[]> {
  const result = await db.execute<any>(sql`
    SELECT id
    FROM   tenant_files
    WHERE  upload_status = 'pending'
      AND  deleted_at    IS NULL
      AND  created_at    < now() - (${staleDurationMinutes} * interval '1 minute')
    ORDER  BY created_at ASC
    LIMIT  ${limit}
  `);

  return result.rows.map(r => r.id as string);
}

// ─────────────────────────────────────────────────────────────────────────────
// Full reconciliation report
// ─────────────────────────────────────────────────────────────────────────────

export async function runReconciliation(
  organizationId?: string,
): Promise<ReconciliationResult> {
  const [
    metadataWithoutObject,
    objectWithoutMetadata,
    deletedMetadataWithLive,
    liveMetadataFailedUpload,
  ] = await Promise.all([
    findMetadataWithoutObject(organizationId),
    findObjectWithoutMetadata(organizationId),
    detectDeletedMetadataWithLiveObject(),
    detectLiveMetadataWithFailedUpload(),
  ]);

  const anomalyCount =
    metadataWithoutObject.length +
    objectWithoutMetadata.length +
    deletedMetadataWithLive.length +
    liveMetadataFailedUpload.length;

  const totalChecked =
    metadataWithoutObject.length +
    objectWithoutMetadata.length +
    deletedMetadataWithLive.length +
    liveMetadataFailedUpload.length;

  return {
    checkedAt:                new Date().toISOString(),
    metadataWithoutObject,
    objectWithoutMetadata,
    deletedMetadataWithLive,
    liveMetadataFailedUpload,
    totalChecked,
    anomalyCount,
  };
}
