/**
 * Phase 11 — Retrieval Ranker Service
 * INV-RET7: Combined scores must use formula: 0.7*vector + 0.3*lexical.
 * INV-RET8: Ranking must be deterministic (stable sort by score DESC, chunk_id ASC).
 * INV-RET9: rank_position must be 1-indexed and contiguous.
 */

import type { VectorHit } from "./retrieval-vector";
import type { LexicalHit } from "./retrieval-lexical";

export interface RankedResult {
  chunkId: string;
  documentId: string;
  sourceId: string;
  content: string;
  scoreVector: number;
  scoreLexical: number;
  scoreCombined: number;
  rankPosition: number;
}

// ─── combineScores ────────────────────────────────────────────────────────────
// INV-RET7: 0.7 * vector_score + 0.3 * lexical_score.

export function combineScores(vectorScore: number, lexicalScore: number): number {
  const combined = 0.7 * Math.max(0, Math.min(1, vectorScore)) + 0.3 * Math.max(0, Math.min(1, lexicalScore));
  return parseFloat(combined.toFixed(6));
}

// ─── rankResults ──────────────────────────────────────────────────────────────
// INV-RET7/8/9: Merge vector + lexical hits, apply hybrid scoring, deterministic sort.

export function rankResults(params: {
  vectorHits: VectorHit[];
  lexicalHits: LexicalHit[];
  topK: number;
  strategy: "vector" | "lexical" | "hybrid";
}): RankedResult[] {
  const { vectorHits, lexicalHits, topK, strategy } = params;

  // Build chunk map from vector hits
  const chunkMap = new Map<string, RankedResult>();

  for (const hit of vectorHits) {
    chunkMap.set(hit.chunkId, {
      chunkId: hit.chunkId,
      documentId: hit.documentId,
      sourceId: hit.sourceId,
      content: hit.content,
      scoreVector: hit.scoreVector,
      scoreLexical: 0,
      scoreCombined: 0,
      rankPosition: 0,
    });
  }

  // Merge lexical hits
  for (const hit of lexicalHits) {
    if (chunkMap.has(hit.chunkId)) {
      chunkMap.get(hit.chunkId)!.scoreLexical = hit.scoreLexical;
    } else {
      chunkMap.set(hit.chunkId, {
        chunkId: hit.chunkId,
        documentId: hit.documentId,
        sourceId: hit.sourceId,
        content: hit.content,
        scoreVector: 0,
        scoreLexical: hit.scoreLexical,
        scoreCombined: 0,
        rankPosition: 0,
      });
    }
  }

  // Compute combined score per strategy
  const results = Array.from(chunkMap.values()).map((r) => {
    let combined: number;
    if (strategy === "vector") combined = r.scoreVector;
    else if (strategy === "lexical") combined = r.scoreLexical;
    else combined = combineScores(r.scoreVector, r.scoreLexical);
    return { ...r, scoreCombined: combined };
  });

  // INV-RET8: Deterministic sort — score DESC, chunk_id ASC for ties
  results.sort((a, b) => {
    const scoreDiff = b.scoreCombined - a.scoreCombined;
    if (Math.abs(scoreDiff) > 1e-9) return scoreDiff;
    return a.chunkId.localeCompare(b.chunkId);
  });

  // INV-RET9: 1-indexed rank positions
  return results.slice(0, topK).map((r, i) => ({ ...r, rankPosition: i + 1 }));
}

// ─── isDeterministic ──────────────────────────────────────────────────────────
// Validates that two result sets are identical in order (for testing).

export function isDeterministic(a: RankedResult[], b: RankedResult[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((hit, i) => hit.chunkId === b[i].chunkId && hit.rankPosition === b[i].rankPosition);
}
