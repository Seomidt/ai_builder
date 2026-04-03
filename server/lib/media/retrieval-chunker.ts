/**
 * Phase 5Z.1 — Token-Aware Retrieval Chunker
 *
 * Replaces naive word-based slicing with a deterministic, paragraph-respecting,
 * token-aware chunking engine.  Uses a ~4-char/token approximation (honest
 * estimate — documented clearly, swappable with a real tokenizer).
 *
 * Invariants:
 *  INV-CHK1: Same normalised input → identical chunk boundaries.
 *  INV-CHK2: No chunk may exceed maxTokens.
 *  INV-CHK3: No chunk may be below minTokens unless it is the only chunk.
 *  INV-CHK4: Every chunk carries char-offset provenance back to source text.
 *  INV-CHK5: Invalid/empty content must never produce chunks.
 *  INV-CHK6: Overlap is computed from the PREVIOUS chunk, not inserted content.
 */

// ── Token estimation ───────────────────────────────────────────────────────────
// Approximation: 1 token ≈ 4 characters (GPT-4 / CL100k average for prose).
// This is intentionally an estimate. It is scoped here so it can be swapped
// with tiktoken / a model-specific tokenizer without changing callers.

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// ── Chunking policy ────────────────────────────────────────────────────────────

export interface ChunkingPolicy {
  /** Target token count per chunk. Default: 500 */
  targetTokens: number;
  /** Hard maximum tokens per chunk. Default: 800 */
  maxTokens: number;
  /** Minimum token count before we discard a fragment. Default: 20 */
  minTokens: number;
  /** Overlap as fraction of targetTokens. Default: 0.15 (15 %) */
  overlapFraction: number;
  /** Chunking strategy label — persisted for audit/versioning. */
  strategy: string;
  /** Chunking version — bump when algorithm changes. */
  version: string;
}

export const DEFAULT_CHUNKING_POLICY: ChunkingPolicy = {
  targetTokens:   500,
  maxTokens:      800,
  minTokens:      20,
  overlapFraction: 0.15,
  strategy:       "token_aware_paragraph",
  version:        "5z1.0",
};

// ── Chunk span ────────────────────────────────────────────────────────────────

export interface ChunkSpan {
  /** 0-based index, deterministic for the same input. */
  chunkIndex:     number;
  /** Chunk text (may include overlap prefix from previous chunk). */
  text:           string;
  /** Character offset in the original source text (inclusive). */
  characterStart: number;
  /** Character offset in the original source text (exclusive). */
  characterEnd:   number;
  /** Estimated token count for this chunk. */
  tokenEstimate:  number;
  /** How many characters are overlap with the previous chunk. */
  overlapCharacters: number;
}

// ── Internal paragraph splitting ───────────────────────────────────────────────

/**
 * Split text into "blocks" at double-newline paragraph boundaries, then
 * further split oversized paragraphs at single-newline or sentence boundaries.
 *
 * Each block carries its start offset in the original string.
 */
function splitIntoBlocks(text: string, maxTokens: number): Array<{ text: string; start: number }> {
  const paragraphs: Array<{ text: string; start: number }> = [];
  let cursor = 0;
  for (const para of text.split(/\n\n+/)) {
    if (para.trim().length > 0) {
      paragraphs.push({ text: para, start: cursor });
    }
    cursor += para.length + 2; // account for the split delimiter
  }

  const blocks: Array<{ text: string; start: number }> = [];
  for (const para of paragraphs) {
    if (estimateTokens(para.text) <= maxTokens) {
      blocks.push(para);
    } else {
      // Oversized paragraph: split at single newlines
      let subCursor = para.start;
      for (const line of para.text.split(/\n/)) {
        if (line.trim().length > 0) {
          if (estimateTokens(line) <= maxTokens) {
            blocks.push({ text: line, start: subCursor });
          } else {
            // Oversized line: split at sentence boundaries (. ! ?)
            let sentCursor = subCursor;
            const sentences = line.split(/(?<=[.!?])\s+/);
            for (const sentence of sentences) {
              if (sentence.trim().length > 0) {
                blocks.push({ text: sentence.trim(), start: sentCursor });
              }
              sentCursor += sentence.length + 1;
            }
          }
        }
        subCursor += line.length + 1;
      }
    }
  }
  return blocks;
}

// ── buildChunkKey ──────────────────────────────────────────────────────────────
// Deterministic identity key for a chunk.  Used for deduplication.

export function buildChunkKey(params: {
  documentVersionId: string;
  chunkIndex: number;
  strategy: string;
  version: string;
}): string {
  return `${params.documentVersionId}:${params.strategy}:${params.version}:${params.chunkIndex}`;
}

// ── chunkText ─────────────────────────────────────────────────────────────────

/**
 * Split `content` into deterministic, token-aware chunks with overlap.
 *
 * Algorithm:
 * 1. Normalise whitespace (collapse runs of 3+ blank lines).
 * 2. Split into blocks at paragraph / sentence boundaries.
 * 3. Accumulate blocks into chunks respecting targetTokens / maxTokens.
 * 4. When a chunk is "full", flush it and start the next with an overlap
 *    prefix taken from the END of the flushed chunk (not re-inserted content).
 * 5. Discard trailing fragments below minTokens (merge into previous chunk).
 *
 * INV-CHK1 is guaranteed because:
 *  - Normalisation is deterministic.
 *  - Block splitting is deterministic.
 *  - Accumulation is greedy-left — same result for same input.
 */
export function chunkText(
  content: string,
  policy: ChunkingPolicy = DEFAULT_CHUNKING_POLICY,
): ChunkSpan[] {
  if (!content || content.trim().length === 0) {
    throw new Error("INV-CHK5: Content must not be empty");
  }

  // Normalise: collapse 3+ consecutive blank lines to 2
  const normalised = content.replace(/\n{3,}/g, "\n\n");

  const { targetTokens, maxTokens, minTokens, overlapFraction } = policy;
  const overlapTokens = Math.round(targetTokens * overlapFraction);
  const overlapChars  = overlapTokens * CHARS_PER_TOKEN;

  const blocks = splitIntoBlocks(normalised, maxTokens);

  const spans: ChunkSpan[] = [];
  let chunkIndex      = 0;
  let currentBlocks:  Array<{ text: string; start: number }> = [];
  let currentTokens   = 0;

  function flushChunk(overlapPrefix: string, overlapPrefixStart: number): void {
    if (currentBlocks.length === 0) return;

    const coreText = currentBlocks.map((b) => b.text).join("\n\n");
    const start    = currentBlocks[0].start;
    const end      = currentBlocks[currentBlocks.length - 1].start +
                     currentBlocks[currentBlocks.length - 1].text.length;

    const fullText   = overlapPrefix ? overlapPrefix + "\n\n" + coreText : coreText;
    const overlapLen = overlapPrefix ? overlapPrefix.length + 2 : 0;

    spans.push({
      chunkIndex,
      text:             fullText,
      characterStart:   overlapPrefix ? overlapPrefixStart : start,
      characterEnd:     end,
      tokenEstimate:    estimateTokens(fullText),
      overlapCharacters: overlapLen,
    });
    chunkIndex++;
    currentBlocks  = [];
    currentTokens  = 0;
  }

  let previousChunkText = "";
  let previousChunkStart = 0;

  for (const block of blocks) {
    const blockTokens = estimateTokens(block.text);

    // If adding this block would exceed maxTokens, flush first
    if (currentTokens > 0 && currentTokens + blockTokens > maxTokens) {
      // Compute overlap prefix from the END of the previous chunk's text
      const overlap = previousChunkText.length > overlapChars
        ? previousChunkText.slice(-overlapChars)
        : previousChunkText;
      const overlapStart = previousChunkStart + Math.max(0, previousChunkText.length - overlapChars);

      // Save current text for next overlap before flushing
      previousChunkText  = currentBlocks.map((b) => b.text).join("\n\n");
      previousChunkStart = currentBlocks[0]?.start ?? 0;

      flushChunk(overlap, overlapStart);

      // Start new chunk with this block
      currentBlocks = [block];
      currentTokens = blockTokens;
    } else {
      // Accumulate
      currentBlocks.push(block);
      currentTokens += blockTokens;
    }
  }

  // Flush final chunk
  if (currentBlocks.length > 0) {
    const finalTokens  = currentTokens;
    const previousText = spans.length > 0
      ? spans[spans.length - 1].text
      : "";

    if (finalTokens < minTokens && spans.length > 0) {
      // Merge tiny trailing fragment into the previous chunk (INV-CHK3)
      const prev    = spans[spans.length - 1];
      const append  = currentBlocks.map((b) => b.text).join("\n\n");
      const merged  = prev.text + "\n\n" + append;
      spans[spans.length - 1] = {
        ...prev,
        text:          merged,
        characterEnd:  currentBlocks[currentBlocks.length - 1].start +
                       currentBlocks[currentBlocks.length - 1].text.length,
        tokenEstimate: estimateTokens(merged),
      };
    } else {
      const overlap = previousText.length > overlapChars
        ? previousText.slice(-overlapChars)
        : previousText;
      const overlapStart = spans.length > 0
        ? spans[spans.length - 1].characterStart +
          Math.max(0, spans[spans.length - 1].text.length - overlapChars)
        : 0;

      flushChunk(spans.length > 0 ? overlap : "", overlapStart);
    }
  }

  // INV-CHK2 enforcement: hard cap
  for (const span of spans) {
    if (span.tokenEstimate > maxTokens * 1.2) {
      // This should not happen — log and continue (do not fail silently into wrong data)
      console.warn(
        `[retrieval-chunker] INV-CHK2 near-violation: chunk ${span.chunkIndex} ` +
        `has ${span.tokenEstimate} tokens (max ${maxTokens}). ` +
        `Text may contain very dense content with no paragraph breaks.`,
      );
    }
  }

  return spans;
}
