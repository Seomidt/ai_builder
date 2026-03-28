/**
 * Attachment Router — decides A/B processing mode for chat attachments.
 *
 * Mode A (direct): small/simple files processed inline for fast chat response.
 * Mode B (pipeline): large/complex files ingested fully or extracted from R2 for full-document analysis.
 *
 * Users never see or choose A/B — it is fully automatic.
 */

export type ProcessingMode = "A" | "B";

export interface AttachmentRoutingInput {
  mimeType:   string;
  sizeBytes:  number;
  fileCount:  number;
  context:    "chat" | "storage";
}

export interface AttachmentRoutingResult {
  mode:   ProcessingMode;
  reason: string;
}

// Deterministic thresholds
const MODE_A_MAX_BYTES = 4 * 1024 * 1024; // 4 MB — safe for direct extraction in chat

const VIDEO_AUDIO_MIMES = new Set([
  "video/mp4", "video/quicktime", "video/x-msvideo", "video/webm", "video/mpeg",
  "audio/mpeg", "audio/wav", "audio/ogg", "audio/webm", "audio/aac",
]);

/**
 * Choose A only when ALL are true:
 *   - chat context (not storage)
 *   - not video/audio
 *   - file count ≤ 3
 *   - size ≤ 4 MB
 *
 * Choose B when ANY are true:
 *   - storage context
 *   - video/audio (requires transcription pipeline)
 *   - too many files
 *   - file size > 4 MB
 */
export function decideAttachmentProcessingMode(
  input: AttachmentRoutingInput,
): AttachmentRoutingResult {
  const { mimeType, sizeBytes, fileCount, context } = input;

  if (context === "storage") {
    return { mode: "B", reason: "storage_context_always_pipeline" };
  }

  if (VIDEO_AUDIO_MIMES.has(mimeType)) {
    return { mode: "B", reason: "video_audio_requires_transcription" };
  }

  if (fileCount > 3) {
    return { mode: "B", reason: `too_many_files:${fileCount}` };
  }

  if (sizeBytes > MODE_A_MAX_BYTES) {
    return { mode: "B", reason: `large_file:${sizeBytes}b_exceeds_${MODE_A_MAX_BYTES}b` };
  }

  return { mode: "A", reason: "small_safe_direct" };
}
