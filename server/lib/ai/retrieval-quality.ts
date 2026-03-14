/**
 * retrieval-quality.ts — Phase 5Q
 *
 * Deterministic retrieval quality signal computation.
 *
 * Design invariants:
 *   INV-QUAL4  Quality signals are deterministic and tenant-safe
 *   INV-QUAL8  Preview/explain functions perform no writes
 *   INV-QUAL9  Metrics are tenant-isolated
 */

import { eq } from "drizzle-orm";
import { db } from "../../db";
import { knowledgeRetrievalQualitySignals } from "@shared/schema";
import {
  QUALITY_SIGNAL_HIGH_CONFIDENCE_THRESHOLD,
  QUALITY_SIGNAL_MEDIUM_CONFIDENCE_THRESHOLD,
  QUALITY_SIGNAL_HIGH_DIVERSITY_THRESHOLD,
} from "../config/retrieval-config";

// ── Types ─────────────────────────────────────────────────────────────────────

export type ConfidenceBand = "high" | "medium" | "low" | "unknown";

export interface QualityChunkInput {
  chunkId: string;
  documentId: string;
  sourceType: string;
  finalScore: number;
  chunkText?: string;
}

export interface QualitySignalParams {
  tenantId: string;
  retrievalRunId: string;
  chunks: QualityChunkInput[];
  citedChunkIds?: string[];
  safetyFlagCount?: number;
  safetyStatus?: string;
  persistSignals?: boolean;
}

export interface RetrievalQualitySignals {
  tenantId: string;
  retrievalRunId: string;
  sourceDiversityScore: number;
  documentDiversityScore: number;
  dominantDocumentRatio: number;
  dominantSourceTypeRatio: number;
  averageFinalScore: number;
  scoreSpread: number;
  citationCoverageEstimate: number;
  contextRedundancyScore: number;
  retrievalConfidenceBand: ConfidenceBand;
  safetyStatus: string;
  flaggedChunkCount: number;
  qualityRunId: string | null;
}

// ── Core signal computation ───────────────────────────────────────────────────

/**
 * Compute all retrieval quality signals deterministically (INV-QUAL4).
 * Given the same input, always returns the same output.
 */
export async function computeRetrievalQualitySignals(
  params: QualitySignalParams,
): Promise<RetrievalQualitySignals> {
  const {
    tenantId,
    retrievalRunId,
    chunks,
    citedChunkIds = [],
    safetyFlagCount = 0,
    safetyStatus = "unknown",
    persistSignals = false,
  } = params;

  if (chunks.length === 0) {
    const empty: RetrievalQualitySignals = {
      tenantId,
      retrievalRunId,
      sourceDiversityScore: 0,
      documentDiversityScore: 0,
      dominantDocumentRatio: 0,
      dominantSourceTypeRatio: 0,
      averageFinalScore: 0,
      scoreSpread: 0,
      citationCoverageEstimate: 0,
      contextRedundancyScore: 0,
      retrievalConfidenceBand: "unknown",
      safetyStatus,
      flaggedChunkCount: safetyFlagCount,
      qualityRunId: null,
    };
    return empty;
  }

  const total = chunks.length;

  // Source diversity: unique source types / min(total, 5) — capped at 1.0
  const uniqueSources = new Set(chunks.map((c) => c.sourceType)).size;
  const sourceDiversityScore = parseFloat(
    Math.min(uniqueSources / Math.max(1, Math.min(total, 5)), 1.0).toFixed(4),
  );

  // Document diversity: unique documentIds / total
  const uniqueDocIds = new Set(chunks.map((c) => c.documentId));
  const documentDiversityScore = parseFloat(
    Math.min(uniqueDocIds.size / total, 1.0).toFixed(4),
  );

  // Dominant document ratio: max chunk count per document / total
  const docCounts = new Map<string, number>();
  for (const c of chunks) docCounts.set(c.documentId, (docCounts.get(c.documentId) ?? 0) + 1);
  const maxDocCount = Math.max(...docCounts.values());
  const dominantDocumentRatio = parseFloat((maxDocCount / total).toFixed(4));

  // Dominant source type ratio
  const srcCounts = new Map<string, number>();
  for (const c of chunks) srcCounts.set(c.sourceType, (srcCounts.get(c.sourceType) ?? 0) + 1);
  const maxSrcCount = Math.max(...srcCounts.values());
  const dominantSourceTypeRatio = parseFloat((maxSrcCount / total).toFixed(4));

  // Score statistics
  const scores = chunks.map((c) => c.finalScore);
  const averageFinalScore = parseFloat(
    (scores.reduce((a, b) => a + b, 0) / total).toFixed(6),
  );
  const minScore = Math.min(...scores);
  const maxScore = Math.max(...scores);
  const scoreSpread = parseFloat((maxScore - minScore).toFixed(6));

  // Citation coverage: cited chunks / total (0 if no citation data)
  const citationCoverageEstimate = citedChunkIds.length > 0
    ? parseFloat(Math.min(citedChunkIds.length / total, 1.0).toFixed(4))
    : 0;

  // Context redundancy: 1 - (unique text prefixes / total)
  // Proxy: unique first-80-char prefixes
  const textPrefixes = new Set(
    chunks.map((c) => (c.chunkText ?? "").slice(0, 80).toLowerCase().trim()),
  );
  const contextRedundancyScore = parseFloat(
    Math.max(0, 1 - textPrefixes.size / total).toFixed(4),
  );

  // Confidence band (deterministic thresholds)
  let retrievalConfidenceBand: ConfidenceBand;
  if (
    averageFinalScore >= QUALITY_SIGNAL_HIGH_CONFIDENCE_THRESHOLD &&
    documentDiversityScore >= QUALITY_SIGNAL_HIGH_DIVERSITY_THRESHOLD &&
    safetyStatus !== "high_risk"
  ) {
    retrievalConfidenceBand = "high";
  } else if (averageFinalScore >= QUALITY_SIGNAL_MEDIUM_CONFIDENCE_THRESHOLD) {
    retrievalConfidenceBand = "medium";
  } else if (averageFinalScore > 0) {
    retrievalConfidenceBand = "low";
  } else {
    retrievalConfidenceBand = "unknown";
  }

  const signals: RetrievalQualitySignals = {
    tenantId,
    retrievalRunId,
    sourceDiversityScore,
    documentDiversityScore,
    dominantDocumentRatio,
    dominantSourceTypeRatio,
    averageFinalScore,
    scoreSpread,
    citationCoverageEstimate,
    contextRedundancyScore,
    retrievalConfidenceBand,
    safetyStatus,
    flaggedChunkCount: safetyFlagCount,
    qualityRunId: null,
  };

  // Persist if requested (INV-QUAL8: only when explicitly opted-in)
  if (persistSignals) {
    const inserted = await db
      .insert(knowledgeRetrievalQualitySignals)
      .values({
        tenantId,
        retrievalRunId,
        confidenceBand: retrievalConfidenceBand,
        sourceDiversityScore: sourceDiversityScore.toFixed(4),
        documentDiversityScore: documentDiversityScore.toFixed(4),
        contextRedundancyScore: contextRedundancyScore.toFixed(4),
        safetyStatus,
        flaggedChunkCount: safetyFlagCount,
      })
      .returning({ id: knowledgeRetrievalQualitySignals.id });

    signals.qualityRunId = inserted[0]?.id ?? null;
  }

  return signals;
}

// ── Read-only operations ──────────────────────────────────────────────────────

export async function summarizeRetrievalQualitySignals(retrievalRunId: string): Promise<{
  retrievalRunId: string;
  confidenceBand: string | null;
  sourceDiversityScore: string | null;
  documentDiversityScore: string | null;
  contextRedundancyScore: string | null;
  safetyStatus: string | null;
  flaggedChunkCount: number | null;
  createdAt: Date | null;
  found: boolean;
  note: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalQualitySignals)
    .where(eq(knowledgeRetrievalQualitySignals.retrievalRunId, retrievalRunId))
    .limit(1);

  const row = rows[0];
  if (!row) {
    return {
      retrievalRunId,
      confidenceBand: null,
      sourceDiversityScore: null,
      documentDiversityScore: null,
      contextRedundancyScore: null,
      safetyStatus: null,
      flaggedChunkCount: null,
      createdAt: null,
      found: false,
      note: "No quality signals found for this retrieval run",
    };
  }

  return {
    retrievalRunId,
    confidenceBand: row.confidenceBand,
    sourceDiversityScore: row.sourceDiversityScore,
    documentDiversityScore: row.documentDiversityScore,
    contextRedundancyScore: row.contextRedundancyScore,
    safetyStatus: row.safetyStatus,
    flaggedChunkCount: row.flaggedChunkCount,
    createdAt: row.createdAt,
    found: true,
    note: `Quality signals found for retrieval run ${retrievalRunId}`,
  };
}

export async function explainRetrievalQuality(retrievalRunId: string): Promise<{
  retrievalRunId: string;
  explanation: Array<{ signal: string; value: string | number | null; interpretation: string }>;
  note: string;
}> {
  const summary = await summarizeRetrievalQualitySignals(retrievalRunId);

  const explanation = [
    {
      signal: "confidence_band",
      value: summary.confidenceBand,
      interpretation: summary.confidenceBand === "high"
        ? "High-quality retrieval: strong scores + diverse sources"
        : summary.confidenceBand === "medium"
        ? "Medium quality: acceptable scores but limited diversity"
        : summary.confidenceBand === "low"
        ? "Low quality: weak scores or insufficient diversity"
        : "Unknown: no quality signals computed yet",
    },
    {
      signal: "source_diversity_score",
      value: summary.sourceDiversityScore,
      interpretation: "Proportion of unique source types in retrieved context (0=no diversity, 1=max diversity)",
    },
    {
      signal: "document_diversity_score",
      value: summary.documentDiversityScore,
      interpretation: "Proportion of unique documents in retrieved context (0=single doc, 1=all unique)",
    },
    {
      signal: "context_redundancy_score",
      value: summary.contextRedundancyScore,
      interpretation: "Proportion of near-duplicate text prefixes (0=fully unique, 1=all duplicates)",
    },
    {
      signal: "safety_status",
      value: summary.safetyStatus,
      interpretation: `Safety review outcome: ${summary.safetyStatus ?? "not reviewed"}. ${summary.flaggedChunkCount ?? 0} chunk(s) flagged.`,
    },
  ];

  return {
    retrievalRunId,
    explanation,
    note: "Read-only explanation. INV-QUAL8: no writes performed.",
  };
}

// ── Quality metrics for runtime telemetry ─────────────────────────────────────

export interface RetrievalQualityMetrics {
  queryRewriteLatencyMs: number | null;
  queryExpansionCount: number;
  safetyReviewLatencyMs: number | null;
  flaggedChunkCount: number;
  excludedForSafetyCount: number;
  qualityConfidenceBand: ConfidenceBand;
}

export async function recordRetrievalQualityMetrics(
  _runId: string,
  _metrics: RetrievalQualityMetrics,
): Promise<void> {
  // Phase 5Q metrics are stored inline in knowledge_retrieval_runs
  // and knowledge_retrieval_quality_signals via computeRetrievalQualitySignals(persistSignals=true)
  // This function is intentionally a no-op: use migrate columns + direct DB writes
  void _runId;
  void _metrics;
}

export async function getRetrievalQualityMetrics(
  retrievalRunId: string,
): Promise<RetrievalQualityMetrics | null> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalQualitySignals)
    .where(eq(knowledgeRetrievalQualitySignals.retrievalRunId, retrievalRunId))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  return {
    queryRewriteLatencyMs: null,
    queryExpansionCount: 0,
    safetyReviewLatencyMs: null,
    flaggedChunkCount: row.flaggedChunkCount ?? 0,
    excludedForSafetyCount: 0,
    qualityConfidenceBand: (row.confidenceBand ?? "unknown") as ConfidenceBand,
  };
}

export async function summarizeRetrievalQualityMetrics(tenantId: string): Promise<{
  tenantId: string;
  totalQualityRuns: number;
  highConfidenceCount: number;
  mediumConfidenceCount: number;
  lowConfidenceCount: number;
  unknownConfidenceCount: number;
  totalFlaggedChunks: number;
  avgSourceDiversity: number | null;
  avgDocumentDiversity: number | null;
  note: string;
}> {
  const rows = await db
    .select()
    .from(knowledgeRetrievalQualitySignals)
    .where(eq(knowledgeRetrievalQualitySignals.tenantId, tenantId));

  if (rows.length === 0) {
    return {
      tenantId,
      totalQualityRuns: 0,
      highConfidenceCount: 0,
      mediumConfidenceCount: 0,
      lowConfidenceCount: 0,
      unknownConfidenceCount: 0,
      totalFlaggedChunks: 0,
      avgSourceDiversity: null,
      avgDocumentDiversity: null,
      note: "No quality signals found for tenant",
    };
  }

  const srcDivScores = rows
    .map((r) => parseFloat(r.sourceDiversityScore ?? "0"))
    .filter(Boolean);
  const docDivScores = rows
    .map((r) => parseFloat(r.documentDiversityScore ?? "0"))
    .filter(Boolean);

  return {
    tenantId,
    totalQualityRuns: rows.length,
    highConfidenceCount: rows.filter((r) => r.confidenceBand === "high").length,
    mediumConfidenceCount: rows.filter((r) => r.confidenceBand === "medium").length,
    lowConfidenceCount: rows.filter((r) => r.confidenceBand === "low").length,
    unknownConfidenceCount: rows.filter((r) => r.confidenceBand === "unknown" || !r.confidenceBand).length,
    totalFlaggedChunks: rows.reduce((acc, r) => acc + (r.flaggedChunkCount ?? 0), 0),
    avgSourceDiversity: srcDivScores.length > 0
      ? parseFloat((srcDivScores.reduce((a, b) => a + b, 0) / srcDivScores.length).toFixed(4))
      : null,
    avgDocumentDiversity: docDivScores.length > 0
      ? parseFloat((docDivScores.reduce((a, b) => a + b, 0) / docDivScores.length).toFixed(4))
      : null,
    note: `${rows.length} quality signal run(s) found for tenant`,
  };
}
