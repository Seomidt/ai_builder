/**
 * Phase 12 — AI Context Builder
 * Assembles retrieval chunks into a coherent context window.
 * Max 8 chunks, ordered by retrieval rank.
 * INV-AI3: Context must be ordered by retrieval rank.
 * INV-AI4: Context must not exceed model context_window.
 */

import type { RankedResult } from "../retrieval/retrieval-ranker";

export interface AssembledContext {
  chunks: Array<{
    rank: number;
    chunkId: string;
    content: string;
    scoreVector: number;
    scoreLexical: number;
    scoreCombined: number;
  }>;
  totalChunks: number;
  estimatedTokens: number;
  contextText: string;
  note: string;
}

const MAX_CHUNKS = 8;
// Rough token estimation: 1 token ≈ 4 chars (GPT tokenization heuristic)
const CHARS_PER_TOKEN = 4;

// ─── estimateTokens ──────────────────────────────────────────────────────────
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ─── buildContext ────────────────────────────────────────────────────────────
// INV-AI3: Ordered by rank. INV-AI4: Fits within contextWindow.
export function buildContext(params: {
  results: RankedResult[];
  contextWindow?: number;
  reserveTokensForPromptAndResponse?: number;
}): AssembledContext {
  const { results, contextWindow = 8192, reserveTokensForPromptAndResponse = 2048 } = params;

  const availableTokens = Math.max(512, contextWindow - reserveTokensForPromptAndResponse);

  // INV-AI3: Already sorted by rank (caller should provide in order), enforce sort
  const sorted = [...results].sort((a, b) => a.rankPosition - b.rankPosition);

  const selectedChunks: typeof sorted = [];
  let totalTokens = 0;

  for (const chunk of sorted) {
    if (selectedChunks.length >= MAX_CHUNKS) break;
    const chunkTokens = estimateTokens(chunk.content);
    if (totalTokens + chunkTokens > availableTokens) break;
    selectedChunks.push(chunk);
    totalTokens += chunkTokens;
  }

  // Build context text with clear delimiters
  const contextText = selectedChunks
    .map((c, i) => `[CONTEXT ${i + 1} | score: ${c.scoreCombined.toFixed(3)}]\n${c.content}`)
    .join("\n\n---\n\n");

  return {
    chunks: selectedChunks.map((c) => ({
      rank: c.rankPosition,
      chunkId: c.chunkId,
      content: c.content,
      scoreVector: c.scoreVector,
      scoreLexical: c.scoreLexical,
      scoreCombined: c.scoreCombined,
    })),
    totalChunks: selectedChunks.length,
    estimatedTokens: totalTokens,
    contextText,
    note: `INV-AI3: Context ordered by retrieval rank. INV-AI4: ${totalTokens} tokens fit within ${availableTokens} available.`,
  };
}

// ─── buildContextFromIds ─────────────────────────────────────────────────────
// Builds context when full ranked results aren't available (fallback).
export function buildContextFromStrings(params: {
  contentItems: string[];
  contextWindow?: number;
}): AssembledContext {
  const { contentItems, contextWindow = 8192 } = params;
  const fakeRanked: RankedResult[] = contentItems.map((content, i) => ({
    chunkId: `ctx-${i}`,
    documentId: "",
    sourceId: "",
    content,
    scoreVector: 1.0,
    scoreLexical: 1.0,
    scoreCombined: 1.0,
    rankPosition: i + 1,
  }));
  return buildContext({ results: fakeRanked, contextWindow });
}
