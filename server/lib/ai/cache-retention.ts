/**
 * AI Cache Retention — Phase 3I.2
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides the exact SQL constants and helpers for previewing and cleaning up
 * expired rows in ai_response_cache.
 *
 * IMPORTANT: Cleanup is manual/external for Phase 3I.2.
 * There is no automatic scheduler, cron job, or background worker here.
 * A future phase may wire deleteExpiredCacheEntries() into an admin route
 * or a scheduled task — this file is that future hook point.
 *
 * Expired rows are already excluded from live read paths.
 * The lookup WHERE clause in response-cache.ts includes:
 *   AND expires_at > NOW()
 * so expired entries are never served regardless of cleanup schedule.
 *
 * Cleanup is therefore a storage hygiene operation, not a correctness requirement.
 */

import { lt } from "drizzle-orm";
import { db } from "../../db";
import { aiResponseCache } from "@shared/schema";

// ── SQL reference strings ─────────────────────────────────────────────────────
// These are the exact SQL statements an admin, DBA, or future scheduler
// should run to preview and perform cache cleanup.

/**
 * Preview SQL — counts expired rows without deleting them.
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
 * Cleanup SQL — deletes all expired cache rows.
 *
 * DELETE FROM ai_response_cache
 * WHERE expires_at < NOW();
 */
export const CACHE_CLEANUP_SQL = `
DELETE FROM ai_response_cache
WHERE expires_at < NOW();
`.trim();

// ── Drizzle helpers ───────────────────────────────────────────────────────────

/**
 * Count expired cache entries without deleting them.
 *
 * Safe to call at any time — read-only preview.
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
 * Delete all expired cache entries.
 *
 * Must only be called by admin tooling or a future scheduler.
 * Not called automatically anywhere in the request path.
 *
 * Returns the number of rows deleted, or 0 on error.
 */
export async function deleteExpiredCacheEntries(): Promise<number> {
  try {
    const result = await db
      .delete(aiResponseCache)
      .where(lt(aiResponseCache.expiresAt, new Date()));
    console.log(`[ai:cache-retention] Deleted ${result.rowCount ?? 0} expired cache entries`);
    return result.rowCount ?? 0;
  } catch (err) {
    console.warn("[ai:cache-retention] deleteExpiredCacheEntries failed:", err);
    return 0;
  }
}
