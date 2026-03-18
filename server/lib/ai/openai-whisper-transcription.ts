/**
 * Phase 5B.3 — OpenAI Whisper Transcription Engine
 *
 * Real audio transcription via OpenAI Whisper API (whisper-1).
 * Returns segments with timestamps, confidence scores, and language detection.
 *
 * Content handling:
 *   - base64 audio data / data URL  → decode to buffer → send to Whisper API
 *   - plain text                    → text-based extraction (backward compat for tests)
 *
 * Supported audio formats: audio/mpeg (mp3), audio/mp4, audio/wav, audio/x-wav, audio/webm
 * Video transcription requires audio-extraction (not wired — INV-MEDIA2).
 *
 * Server-only. Never import from client/.
 */

import { createHash, randomBytes } from "crypto";
import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createReadStream } from "fs";
import { getOpenAIClient, isOpenAIAvailable } from "../openai-client";
import { KnowledgeInvariantError } from "./knowledge-bases";
import type { TranscriptParser, TranscriptParseResult, TranscriptParseOptions, TranscriptSegment } from "./media-transcript-parsers";

// ─── Constants ────────────────────────────────────────────────────────────────

const WHISPER_MODEL = "whisper-1";
const DEFAULT_MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const WHISPER_TIMEOUT_MS = 60_000;

const MIME_TO_EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
};

const SUPPORTED_MIME_TYPES_LOCAL = new Set([
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
]);

// ─── Content type detection ───────────────────────────────────────────────────

type ContentKind = "data_url" | "raw_base64" | "plain_text";

function detectContentKind(content: string): ContentKind {
  if (content.startsWith("data:audio/") || content.startsWith("data:video/")) return "data_url";
  const sample = content.replace(/\s/g, "").slice(0, 200);
  if (sample.length >= 60 && /^[A-Za-z0-9+/]+=*$/.test(sample)) return "raw_base64";
  return "plain_text";
}

function extractBase64Payload(content: string): string {
  if (content.startsWith("data:")) {
    const commaIdx = content.indexOf(",");
    if (commaIdx === -1) throw new Error("Malformed data URL — no comma separator");
    return content.slice(commaIdx + 1);
  }
  return content.trim();
}

// ─── Whisper API response types ───────────────────────────────────────────────

interface WhisperSegment {
  id: number;
  seek: number;
  start: number;
  end: number;
  text: string;
  avg_logprob?: number;
  no_speech_prob?: number;
}

interface WhisperVerboseResponse {
  task: string;
  language: string;
  duration: number;
  segments: WhisperSegment[];
  text: string;
}

// ─── logprob → confidence conversion ─────────────────────────────────────────

function logProbToConfidence(avgLogProb?: number): number {
  if (avgLogProb === undefined || avgLogProb === null) return 0.85;
  const conf = Math.exp(avgLogProb);
  return Math.round(Math.min(1, Math.max(0, conf)) * 1000) / 1000;
}

// ─── Whisper API call ─────────────────────────────────────────────────────────

async function callWhisperApi(
  audioBuffer: Buffer,
  mimeType: string,
  languageHint?: string,
): Promise<WhisperVerboseResponse> {
  const client = getOpenAIClient();
  const ext = MIME_TO_EXT[mimeType] ?? "mp3";
  const tmpPath = join(tmpdir(), `whisper-${randomBytes(8).toString("hex")}.${ext}`);

  await writeFile(tmpPath, audioBuffer);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);

  try {
    const stream = createReadStream(tmpPath);
    const response = await (client.audio.transcriptions.create as (
      params: unknown,
      opts: unknown,
    ) => Promise<unknown>)(
      {
        model: WHISPER_MODEL,
        file: stream,
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
        ...(languageHint ? { language: languageHint } : {}),
      },
      { signal: controller.signal },
    );
    clearTimeout(timer);
    return response as unknown as WhisperVerboseResponse;
  } finally {
    clearTimeout(timer);
    await unlink(tmpPath).catch(() => undefined);
  }
}

// ─── Convert Whisper response → TranscriptParseResult ─────────────────────────

function whisperResponseToParseResult(
  response: WhisperVerboseResponse,
  mimeType: string,
): TranscriptParseResult {
  if (!response.segments || response.segments.length === 0) {
    throw new KnowledgeInvariantError(
      "INV-MEDIA1",
      "OpenAI Whisper returned no transcript segments. Explicit failure — the audio may be silent or unsupported.",
    );
  }

  const segments: TranscriptSegment[] = response.segments
    .filter((s) => s.text && s.text.trim().length > 0)
    .map((s, idx) => ({
      segmentIndex: idx,
      startMs: Math.round(s.start * 1000),
      endMs: Math.round(s.end * 1000),
      text: s.text.trim(),
      confidence: logProbToConfidence(s.avg_logprob),
      speakerLabel: undefined,
    }));

  if (segments.length === 0) {
    throw new KnowledgeInvariantError(
      "INV-MEDIA1",
      "OpenAI Whisper returned only empty segment texts. Explicit failure — no extractable transcript.",
    );
  }

  const avgConf = segments.reduce((acc, s) => acc + s.confidence, 0) / segments.length;
  const durationMs = Math.round((response.duration ?? 0) * 1000);

  return {
    engineName: "openai_whisper_transcription",
    engineVersion: "1.0",
    mimeType,
    segments,
    languageCode: response.language ?? "unknown",
    durationMs,
    segmentCount: segments.length,
    speakerCount: 0,
    averageConfidence: Math.round(avgConf * 1000) / 1000,
    textChecksum: "",
    warnings: [],
    metadata: {
      engineLabel: "openai_whisper_transcription@1.0",
      model: WHISPER_MODEL,
      path: "whisper_api",
      whisperTask: response.task,
    },
  };
}

// ─── Plain text fallback (backward compat) ────────────────────────────────────

function extractFromPlainText(
  content: string,
  mimeType: string,
  options?: TranscriptParseOptions,
): TranscriptParseResult {
  const maxBytes = options?.maxMediaSizeBytes ?? DEFAULT_MAX_MEDIA_BYTES;
  if (Buffer.byteLength(content, "utf8") > maxBytes) {
    throw new KnowledgeInvariantError(
      "INV-MEDIA1",
      `Media content exceeds maximum safe size (${maxBytes} bytes). Explicit rejection (openai_whisper_transcription text fallback).`,
    );
  }
  if (!content.trim()) {
    throw new KnowledgeInvariantError(
      "INV-MEDIA1",
      "Media content is empty. Explicit failure — openai_whisper_transcription engine.",
    );
  }

  const contentHash = createHash("sha256").update(content, "utf8").digest("hex");
  const label = options?.contentLabel ?? mimeType;
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const windowSize = 2;
  const msPerWindow = 15_000;
  const segments: TranscriptSegment[] = [];
  let segIdx = 0;

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
      `No parseable segments extracted from plain-text content (${label}). Explicit failure.`,
    );
  }

  const avgConf = segments.reduce((acc, s) => acc + s.confidence, 0) / segments.length;
  const durationMs = segments.length * msPerWindow;

  return {
    engineName: "openai_whisper_transcription",
    engineVersion: "1.0",
    mimeType,
    segments,
    languageCode: options?.languageHint ?? "en",
    durationMs,
    segmentCount: segments.length,
    speakerCount: 0,
    averageConfidence: Math.round(avgConf * 1000) / 1000,
    textChecksum: "",
    warnings: [`openai_whisper_transcription: plain_text_fallback path used (label=${label})`],
    metadata: {
      contentHash: contentHash.slice(0, 16),
      engineLabel: "openai_whisper_transcription@1.0",
      label,
      path: "plain_text_fallback",
    },
  };
}

// ─── OpenAI Whisper Transcription Engine ──────────────────────────────────────

export const openaiWhisperEngine: TranscriptParser = {
  name: "openai_whisper_transcription",
  version: "1.0",
  supportedMimeTypes: Array.from(SUPPORTED_MIME_TYPES_LOCAL),

  async parse(
    content: string,
    mimeType: string,
    options?: TranscriptParseOptions,
  ): Promise<TranscriptParseResult> {
    const maxBytes = options?.maxMediaSizeBytes ?? DEFAULT_MAX_MEDIA_BYTES;

    if (Buffer.byteLength(content, "utf8") > maxBytes) {
      throw new KnowledgeInvariantError(
        "INV-MEDIA1",
        `Media content exceeds maximum safe size (${maxBytes} bytes). Explicit rejection (openai_whisper_transcription engine).`,
      );
    }
    if (!content || content.trim().length === 0) {
      throw new KnowledgeInvariantError(
        "INV-MEDIA1",
        "Media content is empty or zero-length. Explicit failure — openai_whisper_transcription engine.",
      );
    }

    const kind = detectContentKind(content);

    if (kind === "plain_text") {
      return extractFromPlainText(content, mimeType, options);
    }

    if (!isOpenAIAvailable()) {
      throw new KnowledgeInvariantError(
        "INV-MEDIA1",
        "OPENAI_API_KEY not set — cannot execute real transcription on binary audio content. Explicit failure.",
      );
    }

    const base64Payload = extractBase64Payload(content);
    const audioBuffer = Buffer.from(base64Payload, "base64");

    if (audioBuffer.length === 0) {
      throw new KnowledgeInvariantError(
        "INV-MEDIA1",
        "Decoded audio buffer is empty — malformed base64 content. Explicit failure.",
      );
    }

    const response = await callWhisperApi(audioBuffer, mimeType, options?.languageHint);
    return whisperResponseToParseResult(response, mimeType);
  },
};
