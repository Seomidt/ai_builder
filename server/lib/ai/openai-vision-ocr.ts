/**
 * Phase 5B.2.1 — OpenAI Vision OCR Engine
 *
 * Real OCR implementation backed by GPT-4o vision capabilities.
 * Replaces the stub_ocr placeholder from Phase 5B.2.
 *
 * Content handling:
 *   - base64 image data / data URL  → OpenAI Vision API call
 *   - HTTPS URL                     → OpenAI Vision API call (URL form)
 *   - plain text                    → text-based extraction (backward compat for tests)
 *
 * Bounding boxes: percentage-based coordinates (0–100) mapped to
 * a virtual 1000×1000 canvas so downstream consumers have stable integer values.
 *
 * Server-only. Never import from client/.
 */

import { createHash } from "crypto";
import { getOpenAIClient, isOpenAIAvailable } from "../openai-client";
import { KnowledgeInvariantError } from "./knowledge-bases";
import type { OcrParser, OcrParseResult, OcrParseOptions, OcrRegion } from "./image-ocr-parsers";

const SUPPORTED_OCR_MIME_TYPES_LOCAL = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
]);

// ─── Constants ────────────────────────────────────────────────────────────────

const VISION_MODEL = "gpt-4o";
const VIRTUAL_CANVAS_SIZE = 1000;
const OPENAI_OCR_TIMEOUT_MS = 30_000;

// ─── OpenAI Vision structured response schema ─────────────────────────────────

interface VisionRegion {
  regionIndex: number;
  pageNumber: number;
  text: string;
  lineCount: number;
  confidence: number;
  bbox?: {
    leftPct: number;
    topPct: number;
    widthPct: number;
    heightPct: number;
  };
}

interface VisionOcrResponse {
  regions: VisionRegion[];
  pageCount: number;
  hasText: boolean;
  extractionNotes?: string;
}

// ─── Content type detection ───────────────────────────────────────────────────

type ContentKind = "data_url" | "raw_base64" | "https_url" | "plain_text";

function detectContentKind(content: string): ContentKind {
  if (content.startsWith("data:image/")) return "data_url";
  if (content.startsWith("https://") || content.startsWith("http://")) return "https_url";
  const sample = content.replace(/\s/g, "").slice(0, 200);
  if (sample.length >= 60 && /^[A-Za-z0-9+/]+=*$/.test(sample)) return "raw_base64";
  return "plain_text";
}

function toDataUrl(content: string, mimeType: string): string {
  const kind = detectContentKind(content);
  if (kind === "data_url") return content;
  if (kind === "raw_base64") return `data:${mimeType};base64,${content.trim()}`;
  throw new Error("Cannot convert non-base64 content to data URL");
}

// ─── Text-based extraction (plain text fallback) ───────────────────────────────
// Used when content is plain text — preserves backward compat for tests and
// environments where images are injected as pre-extracted text.

function extractFromPlainText(
  content: string,
  mimeType: string,
  options?: OcrParseOptions,
): OcrParseResult {
  const maxBytes = options?.maxImageSizeBytes ?? 10 * 1024 * 1024;
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new KnowledgeInvariantError(
      "INV-IMG11",
      `Image content exceeds maximum safe size (${maxBytes} bytes). Explicit rejection (openai_vision_ocr text fallback).`,
    );
  }
  if (!content.trim()) {
    throw new KnowledgeInvariantError(
      "INV-IMG11",
      "Image content is empty. Explicit failure — openai_vision_ocr engine.",
    );
  }

  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
  const label = options?.contentLabel ?? mimeType;
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const windowSize = 3;
  const regions: OcrRegion[] = [];
  let regionIdx = 0;

  for (let i = 0; i < lines.length; i += windowSize) {
    const regionLines = lines.slice(i, i + windowSize);
    const regionText = regionLines.join(" ").trim();
    if (!regionText) continue;

    const conf = 0.7 + (parseInt(contentHash.slice(regionIdx * 2, regionIdx * 2 + 4), 16) % 300) / 1000;
    regions.push({
      regionIndex: regionIdx,
      pageNumber: 1,
      text: regionText,
      lineCount: regionLines.length,
      confidence: Math.min(1, conf),
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
      `No parseable regions extracted from plain-text content (${label}). Explicit failure.`,
    );
  }

  const totalLines = regions.reduce((acc, r) => acc + r.lineCount, 0);
  const avgConf = regions.reduce((acc, r) => acc + r.confidence, 0) / regions.length;
  const result: OcrParseResult = {
    engineName: "openai_vision_ocr",
    engineVersion: "1.0",
    mimeType,
    regions,
    pageCount: 1,
    blockCount: regions.length,
    lineCount: totalLines,
    averageConfidence: Math.round(avgConf * 1000) / 1000,
    textChecksum: "",
    warnings: [`openai_vision_ocr: plain_text_fallback path used (label=${label})`],
    metadata: { contentHash: contentHash.slice(0, 16), engineLabel: "openai_vision_ocr@1.0", label, path: "plain_text_fallback" },
  };
  return result;
}

// ─── OpenAI Vision extraction ─────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a high-accuracy OCR (Optical Character Recognition) engine.
Extract ALL visible text from the provided image.
Return ONLY a JSON object with this exact schema:
{
  "regions": [
    {
      "regionIndex": 0,
      "pageNumber": 1,
      "text": "<extracted text for this region>",
      "lineCount": <integer>,
      "confidence": <float 0.0–1.0>,
      "bbox": { "leftPct": <0–100>, "topPct": <0–100>, "widthPct": <0–100>, "heightPct": <0–100> }
    }
  ],
  "pageCount": 1,
  "hasText": true,
  "extractionNotes": "<optional notes about image quality or extraction issues>"
}

Rules:
- Organize text into logical regions: headers, paragraphs, labels, values, table rows, captions.
- Order regions top-to-bottom, then left-to-right.
- Set confidence 0.90–0.99 for crisp, clear text; 0.65–0.90 for unclear, blurry, or uncertain text.
- bbox percentages are relative to the image dimensions (0 = left/top edge, 100 = right/bottom edge).
- widthPct + leftPct must not exceed 100. heightPct + topPct must not exceed 100.
- If the image contains no text, return hasText: false and an empty regions array.
- Do NOT include any text outside the JSON object.`;

async function extractFromVisionApi(
  imageSource: string,
  mimeType: string,
  kind: ContentKind,
  options?: OcrParseOptions,
): Promise<VisionOcrResponse> {
  const client = getOpenAIClient();

  const imageContent: { type: "image_url"; image_url: { url: string; detail: "high" | "low" | "auto" } } = {
    type: "image_url",
    image_url: {
      url: kind === "https_url" ? imageSource : toDataUrl(imageSource, mimeType),
      detail: "high",
    },
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_OCR_TIMEOUT_MS);

  try {
    const response = await client.chat.completions.create(
      {
        model: VISION_MODEL,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [
              imageContent,
              { type: "text", text: "Extract all text from this image and return the structured JSON as specified." },
            ],
          },
        ],
        temperature: 0,
        max_tokens: 4096,
      },
      { signal: controller.signal },
    );

    clearTimeout(timer);
    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error("OpenAI Vision returned empty content");
    return JSON.parse(raw) as VisionOcrResponse;
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Convert Vision response → OcrParseResult ─────────────────────────────────

function visionResponseToParseResult(
  response: VisionOcrResponse,
  mimeType: string,
  options?: OcrParseOptions,
): OcrParseResult {
  if (!response.hasText || response.regions.length === 0) {
    throw new KnowledgeInvariantError(
      "INV-IMG11",
      "OpenAI Vision found no extractable text in the image. Explicit failure — no silent fallback.",
    );
  }

  const regions: OcrRegion[] = response.regions.map((r, idx) => {
    const bbox = r.bbox
      ? {
          left: Math.round((r.bbox.leftPct / 100) * VIRTUAL_CANVAS_SIZE),
          top: Math.round((r.bbox.topPct / 100) * VIRTUAL_CANVAS_SIZE),
          width: Math.round((r.bbox.widthPct / 100) * VIRTUAL_CANVAS_SIZE),
          height: Math.round((r.bbox.heightPct / 100) * VIRTUAL_CANVAS_SIZE),
        }
      : undefined;

    return {
      regionIndex: typeof r.regionIndex === "number" ? r.regionIndex : idx,
      pageNumber: typeof r.pageNumber === "number" ? r.pageNumber : 1,
      text: String(r.text ?? "").trim(),
      lineCount: typeof r.lineCount === "number" ? r.lineCount : r.text.split("\n").length,
      confidence: typeof r.confidence === "number" ? Math.min(1, Math.max(0, r.confidence)) : 0.9,
      bbox,
    };
  }).filter((r) => r.text.length > 0);

  if (regions.length === 0) {
    throw new KnowledgeInvariantError(
      "INV-IMG11",
      "OpenAI Vision returned regions with no extractable text. Explicit failure.",
    );
  }

  const totalLines = regions.reduce((acc, r) => acc + r.lineCount, 0);
  const avgConf = regions.reduce((acc, r) => acc + r.confidence, 0) / regions.length;
  const warnings: string[] = [];
  if (response.extractionNotes) warnings.push(`vision_note: ${response.extractionNotes}`);

  return {
    engineName: "openai_vision_ocr",
    engineVersion: "1.0",
    mimeType,
    regions,
    pageCount: response.pageCount ?? 1,
    blockCount: regions.length,
    lineCount: totalLines,
    averageConfidence: Math.round(avgConf * 1000) / 1000,
    textChecksum: "",
    warnings,
    metadata: {
      engineLabel: "openai_vision_ocr@1.0",
      model: VISION_MODEL,
      path: "vision_api",
      virtualCanvasSize: VIRTUAL_CANVAS_SIZE,
    },
  };
}

// ─── OpenAI Vision OCR Engine ─────────────────────────────────────────────────

export const openaiVisionOcrEngine: OcrParser = {
  name: "openai_vision_ocr",
  version: "1.0",
  supportedMimeTypes: Array.from(SUPPORTED_OCR_MIME_TYPES_LOCAL),

  async parse(content: string, mimeType: string, options?: OcrParseOptions): Promise<OcrParseResult> {
    const maxBytes = options?.maxImageSizeBytes ?? 10 * 1024 * 1024;

    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      throw new KnowledgeInvariantError(
        "INV-IMG11",
        `Image content exceeds maximum safe size (${maxBytes} bytes). Explicit rejection (openai_vision_ocr engine).`,
      );
    }
    if (!content || content.trim().length === 0) {
      throw new KnowledgeInvariantError(
        "INV-IMG11",
        "Image content is empty or zero-length. Explicit failure — openai_vision_ocr engine.",
      );
    }

    const kind = detectContentKind(content);

    if (kind === "plain_text") {
      const result = extractFromPlainText(content, mimeType, options);
      return result;
    }

    if (!isOpenAIAvailable()) {
      throw new KnowledgeInvariantError(
        "INV-IMG11",
        "OPENAI_API_KEY not set — cannot execute real OCR on binary image content. Explicit failure.",
      );
    }

    const visionResponse = await extractFromVisionApi(content, mimeType, kind, options);
    const result = visionResponseToParseResult(visionResponse, mimeType, options);
    return result;
  },
};
