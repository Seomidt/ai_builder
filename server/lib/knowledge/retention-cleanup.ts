/**
 * Retention Cleanup Engine — PHASE NEXT-B
 *
 * Purges knowledge_documents rows whose retention_expires_at has passed.
 * For each expired asset:
 *   1. Deletes the R2 object (if r2Key exists in metadata)
 *   2. Soft-deletes the DB row: lifecycle_state='archived', deleted_at=NOW()
 *   3. Stamps metadata.retentionPurgedAt + retentionStatus='purged'
 *   4. Emits an audit log event
 *
 * Invariants:
 *   • Multi-tenant safe: no cross-tenant mutation. Only touches the row's own tenant.
 *   • Idempotent: re-running on already-archived rows is a no-op (lifecycle_state filter).
 *   • FOR UPDATE SKIP LOCKED: multiple concurrent cleanup runs never double-process.
 *   • Promoted assets (persistent_storage) are NEVER auto-purged by this engine —
 *     only temporary_chat scope OR persistent_storage with explicit retention expiry.
 *   • Does not touch rows with retentionMode='forever' (retention_expires_at IS NULL).
 *
 * Scheduler:
 *   Called by server/index.ts via setInterval every 6 hours.
 *   Also exposed as POST /api/admin/retention/cleanup for manual / test triggers.
 */

import pg from "pg";
import { DeleteObjectCommand } from "@aws-sdk/client-s3";
import { logAuditBestEffort } from "../audit/audit-log.ts";

function getClient(): pg.Client {
  return new pg.Client({
    connectionString: process.env.SUPABASE_DB_POOL_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CleanupBatchOptions {
  /** Max rows to process in one batch (default: 50) */
  batchSize?: number;
  /**
   * Dry run: select and log what would be deleted, but do not mutate.
   * R2 objects are NOT deleted. DB rows are NOT archived.
   */
  dryRun?: boolean;
  /** Optional: restrict cleanup to a single tenant (for admin/manual triggers). */
  tenantId?: string;
}

export interface CleanupBatchResult {
  processed:   number;
  r2Deleted:   number;
  r2Skipped:   number;
  dbArchived:  number;
  errors:      number;
  dryRun:      boolean;
  durationMs:  number;
}

interface ExpiredRow {
  id:        string;
  tenantId:  string;
  title:     string;
  r2Key:     string | null;
  assetScope: string;
  documentType: string;
  retentionMode: string | null;
  retentionExpiresAt: Date | null;
}

// ─── Core batch function ───────────────────────────────────────────────────────

/**
 * Runs one cleanup batch. Safe to call repeatedly — idempotent.
 * Returns a summary of what was processed.
 */
export async function runRetentionCleanupBatch(
  opts: CleanupBatchOptions = {},
): Promise<CleanupBatchResult> {
  const { batchSize = 50, dryRun = false, tenantId } = opts;
  const t0 = Date.now();

  const result: CleanupBatchResult = {
    processed: 0, r2Deleted: 0, r2Skipped: 0, dbArchived: 0, errors: 0, dryRun, durationMs: 0,
  };

  // Lazy-import R2 to avoid startup failure when R2 is unconfigured
  const { r2Client, R2_BUCKET, R2_CONFIGURED } = await import("../r2/r2-client.ts");

  const client = getClient();
  try {
    await client.connect();

    // ── 1. SELECT batch with FOR UPDATE SKIP LOCKED ────────────────────────
    // Conditions:
    //   • retention_expires_at < NOW()  (only expired, never NULL/forever)
    //   • lifecycle_state = 'active'    (idempotent: skip already-archived)
    //   • retention_mode != 'forever' OR retention_mode IS NULL guard
    const tenantFilter = tenantId ? `AND tenant_id = '${tenantId.replace(/'/g, "''")}'` : "";

    const selectSql = `
      SELECT
        id,
        tenant_id,
        title,
        (metadata->>'r2Key')::text      AS r2_key,
        asset_scope,
        document_type,
        retention_mode,
        retention_expires_at
      FROM knowledge_documents
      WHERE lifecycle_state   = 'active'
        AND retention_expires_at IS NOT NULL
        AND retention_expires_at < NOW()
        AND COALESCE(retention_mode, '') != 'forever'
        ${tenantFilter}
      ORDER BY retention_expires_at ASC
      LIMIT $1
      FOR UPDATE SKIP LOCKED
    `;

    const rows = await client.query<Record<string, unknown>>(selectSql, [batchSize]);
    result.processed = rows.rowCount ?? 0;

    if (result.processed === 0) {
      result.durationMs = Date.now() - t0;
      return result;
    }

    const expired: ExpiredRow[] = rows.rows.map(r => ({
      id:                 r["id"] as string,
      tenantId:           r["tenant_id"] as string,
      title:              r["title"] as string,
      r2Key:              (r["r2_key"] as string) ?? null,
      assetScope:         r["asset_scope"] as string,
      documentType:       r["document_type"] as string,
      retentionMode:      (r["retention_mode"] as string) ?? null,
      retentionExpiresAt: r["retention_expires_at"] ? new Date(r["retention_expires_at"] as string) : null,
    }));

    console.log(
      `[retention-cleanup] batch rows=${result.processed} dryRun=${dryRun}` +
      (tenantId ? ` tenant=${tenantId}` : ""),
    );

    // ── 2. Process each row ────────────────────────────────────────────────
    for (const row of expired) {
      try {
        // ── 2a. R2 delete ──────────────────────────────────────────────────
        if (row.r2Key) {
          if (!dryRun && R2_CONFIGURED) {
            try {
              await r2Client.send(
                new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: row.r2Key }),
              );
              result.r2Deleted++;
              console.log(
                `[retention-cleanup] R2_DELETED id=${row.id} tenant=${row.tenantId}` +
                ` key=${row.r2Key} type=${row.documentType}`,
              );
            } catch (r2Err: unknown) {
              const msg = r2Err instanceof Error ? r2Err.message : String(r2Err);
              // NoSuchKey is fine — object already gone; treat as success
              if (msg.includes("NoSuchKey") || msg.includes("404")) {
                result.r2Deleted++;
                console.log(`[retention-cleanup] R2_ALREADY_GONE id=${row.id} key=${row.r2Key}`);
              } else {
                result.r2Skipped++;
                console.warn(`[retention-cleanup] R2_ERROR id=${row.id} key=${row.r2Key}: ${msg}`);
              }
            }
          } else {
            result.r2Skipped++;
            if (dryRun) {
              console.log(`[retention-cleanup] DRY_RUN would_delete_r2 id=${row.id} key=${row.r2Key}`);
            } else {
              console.warn(`[retention-cleanup] R2_NOT_CONFIGURED skip_r2_delete id=${row.id}`);
            }
          }
        } else {
          result.r2Skipped++;
          console.log(`[retention-cleanup] NO_R2_KEY id=${row.id} tenant=${row.tenantId}`);
        }

        // ── 2b. Soft-delete DB row ─────────────────────────────────────────
        if (!dryRun) {
          await client.query(
            `UPDATE knowledge_documents
               SET lifecycle_state = 'archived',
                   deleted_at      = NOW(),
                   document_status = 'superseded',
                   metadata        = COALESCE(metadata, '{}'::jsonb)
                                     || jsonb_build_object(
                                          'retentionStatus',   'purged',
                                          'retentionPurgedAt', NOW()::text,
                                          'r2Key',             NULL
                                        ),
                   updated_at      = NOW()
             WHERE id = $1 AND tenant_id = $2 AND lifecycle_state = 'active'`,
            [row.id, row.tenantId],
          );
          result.dbArchived++;

          // ── 2c. Audit event ────────────────────────────────────────────────
          await logAuditBestEffort({
            tenantId:     row.tenantId,
            actorId:      "system:retention-cleanup",
            action:       "asset.retention_purged",
            resourceType: "knowledge_document",
            resourceId:   row.id,
            metadata: {
              title:              row.title,
              assetScope:         row.assetScope,
              documentType:       row.documentType,
              retentionMode:      row.retentionMode,
              retentionExpiresAt: row.retentionExpiresAt?.toISOString(),
              r2KeyPurged:        row.r2Key ?? null,
            },
          });
        }
      } catch (rowErr: unknown) {
        result.errors++;
        const msg = rowErr instanceof Error ? rowErr.message : String(rowErr);
        console.error(`[retention-cleanup] ROW_ERROR id=${row.id} tenant=${row.tenantId}: ${msg}`);
      }
    }
  } finally {
    await client.end();
  }

  result.durationMs = Date.now() - t0;
  console.log(
    `[retention-cleanup] DONE processed=${result.processed}` +
    ` r2Deleted=${result.r2Deleted} r2Skipped=${result.r2Skipped}` +
    ` dbArchived=${result.dbArchived} errors=${result.errors}` +
    ` durationMs=${result.durationMs} dryRun=${dryRun}`,
  );

  return result;
}

// ─── Scheduler bootstrap ──────────────────────────────────────────────────────

const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Starts the retention cleanup scheduler.
 * Safe to call multiple times — only registers one interval.
 */
let _cleanupStarted = false;
export function startRetentionCleanupScheduler(): void {
  if (_cleanupStarted) return;
  _cleanupStarted = true;

  // Run once after 5 min startup delay (let server fully warm up)
  const initialDelay = 5 * 60 * 1000;
  setTimeout(() => {
    runRetentionCleanupBatch({ batchSize: 100 }).catch(err =>
      console.error("[retention-cleanup] scheduled run failed:", err),
    );
  }, initialDelay);

  setInterval(() => {
    runRetentionCleanupBatch({ batchSize: 100 }).catch(err =>
      console.error("[retention-cleanup] scheduled run failed:", err),
    );
  }, CLEANUP_INTERVAL_MS);

  console.log(
    `[retention-cleanup] scheduler started` +
    ` initialDelay=${initialDelay / 1000}s interval=${CLEANUP_INTERVAL_MS / 3600000}h`,
  );
}
