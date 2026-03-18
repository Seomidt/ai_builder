/**
 * retrieval-cache.ts — Phase 5F
 *
 * Tenant+KB-scoped retrieval cache. Reduces redundant vector search overhead
 * for identical queries within the same knowledge base.
 *
 * Design:
 *   - Cache is tenant-scoped (INV-RET7: cross-tenant impossible)
 *   - Cache is KB-scoped
 *   - Expired rows are always ignored
 *   - Cache never bypasses lifecycle filters (hits still carry chunk IDs — caller
 *     must verify live chunk accessibility if freshness is critical)
 *   - Invalidation is mark-based (status → 'invalidated'), not delete
 *
 * Cache key: tenantId + knowledgeBaseId + queryHash + retrievalVersion
 */

import { and, eq, lt, gt, sql } from "drizzle-orm";
import crypto from "crypto";
import { db } from "../../db";
import { retrievalCacheEntries } from "@shared/schema";
import type { RetrievalCacheEntry } from "@shared/schema";
import { getCurrentRetrievalVersion } from "./embedding-lifecycle";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CachedRetrievalResult {
  cacheId: string;
  tenantId: string;
  knowledgeBaseId: string;
  queryHash: string;
  embeddingVersion: string | null;
  retrievalVersion: string;
  resultChunkIds: string[];
  resultSummary: Record<string, unknown> | null;
  cachedAt: Date;
  expiresAt: Date;
  hitStatus: "hit";
}

export interface StoreCacheParams {
  tenantId: string;
  knowledgeBaseId: string;
  queryHash: string;
  queryText: string;
  embeddingVersion?: string;
  resultChunkIds: string[];
  resultSummary?: Record<string, unknown>;
  ttlSeconds?: number;
}

// ─── Hash helper ──────────────────────────────────────────────────────────────

/**
 * Compute a stable SHA-256 hash for a retrieval query.
 * Normalises whitespace before hashing so minor formatting differences don't
 * produce different cache keys.
 */
export function hashRetrievalQuery(queryText: string): string {
  const normalised = queryText.trim().toLowerCase().replace(/\s+/g, " ");
  return crypto.createHash("sha256").update(normalised, "utf8").digest("hex");
}

// ─── Cache lookup ─────────────────────────────────────────────────────────────

/**
 * Try to retrieve a valid cached retrieval result.
 *
 * Returns null if:
 *   - no cache entry exists
 *   - entry is expired or invalidated
 *   - entry belongs to different tenant (impossible by query — belt-and-suspenders)
 */
export async function getCachedRetrieval(params: {
  tenantId: string;
  knowledgeBaseId: string;
  queryHash: string;
  retrievalVersion?: string;
}): Promise<CachedRetrievalResult | null> {
  const { tenantId, knowledgeBaseId, queryHash } = params;
  const retrievalVersion = params.retrievalVersion ?? getCurrentRetrievalVersion();
  const now = new Date();

  const [row] = await db
    .select()
    .from(retrievalCacheEntries)
    .where(
      and(
        eq(retrievalCacheEntries.tenantId, tenantId),
        eq(retrievalCacheEntries.knowledgeBaseId, knowledgeBaseId),
        eq(retrievalCacheEntries.queryHash, queryHash),
        eq(retrievalCacheEntries.retrievalVersion, retrievalVersion),
        eq(retrievalCacheEntries.cacheStatus, "active"),
        gt(retrievalCacheEntries.expiresAt, now),
      ),
    )
    .orderBy(retrievalCacheEntries.createdAt)
    .limit(1);

  if (!row) return null;

  const chunkIds = Array.isArray(row.resultChunkIds)
    ? (row.resultChunkIds as string[])
    : [];

  return {
    cacheId: row.id,
    tenantId: row.tenantId,
    knowledgeBaseId: row.knowledgeBaseId,
    queryHash: row.queryHash,
    embeddingVersion: row.embeddingVersion,
    retrievalVersion: row.retrievalVersion,
    resultChunkIds: chunkIds,
    resultSummary: row.resultSummary as Record<string, unknown> | null,
    cachedAt: row.createdAt,
    expiresAt: row.expiresAt,
    hitStatus: "hit",
  };
}

// ─── Cache store ──────────────────────────────────────────────────────────────

const DEFAULT_TTL_SECONDS = 3600; // 1 hour

/**
 * Store a retrieval result in the cache.
 * Only stores — does not invalidate previous entries.
 */
export async function storeCachedRetrieval(
  params: StoreCacheParams,
): Promise<{ cacheId: string }> {
  const {
    tenantId,
    knowledgeBaseId,
    queryHash,
    queryText,
    embeddingVersion,
    resultChunkIds,
    resultSummary,
    ttlSeconds = DEFAULT_TTL_SECONDS,
  } = params;

  const retrievalVersion = getCurrentRetrievalVersion();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  const [row] = await db
    .insert(retrievalCacheEntries)
    .values({
      tenantId,
      knowledgeBaseId,
      queryHash,
      queryText,
      embeddingVersion: embeddingVersion ?? null,
      retrievalVersion,
      cacheStatus: "active",
      resultChunkIds: resultChunkIds as unknown as Record<string, unknown>,
      resultSummary: resultSummary ?? null,
      expiresAt,
    })
    .returning({ id: retrievalCacheEntries.id });

  return { cacheId: row.id };
}

// ─── Invalidation ─────────────────────────────────────────────────────────────

/**
 * Invalidate all active cache entries for a knowledge base.
 * Called when a KB is re-indexed or documents are updated.
 */
export async function invalidateRetrievalCacheForKnowledgeBase(params: {
  tenantId: string;
  knowledgeBaseId: string;
}): Promise<{ invalidatedCount: number }> {
  const { tenantId, knowledgeBaseId } = params;

  const result = await db
    .update(retrievalCacheEntries)
    .set({ cacheStatus: "invalidated", updatedAt: new Date() })
    .where(
      and(
        eq(retrievalCacheEntries.tenantId, tenantId),
        eq(retrievalCacheEntries.knowledgeBaseId, knowledgeBaseId),
        eq(retrievalCacheEntries.cacheStatus, "active"),
      ),
    )
    .returning({ id: retrievalCacheEntries.id });

  return { invalidatedCount: result.length };
}

/**
 * Invalidate all active cache entries that reference a specific document.
 * Uses JSONB containment check — marks entries where result_chunk_ids contains
 * any of the provided document-derived chunk IDs.
 *
 * Note: For simplicity, this invalidates the whole KB cache for the tenant when
 * a document changes (safest approach without maintaining chunk→document index).
 */
export async function invalidateRetrievalCacheForDocument(params: {
  tenantId: string;
  knowledgeBaseId: string;
  documentId: string;
}): Promise<{ invalidatedCount: number }> {
  // Safest: invalidate entire KB cache for the tenant when a document changes.
  return invalidateRetrievalCacheForKnowledgeBase({
    tenantId: params.tenantId,
    knowledgeBaseId: params.knowledgeBaseId,
  });
}

// ─── Expired cache preview ────────────────────────────────────────────────────

/**
 * Preview expired cache entries that can be cleaned up.
 * Returns count + sample rows.
 */
export async function previewExpiredRetrievalCache(params: {
  tenantId: string;
  knowledgeBaseId?: string;
  limit?: number;
}): Promise<{
  expiredCount: number;
  sample: Array<{ id: string; queryHash: string; expiresAt: Date; cacheStatus: string }>;
}> {
  const { tenantId, knowledgeBaseId, limit = 10 } = params;
  const now = new Date();

  const conditions = knowledgeBaseId
    ? and(
        eq(retrievalCacheEntries.tenantId, tenantId),
        eq(retrievalCacheEntries.knowledgeBaseId, knowledgeBaseId),
        lt(retrievalCacheEntries.expiresAt, now),
      )
    : and(
        eq(retrievalCacheEntries.tenantId, tenantId),
        lt(retrievalCacheEntries.expiresAt, now),
      );

  const rows = await db
    .select({
      id: retrievalCacheEntries.id,
      queryHash: retrievalCacheEntries.queryHash,
      expiresAt: retrievalCacheEntries.expiresAt,
      cacheStatus: retrievalCacheEntries.cacheStatus,
    })
    .from(retrievalCacheEntries)
    .where(conditions)
    .limit(limit);

  return {
    expiredCount: rows.length,
    sample: rows.map((r) => ({
      id: r.id,
      queryHash: r.queryHash,
      expiresAt: r.expiresAt,
      cacheStatus: r.cacheStatus,
    })),
  };
}
