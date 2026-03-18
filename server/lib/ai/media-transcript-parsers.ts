/**
 * Phase 5B.3 — Media Transcript Parser Abstraction
 *
 * Supported mime types:
 *   audio: audio/mpeg, audio/mp4, audio/wav, audio/x-wav, audio/webm
 *   video: video/mp4, video/webm, video/quicktime
 *
 * Unsupported types: explicit fail (INV-MEDIA1)
 * Video without audio-extraction support: explicit fail (INV-MEDIA2)
 *
 * Primary engine: openai_whisper_transcription v1.0
 *   - Real audio transcription via OpenAI Whisper API
 *   - Plain-text fallback for tests and pre-extracted transcripts
 *
 * Server-only. Never import from client/.
 */

import { createHash } from "crypto";
import { KnowledgeInvariantError } from "./knowledge-bases";
import { openaiWhisperEngine } from "./openai-whisper-transcription";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TranscriptSegment {
  segmentIndex: number;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number;
  speakerLabel?: string;
}

export interface TranscriptParseResult {
  engineName: string;
  engineVersion: string;
  mimeType: string;
  segments: TranscriptSegment[];
  languageCode: string;
  durationMs: number;
  segmentCount: number;
  speakerCount: number;
  averageConfidence: number;
  textChecksum: string;
  warnings: string[];
  metadata: Record<string, unknown>;
}

export interface TranscriptParseOptions {
  maxMediaSizeBytes?: number;
  languageHint?: string;
  engineHint?: string;
  contentLabel?: string;
  includeTimestamps?: boolean;
}

export interface TranscriptParser {
  name: string;
  version: string;
  supportedMimeTypes: string[];
  parse(
    content: string,
    mimeType: string,
    options?: TranscriptParseOptions,
  ): Promise<TranscriptParseResult>;
}

// ─── Constants ────────────────────────────────────────────────────────────────

export const SUPPORTED_AUDIO_MIME_TYPES = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
]);

export const SUPPORTED_VIDEO_MIME_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

export const SUPPORTED_MEDIA_MIME_TYPES = new Set([
  ...Array.from(SUPPORTED_AUDIO_MIME_TYPES),
  ...Array.from(SUPPORTED_VIDEO_MIME_TYPES),
]);

// ─── Checksum ────────────────────────────────────────────────────────────────

export function computeTranscriptTextChecksum(result: TranscriptParseResult): string {
  const normalized = result.segments
    .sort((a, b) => a.segmentIndex - b.segmentIndex)
    .map((s) => `${s.segmentIndex}|${s.startMs}|${s.endMs}|${s.text.trim()}`)
    .join("\n");
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 24);
}

// ─── Normalize ────────────────────────────────────────────────────────────────

export function normalizeTranscriptDocument(result: TranscriptParseResult): TranscriptParseResult {
  const sortedSegments = [...result.segments].sort((a, b) => a.segmentIndex - b.segmentIndex);
  const normalized = { ...result, segments: sortedSegments };
  normalized.textChecksum = computeTranscriptTextChecksum(normalized);
  return normalized;
}

// ─── Summary ─────────────────────────────────────────────────────────────────

export function summarizeTranscriptParseResult(result: TranscriptParseResult): string {
  return `engine=${result.engineName}@${result.engineVersion} lang=${result.languageCode} segments=${result.segmentCount} speakers=${result.speakerCount} durationMs=${result.durationMs} avgConf=${result.averageConfidence.toFixed(3)} checksum=${result.textChecksum.slice(0, 12)}`;
}

// ─── Parser Selection ─────────────────────────────────────────────────────────

/**
 * selectMediaTranscriptParser — returns the appropriate parser for the given mime type.
 *
 * INV-MEDIA1: Unsupported mime types fail explicitly — no silent fallback.
 * INV-MEDIA2: Video transcription requires audio-extraction support not yet wired.
 *             Explicit failure with actionable reason.
 *
 * @param mimeType  Normalized mime type of the media document version.
 * @param hint      Optional engine override (e.g. 'stub_transcript' for isolated testing).
 */
export function selectMediaTranscriptParser(mimeType: string, hint?: string): TranscriptParser {
  const normalizedMime = mimeType.toLowerCase().trim();

  if (!SUPPORTED_MEDIA_MIME_TYPES.has(normalizedMime)) {
    throw new KnowledgeInvariantError(
      "INV-MEDIA1",
      `Transcript parser not available for mime type '${mimeType}'. Supported audio: ${Array.from(SUPPORTED_AUDIO_MIME_TYPES).join(", ")}. Supported video: ${Array.from(SUPPORTED_VIDEO_MIME_TYPES).join(", ")}. Explicit failure — no silent fallback.`,
    );
  }

  if (SUPPORTED_VIDEO_MIME_TYPES.has(normalizedMime)) {
    throw new KnowledgeInvariantError(
      "INV-MEDIA2",
      `Video transcription for '${mimeType}' requires audio-track extraction (ffmpeg), which is not wired in Phase 5B.3. Submit audio track separately. Explicit failure — no silent coercion.`,
    );
  }

  if (hint === "stub_transcript") return stubTranscriptEngine;
  return openaiWhisperEngine;
}

// ─── Top-level parse function ─────────────────────────────────────────────────

export async function parseMediaDocumentVersion(
  content: string,
  mimeType: string,
  options?: TranscriptParseOptions,
): Promise<TranscriptParseResult> {
  const engineHint = options?.engineHint;
  const parser = selectMediaTranscriptParser(mimeType, engineHint);
  const raw = await parser.parse(content, mimeType, options);
  return normalizeTranscriptDocument(raw);
}

// ─── Legacy Stub Engine (unit testing only) ───────────────────────────────────
/**
 * stub_transcript — legacy deterministic placeholder.
 * Kept for isolated unit testing. Not used in production routing.
 * selectMediaTranscriptParser() routes to openai_whisper_transcription in all production paths.
 */
export const stubTranscriptEngine: TranscriptParser = {
  name: "stub_transcript",
  version: "1.0",
  supportedMimeTypes: Array.from(SUPPORTED_AUDIO_MIME_TYPES),

  async parse(
    content: string,
    mimeType: string,
    options?: TranscriptParseOptions,
  ): Promise<TranscriptParseResult> {
    const maxBytes = options?.maxMediaSizeBytes ?? 25 * 1024 * 1024;

    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      throw new KnowledgeInvariantError(
        "INV-MEDIA1",
        `Media content exceeds maximum safe size (${maxBytes} bytes). Explicit rejection (stub_transcript engine).`,
      );
    }
    if (!content || content.trim().length === 0) {
      throw new KnowledgeInvariantError(
        "INV-MEDIA1",
        "Media content is empty or zero-length. Explicit failure — stub_transcript engine.",
      );
    }

    const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
    const label = options?.contentLabel ?? mimeType;
    const lines = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    const windowSize = 2;
    const segments: TranscriptSegment[] = [];
    let segIdx = 0;
    const msPerWindow = 15_000;

    for (let i = 0; i < lines.length; i += windowSize) {
      const segLines = lines.slice(i, i + windowSize);
      const text = segLines.join(" ").trim();
      if (!text) continue;

      const baseConf = 0.8 + (parseInt(contentHash.slice(segIdx * 2, segIdx * 2 + 4), 16) % 200) / 1000;

      segments.push({
        segmentIndex: segIdx,
        startMs: segIdx * msPerWindow,
        endMs: (segIdx + 1) * msPerWindow,
        text,
        confidence: Math.min(1, baseConf),
        speakerLabel: undefined,
      });
      segIdx++;
    }

    if (segments.length === 0) {
      throw new KnowledgeInvariantError(
        "INV-MEDIA1",
        `No parseable transcript segments extracted from media content (${label}). Explicit failure — stub_transcript engine.`,
      );
    }

    const avgConf = segments.reduce((acc, s) => acc + s.confidence, 0) / segments.length;
    const durationMs = segments.length * msPerWindow;

    const result: TranscriptParseResult = {
      engineName: "stub_transcript",
      engineVersion: "1.0",
      mimeType,
      segments,
      languageCode: "en",
      durationMs,
      segmentCount: segments.length,
      speakerCount: 0,
      averageConfidence: Math.round(avgConf * 1000) / 1000,
      textChecksum: "",
      warnings: [
        `stub_transcript: legacy deterministic placeholder engine (${label}) — use openai_whisper_transcription in production`,
      ],
      metadata: {
        contentHash: contentHash.slice(0, 16),
        engineLabel: "stub_transcript@1.0",
        label,
      },
    };
    return result;
  },
};
