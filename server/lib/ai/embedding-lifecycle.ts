/**
 * embedding-lifecycle.ts — Phase 5F
 *
 * Embedding versioning support and lifecycle awareness.
 *
 * Purpose:
 *   - Provide stable version markers for embedding model + retrieval pipeline
 *   - Allow detection of stale embeddings (model changed, schema changed, etc.)
 *   - Support future re-indexing workflows without requiring a redesign
 *
 * Rules (Phase 5F):
 *   - No forced re-embedding in this phase
 *   - Only lifecycle/version-awareness
 *   - Future migration must be possible without redesign
 */

import { and, eq, ne, sql, desc } from "drizzle-orm";
import { db } from "../../db";
import { knowledgeEmbeddings, knowledgeIndexState, knowledgeBases } from "@shared/schema";

// ─── Version constants ────────────────────────────────────────────────────────

// Increment EMBEDDING_VERSION when the model or pipeline changes in a
// backwards-incompatible way (different vector space).
export const CURRENT_EMBEDDING_VERSION = "v1.0";

// Increment RETRIEVAL_VERSION when ranking/context assembly logic changes
// in a way that makes cached results stale.
export const CURRENT_RETRIEVAL_VERSION = "v1.0";

// Default embedding model identifier used by Phase 5C pipeline.
export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";

// ─── Version accessors ────────────────────────────────────────────────────────

export function getCurrentEmbeddingVersion(): string {
  return CURRENT_EMBEDDING_VERSION;
}

export function getCurrentRetrievalVersion(): string {
  return CURRENT_RETRIEVAL_VERSION;
}

export function getDefaultEmbeddingModel(): string {
  return DEFAULT_EMBEDDING_MODEL;
}

// ─── Stale embedding detection ────────────────────────────────────────────────

/**
 * Preview documents/embeddings that are stale (embedding_version doesn't match
 * the current version, or version is null).
 *
 * Returns a list of knowledge_base_id + counts. Does NOT trigger re-indexing.
 */
export async function previewStaleEmbeddingDocuments(params: {
  tenantId: string;
  knowledgeBaseId?: string;
  limit?: number;
}): Promise<Array<{
  knowledgeBaseId: string;
  embeddingId: string;
  documentId: string;
  currentVersion: string | null;
  expectedVersion: string;
  isStale: boolean;
}>> {
  const { tenantId, knowledgeBaseId, limit = 50 } = params;

  const conditions = knowledgeBaseId
    ? and(
        eq(knowledgeEmbeddings.tenantId, tenantId),
        eq(knowledgeEmbeddings.knowledgeBaseId, knowledgeBaseId),
      )
    : eq(knowledgeEmbeddings.tenantId, tenantId);

  const rows = await db
    .select({
      id: knowledgeEmbeddings.id,
      knowledgeBaseId: knowledgeEmbeddings.knowledgeBaseId,
      knowledgeDocumentId: knowledgeEmbeddings.knowledgeDocumentId,
      embeddingVersion: knowledgeEmbeddings.embeddingVersion,
    })
    .from(knowledgeEmbeddings)
    .where(conditions)
    .orderBy(desc(knowledgeEmbeddings.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    knowledgeBaseId: row.knowledgeBaseId,
    embeddingId: row.id,
    documentId: row.knowledgeDocumentId,
    currentVersion: row.embeddingVersion,
    expectedVersion: CURRENT_EMBEDDING_VERSION,
    isStale:
      row.embeddingVersion === null ||
      row.embeddingVersion !== CURRENT_EMBEDDING_VERSION,
  }));
}

// ─── Mark KB for reindex ──────────────────────────────────────────────────────

/**
 * Mark all index state rows for a knowledge base as 'stale'.
 * Does NOT trigger re-indexing. Future indexing jobs check is_stale and re-run.
 *
 * This is used when an embedding model/version change is detected.
 */
export async function markKnowledgeBaseForReindex(params: {
  tenantId: string;
  knowledgeBaseId: string;
  reason: string;
}): Promise<{ markedCount: number }> {
  const { tenantId, knowledgeBaseId, reason } = params;

  const result = await db
    .update(knowledgeIndexState)
    .set({
      indexState: "stale",
      staleReason: reason,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(knowledgeIndexState.tenantId, tenantId),
        eq(knowledgeIndexState.knowledgeBaseId, knowledgeBaseId),
        ne(knowledgeIndexState.indexState, "stale"),
      ),
    )
    .returning({ id: knowledgeIndexState.id });

  return { markedCount: result.length };
}

// ─── Explain embedding version state ─────────────────────────────────────────

/**
 * Explain the current embedding version state for a knowledge base.
 * Returns a human-readable summary for admin inspection.
 */
export async function explainEmbeddingVersionState(params: {
  tenantId: string;
  knowledgeBaseId: string;
}): Promise<Record<string, unknown>> {
  const { tenantId, knowledgeBaseId } = params;

  // Count embeddings by version
  const embeddingRows = await db
    .select({
      embeddingVersion: knowledgeEmbeddings.embeddingVersion,
      embeddingModel: knowledgeEmbeddings.embeddingModel,
    })
    .from(knowledgeEmbeddings)
    .where(
      and(
        eq(knowledgeEmbeddings.tenantId, tenantId),
        eq(knowledgeEmbeddings.knowledgeBaseId, knowledgeBaseId),
      ),
    );

  const totalEmbeddings = embeddingRows.length;

  // Version distribution
  const versionCounts: Record<string, number> = {};
  const modelCounts: Record<string, number> = {};
  for (const row of embeddingRows) {
    const v = row.embeddingVersion ?? "null";
    versionCounts[v] = (versionCounts[v] ?? 0) + 1;
    const m = row.embeddingModel ?? "unknown";
    modelCounts[m] = (modelCounts[m] ?? 0) + 1;
  }

  const staleCount = embeddingRows.filter(
    (r) => r.embeddingVersion === null || r.embeddingVersion !== CURRENT_EMBEDDING_VERSION,
  ).length;

  // Index state
  const indexRows = await db
    .select({ indexState: knowledgeIndexState.indexState })
    .from(knowledgeIndexState)
    .where(
      and(
        eq(knowledgeIndexState.tenantId, tenantId),
        eq(knowledgeIndexState.knowledgeBaseId, knowledgeBaseId),
      ),
    );

  const indexStateCounts: Record<string, number> = {};
  for (const row of indexRows) {
    indexStateCounts[row.indexState] = (indexStateCounts[row.indexState] ?? 0) + 1;
  }

  return {
    tenantId,
    knowledgeBaseId,
    currentEmbeddingVersion: CURRENT_EMBEDDING_VERSION,
    currentRetrievalVersion: CURRENT_RETRIEVAL_VERSION,
    defaultEmbeddingModel: DEFAULT_EMBEDDING_MODEL,
    totalEmbeddings,
    staleEmbeddings: staleCount,
    freshEmbeddings: totalEmbeddings - staleCount,
    stalePct: totalEmbeddings > 0 ? Math.round((staleCount / totalEmbeddings) * 100) : 0,
    versionDistribution: versionCounts,
    modelDistribution: modelCounts,
    indexStateCounts,
    requiresReindex: staleCount > 0,
    note: "Re-indexing is not triggered automatically in Phase 5F. Use markKnowledgeBaseForReindex() to schedule.",
  };
}
