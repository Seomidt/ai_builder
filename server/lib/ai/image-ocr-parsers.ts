/**
 * Phase 5B.2.1 — Image OCR Parser Abstraction (Real Engine)
 *
 * Supported mime types: image/png, image/jpeg, image/jpg, image/webp
 * Unsupported types: explicit fail (INV-IMG11)
 *
 * Primary OCR engine: openai_vision_ocr v1.0
 *   - Real text extraction via GPT-4o Vision API
 *   - Bounding box metadata (percentage → virtual 1000×1000 canvas)
 *   - Per-region confidence scores
 *   - Deterministic normalization and text checksum
 *   - Plain-text fallback for backward compat (tests, pre-extracted content)
 *   - Explicit failure for unsupported / oversized / empty input (INV-IMG11)
 *
 * Legacy engine: stub_ocr v1.0 (kept for isolated unit testing only)
 */

import { createHash } from "crypto";
import { KnowledgeInvariantError } from "./knowledge-bases";
import { openaiVisionOcrEngine } from "./openai-vision-ocr";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface OcrBoundingBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface OcrRegion {
  regionIndex: number;
  pageNumber: number;
  text: string;
  lineCount: number;
  confidence: number;
  bbox?: OcrBoundingBox;
  engineHint?: string;
}

export interface OcrParseResult {
  engineName: string;
  engineVersion: string;
  mimeType: string;
  regions: OcrRegion[];
  pageCount: number;
  blockCount: number;
  lineCount: number;
  averageConfidence: number;
  textChecksum: string;
  warnings: string[];
  metadata: Record<string, unknown>;
}

export interface OcrParseOptions {
  maxImageSizeBytes?: number;
  expectedPageCount?: number;
  engineHint?: string;
  contentLabel?: string;
}

export interface OcrParser {
  name: string;
  version: string;
  supportedMimeTypes: string[];
  parse(content: string, mimeType: string, options?: OcrParseOptions): Promise<OcrParseResult>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const SUPPORTED_OCR_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

// ─── Checksum ────────────────────────────────────────────────────────────────

export function computeOcrTextChecksum(result: OcrParseResult): string {
  const normalized = result.regions
    .sort((a, b) => a.pageNumber - b.pageNumber || a.regionIndex - b.regionIndex)
    .map((r) => `${r.pageNumber}|${r.regionIndex}|${r.text.trim()}`)
    .join("\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 24);
}

// ─── Legacy Stub Engine (unit testing only) ───────────────────────────────────
/**
 * stub_ocr — legacy deterministic placeholder.
 * Kept for isolated unit testing. Not used in production routing.
 * selectOcrParser() routes to openai_vision_ocr in all production paths.
 */
export const stubOcrEngine: OcrParser = {
  name: "stub_ocr",
  version: "1.0",
  supportedMimeTypes: Array.from(SUPPORTED_OCR_MIME_TYPES),

  async parse(content: string, mimeType: string, options?: OcrParseOptions): Promise<OcrParseResult> {
    const maxBytes = options?.maxImageSizeBytes ?? 10 * 1024 * 1024;

    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      throw new KnowledgeInvariantError(
        "INV-IMG11",
        `Image content exceeds maximum safe size (${maxBytes} bytes). Explicit rejection (stub_ocr engine).`,
      );
    }
    if (!content || content.trim().length === 0) {
      throw new KnowledgeInvariantError(
        "INV-IMG11",
        "Image content is empty or zero-length. Explicit failure — stub_ocr engine.",
      );
    }

    const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
    const label = options?.contentLabel ?? mimeType;
    const lines = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const regionWindowSize = 3;
    const regions: OcrRegion[] = [];
    let regionIdx = 0;
    for (let i = 0; i < lines.length; i += regionWindowSize) {
      const regionLines = lines.slice(i, i + regionWindowSize);
      const regionText = regionLines.join(" ").trim();
      if (!regionText) continue;

      const deterministicConfidence =
        0.7 + (parseInt(contentHash.slice(regionIdx * 2, regionIdx * 2 + 4), 16) % 300) / 1000;

      regions.push({
        regionIndex: regionIdx,
        pageNumber: 1,
        text: regionText,
        lineCount: regionLines.length,
        confidence: Math.min(1, deterministicConfidence),
        bbox: {
          left: 10 + regionIdx * 2,
          top: 20 + regionIdx * 40,
          width: 200,
          height: 30 + regionLines.length * 10,
        },
      });
      regionIdx++;
    }

    if (regions.length === 0) {
      throw new KnowledgeInvariantError(
        "INV-IMG11",
        `No parseable OCR regions extracted from image content (${label}). Explicit failure — stub_ocr engine.`,
      );
    }

    const totalLines = regions.reduce((acc, r) => acc + r.lineCount, 0);
    const avgConf = regions.reduce((acc, r) => acc + r.confidence, 0) / regions.length;

    const result: OcrParseResult = {
      engineName: "stub_ocr",
      engineVersion: "1.0",
      mimeType,
      regions,
      pageCount: 1,
      blockCount: regions.length,
      lineCount: totalLines,
      averageConfidence: Math.round(avgConf * 1000) / 1000,
      textChecksum: "",
      warnings: [
        `stub_ocr: legacy deterministic placeholder engine (${label}) — use openai_vision_ocr in production`,
      ],
      metadata: {
        contentHash: contentHash.slice(0, 16),
        engineLabel: "stub_ocr@1.0",
        label,
      },
    };
    result.textChecksum = computeOcrTextChecksum(result);
    return result;
  },
};

// ─── Parser Selection ─────────────────────────────────────────────────────────

/**
 * selectOcrParser — returns the appropriate OCR parser for the given mime type.
 *
 * Phase 5B.2.1: Routes ALL supported mime types to openai_vision_ocr.
 * Unsupported types fail explicitly (INV-IMG11).
 *
 * @param mimeType  Normalized mime type of the image document version.
 * @param hint      Optional engine override (e.g. 'stub_ocr' for isolated testing).
 */
export function selectOcrParser(mimeType: string, hint?: string): OcrParser {
  const normalizedMime = mimeType.toLowerCase().trim();

  if (!SUPPORTED_OCR_MIME_TYPES.has(normalizedMime)) {
    throw new KnowledgeInvariantError(
      "INV-IMG11",
      `OCR parser not available for mime type '${mimeType}'. Supported: ${Array.from(SUPPORTED_OCR_MIME_TYPES).join(", ")}. Explicit failure — no silent fallback.`,
    );
  }

  if (hint === "stub_ocr") return stubOcrEngine;
  return openaiVisionOcrEngine;
}

// ─── Normalize ────────────────────────────────────────────────────────────────

/**
 * normalizeOcrDocument — deterministic normalization of OCR parse output.
 * Sorts regions by page and regionIndex for stable processing.
 */
export function normalizeOcrDocument(result: OcrParseResult): OcrParseResult {
  const sortedRegions = [...result.regions].sort(
    (a, b) => a.pageNumber - b.pageNumber || a.regionIndex - b.regionIndex,
  );
  const normalized = { ...result, regions: sortedRegions };
  normalized.textChecksum = computeOcrTextChecksum(normalized);
  return normalized;
}

// ─── Top-level parse function ─────────────────────────────────────────────────

/**
 * parseImageDocumentVersion — selects parser, parses, normalizes, validates output.
 * INV-IMG11: explicit failure for unsupported mime types.
 */
export async function parseImageDocumentVersion(
  content: string,
  mimeType: string,
  options?: OcrParseOptions,
): Promise<OcrParseResult> {
  const engineHint = options?.engineHint;
  const parser = selectOcrParser(mimeType, engineHint);
  const raw = await parser.parse(content, mimeType, options);
  return normalizeOcrDocument(raw);
}

/**
 * summarizeOcrParseResult — short summary string for job result_summary.
 */
export function summarizeOcrParseResult(result: OcrParseResult): string {
  return `engine=${result.engineName}@${result.engineVersion} regions=${result.regions.length} blocks=${result.blockCount} lines=${result.lineCount} avgConf=${result.averageConfidence.toFixed(3)} checksum=${result.textChecksum.slice(0, 12)}`;
}
