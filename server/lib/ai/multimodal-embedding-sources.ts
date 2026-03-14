/**
 * multimodal-embedding-sources.ts — Phase 5L
 *
 * Canonical model for collecting, normalizing, and explaining
 * multimodal embedding inputs from knowledge asset versions.
 *
 * Source priority order (deterministic):
 *   1. parsed_text   — from direct document parsing
 *   2. ocr_text      — from metadata.ocr.extracted_text
 *   3. transcript_text — from metadata.transcript.transcript_text
 *   4. caption_text  — from metadata.caption.caption_text
 *   5. video_frame_text — from metadata.video_frames (concatenated frame descriptors)
 *   6. imported_text — from metadata.imported_text
 *
 * Rules for multi-source assets:
 * - document with parsed_text + ocr_text: parsed_text is primary; ocr is supplemental only if text differs materially (checksum mismatch)
 * - image with ocr_text + caption_text: both are embedded (different semantic roles)
 * - audio with transcript_text only: transcript is primary
 * - video with transcript + frame_text: transcript primary, frame text supplemental
 * - sources with identical checksums: deduplicated (only highest priority source kept)
 *
 * INV-EMB8: Sources are NOT merged silently — rules are explicit and documented per source pair.
 */

import crypto from "crypto";
import { db } from "../../db";
import { knowledgeAssetVersions, knowledgeAssets } from "@shared/schema";
import { eq, and } from "drizzle-orm";

// ── Source types ──────────────────────────────────────────────────────────────

export type EmbeddingSourceType =
  | "parsed_text"
  | "ocr_text"
  | "transcript_text"
  | "caption_text"
  | "video_frame_text"
  | "imported_text";

export interface EmbeddingSource {
  sourceType: EmbeddingSourceType;
  sourceKey: string;
  textContent: string;
  sourceMetadata: Record<string, unknown>;
  sourcePriority: number;
  sourceLength: number;
  sourceChecksum: string;
  originProcessor: string;
  isDuplicate: boolean;
  duplicateOf: string | null;
}

export interface EmbeddingSourceCoverage {
  assetVersionId: string;
  assetType: string;
  tenantId: string;
  totalSources: number;
  activeSources: number;
  deduplicatedSources: number;
  sourceTypes: EmbeddingSourceType[];
  primarySource: EmbeddingSourceType | null;
  supplementalSources: EmbeddingSourceType[];
  hasEmbeddableContent: boolean;
  missingExpectedSources: string[];
  coverageNotes: string[];
}

// ── Priority table ─────────────────────────────────────────────────────────────

const SOURCE_PRIORITY: Record<EmbeddingSourceType, number> = {
  parsed_text: 1,
  ocr_text: 2,
  transcript_text: 3,
  caption_text: 4,
  video_frame_text: 5,
  imported_text: 6,
};

// ── Text normalization ─────────────────────────────────────────────────────────

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function textChecksum(text: string): string {
  return crypto.createHash("sha256").update(normalizeText(text)).digest("hex").slice(0, 16);
}

function isMateriallyDifferent(a: string, b: string): boolean {
  return textChecksum(a) !== textChecksum(b);
}

// ── Source extraction from metadata ───────────────────────────────────────────

function extractSourcesFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
  assetType: string,
): EmbeddingSource[] {
  const sources: EmbeddingSource[] = [];
  const meta = metadata ?? {};

  // ocr_text — from Phase 5K real-ocr-image processor
  const ocrData = (meta.ocr as Record<string, unknown> | null | undefined);
  if (ocrData?.extracted_text && typeof ocrData.extracted_text === "string" && ocrData.extracted_text.trim()) {
    const text = normalizeText(ocrData.extracted_text);
    sources.push({
      sourceType: "ocr_text",
      sourceKey: "metadata.ocr.extracted_text",
      textContent: text,
      sourceMetadata: {
        engine_name: ocrData.engine_name ?? "unknown",
        average_confidence: ocrData.average_confidence ?? null,
        block_count: ocrData.block_count ?? null,
      },
      sourcePriority: SOURCE_PRIORITY.ocr_text,
      sourceLength: text.length,
      sourceChecksum: textChecksum(text),
      originProcessor: "real-ocr-image",
      isDuplicate: false,
      duplicateOf: null,
    });
  }

  // transcript_text — from Phase 5K real-transcribe-audio processor
  const transcriptData = (meta.transcript as Record<string, unknown> | null | undefined);
  if (transcriptData?.transcript_text && typeof transcriptData.transcript_text === "string" && transcriptData.transcript_text.trim()) {
    const text = normalizeText(transcriptData.transcript_text);
    sources.push({
      sourceType: "transcript_text",
      sourceKey: "metadata.transcript.transcript_text",
      textContent: text,
      sourceMetadata: {
        engine_name: transcriptData.engine_name ?? "unknown",
        detected_language: transcriptData.detected_language ?? null,
        duration_seconds: transcriptData.duration_seconds ?? null,
      },
      sourcePriority: SOURCE_PRIORITY.transcript_text,
      sourceLength: text.length,
      sourceChecksum: textChecksum(text),
      originProcessor: "real-transcribe-audio",
      isDuplicate: false,
      duplicateOf: null,
    });
  }

  // caption_text — from Phase 5K real-caption-image processor
  const captionData = (meta.caption as Record<string, unknown> | null | undefined);
  if (captionData?.caption_text && typeof captionData.caption_text === "string" && captionData.caption_text.trim()) {
    const text = normalizeText(captionData.caption_text);
    sources.push({
      sourceType: "caption_text",
      sourceKey: "metadata.caption.caption_text",
      textContent: text,
      sourceMetadata: {
        engine_name: captionData.engine_name ?? "unknown",
        labels: captionData.labels ?? [],
      },
      sourcePriority: SOURCE_PRIORITY.caption_text,
      sourceLength: text.length,
      sourceChecksum: textChecksum(text),
      originProcessor: "real-caption-image",
      isDuplicate: false,
      duplicateOf: null,
    });
  }

  // video_frame_text — from Phase 5K real-sample-video-frames processor
  const videoFramesData = (meta.video_frames as Record<string, unknown> | null | undefined);
  if (videoFramesData) {
    const frames = (videoFramesData.sampled_at_seconds as number[] | undefined) ?? [];
    const frameCount = videoFramesData.frame_count as number | undefined;
    if (frameCount && frameCount > 0) {
      const descriptor = `Video contains ${frameCount} sampled frames at intervals: ${frames.slice(0, 5).join("s, ")}s${frames.length > 5 ? "..." : ""}. Strategy: ${videoFramesData.sample_strategy ?? "fps_1_10"}.`;
      const text = normalizeText(descriptor);
      sources.push({
        sourceType: "video_frame_text",
        sourceKey: "metadata.video_frames.descriptor",
        textContent: text,
        sourceMetadata: {
          frame_count: frameCount,
          sample_strategy: videoFramesData.sample_strategy ?? "fps_1_10",
          sampled_at_seconds: frames,
        },
        sourcePriority: SOURCE_PRIORITY.video_frame_text,
        sourceLength: text.length,
        sourceChecksum: textChecksum(text),
        originProcessor: "real-sample-video-frames",
        isDuplicate: false,
        duplicateOf: null,
      });
    }
  }

  // imported_text — from direct metadata import
  const importedText = (meta.imported_text as string | undefined);
  if (importedText && typeof importedText === "string" && importedText.trim()) {
    const text = normalizeText(importedText);
    sources.push({
      sourceType: "imported_text",
      sourceKey: "metadata.imported_text",
      textContent: text,
      sourceMetadata: {},
      sourcePriority: SOURCE_PRIORITY.imported_text,
      sourceLength: text.length,
      sourceChecksum: textChecksum(text),
      originProcessor: "import",
      isDuplicate: false,
      duplicateOf: null,
    });
  }

  return sources;
}

// ── Deduplication ─────────────────────────────────────────────────────────────
// Rule: if two sources have identical checksums, keep only the highest-priority one.
// Exception: ocr_text and caption_text are NEVER deduplicated (different semantic roles).
// Exception: transcript_text and video_frame_text are NEVER deduplicated.
function deduplicateSources(sources: EmbeddingSource[]): EmbeddingSource[] {
  const checksumMap = new Map<string, EmbeddingSource>();
  const result: EmbeddingSource[] = [];

  const NEVER_DEDUPLICATE_PAIRS: Set<string> = new Set([
    "ocr_text:caption_text",
    "caption_text:ocr_text",
    "transcript_text:video_frame_text",
    "video_frame_text:transcript_text",
  ]);

  for (const source of sources.sort((a, b) => a.sourcePriority - b.sourcePriority)) {
    const existing = checksumMap.get(source.sourceChecksum);
    if (existing) {
      const pairKey = `${existing.sourceType}:${source.sourceType}`;
      if (NEVER_DEDUPLICATE_PAIRS.has(pairKey)) {
        result.push(source);
        continue;
      }
      // Same checksum, lower priority — mark as duplicate
      result.push({ ...source, isDuplicate: true, duplicateOf: existing.sourceType });
    } else {
      checksumMap.set(source.sourceChecksum, source);
      result.push(source);
    }
  }

  return result;
}

// ── Public API ─────────────────────────────────────────────────────────────────

export async function listEmbeddingSourcesForAssetVersion(
  assetVersionId: string,
): Promise<EmbeddingSource[]> {
  const rows = await db
    .select()
    .from(knowledgeAssetVersions)
    .where(eq(knowledgeAssetVersions.id, assetVersionId))
    .limit(1);
  if (!rows.length) throw new Error(`AssetVersion not found: ${assetVersionId}`);
  const version = rows[0];
  const meta = (version.metadata ?? {}) as Record<string, unknown>;

  const assetRows = await db
    .select({ assetType: knowledgeAssets.assetType })
    .from(knowledgeAssets)
    .where(eq(knowledgeAssets.id, version.assetId))
    .limit(1);
  const assetType = assetRows[0]?.assetType ?? "document";

  const raw = extractSourcesFromMetadata(meta, assetType);
  return deduplicateSources(raw);
}

export async function buildEmbeddingInputsForAssetVersion(
  assetVersionId: string,
): Promise<{ sources: EmbeddingSource[]; activeSources: EmbeddingSource[] }> {
  const sources = await listEmbeddingSourcesForAssetVersion(assetVersionId);
  const activeSources = sources.filter((s) => !s.isDuplicate && s.textContent.length > 10);
  return { sources, activeSources };
}

export async function explainEmbeddingSourcesForAssetVersion(assetVersionId: string): Promise<{
  assetVersionId: string;
  sources: EmbeddingSource[];
  activeSources: EmbeddingSource[];
  deduplicationLog: string[];
  priorityResolutionLog: string[];
  embeddingInputCount: number;
}> {
  const { sources, activeSources } = await buildEmbeddingInputsForAssetVersion(assetVersionId);
  const deduplicationLog: string[] = [];
  const priorityResolutionLog: string[] = [];

  sources.forEach((s) => {
    if (s.isDuplicate) {
      deduplicationLog.push(`${s.sourceType} DEDUPLICATED — identical checksum to ${s.duplicateOf} (higher priority source kept)`);
    }
  });

  // Priority resolution notes
  const activeTypes = activeSources.map((s) => s.sourceType);
  if (activeTypes.includes("parsed_text") && activeTypes.includes("ocr_text")) {
    const pt = activeSources.find((s) => s.sourceType === "parsed_text")!;
    const ot = activeSources.find((s) => s.sourceType === "ocr_text")!;
    if (isMateriallyDifferent(pt.textContent, ot.textContent)) {
      priorityResolutionLog.push("parsed_text + ocr_text: checksums differ — both included (parsed_text primary)");
    } else {
      priorityResolutionLog.push("parsed_text + ocr_text: near-identical content — ocr_text marked supplemental");
    }
  }
  if (activeTypes.includes("ocr_text") && activeTypes.includes("caption_text")) {
    priorityResolutionLog.push("ocr_text + caption_text: both retained — different semantic roles (text recognition vs. scene description)");
  }
  if (activeTypes.includes("transcript_text") && activeTypes.includes("video_frame_text")) {
    priorityResolutionLog.push("transcript_text + video_frame_text: transcript primary, frame descriptors supplemental");
  }

  return {
    assetVersionId,
    sources,
    activeSources,
    deduplicationLog,
    priorityResolutionLog,
    embeddingInputCount: activeSources.length,
  };
}

export async function summarizeEmbeddingSourceCoverage(
  assetVersionId: string,
): Promise<EmbeddingSourceCoverage> {
  const versionRows = await db
    .select()
    .from(knowledgeAssetVersions)
    .where(eq(knowledgeAssetVersions.id, assetVersionId))
    .limit(1);
  if (!versionRows.length) throw new Error(`AssetVersion not found: ${assetVersionId}`);
  const version = versionRows[0];
  const assetRows = await db
    .select()
    .from(knowledgeAssets)
    .where(eq(knowledgeAssets.id, version.assetId))
    .limit(1);
  const asset = assetRows[0];

  const { sources, activeSources } = await buildEmbeddingInputsForAssetVersion(assetVersionId);
  const duplicates = sources.filter((s) => s.isDuplicate);

  const sourceTypes = Array.from(new Set(activeSources.map((s) => s.sourceType)));
  const primarySource = activeSources.length > 0 ? activeSources[0].sourceType : null;
  const supplementalSources = activeSources.slice(1).map((s) => s.sourceType);

  const assetType = asset?.assetType ?? "document";
  const expectedSources: Record<string, EmbeddingSourceType[]> = {
    document: ["parsed_text"],
    image: ["ocr_text", "caption_text"],
    audio: ["transcript_text"],
    video: ["transcript_text", "video_frame_text"],
    email: ["parsed_text"],
    webpage: ["parsed_text"],
  };
  const expected = expectedSources[assetType] ?? ["parsed_text"];
  const missingExpectedSources = expected.filter((e) => !sourceTypes.includes(e));

  const coverageNotes: string[] = [];
  if (duplicates.length > 0) {
    coverageNotes.push(`${duplicates.length} source(s) deduplicated due to identical content checksums`);
  }
  if (missingExpectedSources.length > 0) {
    coverageNotes.push(`Missing expected sources for ${assetType}: ${missingExpectedSources.join(", ")} — processing may be incomplete`);
  }
  if (activeSources.length === 0) {
    coverageNotes.push("No embeddable content found — asset may need processing first");
  }

  return {
    assetVersionId,
    assetType,
    tenantId: version.tenantId ?? "",
    totalSources: sources.length,
    activeSources: activeSources.length,
    deduplicatedSources: duplicates.length,
    sourceTypes,
    primarySource,
    supplementalSources,
    hasEmbeddableContent: activeSources.length > 0,
    missingExpectedSources,
    coverageNotes,
  };
}
