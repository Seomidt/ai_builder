/**
 * retrieval-metrics.ts — Phase 5F
 *
 * Records and queries retrieval quality telemetry.
 *
 * A retrieval_metrics row is appended after each successful retrieval run
 * to capture quality signals: similarity distribution, dedup count, token utilisation,
 * document diversity, etc.
 *
 * Append-only. No updates. No deletes.
 */

import { eq, and, avg, max, min, count, desc } from "drizzle-orm";
import { db } from "../../db";
import { retrievalMetrics } from "@shared/schema";
import type { ContextWindow } from "./context-window-builder";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecordRetrievalMetricsParams {
  retrievalRunId: string;
  tenantId: string;
  knowledgeBaseId: string;
  contextWindow: ContextWindow;
  dedupRemovedCount?: number;
}

export interface RetrievalMetricsSummaryScope {
  tenantId: string;
  knowledgeBaseId?: string;
  limit?: number;
}

// ─── Core functions ───────────────────────────────────────────────────────────

/**
 * Record retrieval quality metrics for a completed retrieval run.
 * Derives similarity stats from context window entries.
 */
export async function recordRetrievalMetrics(
  params: RecordRetrievalMetricsParams,
): Promise<{ metricId: string }> {
  const { retrievalRunId, tenantId, knowledgeBaseId, contextWindow, dedupRemovedCount = 0 } = params;

  const scores = contextWindow.entries.map((e) => e.metadata.similarityScore).filter((s) => s > 0);
  const avgSimilarity = scores.length > 0
    ? String((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(6))
    : null;
  const topSimilarity = scores.length > 0 ? String(Math.max(...scores).toFixed(6)) : null;
  const lowestSimilarity = scores.length > 0 ? String(Math.min(...scores).toFixed(6)) : null;

  // Diversity score: ratio of unique docs to total chunks (0-1 scale, higher = more diverse)
  const diversityScore =
    contextWindow.chunksSelected > 0 && contextWindow.documentCount > 0
      ? String(
          Math.min(1, contextWindow.documentCount / contextWindow.chunksSelected).toFixed(4),
        )
      : null;

  const [row] = await db
    .insert(retrievalMetrics)
    .values({
      retrievalRunId,
      tenantId,
      knowledgeBaseId,
      chunkCount: contextWindow.chunksSelected,
      uniqueDocumentCount: contextWindow.documentCount,
      tokenUsed: contextWindow.totalEstimatedTokens,
      tokenBudget: contextWindow.totalEstimatedTokens + contextWindow.budgetRemaining,
      dedupRemovedCount: dedupRemovedCount + contextWindow.chunksSkippedDuplicate,
      avgSimilarity,
      topSimilarity,
      lowestSimilarity,
      diversityScore,
    })
    .returning({ id: retrievalMetrics.id });

  return { metricId: row.id };
}

/**
 * Get retrieval metrics for a specific run.
 */
export async function getRetrievalMetricsByRunId(
  runId: string,
): Promise<Record<string, unknown> | null> {
  const [row] = await db
    .select()
    .from(retrievalMetrics)
    .where(eq(retrievalMetrics.retrievalRunId, runId))
    .limit(1);

  if (!row) return null;
  return {
    metricId: row.id,
    retrievalRunId: row.retrievalRunId,
    tenantId: row.tenantId,
    knowledgeBaseId: row.knowledgeBaseId,
    chunkCount: row.chunkCount,
    uniqueDocumentCount: row.uniqueDocumentCount,
    tokenUsed: row.tokenUsed,
    tokenBudget: row.tokenBudget,
    dedupRemovedCount: row.dedupRemovedCount,
    avgSimilarity: row.avgSimilarity,
    topSimilarity: row.topSimilarity,
    lowestSimilarity: row.lowestSimilarity,
    diversityScore: row.diversityScore,
    createdAt: row.createdAt,
  };
}

/**
 * Get retrieval metrics summary for a tenant (optionally scoped to KB).
 * Returns the most recent rows up to a limit.
 */
export async function getRetrievalMetricsSummary(
  scope: RetrievalMetricsSummaryScope,
): Promise<Record<string, unknown>[]> {
  const { tenantId, knowledgeBaseId, limit = 50 } = scope;

  const conditions = knowledgeBaseId
    ? and(
        eq(retrievalMetrics.tenantId, tenantId),
        eq(retrievalMetrics.knowledgeBaseId, knowledgeBaseId),
      )
    : eq(retrievalMetrics.tenantId, tenantId);

  const rows = await db
    .select()
    .from(retrievalMetrics)
    .where(conditions)
    .orderBy(desc(retrievalMetrics.createdAt))
    .limit(limit);

  return rows.map((row) => ({
    metricId: row.id,
    retrievalRunId: row.retrievalRunId,
    knowledgeBaseId: row.knowledgeBaseId,
    chunkCount: row.chunkCount,
    uniqueDocumentCount: row.uniqueDocumentCount,
    tokenUsed: row.tokenUsed,
    tokenBudget: row.tokenBudget,
    budgetUtilizationPct:
      row.tokenBudget > 0 ? Math.round((row.tokenUsed / row.tokenBudget) * 100) : 0,
    dedupRemovedCount: row.dedupRemovedCount,
    avgSimilarity: row.avgSimilarity,
    topSimilarity: row.topSimilarity,
    lowestSimilarity: row.lowestSimilarity,
    diversityScore: row.diversityScore,
    createdAt: row.createdAt,
  }));
}
