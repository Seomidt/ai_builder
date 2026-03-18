/**
 * Phase 5B.2 — Image OCR Chunking Foundation
 *
 * Strategy: ocr_regions (group OCR regions into chunks with stable ordering)
 * Deterministic chunk keys and hashes.
 * Preserves page/region context and bounding metadata.
 */

import { createHash } from "crypto";
import type { OcrParseResult, OcrRegion } from "./image-ocr-parsers";

// ─── Config ───────────────────────────────────────────────────────────────────

export interface OcrChunkingConfig {
  strategy?: string;
  version?: string;
  regionWindowSize?: number;
  includeRegionMetadata?: boolean;
}

export const DEFAULT_OCR_CHUNKING_CONFIG: OcrChunkingConfig = {
  strategy: "ocr_regions",
  version: "1.0",
  regionWindowSize: 1,
  includeRegionMetadata: true,
};

// ─── Candidate type ───────────────────────────────────────────────────────────

export interface OcrChunkCandidate {
  chunkIndex: number;
  chunkKey: string;
  chunkHash: string;
  chunkText: string;
  imageChunkStrategy: string;
  imageChunkVersion: string;
  imageRegionIndex: number;
  regionEnd: number;
  pageNumber: number;
  bboxLeft?: number;
  bboxTop?: number;
  bboxWidth?: number;
  bboxHeight?: number;
  ocrConfidence?: number;
  sourcePageNumber: number;
  tokenEstimate: number;
}

// ─── Deterministic key + hash ─────────────────────────────────────────────────

/**
 * buildOcrChunkKey — stable, deterministic key per OCR chunk.
 * Same inputs must always produce the same key (INV-IMG10).
 */
export function buildOcrChunkKey(
  documentId: string,
  versionId: string,
  pageNumber: number,
  regionStart: number,
  regionEnd: number,
  strategy: string,
  strategyVersion: string,
): string {
  const raw = `${documentId}::${versionId}::p${pageNumber}::r${regionStart}-${regionEnd}::${strategy}@${strategyVersion}`;
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32);
}

/**
 * buildOcrChunkHash — content hash for OCR chunk text.
 * Same normalized text + same strategy produces same hash (INV-IMG10).
 */
export function buildOcrChunkHash(
  normalizedText: string,
  strategy: string,
  strategyVersion: string,
): string {
  const raw = `${strategy}@${strategyVersion}::${normalizedText}`;
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32);
}

// ─── Text normalization ───────────────────────────────────────────────────────

/**
 * normalizeOcrChunkText — deterministic text normalization for OCR chunk text.
 * Collapses whitespace, trims, normalizes line endings.
 */
export function normalizeOcrChunkText(text: string): string {
  return text
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ─── Merge bounding boxes ─────────────────────────────────────────────────────

function mergeBBoxes(
  regions: OcrRegion[],
): { left: number; top: number; width: number; height: number } | undefined {
  const withBBox = regions.filter((r) => r.bbox);
  if (withBBox.length === 0) return undefined;
  const left = Math.min(...withBBox.map((r) => r.bbox!.left));
  const top = Math.min(...withBBox.map((r) => r.bbox!.top));
  const right = Math.max(...withBBox.map((r) => r.bbox!.left + r.bbox!.width));
  const bottom = Math.max(...withBBox.map((r) => r.bbox!.top + r.bbox!.height));
  return { left, top, width: right - left, height: bottom - top };
}

// ─── Main chunking function ───────────────────────────────────────────────────

/**
 * chunkOcrDocument — groups OCR regions into chunk candidates.
 *
 * INV-IMG10: chunk keys and hashes are deterministic.
 * Preserves page context, region ordering, bounding metadata.
 * Does NOT create embeddings or set index_state='indexed'.
 */
export function chunkOcrDocument(
  parseResult: OcrParseResult,
  documentId: string,
  versionId: string,
  config: OcrChunkingConfig = {},
): OcrChunkCandidate[] {
  const strategy = config.strategy ?? DEFAULT_OCR_CHUNKING_CONFIG.strategy!;
  const stratVersion = config.version ?? DEFAULT_OCR_CHUNKING_CONFIG.version!;
  const windowSize = config.regionWindowSize ?? DEFAULT_OCR_CHUNKING_CONFIG.regionWindowSize!;

  const sortedRegions = [...parseResult.regions].sort(
    (a, b) => a.pageNumber - b.pageNumber || a.regionIndex - b.regionIndex,
  );

  const candidates: OcrChunkCandidate[] = [];
  let chunkIndex = 0;

  for (let i = 0; i < sortedRegions.length; i += windowSize) {
    const window = sortedRegions.slice(i, i + windowSize);
    const regionStart = window[0].regionIndex;
    const regionEnd = window[window.length - 1].regionIndex;
    const pageNumber = window[0].pageNumber;

    const rawText = window.map((r) => r.text).join(" ");
    const normalizedText = normalizeOcrChunkText(rawText);

    if (!normalizedText) continue;

    const chunkKey = buildOcrChunkKey(
      documentId,
      versionId,
      pageNumber,
      regionStart,
      regionEnd,
      strategy,
      stratVersion,
    );
    const chunkHash = buildOcrChunkHash(normalizedText, strategy, stratVersion);
    const merged = mergeBBoxes(window);
    const avgConf = window.reduce((acc, r) => acc + r.confidence, 0) / window.length;

    candidates.push({
      chunkIndex,
      chunkKey,
      chunkHash,
      chunkText: normalizedText,
      imageChunkStrategy: strategy,
      imageChunkVersion: stratVersion,
      imageRegionIndex: regionStart,
      regionEnd,
      pageNumber,
      bboxLeft: merged?.left,
      bboxTop: merged?.top,
      bboxWidth: merged?.width,
      bboxHeight: merged?.height,
      ocrConfidence: Math.round(avgConf * 1000) / 1000,
      sourcePageNumber: pageNumber,
      tokenEstimate: Math.ceil(normalizedText.length / 4),
    });
    chunkIndex++;
  }

  return candidates;
}

/**
 * summarizeOcrChunks — short summary for job result_summary and inspection.
 */
export function summarizeOcrChunks(candidates: OcrChunkCandidate[]): string {
  const pages = Array.from(new Set(candidates.map((c) => c.pageNumber)));
  const avgConf = candidates.length > 0
    ? (candidates.reduce((acc, c) => acc + (c.ocrConfidence ?? 0), 0) / candidates.length).toFixed(3)
    : "n/a";
  return `chunks=${candidates.length} pages=${pages.join(",")} avgConf=${avgConf}`;
}
