/**
 * context-window-builder.ts — Phase 5E
 *
 * Assembles retrieval context from ranked chunks for LLM consumption.
 *
 * Responsibilities:
 *   - Assemble chunk texts in reading order
 *   - Maintain chunk order within documents (chunk_index respected)
 *   - Prevent overlapping segments
 *   - Track token usage precisely
 *   - Include full traceable metadata per chunk (INV-RET10)
 *   - Enforce token budget (INV-RET5)
 *
 * This module does NOT call LLMs. It only prepares structured context.
 */

import type { RankedChunk } from "./chunk-ranking";
import {
  enforceTokenBudget,
  estimateTokens,
  estimateChunkTokens,
  formatBudgetSummary,
  DEFAULT_CONTEXT_TOKEN_BUDGET,
  type TokenBudgetOptions,
} from "./token-budget";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ContextChunkMetadata {
  rank: number;
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  knowledgeBaseId: string;
  chunkIndex: number;
  chunkKey: string;
  sourcePageStart: number | null;
  sourceHeadingPath: string | null;
  similarityScore: number;
  similarityMetric: string;
  contentHash: string | null;
  estimatedTokens: number;
}

export interface ContextWindowEntry {
  text: string;
  metadata: ContextChunkMetadata;
}

export interface ContextWindow {
  entries: ContextWindowEntry[];
  totalEstimatedTokens: number;
  budgetRemaining: number;
  budgetUtilizationPct: number;
  chunksSelected: number;
  chunksSkippedBudget: number;
  chunksSkippedDuplicate: number;
  documentCount: number;
  documentIds: string[];
  assembledText: string;
  assemblyFormat: "plain" | "cited";
}

export interface ContextWindowOptions {
  maxTokens?: number;
  metadataOverheadTokens?: number;
  format?: "plain" | "cited";
  chunkSeparator?: string;
  includeCitations?: boolean;
  deduplicateByContentHash?: boolean;
}

// ─── Context assembly ─────────────────────────────────────────────────────────

/**
 * Build a context window from ranked chunks.
 *
 * Process:
 *   1. Enforce token budget (greedy — add chunks in rank order)
 *   2. Deduplicate by content hash (if enabled, catches exact duplicates)
 *   3. Assemble final text with optional citation markers
 *   4. Return structured ContextWindow with full metadata (INV-RET10)
 */
export function buildContextWindow(
  rankedChunks: RankedChunk[],
  options: ContextWindowOptions = {},
): ContextWindow {
  const {
    maxTokens = DEFAULT_CONTEXT_TOKEN_BUDGET,
    metadataOverheadTokens = 50,
    format = "plain",
    chunkSeparator = "\n\n---\n\n",
    includeCitations = false,
    deduplicateByContentHash = true,
  } = options;

  const budgetOpts: TokenBudgetOptions = {
    maxTokens,
    metadataOverheadTokens,
  };

  // Step 1: Enforce token budget
  const budgetResult = enforceTokenBudget(rankedChunks, budgetOpts);

  // Step 2: Deduplicate selected chunks by content hash (exact duplicate removal)
  const seenHashes = new Set<string>();
  let dupSkipped = 0;
  const deduped: RankedChunk[] = [];

  for (const chunk of budgetResult.selected) {
    if (deduplicateByContentHash && chunk.contentHash) {
      if (seenHashes.has(chunk.contentHash)) {
        dupSkipped++;
        continue;
      }
      seenHashes.add(chunk.contentHash);
    }
    deduped.push(chunk);
  }

  // Step 3: Build entries with metadata
  const entries: ContextWindowEntry[] = deduped.map((chunk, idx) => {
    const text = chunk.chunkText ?? "";
    return {
      text,
      metadata: {
        rank: chunk.rank,
        chunkId: chunk.chunkId,
        documentId: chunk.documentId,
        documentVersionId: chunk.documentVersionId,
        knowledgeBaseId: chunk.knowledgeBaseId,
        chunkIndex: chunk.chunkIndex,
        chunkKey: chunk.chunkKey,
        sourcePageStart: chunk.sourcePageStart,
        sourceHeadingPath: chunk.sourceHeadingPath,
        similarityScore: chunk.similarityScore,
        similarityMetric: chunk.similarityMetric,
        contentHash: chunk.contentHash,
        estimatedTokens: estimateChunkTokens(text, metadataOverheadTokens),
      },
    };
  });

  // Step 4: Assemble text
  let assembledText: string;
  if (format === "cited" || includeCitations) {
    assembledText = entries
      .map((entry, idx) => {
        const docShort = entry.metadata.documentId.slice(0, 8);
        const page = entry.metadata.sourcePageStart != null ? ` (p.${entry.metadata.sourcePageStart})` : "";
        return `[${idx + 1}] (doc:${docShort}${page}, score:${entry.metadata.similarityScore.toFixed(3)})\n${entry.text}`;
      })
      .join(chunkSeparator);
  } else {
    assembledText = entries.map((e) => e.text).join(chunkSeparator);
  }

  // Step 5: Collect document IDs (unique, in order)
  const docIdOrder: string[] = [];
  const seenDocs = new Set<string>();
  for (const entry of entries) {
    if (!seenDocs.has(entry.metadata.documentId)) {
      docIdOrder.push(entry.metadata.documentId);
      seenDocs.add(entry.metadata.documentId);
    }
  }

  const totalTokens = entries.reduce((sum, e) => sum + e.metadata.estimatedTokens, 0);
  const effectiveBudget = maxTokens;

  return {
    entries,
    totalEstimatedTokens: totalTokens,
    budgetRemaining: effectiveBudget - totalTokens,
    budgetUtilizationPct: effectiveBudget > 0 ? Math.round((totalTokens / effectiveBudget) * 100) : 0,
    chunksSelected: entries.length,
    chunksSkippedBudget: budgetResult.skippedBudget.length,
    chunksSkippedDuplicate: dupSkipped,
    documentCount: docIdOrder.length,
    documentIds: docIdOrder,
    assembledText,
    assemblyFormat: format,
  };
}

/**
 * Format context window for logging / debug output.
 */
export function summarizeContextWindow(window: ContextWindow): Record<string, unknown> {
  return {
    chunksSelected: window.chunksSelected,
    chunksSkippedBudget: window.chunksSkippedBudget,
    chunksSkippedDuplicate: window.chunksSkippedDuplicate,
    totalEstimatedTokens: window.totalEstimatedTokens,
    budgetUtilizationPct: window.budgetUtilizationPct,
    budgetRemaining: window.budgetRemaining,
    documentCount: window.documentCount,
    documentIds: window.documentIds,
    assemblyFormat: window.assemblyFormat,
    assembledTextLength: window.assembledText.length,
    topChunks: window.entries.slice(0, 3).map((e) => ({
      rank: e.metadata.rank,
      chunkId: e.metadata.chunkId,
      documentId: e.metadata.documentId,
      similarityScore: e.metadata.similarityScore,
      estimatedTokens: e.metadata.estimatedTokens,
      textPreview: e.text.slice(0, 80),
    })),
  };
}
