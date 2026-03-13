/**
 * Phase 5B.2 — Image OCR Parser Abstraction
 *
 * Supported mime types: image/png, image/jpeg, image/webp
 * XLSX and arbitrary binaries: explicit fail (INV-IMG11)
 *
 * OCR engine: stub_ocr v1.0 — deterministic placeholder.
 * Real OCR engine (e.g. tesseract) must be wired in a future phase.
 * This layer builds the full abstraction and explicit failure path now.
 */

import { createHash } from "crypto";
import { KnowledgeInvariantError } from "./knowledge-bases";

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

const MAX_DEFAULT_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

// ─── Checksum ────────────────────────────────────────────────────────────────

export function computeOcrTextChecksum(result: OcrParseResult): string {
  const normalized = result.regions
    .sort((a, b) => a.pageNumber - b.pageNumber || a.regionIndex - b.regionIndex)
    .map((r) => `${r.pageNumber}|${r.regionIndex}|${r.text.trim()}`)
    .join("\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 24);
}

// ─── Stub OCR Engine ──────────────────────────────────────────────────────────
/**
 * stub_ocr — deterministic placeholder OCR engine.
 *
 * For testing and integration validation. Parses image-like content
 * by treating the content string as OCR source text (e.g. base64 header
 * stripped or plain text injected for tests).
 *
 * INV-IMG11: Real unsupported binary blobs that cannot be parsed as text
 * still fail explicitly below the content validation check.
 */
const stubOcrEngine: OcrParser = {
  name: "stub_ocr",
  version: "1.0",
  supportedMimeTypes: Array.from(SUPPORTED_OCR_MIME_TYPES),

  async parse(content: string, mimeType: string, options?: OcrParseOptions): Promise<OcrParseResult> {
    const maxBytes = options?.maxImageSizeBytes ?? MAX_DEFAULT_IMAGE_SIZE_BYTES;

    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      throw new KnowledgeInvariantError(
        "INV-IMG11",
        `Image content exceeds maximum safe size (${maxBytes} bytes). Explicit rejection (stub_ocr engine).`,
      );
    }

    if (!content || content.trim().length === 0) {
      throw new KnowledgeInvariantError(
        "INV-IMG11",
        "Image content is empty or zero-length. Explicit failure — stub_ocr engine cannot process empty input.",
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
        `stub_ocr: deterministic placeholder engine — real OCR not executed (${label})`,
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
 * INV-IMG11: Unsupported/malformed mime types fail explicitly.
 */
export function selectOcrParser(mimeType: string): OcrParser {
  const normalizedMime = mimeType.toLowerCase().trim();

  if (SUPPORTED_OCR_MIME_TYPES.has(normalizedMime)) {
    return stubOcrEngine;
  }

  throw new KnowledgeInvariantError(
    "INV-IMG11",
    `OCR parser not available for mime type '${mimeType}'. Supported: ${Array.from(SUPPORTED_OCR_MIME_TYPES).join(", ")}. Explicit failure — no silent fallback.`,
  );
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
  return { ...result, regions: sortedRegions };
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
  const parser = selectOcrParser(mimeType);
  const raw = await parser.parse(content, mimeType, options);
  return normalizeOcrDocument(raw);
}

/**
 * summarizeOcrParseResult — short summary string for job result_summary.
 */
export function summarizeOcrParseResult(result: OcrParseResult): string {
  return `engine=${result.engineName}@${result.engineVersion} regions=${result.regions.length} blocks=${result.blockCount} lines=${result.lineCount} avgConf=${result.averageConfidence.toFixed(3)} checksum=${result.textChecksum.slice(0, 12)}`;
}
