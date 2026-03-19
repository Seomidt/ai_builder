/**
 * Phase 46 — Scan Status State Machine
 *
 * Enterprise-safe scan workflow for uploaded files.
 * Works without an antivirus engine today — state machine is ready for real integration.
 *
 * States:
 *   not_scanned    — default for categories that don't require scanning
 *   pending_scan   — queued for scan (category requires it)
 *   clean          — scan completed, no threat found
 *   rejected       — scan found threat; file is blocked
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";
import type { StorageCategory } from "./storage-policy";
import { categoryRequiresScan, categoryBlocksDownloadUntilClean } from "./storage-policy";

export type ScanStatus = "not_scanned" | "pending_scan" | "clean" | "rejected";

// ─────────────────────────────────────────────────────────────────────────────
// State initialization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Determine the initial scan status for a new upload.
 * Categories that require scanning start as "pending_scan".
 */
export function initializeScanState(category: StorageCategory): ScanStatus {
  return categoryRequiresScan(category) ? "pending_scan" : "not_scanned";
}

// ─────────────────────────────────────────────────────────────────────────────
// Access check
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Assert that a file's scan status allows download access.
 * Throws if the category blocks downloads until scan is clean.
 */
export function assertFileCleanForAccess(
  fileId:     string,
  scanStatus: ScanStatus,
  category:   StorageCategory,
): void {
  if (scanStatus === "rejected") {
    throw new ScanStatusError(
      `File ${fileId} has been rejected by security scan — download blocked`
    );
  }

  if (categoryBlocksDownloadUntilClean(category) && scanStatus !== "clean") {
    throw new ScanStatusError(
      `File ${fileId} in category '${category}' cannot be downloaded until scan completes. ` +
      `Current scan status: ${scanStatus}`
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// State transitions (DB updates)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mark a file as scan-clean.
 * Called by the scan engine (or manually by admin) when no threat is found.
 */
export async function markFileClean(fileId: string): Promise<void> {
  const result = await db.execute<any>(sql`
    UPDATE tenant_files
    SET    scan_status  = 'clean',
           metadata     = jsonb_set(
             coalesce(metadata, '{}'::jsonb),
             '{scan_completed_at}',
             to_jsonb(now()::text)
           )
    WHERE  id            = ${fileId}
      AND  deleted_at    IS NULL
      AND  scan_status   IN ('pending_scan', 'not_scanned')
    RETURNING id
  `);

  if (result.rows.length === 0) {
    throw new ScanStatusError(
      `markFileClean: file ${fileId} not found or already in final scan state`
    );
  }
}

/**
 * Mark a file as scan-rejected.
 * Blocked from download. Soft-delete is scheduled.
 */
export async function markFileRejected(fileId: string, reason: string): Promise<void> {
  const result = await db.execute<any>(sql`
    UPDATE tenant_files
    SET    scan_status          = 'rejected',
           upload_status        = 'failed',
           delete_scheduled_at  = now() + interval '7 days',
           metadata             = jsonb_set(
             jsonb_set(
               coalesce(metadata, '{}'::jsonb),
               '{scan_rejected_at}',
               to_jsonb(now()::text)
             ),
             '{scan_rejection_reason}',
             to_jsonb(${reason}::text)
           )
    WHERE  id         = ${fileId}
      AND  deleted_at IS NULL
    RETURNING id
  `);

  if (result.rows.length === 0) {
    throw new ScanStatusError(
      `markFileRejected: file ${fileId} not found or already deleted`
    );
  }
}

/**
 * Queue a file for scan (e.g., after upload completion, re-scan request).
 */
export async function queueForScan(fileId: string): Promise<void> {
  await db.execute<any>(sql`
    UPDATE tenant_files
    SET    scan_status = 'pending_scan'
    WHERE  id          = ${fileId}
      AND  deleted_at  IS NULL
      AND  scan_status = 'not_scanned'
  `);
}

export class ScanStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScanStatusError";
  }
}
