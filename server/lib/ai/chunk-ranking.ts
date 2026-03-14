/**
 * chunk-ranking.ts — Phase 5E
 *
 * Chunk selection and ranking logic for retrieval orchestration.
 *
 * Ranking factors (in order of precedence):
 *   1. Vector similarity score (primary — from Phase 5D search)
 *   2. Duplicate suppression (INV-RET9: similar text content removed)
 *   3. Document proximity grouping (chunks from same doc stay together)
 *   4. Chunk ordering (chunk_index respected within same doc+version)
 *
 * This module is purely functional — no DB calls, no side effects.
 */

import type { VectorSearchCandidate } from "./vector-search";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RankedChunk {
  rank: number;
  chunkId: string;
  documentId: string;
  documentVersionId: string;
  knowledgeBaseId: string;
  chunkText: string | null;
  chunkIndex: number;
  chunkKey: string;
  sourcePageStart: number | null;
  sourceHeadingPath: string | null;
  similarityScore: number;
  similarityMetric: string;
  contentHash: string | null;
  documentGroup: number;
}

export interface RankingOptions {
  similarityThreshold?: number;
  duplicateSimilarityThreshold?: number;
  groupByDocument?: boolean;
  maxChunksPerDocument?: number;
}

export interface RankingResult {
  ranked: RankedChunk[];
  skippedDuplicate: VectorSearchCandidate[];
  skippedThreshold: VectorSearchCandidate[];
  documentGroups: Map<string, RankedChunk[]>;
}

// ─── Duplicate detection ──────────────────────────────────────────────────────

/**
 * Simple character-level Jaccard similarity for duplicate suppression.
 * Fast enough for context-size text comparisons without embedding calls.
 */
function computeJaccardSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;

  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));

  let intersectionSize = 0;
  for (const word of Array.from(setA)) {
    if (setB.has(word)) intersectionSize++;
  }

  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

/**
 * Check if a candidate is sufficiently similar to any already-selected chunk.
 * Used to suppress near-duplicate content. (INV-RET9)
 */
function isDuplicate(
  candidate: VectorSearchCandidate,
  selected: RankedChunk[],
  threshold: number,
): boolean {
  if (!candidate.chunkText) return false;

  for (const existing of selected) {
    if (!existing.chunkText) continue;
    if (existing.chunkId === candidate.chunkId) return true;
    const sim = computeJaccardSimilarity(candidate.chunkText, existing.chunkText);
    if (sim >= threshold) return true;
  }
  return false;
}

// ─── Document grouping ────────────────────────────────────────────────────────

/**
 * Assign document group numbers based on similarity score order.
 * Documents encountered earlier (higher similarity) get lower group numbers.
 * Within each group, chunks are sorted by chunk_index.
 */
function buildDocumentGroupMap(
  candidates: VectorSearchCandidate[],
): Map<string, number> {
  const groupMap = new Map<string, number>();
  let nextGroup = 0;
  for (const c of candidates) {
    if (!groupMap.has(c.documentId)) {
      groupMap.set(c.documentId, nextGroup++);
    }
  }
  return groupMap;
}

// ─── Core ranking function ────────────────────────────────────────────────────

/**
 * Rank and filter vector search candidates for retrieval assembly.
 *
 * Process:
 *   1. Filter by similarity threshold (if set)
 *   2. Suppress near-duplicate chunks (INV-RET9)
 *   3. Apply per-document limits (if set)
 *   4. Group by document + sort by chunk_index within groups
 *   5. Assign final ranks
 */
export function rankChunks(
  candidates: VectorSearchCandidate[],
  options: RankingOptions = {},
): RankingResult {
  const {
    similarityThreshold = 0,
    duplicateSimilarityThreshold = 0.85,
    groupByDocument = true,
    maxChunksPerDocument,
  } = options;

  const skippedThreshold: VectorSearchCandidate[] = [];
  const skippedDuplicate: VectorSearchCandidate[] = [];
  const docGroupMap = buildDocumentGroupMap(candidates);
  const docChunkCounts = new Map<string, number>();

  // Step 1: Filter by similarity threshold
  const thresholdPassed = candidates.filter((c) => {
    if (c.similarityScore < similarityThreshold) {
      skippedThreshold.push(c);
      return false;
    }
    return true;
  });

  // Step 2: Duplicate suppression (INV-RET9) + per-doc limits
  const deduplicated: VanillaRanked[] = [];

  for (const candidate of thresholdPassed) {
    if (isDuplicate(candidate, deduplicated as unknown as RankedChunk[], duplicateSimilarityThreshold)) {
      skippedDuplicate.push(candidate);
      continue;
    }

    const docCount = docChunkCounts.get(candidate.documentId) ?? 0;
    if (maxChunksPerDocument != null && docCount >= maxChunksPerDocument) {
      skippedDuplicate.push(candidate);
      continue;
    }

    docChunkCounts.set(candidate.documentId, docCount + 1);
    deduplicated.push({
      ...candidate,
      documentGroup: docGroupMap.get(candidate.documentId) ?? 0,
    });
  }

  // Step 3: Sort — by doc group then chunk_index (if groupByDocument), else by similarity
  let sorted: VanillaRanked[];
  if (groupByDocument && deduplicated.length > 0) {
    sorted = [...deduplicated].sort((a, b) => {
      if (a.documentGroup !== b.documentGroup) return a.documentGroup - b.documentGroup;
      if (a.documentId === b.documentId) return a.chunkIndex - b.chunkIndex;
      return b.similarityScore - a.similarityScore;
    });
  } else {
    sorted = [...deduplicated].sort((a, b) => b.similarityScore - a.similarityScore);
  }

  // Step 4: Assign final ranks
  const ranked: RankedChunk[] = sorted.map((c, idx) => ({
    rank: idx + 1,
    chunkId: c.chunkId,
    documentId: c.documentId,
    documentVersionId: c.documentVersionId,
    knowledgeBaseId: c.knowledgeBaseId,
    chunkText: c.chunkText,
    chunkIndex: c.chunkIndex,
    chunkKey: c.chunkKey,
    sourcePageStart: c.sourcePageStart,
    sourceHeadingPath: c.sourceHeadingPath,
    similarityScore: c.similarityScore,
    similarityMetric: c.similarityMetric,
    contentHash: c.contentHash,
    documentGroup: c.documentGroup,
  }));

  // Step 5: Build document groups map
  const documentGroups = new Map<string, RankedChunk[]>();
  for (const chunk of ranked) {
    const existing = documentGroups.get(chunk.documentId) ?? [];
    existing.push(chunk);
    documentGroups.set(chunk.documentId, existing);
  }

  return {
    ranked,
    skippedDuplicate,
    skippedThreshold,
    documentGroups,
  };
}

// ─── Internal type helper ─────────────────────────────────────────────────────

type VanillaRanked = VectorSearchCandidate & { documentGroup: number };
