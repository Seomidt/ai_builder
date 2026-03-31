// ============================================================
// PHASE 5Y — Unified Media Processing Platform
// fallback-policy.ts — Provider fallback chains per media/step type
// ============================================================
//
// DESIGN DECISION (from spec):
//   - attempt_count = job-level retry count
//   - fallback within same job-run does NOT increment attempt_count
//   - fallback_depth tracks which provider in the chain we are at
//   - step-level provider/model changes are logged in media_event_log

import type { FailureCategory, MediaType, PipelineType, StepType } from "./media-types.ts";
import { isCategoryRetryable } from "./failure-classifier.ts";

export interface FallbackProvider {
  provider: string;
  model: string;
  timeoutMs: number;
}

export interface FallbackChain {
  mediaType: MediaType | "*";
  pipelineType: PipelineType | "*";
  stepType: StepType;
  chain: FallbackProvider[];
}

// ── Fallback chains registry ──────────────────────────────────────────────────

const FALLBACK_CHAINS: FallbackChain[] = [
  // PDF OCR
  {
    mediaType: "pdf",
    pipelineType: "ocr",
    stepType: "ocr",
    chain: [
      { provider: "google", model: "gemini-2.5-flash", timeoutMs: 30_000 },
      { provider: "google", model: "gemini-1.5-pro",   timeoutMs: 60_000 },
    ],
  },
  // Image vision
  {
    mediaType: "image",
    pipelineType: "vision",
    stepType: "vision_caption",
    chain: [
      { provider: "google", model: "gemini-2.5-flash", timeoutMs: 30_000 },
      { provider: "google", model: "gemini-1.5-pro",   timeoutMs: 60_000 },
    ],
  },
  // Image OCR (text in images)
  {
    mediaType: "image",
    pipelineType: "ocr",
    stepType: "ocr",
    chain: [
      { provider: "google", model: "gemini-2.5-flash", timeoutMs: 30_000 },
      { provider: "google", model: "gemini-1.5-pro",   timeoutMs: 60_000 },
    ],
  },
  // Audio transcription
  {
    mediaType: "audio",
    pipelineType: "transcription",
    stepType: "transcribe_audio",
    chain: [
      { provider: "google", model: "gemini-2.5-flash", timeoutMs: 60_000 },
      { provider: "google", model: "gemini-1.5-pro",   timeoutMs: 90_000 },
    ],
  },
  // Video — full multimodal
  {
    mediaType: "video",
    pipelineType: "multimodal_extract",
    stepType: "transcribe_audio",
    chain: [
      { provider: "google", model: "gemini-2.5-flash", timeoutMs: 90_000 },
      { provider: "google", model: "gemini-1.5-pro",   timeoutMs: 120_000 },
    ],
  },
  {
    mediaType: "video",
    pipelineType: "multimodal_extract",
    stepType: "vision_caption",
    chain: [
      { provider: "google", model: "gemini-2.5-flash", timeoutMs: 90_000 },
      { provider: "google", model: "gemini-1.5-pro",   timeoutMs: 120_000 },
    ],
  },
];

// ── Lookup ────────────────────────────────────────────────────────────────────

export function getFallbackChain(
  mediaType: MediaType,
  pipelineType: PipelineType,
  stepType: StepType
): FallbackProvider[] {
  // Exact match first
  const exact = FALLBACK_CHAINS.find(
    (c) =>
      (c.mediaType === mediaType || c.mediaType === "*") &&
      (c.pipelineType === pipelineType || c.pipelineType === "*") &&
      c.stepType === stepType
  );
  if (exact) return exact.chain;

  // Generic fallback: gemini-2.5-flash → gemini-1.5-pro
  return [
    { provider: "google", model: "gemini-2.5-flash", timeoutMs: 45_000 },
    { provider: "google", model: "gemini-1.5-pro",   timeoutMs: 90_000 },
  ];
}

/**
 * Given current fallback_depth and a failure, decide whether to advance
 * to the next provider in the chain or give up.
 *
 * Returns null if no more fallbacks are available.
 */
export function getNextFallback(
  mediaType: MediaType,
  pipelineType: PipelineType,
  stepType: StepType,
  currentFallbackDepth: number,
  failureCategory: FailureCategory
): FallbackProvider | null {
  // Only fallback on retryable categories
  if (!isCategoryRetryable(failureCategory)) return null;

  const chain = getFallbackChain(mediaType, pipelineType, stepType);
  const nextDepth = currentFallbackDepth + 1;

  if (nextDepth >= chain.length) return null;
  return chain[nextDepth];
}

/**
 * Get the primary (first) provider for a given step.
 */
export function getPrimaryProvider(
  mediaType: MediaType,
  pipelineType: PipelineType,
  stepType: StepType
): FallbackProvider {
  const chain = getFallbackChain(mediaType, pipelineType, stepType);
  return chain[0];
}
