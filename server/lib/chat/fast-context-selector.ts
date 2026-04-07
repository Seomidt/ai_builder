/**
 * fast-context-selector.ts
 *
 * Deterministic keyword-relevance chunk selector for fast-path document chat.
 *
 * PURPOSE:
 *   Fast-path extraction may produce 50-200k chars of document text.
 *   Sending all of it to the AI triggers the "heavy" tier (docChars > 20k → gpt-4.1),
 *   which has a TTFT of 30-40s. This selector picks the most relevant chunks
 *   from the document for the user's question, staying within a token budget
 *   that keeps the default tier (gpt-4.1-mini, TTFT ~2s).
 *
 * ALGORITHM:
 *   1. Split text into overlapping chunks of ~400 chars
 *   2. Score each chunk against question keywords (term frequency match)
 *   3. Select top-N scoring chunks up to MAX_CHARS budget
 *   4. Preserve original order for coherent output
 *
 * PROPERTIES:
 *   - Deterministic: same input → same output
 *   - No vector DB, no embeddings
 *   - Pure function, fully testable
 *   - Handles edge cases: empty text, single chunk, no keyword match
 */

export interface FastContextResult {
  selectedText:   string;
  selectedChars:  number;
  totalChars:     number;
  chunkCount:     number;
  totalChunks:    number;
  topScore:       number;
  method:         "keyword_relevance" | "head_truncation" | "full_fit";
  trimmed:        boolean;
}

export interface FastContextOptions {
  /** Max chars to return. Default: 15,000 (keeps docChars below heavy-tier threshold) */
  maxChars?:   number;
  /** Chunk size in chars. Default: 400 */
  chunkSize?:  number;
  /** Overlap between adjacent chunks in chars. Default: 80 */
  overlap?:    number;
  /** How many top chunks to include at most. Default: 40 */
  topN?:       number;
}

const DEFAULT_MAX_CHARS  = 15_000;
const DEFAULT_CHUNK_SIZE = 400;
const DEFAULT_OVERLAP    = 80;
const DEFAULT_TOP_N      = 40;

/** Split text into overlapping chunks, returning { text, index } pairs. */
function splitChunks(
  text: string,
  chunkSize: number,
  overlap: number,
): Array<{ text: string; index: number }> {
  const chunks: Array<{ text: string; index: number }> = [];
  const step = chunkSize - overlap;
  if (step <= 0) throw new Error("chunkSize must be > overlap");

  let i = 0;
  while (i < text.length) {
    const slice = text.slice(i, i + chunkSize);
    if (slice.trim().length > 0) {
      chunks.push({ text: slice, index: chunks.length });
    }
    i += step;
  }
  return chunks;
}

/** Tokenize a string into lowercase, min-length terms. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9æøå\s]/gi, " ")
    .split(/\s+/)
    .filter(t => t.length >= 3);
}

/** Score a chunk against a set of question terms. */
function scoreChunk(chunkText: string, questionTerms: Set<string>): number {
  if (questionTerms.size === 0) return 0;
  const chunkTokens = tokenize(chunkText);
  let hits = 0;
  for (const t of chunkTokens) {
    if (questionTerms.has(t)) hits++;
  }
  // Normalize by question term count so short queries don't dominate
  return hits / questionTerms.size;
}

/**
 * Select the most relevant chunks from a document text for a given question.
 *
 * When the full text fits within maxChars, returns it as-is without chunking.
 * When no chunks score above 0, falls back to head-truncation (first N chars).
 */
export function selectFastContext(
  fullText: string,
  question: string,
  options: FastContextOptions = {},
): FastContextResult {
  const maxChars  = options.maxChars  ?? DEFAULT_MAX_CHARS;
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap   = options.overlap   ?? DEFAULT_OVERLAP;
  const topN      = options.topN      ?? DEFAULT_TOP_N;

  const totalChars = fullText.length;

  // Fast path: text fits entirely — no trimming needed
  if (totalChars <= maxChars) {
    return {
      selectedText:  fullText,
      selectedChars: totalChars,
      totalChars,
      chunkCount:    1,
      totalChunks:   1,
      topScore:      1,
      method:        "full_fit",
      trimmed:       false,
    };
  }

  // Extract question terms (min 3 chars)
  const questionTerms = new Set(tokenize(question));

  // Split into chunks
  const chunks = splitChunks(fullText, chunkSize, overlap);

  // Score each chunk
  const scored = chunks.map(c => ({
    ...c,
    score: scoreChunk(c.text, questionTerms),
  }));

  // Sort by score descending, break ties by original position (prefer earlier)
  const sorted = [...scored].sort((a, b) => b.score - a.score || a.index - b.index);

  const topScore = sorted[0]?.score ?? 0;

  // If no keyword match at all → fall back to head-truncation
  if (topScore === 0) {
    const truncated = fullText.slice(0, maxChars);
    return {
      selectedText:  truncated,
      selectedChars: truncated.length,
      totalChars,
      chunkCount:    1,
      totalChunks:   chunks.length,
      topScore:      0,
      method:        "head_truncation",
      trimmed:       true,
    };
  }

  // Select top-N chunks within char budget, then restore original order.
  // Account for "\n\n" separator (2 chars) added by join — budget must cover all chars
  // including the separators so the final selectedText.length never exceeds maxChars.
  const SEP_LEN = 2; // "\n\n"
  const selectedIndices = new Set<number>();
  let budget = maxChars;
  let count  = 0;

  for (const c of sorted) {
    if (count >= topN) break;
    // Include separator cost for all chunks after the first
    const cost = c.text.trim().length + (count > 0 ? SEP_LEN : 0);
    if (cost > budget) break;
    selectedIndices.add(c.index);
    budget -= cost;
    count++;
  }

  // Restore original document order
  const selectedChunks = chunks
    .filter(c => selectedIndices.has(c.index))
    .map(c => c.text.trim());

  const selectedText = selectedChunks.join("\n\n");

  return {
    selectedText,
    selectedChars:  selectedText.length,
    totalChars,
    chunkCount:     selectedChunks.length,
    totalChunks:    chunks.length,
    topScore,
    method:         "keyword_relevance",
    trimmed:        true,
  };
}
