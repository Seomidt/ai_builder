// ============================================================
// PHASE 5Y — Unified Media Processing Platform
// input-validator.ts — Media-type-aware input validation
// ============================================================

import type { MediaType, PipelineType, ValidationResult } from "./media-types.ts";
import { checkGuardrails } from "./cost-policy.ts";

// ── MIME type → MediaType mapping ─────────────────────────────────────────────

const MIME_TO_MEDIA_TYPE: Record<string, MediaType> = {
  // PDF
  "application/pdf": "pdf",
  // Images
  "image/jpeg": "image",
  "image/jpg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/tiff": "image",
  "image/bmp": "image",
  "image/heic": "image",
  "image/heif": "image",
  // Audio
  "audio/mpeg": "audio",
  "audio/mp3": "audio",
  "audio/wav": "audio",
  "audio/wave": "audio",
  "audio/ogg": "audio",
  "audio/flac": "audio",
  "audio/aac": "audio",
  "audio/mp4": "audio",
  "audio/webm": "audio",
  // Video
  "video/mp4": "video",
  "video/mpeg": "video",
  "video/quicktime": "video",
  "video/webm": "video",
  "video/x-msvideo": "video",
  "video/3gpp": "video",
  "video/ogg": "video",
  // Text
  "text/plain": "text",
  "text/csv": "text",
  "text/markdown": "text",
  "application/json": "text",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "text",
  "application/msword": "text",
};

// ── Legal pipeline combinations ───────────────────────────────────────────────

const LEGAL_PIPELINES: Record<MediaType, PipelineType[]> = {
  pdf:   ["ocr", "parsing", "embedding"],
  image: ["ocr", "vision", "embedding"],
  audio: ["transcription", "embedding"],
  video: ["multimodal_extract", "transcription", "embedding"],
  text:  ["parsing", "embedding"],
};

// ── Validation ────────────────────────────────────────────────────────────────

export interface InputValidationParams {
  mimeType: string;
  fileSizeBytes: number;
  requestedPipeline: PipelineType;
  durationSec?: number;
  pageCount?: number;
  r2KeyExists?: boolean; // true if we confirmed the file exists in R2
}

export function validateInput(params: InputValidationParams): ValidationResult {
  const { mimeType, fileSizeBytes, requestedPipeline, durationSec, pageCount, r2KeyExists } = params;

  // ── 1. MIME type must be known ────────────────────────────────────────────
  const mediaType = MIME_TO_MEDIA_TYPE[mimeType.toLowerCase()];
  if (!mediaType) {
    return {
      valid: false,
      errorCode: "UNSUPPORTED_MIME_TYPE",
      errorMessage: `MIME type '${mimeType}' is not supported`,
      failureCategory: "unsupported_media",
      retryable: false,
    };
  }

  // ── 2. File must exist in storage ─────────────────────────────────────────
  if (r2KeyExists === false) {
    return {
      valid: false,
      errorCode: "FILE_NOT_FOUND",
      errorMessage: "File not found in storage",
      failureCategory: "storage",
      retryable: true, // Might be a race condition, allow retry
    };
  }

  // ── 3. Pipeline must be legal for this media type ─────────────────────────
  const legalPipelines = LEGAL_PIPELINES[mediaType];
  if (!legalPipelines.includes(requestedPipeline)) {
    return {
      valid: false,
      errorCode: "ILLEGAL_PIPELINE",
      errorMessage: `Pipeline '${requestedPipeline}' is not valid for media type '${mediaType}'. Legal pipelines: ${legalPipelines.join(", ")}`,
      failureCategory: "invalid_input",
      retryable: false,
    };
  }

  // ── 4. Guardrail checks (size, duration, pages) ───────────────────────────
  const guardrail = checkGuardrails({ mediaType, fileSizeBytes, durationSec, pageCount });
  if (guardrail.blocked) {
    return {
      valid: false,
      errorCode: guardrail.errorCode,
      errorMessage: guardrail.errorMessage,
      failureCategory: "unsupported_media",
      retryable: false,
    };
  }

  return { valid: true, retryable: false };
}

// ── MIME type inference ───────────────────────────────────────────────────────

export function inferMediaType(mimeType: string): MediaType | null {
  return MIME_TO_MEDIA_TYPE[mimeType.toLowerCase()] ?? null;
}

export function isSupportedMimeType(mimeType: string): boolean {
  return mimeType.toLowerCase() in MIME_TO_MEDIA_TYPE;
}
