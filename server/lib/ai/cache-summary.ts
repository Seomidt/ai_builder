/**
 * AI Cache Summary — Phase 3I
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Backend-only summary of cache state for a given tenant.
 * Future admin UI can consume this without refactor.
 *
 * No public route is registered here — this is a backend foundation only.
 */

import { eq, and, gt, lte, count, sql } from "drizzle-orm";
import { db } from "../../db";
import { aiResponseCache, aiCacheEvents } from "@shared/schema";

export interface AiCacheSummary {
  tenantId: string;
  totalEntries: number;
  liveEntries: number;
  expiredEntries: number;
  recentHits: number;
  recentMisses: number;
}

/**
 * Return a snapshot summary of the cache state for a tenant.
 *
 * "recent" = last 24 hours of ai_cache_events.
 * Fail-open on DB errors — returns zeroed summary.
 */
export async function getAiCacheSummary(tenantId: string): Promise<AiCacheSummary> {
  const now = new Date();
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1_000);

  try {
    const [entryRows, eventRows] = await Promise.all([
      db
        .select({
          live: sql<number>`count(*) filter (where ${aiResponseCache.expiresAt} > ${now})`,
          expired: sql<number>`count(*) filter (where ${aiResponseCache.expiresAt} <= ${now})`,
        })
        .from(aiResponseCache)
        .where(eq(aiResponseCache.tenantId, tenantId)),

      db
        .select({
          hits: sql<number>`count(*) filter (where ${aiCacheEvents.eventType} = 'cache_hit')`,
          misses: sql<number>`count(*) filter (where ${aiCacheEvents.eventType} = 'cache_miss')`,
        })
        .from(aiCacheEvents)
        .where(
          and(
            eq(aiCacheEvents.tenantId, tenantId),
            gt(aiCacheEvents.createdAt, since24h),
          ),
        ),
    ]);

    const live = Number(entryRows[0]?.live ?? 0);
    const expired = Number(entryRows[0]?.expired ?? 0);

    return {
      tenantId,
      totalEntries: live + expired,
      liveEntries: live,
      expiredEntries: expired,
      recentHits: Number(eventRows[0]?.hits ?? 0),
      recentMisses: Number(eventRows[0]?.misses ?? 0),
    };
  } catch (err) {
    console.warn("[ai:cache-summary] getAiCacheSummary failed:", err);
    return {
      tenantId,
      totalEntries: 0,
      liveEntries: 0,
      expiredEntries: 0,
      recentHits: 0,
      recentMisses: 0,
    };
  }
}
