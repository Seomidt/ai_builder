/**
 * Phase 46 — Storage Audit Logging
 *
 * Every storage-sensitive action emits an audit event.
 * Uses existing security_events table if available; falls back to console log.
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";

export type StorageAuditEvent =
  | "upload_requested"
  | "upload_completed"
  | "upload_failed"
  | "download_url_issued"
  | "file_deleted"
  | "file_delete_failed"
  | "scan_pending"
  | "scan_clean"
  | "scan_rejected"
  | "unauthorized_storage_access_attempt";

export interface StorageAuditPayload {
  event:          StorageAuditEvent;
  fileId?:        string;
  organizationId: string;
  userId?:        string;
  category?:      string;
  objectKey?:     string;
  details?:       Record<string, unknown>;
  ipAddress?:     string;
  requestId?:     string;
}

/**
 * Emit a storage audit event to the security_events table.
 * Non-throwing — if DB write fails, logs to stderr but does not block the operation.
 */
export async function emitStorageAuditEvent(payload: StorageAuditPayload): Promise<void> {
  try {
    await db.execute<any>(sql`
      INSERT INTO security_events (
        tenant_id,
        event_type,
        user_id,
        request_id,
        ip_address,
        metadata,
        created_at
      ) VALUES (
        ${payload.organizationId},
        ${"storage_" + payload.event},
        ${payload.userId ?? null},
        ${payload.requestId ?? null},
        ${payload.ipAddress ?? null},
        ${JSON.stringify({
          event:      payload.event,
          fileId:     payload.fileId,
          category:   payload.category,
          objectKey:  payload.objectKey ? redactObjectKey(payload.objectKey) : undefined,
          ...(payload.details ?? {}),
        })}::jsonb,
        now()
      )
    `);
  } catch (err) {
    // Non-blocking — log but do not fail the operation
    console.error("[StorageAudit] Failed to write audit event:", payload.event, err);
  }
}

/**
 * Redact the last segment of an object key (the file UUID) in audit logs.
 * We log the path structure but not the full key.
 *
 * org/abc123/checkins/clients/cli456/[REDACTED] → safe to log
 */
function redactObjectKey(key: string): string {
  const parts = key.split("/");
  if (parts.length > 1) {
    parts[parts.length - 1] = "[REDACTED]";
  }
  return parts.join("/");
}
