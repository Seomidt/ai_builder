/**
 * Phase 46 — DB-First Upload Flow
 *
 * Upload flow:
 *   1. validateAndRequestUpload  — validate + create metadata row (status=pending)
 *   2. Return signed PUT URL for client-direct R2 upload
 *   3. completeUpload            — client calls after upload, marks status=uploaded
 *   4. Audit events at each step
 */

import { randomUUID }           from "crypto";
import { db }                   from "../../db";
import { sql }                  from "drizzle-orm";
import { getUploadUrl }         from "../r2/r2-service";
import { R2_BUCKET }            from "../r2/r2-client";
import { generateObjectKey }    from "./object-key";
import { assertUploadIntegrity } from "./integrity";
import { initializeScanState }  from "./scan-status";
import { emitStorageAuditEvent } from "./audit-log";
import {
  assertStorageUploadAllowed,
  isValidCategory,
  type StorageCategory,
} from "./storage-policy";

export interface RequestUploadInput {
  organizationId:   string;
  uploaderRole:     string;
  userId?:          string;
  category:         string;
  mimeType:         string;
  sizeBytes:        number;
  originalFilename: string;
  clientId?:        string;
  ipAddress?:       string;
  requestId?:       string;
}

export interface RequestUploadResult {
  fileId:         string;
  objectKey:      string;
  uploadUrl:      string;
  uploadUrlExpiry: number;
  scanRequired:   boolean;
}

export interface CompleteUploadInput {
  fileId:         string;
  organizationId: string;
  checksumSha256?: string;
  sizeBytes?:     number;
  userId?:        string;
  ipAddress?:     string;
  requestId?:     string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1: Request upload (DB-first)
// ─────────────────────────────────────────────────────────────────────────────

export async function requestUpload(input: RequestUploadInput): Promise<RequestUploadResult> {
  // Validate category
  if (!isValidCategory(input.category)) {
    throw new UploadFlowError(`Invalid storage category: '${input.category}'`);
  }
  const category = input.category as StorageCategory;

  // Validate organization_id and uploader
  if (!input.organizationId || !/^[a-zA-Z0-9_\-]{1,128}$/.test(input.organizationId)) {
    throw new UploadFlowError("Invalid organizationId");
  }

  // Enforce policy
  assertStorageUploadAllowed(
    category,
    input.mimeType,
    input.sizeBytes,
    input.uploaderRole,
    !!input.clientId,
  );

  // Integrity pre-check (metadata only — no data buffer at this stage)
  const integrity = assertUploadIntegrity({
    category,
    mimeType:         input.mimeType,
    sizeBytes:        input.sizeBytes,
    originalFilename: input.originalFilename,
  });

  // Generate server-controlled object key
  const { objectKey, fileId } = generateObjectKey({
    organizationId: input.organizationId,
    category,
    mimeType:       integrity.normalizedMime,
    clientId:       input.clientId,
  });

  // Determine initial scan status
  const scanStatus = initializeScanState(category);

  // Create metadata row (status = pending — BEFORE upload starts)
  await db.execute<any>(sql`
    INSERT INTO tenant_files (
      id, organization_id, client_id, owner_user_id,
      bucket, object_key, original_filename, mime_type,
      size_bytes, checksum_sha256, category,
      visibility, upload_status, scan_status,
      created_at, metadata
    ) VALUES (
      ${fileId},
      ${input.organizationId},
      ${input.clientId ?? null},
      ${input.userId ?? null},
      ${R2_BUCKET ?? "default"},
      ${objectKey},
      ${input.originalFilename},
      ${integrity.normalizedMime},
      ${input.sizeBytes},
      'pending',
      ${category},
      'private',
      'pending',
      ${scanStatus},
      now(),
      ${JSON.stringify({ uploadRequestedAt: new Date().toISOString() })}::jsonb
    )
  `);

  // Generate signed PUT URL for direct browser → R2 upload
  const uploadUrlExpiry = 900; // 15 minutes
  const uploadUrl = await getUploadUrl(objectKey, integrity.normalizedMime, uploadUrlExpiry);

  await emitStorageAuditEvent({
    event:          "upload_requested",
    fileId,
    organizationId: input.organizationId,
    userId:         input.userId,
    category:       category,
    objectKey,
    ipAddress:      input.ipAddress,
    requestId:      input.requestId,
  });

  return {
    fileId,
    objectKey,
    uploadUrl,
    uploadUrlExpiry,
    scanRequired: scanStatus === "pending_scan",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2: Complete upload (called after client finishes R2 PUT)
// ─────────────────────────────────────────────────────────────────────────────

export async function completeUpload(input: CompleteUploadInput): Promise<{
  fileId:     string;
  scanStatus: string;
}> {
  const updates: Record<string, unknown> = {
    upload_status: "uploaded",
    uploaded_at:   new Date().toISOString(),
  };

  if (input.checksumSha256) {
    updates.checksum_sha256 = input.checksumSha256;
  }
  if (input.sizeBytes !== undefined) {
    updates.size_bytes = input.sizeBytes;
  }

  const result = await db.execute<any>(sql`
    UPDATE tenant_files
    SET
      upload_status = 'uploaded',
      uploaded_at   = now(),
      checksum_sha256 = COALESCE(${input.checksumSha256 ?? null}, checksum_sha256),
      size_bytes    = COALESCE(${input.sizeBytes ?? null}, size_bytes)
    WHERE
      id              = ${input.fileId}
      AND organization_id = ${input.organizationId}
      AND upload_status   = 'pending'
      AND deleted_at      IS NULL
    RETURNING id, scan_status
  `);

  if (result.rows.length === 0) {
    await emitStorageAuditEvent({
      event:          "upload_failed",
      fileId:         input.fileId,
      organizationId: input.organizationId,
      userId:         input.userId,
      ipAddress:      input.ipAddress,
      requestId:      input.requestId,
      details:        { reason: "file not found or already completed" },
    });
    throw new UploadFlowError(
      `completeUpload: file ${input.fileId} not found, already uploaded, ` +
      `or wrong organization`
    );
  }

  const scanStatus = result.rows[0].scan_status as string;

  await emitStorageAuditEvent({
    event:          "upload_completed",
    fileId:         input.fileId,
    organizationId: input.organizationId,
    userId:         input.userId,
    ipAddress:      input.ipAddress,
    requestId:      input.requestId,
    details:        { scanStatus },
  });

  if (scanStatus === "pending_scan") {
    await emitStorageAuditEvent({
      event:          "scan_pending",
      fileId:         input.fileId,
      organizationId: input.organizationId,
      userId:         input.userId,
    });
  }

  return { fileId: input.fileId, scanStatus };
}

export class UploadFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadFlowError";
  }
}
