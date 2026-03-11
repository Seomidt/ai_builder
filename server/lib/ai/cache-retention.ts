/**
 * AI Cache Retention — Phase 3I.2 / 3I.3
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides SQL constants and helpers for previewing and cleaning up
 * expired rows in ai_response_cache.
 *
 * IMPORTANT: Cleanup is manual/external.
 * There is no automatic scheduler, cron job, or background worker here.
 * A future phase may wire these helpers into an admin route or scheduled task.
 *
 * Expired rows are already excluded from live read paths.
 * The lookup WHERE clause in response-cache.ts includes:
 *   AND expires_at > NOW()
 * so expired entries are never served regardless of cleanup schedule.
 * Cleanup is therefore a storage hygiene operation, not a correctness requirement.
 *
 * Why batch cleanup (Phase 3I.3):
 * A single large DELETE can lock rows for a long time and impact write throughput
 * as ai_response_cache grows. Batch cleanup deletes in small deterministic chunks
 * (oldest-first via ORDER BY expires_at ASC) and is safe to run repeatedly.
 * The expires_at index (ai_response_cache_expires_idx) makes both the subquery
 * and the live lookup filter efficient at scale.
 *
 * expires_at index: ai_response_cache_expires_idx (btree on expires_at)
 * — confirmed present, no schema change required.
 */

import { lt, sql } from "drizzle-orm";
import { db } from "../../db";
import { aiResponseCache } from "@shared/schema";

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * Default batch size for cleanup operations.
 * Deletes up to 5000 expired rows per batch — safe for production workloads.
 * Tune down if the table is under heavy concurrent write load.
 */
export const CACHE_CLEANUP_BATCH_SIZE = 5_000;

// ── SQL reference strings ─────────────────────────────────────────────────────

/**
 * Preview SQL — counts all expired rows without deleting them.
 *
 * SELECT COUNT(*) AS rows_to_delete
 * FROM ai_response_cache
 * WHERE expires_at < NOW();
 */
export const CACHE_CLEANUP_PREVIEW_SQL = `
SELECT COUNT(*) AS rows_to_delete
FROM ai_response_cache
WHERE expires_at < NOW();
`.trim();

/**
 * Batch cleanup SQL — deletes up to $1 expired rows, oldest first.
 *
 * Uses a subquery with LIMIT so each execution is bounded.
 * ORDER BY expires_at ASC ensures oldest expired rows are removed first.
 * The expires_at index (ai_response_cache_expires_idx) keeps the subquery efficient.
 *
 * DELETE FROM ai_response_cache
 * WHERE id IN (
 *   SELECT id
 *   FROM ai_response_cache
 *   WHERE expires_at < NOW()
 *   ORDER BY expires_at ASC
 *   LIMIT $1
 * );
 *
 * Previous (Phase 3I.2) unbounded cleanup SQL, retained for reference:
 * DELETE FROM ai_response_cache WHERE expires_at < NOW();
 */
export const CACHE_BATCH_CLEANUP_SQL = `
DELETE FROM ai_response_cache
WHERE id IN (
  SELECT id
  FROM ai_response_cache
  WHERE expires_at < NOW()
  ORDER BY expires_at ASC
  LIMIT $1
);
`.trim();

// ── Drizzle helpers ───────────────────────────────────────────────────────────

/**
 * Count all expired cache entries without deleting them.
 *
 * Safe to call at any time — read-only.
 * Returns 0 on DB error (fail-open).
 */
export async function countExpiredCacheEntries(): Promise<number> {
  try {
    const result = await db.$count(
      aiResponseCache,
      lt(aiResponseCache.expiresAt, new Date()),
    );
    return result;
  } catch (err) {
    console.warn("[ai:cache-retention] countExpiredCacheEntries failed:", err);
    return 0;
  }
}

/**
 * Delete up to `batchSize` expired cache entries in a single statement.
 *
 * Deletes oldest-first (ORDER BY expires_at ASC).
 * Must only be called by admin tooling or a future scheduler.
 * Not called automatically anywhere in the request path.
 *
 * @param batchSize  Maximum rows to delete in this call. Default: CACHE_CLEANUP_BATCH_SIZE.
 * @returns          Number of rows deleted in this batch, or 0 on error.
 */
export async function deleteExpiredCacheEntriesBatch(
  batchSize: number = CACHE_CLEANUP_BATCH_SIZE,
): Promise<number> {
  try {
    const result = await db.execute(sql`
      DELETE FROM ai_response_cache
      WHERE id IN (
        SELECT id
        FROM ai_response_cache
        WHERE expires_at < NOW()
        ORDER BY expires_at ASC
        LIMIT ${batchSize}
      )
    `);
    const deleted = (result as { rowCount?: number }).rowCount ?? 0;
    console.log(`[ai:cache-retention] Batch deleted ${deleted} expired cache entries (batchSize=${batchSize})`);
    return deleted;
  } catch (err) {
    console.warn("[ai:cache-retention] deleteExpiredCacheEntriesBatch failed:", err);
    return 0;
  }
}

/**
 * Delete ALL expired cache entries by running batches until none remain.
 *
 * Loops until the batch returns 0 deleted rows.
 * Designed for admin/maintenance use — never call from the request path.
 *
 * @param batchSize  Rows per batch. Default: CACHE_CLEANUP_BATCH_SIZE.
 * @returns          Total rows deleted across all batches.
 */
export async function deleteAllExpiredCacheEntries(
  batchSize: number = CACHE_CLEANUP_BATCH_SIZE,
): Promise<number> {
  let total = 0;
  let round = 0;
  while (true) {
    round++;
    const deleted = await deleteExpiredCacheEntriesBatch(batchSize);
    total += deleted;
    if (deleted === 0) break;
    console.log(`[ai:cache-retention] Round ${round}: deleted ${deleted}, total so far: ${total}`);
  }
  console.log(`[ai:cache-retention] Full cleanup complete: ${total} rows deleted in ${round - 1} batch(es)`);
  return total;
}
