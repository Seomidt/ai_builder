/**
 * Phase 46 — Private-by-Default Download Access
 *
 * Download flow:
 *   1. Load file metadata from DB by fileId
 *   2. Verify tenant ownership + role + scan status
 *   3. Return short-lived signed GET URL (never persisted)
 *
 * Rules:
 *   - Signed URLs are never stored in DB
 *   - Short expiry (default 900s = 15 min)
 *   - Deleted files never resolve
 *   - Scan-blocked files blocked until clean (per policy)
 */

import { db }                from "../../db";
import { sql }               from "drizzle-orm";
import { getPresignedUrl }   from "../r2/r2-service";
import { assertFileCleanForAccess } from "./scan-status";
import { emitStorageAuditEvent }    from "./audit-log";
import {
  getStoragePolicy,
  isValidCategory,
  type StorageCategory,
} from "./storage-policy";

export interface DownloadAccessRequest {
  fileId:         string;
  requestingOrgId: string;
  requestingRole:  string;
  userId?:         string;
  ipAddress?:      string;
  requestId?:      string;
  /** URL expiry in seconds. Default 900 (15 min). Max 3600. */
  expiresInSec?:   number;
}

export interface DownloadAccessResult {
  signedUrl:    string;
  expiresInSec: number;
  fileId:       string;
  filename:     string;
  mimeType:     string;
}

interface TenantFileRow {
  id:               string;
  organization_id:  string;
  object_key:       string;
  original_filename: string;
  mime_type:        string;
  upload_status:    string;
  scan_status:      string;
  category:         string;
  deleted_at:       string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Load file metadata with tenant check
// ─────────────────────────────────────────────────────────────────────────────

async function loadFileForOrg(
  fileId:  string,
  orgId:   string,
): Promise<TenantFileRow> {
  const result = await db.execute<any>(sql`
    SELECT id, organization_id, object_key, original_filename,
           mime_type, upload_status, scan_status, category, deleted_at
    FROM   tenant_files
    WHERE  id = ${fileId}
    LIMIT  1
  `);

  if (result.rows.length === 0) {
    throw new DownloadAccessError("File not found", 404);
  }

  const row = result.rows[0] as TenantFileRow;

  if (row.deleted_at !== null) {
    throw new DownloadAccessError("File has been deleted", 410);
  }

  if (row.organization_id !== orgId) {
    throw new DownloadAccessError("Access denied — file belongs to another tenant", 403);
  }

  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// Download access check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assert that the requesting user/role is allowed to download this file.
 * Checks: tenant ownership, upload status, scan status, system_backup restriction.
 */
export function assertDownloadAllowed(
  file:  TenantFileRow,
  role:  string,
): void {
  // system_backup is service_role only
  if (file.category === "system_backup" && role !== "service_role" && role !== "admin") {
    throw new DownloadAccessError("system_backup files are restricted to service_role/admin", 403);
  }

  if (file.upload_status !== "uploaded") {
    throw new DownloadAccessError(
      `File upload is not complete (status: ${file.upload_status})`,
      409,
    );
  }

  // Check scan status via policy
  if (isValidCategory(file.category)) {
    assertFileCleanForAccess(
      file.id,
      file.scan_status as any,
      file.category as StorageCategory,
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Issue download access
// ─────────────────────────────────────────────────────────────────────────────

export async function issueDownloadAccess(
  req: DownloadAccessRequest,
): Promise<DownloadAccessResult> {
  const file = await loadFileForOrg(req.fileId, req.requestingOrgId);

  try {
    assertDownloadAllowed(file, req.requestingRole);
  } catch (err) {
    await emitStorageAuditEvent({
      event:          "unauthorized_storage_access_attempt",
      fileId:         req.fileId,
      organizationId: req.requestingOrgId,
      userId:         req.userId,
      category:       file.category,
      ipAddress:      req.ipAddress,
      requestId:      req.requestId,
      details:        { reason: (err as Error).message, role: req.requestingRole },
    });
    throw err;
  }

  // Clamp expiry: min 60s, max 3600s
  const expiresInSec = Math.min(Math.max(req.expiresInSec ?? 900, 60), 3600);

  // Generate signed GET URL — NEVER persisted
  const signedUrl = await getPresignedUrl(file.object_key, expiresInSec);

  await emitStorageAuditEvent({
    event:          "download_url_issued",
    fileId:         req.fileId,
    organizationId: req.requestingOrgId,
    userId:         req.userId,
    category:       file.category,
    objectKey:      file.object_key,
    ipAddress:      req.ipAddress,
    requestId:      req.requestId,
    details:        { expiresInSec },
  });

  return {
    signedUrl,
    expiresInSec,
    fileId:   file.id,
    filename: file.original_filename,
    mimeType: file.mime_type,
  };
}

export class DownloadAccessError extends Error {
  constructor(message: string, public readonly statusCode: number = 403) {
    super(message);
    this.name = "DownloadAccessError";
  }
}
