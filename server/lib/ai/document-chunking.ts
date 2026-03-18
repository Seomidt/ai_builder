import { createHash } from "crypto";
import type { ParsedDocument, ParsedSection } from "./document-parsers.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ChunkingConfig {
  maxCharacters: number;
  overlapCharacters: number;
  strategy: string;
  strategyVersion: string;
}

export const DEFAULT_CHUNKING_CONFIG: ChunkingConfig = {
  maxCharacters: 1000,
  overlapCharacters: 100,
  strategy: "paragraph_window",
  strategyVersion: "1.0",
};

export interface ChunkCandidate {
  chunkIndex: number;
  chunkKey: string;
  chunkHash: string;
  chunkText: string;
  chunkStrategy: string;
  chunkVersion: string;
  overlapCharacters: number;
  characterStart: number;
  characterEnd: number;
  tokenEstimate: number;
  sourceHeadingPath?: string;
  sourceSectionLabel?: string;
}

// ─── buildChunkKey ────────────────────────────────────────────────────────────
// Deterministic, content-addressable key scoped to version + strategy + index.
// Same inputs always produce same key (INV-P9).

export function buildChunkKey(
  documentId: string,
  versionId: string,
  chunkIndex: number,
  strategy: string,
  strategyVersion: string,
): string {
  const raw = `${documentId}::${versionId}::${strategy}::${strategyVersion}::${chunkIndex}`;
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 64);
}

// ─── buildChunkHash ───────────────────────────────────────────────────────────
// Deterministic hash of normalized text + strategy context.
// Same normalized text + same strategy always produces same hash (INV-P9).

export function buildChunkHash(text: string, strategy: string, strategyVersion: string): string {
  const raw = `${strategy}::${strategyVersion}::${text}`;
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

// ─── estimateChunkTokens ──────────────────────────────────────────────────────
// Conservative approximation: 1 token ≈ 4 characters (English average).
// Do NOT call any external tokenizer here — chunking must not depend on AI APIs.

export function estimateChunkTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ─── splitTextIntoWindows ─────────────────────────────────────────────────────
// Splits a flat text string into bounded character windows with overlap.
// Deterministic: same text + same config → same splits.

function splitTextIntoWindows(
  text: string,
  maxChars: number,
  overlapChars: number,
): Array<{ text: string; characterStart: number; characterEnd: number }> {
  const windows: Array<{ text: string; characterStart: number; characterEnd: number }> = [];
  if (text.length === 0) return windows;

  const safe = Math.max(maxChars, 1);
  const safeOverlap = Math.min(Math.max(overlapChars, 0), Math.floor(safe / 2));
  const step = safe - safeOverlap;

  let pos = 0;
  while (pos < text.length) {
    const end = Math.min(pos + safe, text.length);
    const slice = text.slice(pos, end);
    windows.push({ text: slice, characterStart: pos, characterEnd: end });
    if (end >= text.length) break;
    pos += step;
  }
  return windows;
}

// ─── chunkByParagraphWindow ───────────────────────────────────────────────────
// Groups paragraphs/sections into chunks up to maxCharacters, then applies overlap.
// Respects section headings for metadata.

function chunkByParagraphWindow(
  sections: ParsedSection[],
  fullText: string,
  config: ChunkingConfig,
): Array<{
  text: string;
  characterStart: number;
  characterEnd: number;
  sourceHeadingPath?: string;
  sourceSectionLabel?: string;
}> {
  const results: Array<{
    text: string;
    characterStart: number;
    characterEnd: number;
    sourceHeadingPath?: string;
    sourceSectionLabel?: string;
  }> = [];

  if (sections.length === 0) {
    // Fallback: window over full text
    return splitTextIntoWindows(fullText, config.maxCharacters, config.overlapCharacters).map((w) => ({
      text: w.text,
      characterStart: w.characterStart,
      characterEnd: w.characterEnd,
    }));
  }

  let currentBuffer = "";
  let currentStart = 0;
  let currentHeadingPath: string | undefined;
  let currentSectionLabel: string | undefined;
  let charOffset = 0;

  for (const section of sections) {
    const sectionText = section.content;
    const sectionHeadingPath = section.headingPath ?? section.heading;
    const sectionLabel = section.heading;

    if (sectionText.length === 0) continue;

    // If this section alone exceeds maxCharacters, split it into windows
    if (sectionText.length > config.maxCharacters) {
      // Flush current buffer first
      if (currentBuffer.trim().length > 0) {
        results.push({
          text: currentBuffer.trim(),
          characterStart: currentStart,
          characterEnd: currentStart + currentBuffer.length,
          sourceHeadingPath: currentHeadingPath,
          sourceSectionLabel: currentSectionLabel,
        });
        currentBuffer = "";
      }

      const windows = splitTextIntoWindows(sectionText, config.maxCharacters, config.overlapCharacters);
      for (const w of windows) {
        results.push({
          text: w.text,
          characterStart: charOffset + w.characterStart,
          characterEnd: charOffset + w.characterEnd,
          sourceHeadingPath: sectionHeadingPath,
          sourceSectionLabel: sectionLabel,
        });
      }
      charOffset += sectionText.length + 2;
      continue;
    }

    // Adding this section to buffer would exceed limit — flush first
    const separator = currentBuffer.length > 0 ? "\n\n" : "";
    if (currentBuffer.length + separator.length + sectionText.length > config.maxCharacters && currentBuffer.length > 0) {
      results.push({
        text: currentBuffer.trim(),
        characterStart: currentStart,
        characterEnd: currentStart + currentBuffer.length,
        sourceHeadingPath: currentHeadingPath,
        sourceSectionLabel: currentSectionLabel,
      });
      // Start next buffer with overlap
      const overlapText = currentBuffer.length > config.overlapCharacters
        ? currentBuffer.slice(-config.overlapCharacters)
        : currentBuffer;
      currentBuffer = overlapText + "\n\n" + sectionText;
      currentStart = currentStart + currentBuffer.length - overlapText.length - 2 - sectionText.length;
      currentHeadingPath = sectionHeadingPath;
      currentSectionLabel = sectionLabel;
    } else {
      if (currentBuffer.length === 0) {
        currentStart = charOffset;
        currentHeadingPath = sectionHeadingPath;
        currentSectionLabel = sectionLabel;
      }
      currentBuffer += separator + sectionText;
    }

    charOffset += sectionText.length + 2;
  }

  if (currentBuffer.trim().length > 0) {
    results.push({
      text: currentBuffer.trim(),
      characterStart: currentStart,
      characterEnd: currentStart + currentBuffer.length,
      sourceHeadingPath: currentHeadingPath,
      sourceSectionLabel: currentSectionLabel,
    });
  }

  return results;
}

// ─── chunkParsedDocument ──────────────────────────────────────────────────────
// Main entry point for chunking.
// Returns a deterministic list of ChunkCandidates for the given version.
// chunk_key and chunk_hash are stable for same input + config (INV-P9).

export function chunkParsedDocument(
  parsed: ParsedDocument,
  documentId: string,
  versionId: string,
  configOverride?: Partial<ChunkingConfig>,
): ChunkCandidate[] {
  const config: ChunkingConfig = {
    ...DEFAULT_CHUNKING_CONFIG,
    ...configOverride,
  };

  if (config.maxCharacters < 10) {
    throw new Error(`ChunkingConfig.maxCharacters must be >= 10, got ${config.maxCharacters}`);
  }
  if (config.overlapCharacters < 0) {
    throw new Error(`ChunkingConfig.overlapCharacters must be >= 0, got ${config.overlapCharacters}`);
  }
  if (config.overlapCharacters >= config.maxCharacters) {
    throw new Error(
      `ChunkingConfig.overlapCharacters (${config.overlapCharacters}) must be less than maxCharacters (${config.maxCharacters})`,
    );
  }

  const rawChunks = chunkByParagraphWindow(parsed.sections, parsed.plainText, config);

  const candidates: ChunkCandidate[] = rawChunks
    .filter((c) => c.text.trim().length > 0)
    .map((c, idx) => ({
      chunkIndex: idx,
      chunkKey: buildChunkKey(documentId, versionId, idx, config.strategy, config.strategyVersion),
      chunkHash: buildChunkHash(c.text, config.strategy, config.strategyVersion),
      chunkText: c.text,
      chunkStrategy: config.strategy,
      chunkVersion: config.strategyVersion,
      overlapCharacters: config.overlapCharacters,
      characterStart: c.characterStart,
      characterEnd: c.characterEnd,
      tokenEstimate: estimateChunkTokens(c.text),
      sourceHeadingPath: c.sourceHeadingPath,
      sourceSectionLabel: c.sourceSectionLabel,
    }));

  return candidates;
}
