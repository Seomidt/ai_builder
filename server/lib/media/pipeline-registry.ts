// ============================================================
// PHASE 5Y — Unified Media Processing Platform
// pipeline-registry.ts — Declarative pipeline step definitions
// ============================================================

import type { MediaType, PipelineType, PipelineDef, PipelineStepDef } from "./media-types.ts";
import { getPrimaryProvider } from "./fallback-policy.ts";

// ── Pipeline definitions ──────────────────────────────────────────────────────

const PIPELINE_REGISTRY: PipelineDef[] = [
  // ── PDF OCR ───────────────────────────────────────────────────────────────
  {
    mediaType: "pdf",
    pipelineType: "ocr",
    steps: [
      { stepType: "ocr",            provider: "google", model: "gemini-2.5-flash", timeoutMs: 30_000 },
      { stepType: "normalize_text", provider: "internal", model: "text-normalizer", timeoutMs: 5_000 },
      { stepType: "chunk_text",     provider: "internal", model: "text-chunker",    timeoutMs: 5_000 },
      { stepType: "persist_output", provider: "internal", model: "db-writer",       timeoutMs: 10_000 },
    ],
  },

  // ── Image Vision ──────────────────────────────────────────────────────────
  {
    mediaType: "image",
    pipelineType: "vision",
    steps: [
      { stepType: "vision_caption", provider: "google", model: "gemini-2.5-flash", timeoutMs: 30_000 },
      { stepType: "normalize_text", provider: "internal", model: "text-normalizer", timeoutMs: 5_000 },
      { stepType: "chunk_text",     provider: "internal", model: "text-chunker",    timeoutMs: 5_000 },
      { stepType: "persist_output", provider: "internal", model: "db-writer",       timeoutMs: 10_000 },
    ],
  },

  // ── Image OCR (text in images) ────────────────────────────────────────────
  {
    mediaType: "image",
    pipelineType: "ocr",
    steps: [
      { stepType: "ocr",            provider: "google", model: "gemini-2.5-flash", timeoutMs: 30_000 },
      { stepType: "normalize_text", provider: "internal", model: "text-normalizer", timeoutMs: 5_000 },
      { stepType: "chunk_text",     provider: "internal", model: "text-chunker",    timeoutMs: 5_000 },
      { stepType: "persist_output", provider: "internal", model: "db-writer",       timeoutMs: 10_000 },
    ],
  },

  // ── Audio Transcription ───────────────────────────────────────────────────
  {
    mediaType: "audio",
    pipelineType: "transcription",
    steps: [
      { stepType: "transcribe_audio", provider: "google", model: "gemini-2.5-flash", timeoutMs: 60_000 },
      { stepType: "normalize_text",   provider: "internal", model: "text-normalizer", timeoutMs: 5_000 },
      { stepType: "chunk_text",       provider: "internal", model: "text-chunker",    timeoutMs: 5_000 },
      { stepType: "persist_output",   provider: "internal", model: "db-writer",       timeoutMs: 10_000 },
    ],
  },

  // ── Video Multimodal ──────────────────────────────────────────────────────
  {
    mediaType: "video",
    pipelineType: "multimodal_extract",
    steps: [
      { stepType: "transcribe_audio",       provider: "google",    model: "gemini-2.5-flash", timeoutMs: 90_000 },
      { stepType: "vision_caption",         provider: "google",    model: "gemini-2.5-flash", timeoutMs: 90_000 },
      { stepType: "merge_multimodal_output",provider: "internal",  model: "merger",           timeoutMs: 5_000 },
      { stepType: "normalize_text",         provider: "internal",  model: "text-normalizer",  timeoutMs: 5_000 },
      { stepType: "chunk_text",             provider: "internal",  model: "text-chunker",     timeoutMs: 5_000 },
      { stepType: "persist_output",         provider: "internal",  model: "db-writer",        timeoutMs: 10_000 },
    ],
  },

  // ── Plain Text Parsing ────────────────────────────────────────────────────
  {
    mediaType: "text",
    pipelineType: "parsing",
    steps: [
      { stepType: "preprocess",    provider: "internal", model: "text-parser",    timeoutMs: 5_000 },
      { stepType: "normalize_text",provider: "internal", model: "text-normalizer",timeoutMs: 5_000 },
      { stepType: "chunk_text",    provider: "internal", model: "text-chunker",   timeoutMs: 5_000 },
      { stepType: "persist_output",provider: "internal", model: "db-writer",      timeoutMs: 10_000 },
    ],
  },
];

// ── Registry lookup ───────────────────────────────────────────────────────────

export function getPipelineDef(
  mediaType: MediaType,
  pipelineType: PipelineType
): PipelineDef | null {
  return (
    PIPELINE_REGISTRY.find(
      (p) => p.mediaType === mediaType && p.pipelineType === pipelineType
    ) ?? null
  );
}

export function getAllPipelines(): PipelineDef[] {
  return PIPELINE_REGISTRY;
}

/**
 * Returns the default pipeline type for a given media type.
 * Used when the caller doesn't specify a pipeline explicitly.
 */
export function getDefaultPipelineType(mediaType: MediaType): PipelineType {
  const defaults: Record<MediaType, PipelineType> = {
    pdf:   "ocr",
    image: "vision",
    audio: "transcription",
    video: "multimodal_extract",
    text:  "parsing",
  };
  return defaults[mediaType];
}
