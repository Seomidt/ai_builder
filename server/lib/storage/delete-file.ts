/**
 * Phase 46 — Soft Delete + Async Hard Delete
 *
 * Delete flow:
 *   1. softDeleteFile   → marks deleted_at, upload_status='deleted', schedules hard delete
 *   2. scheduleObjectDeletion → sets delete_scheduled_at
 *   3. hardDeleteObject → removes object from R2 (runs async / background)
 *   4. finalizeObjectDeletion → marks final state after hard delete completes
 *
 * NEVER removes DB row first.
 * DB row is the permanent audit record.
 */

import { db }         from "../../db";
import { sql }        from "drizzle-orm";
import { deleteObject } from "../r2/r2-service";
import { emitStorageAuditEvent } from "./audit-log";

export interface DeleteFileOptions {
  fileId:         string;
  organizationId: string;
  requestedByUserId?: string;
  ipAddress?:     string;
  requestId?:     string;
  /** Delay in seconds before hard delete. Default: 86400 (24 hours) */
  hardDeleteDelaySec?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Soft delete
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark the file as deleted in DB.
 * Object remains in R2 until hard delete runs.
 * File is immediately hidden from normal tenant queries.
 */
export async function softDeleteFile(opts: DeleteFileOptions): Promise<{ objectKey: string }> {
  const delaySec = opts.hardDeleteDelaySec ?? 86400;

  const result = await db.execute<any>(sql`
    UPDATE tenant_files
    SET
      deleted_at           = now(),
      upload_status        = 'deleted',
      delete_scheduled_at  = now() + (${delaySec} * interval '1 second')
    WHERE
      id              = ${opts.fileId}
      AND organization_id = ${opts.organizationId}
      AND deleted_at  IS NULL
    RETURNING id, object_key
  `);

  if (result.rows.length === 0) {
    throw new DeleteError(
      `softDeleteFile: file ${opts.fileId} not found, already deleted, ` +
      `or does not belong to org ${opts.organizationId}`
    );
  }

  const objectKey = result.rows[0].object_key as string;

  await emitStorageAuditEvent({
    event:          "file_deleted",
    fileId:         opts.fileId,
    organizationId: opts.organizationId,
    userId:         opts.requestedByUserId,
    objectKey,
    ipAddress:      opts.ipAddress,
    requestId:      opts.requestId,
    details:        { hardDeleteScheduledInSec: delaySec },
  });

  return { objectKey };
}

// ─────────────────────────────────────────────────────────────────────────────
// Schedule / hard delete
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update or reset the scheduled hard-delete time.
 */
export async function scheduleObjectDeletion(
  fileId:     string,
  delaySec:   number = 86400,
): Promise<void> {
  await db.execute<any>(sql`
    UPDATE tenant_files
    SET delete_scheduled_at = now() + (${delaySec} * interval '1 second')
    WHERE id = ${fileId} AND deleted_at IS NOT NULL
  `);
}

/**
 * Perform the actual R2 object deletion.
 * Should only be called after softDeleteFile has run.
 * Does NOT remove the DB row — the row is the permanent audit record.
 */
export async function hardDeleteObject(
  fileId:    string,
  objectKey: string,
): Promise<{ deleted: boolean }> {
  try {
    await deleteObject(objectKey);

    // Mark that R2 object has been removed
    await db.execute<any>(sql`
      UPDATE tenant_files
      SET metadata = jsonb_set(
        coalesce(metadata, '{}'::jsonb),
        '{r2_hard_deleted_at}',
        to_jsonb(now()::text)
      )
      WHERE id = ${fileId}
    `);

    return { deleted: true };
  } catch (err: any) {
    console.error(`[StorageDelete] hardDeleteObject failed for ${fileId}:`, err.message);
    return { deleted: false };
  }
}

/**
 * Finalize object deletion — called after hard delete succeeds.
 * Marks delete_scheduled_at as null to prevent re-processing.
 */
export async function finalizeObjectDeletion(fileId: string): Promise<void> {
  await db.execute<any>(sql`
    UPDATE tenant_files
    SET delete_scheduled_at = NULL
    WHERE id = ${fileId} AND deleted_at IS NOT NULL
  `);
}

// ─────────────────────────────────────────────────────────────────────────────
// Background job helper — find files due for hard delete
// ─────────────────────────────────────────────────────────────────────────────

export async function findFilesDueForHardDelete(limit = 100): Promise<
  Array<{ id: string; objectKey: string; organizationId: string }>
> {
  const result = await db.execute<any>(sql`
    SELECT id, object_key, organization_id
    FROM   tenant_files
    WHERE  deleted_at           IS NOT NULL
      AND  delete_scheduled_at  IS NOT NULL
      AND  delete_scheduled_at  <= now()
      AND  metadata->>'r2_hard_deleted_at' IS NULL
    ORDER  BY delete_scheduled_at ASC
    LIMIT  ${limit}
  `);

  return result.rows.map(r => ({
    id:             r.id,
    objectKey:      r.object_key,
    organizationId: r.organization_id,
  }));
}

export class DeleteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeleteError";
  }
}
