/**
 * Phase 5B.3 — Media Transcript Chunking Foundation
 *
 * Strategy: time_windows (group transcript segments by configurable time windows)
 * Deterministic chunk keys and hashes.
 * Preserves segment order, timestamp context, and speaker grouping.
 */

import { createHash } from "crypto";
import type { TranscriptParseResult, TranscriptSegment } from "./media-transcript-parsers";

// ─── Config ───────────────────────────────────────────────────────────────────

export interface TranscriptChunkingConfig {
  strategy?: string;
  version?: string;
  windowMs?: number;
  segmentWindowSize?: number;
  includeTimestamps?: boolean;
  includeSpeakerLabel?: boolean;
}

export const DEFAULT_TRANSCRIPT_CHUNKING_CONFIG: TranscriptChunkingConfig = {
  strategy: "time_windows",
  version: "1.0",
  windowMs: 60_000,
  segmentWindowSize: 5,
  includeTimestamps: true,
  includeSpeakerLabel: true,
};

// ─── Candidate type ───────────────────────────────────────────────────────────

export interface TranscriptChunkCandidate {
  chunkIndex: number;
  chunkKey: string;
  chunkHash: string;
  chunkText: string;
  transcriptChunkStrategy: string;
  transcriptChunkVersion: string;
  segmentStartMs: number;
  segmentEndMs: number;
  transcriptSegmentIndex: number;
  segmentEndIndex: number;
  speakerLabel?: string;
  transcriptConfidence?: number;
  sourceTrack?: string;
  tokenEstimate: number;
}

// ─── Deterministic key + hash ─────────────────────────────────────────────────

/**
 * buildTranscriptChunkKey — stable, deterministic key per transcript chunk.
 * Same inputs must always produce the same key (INV-MEDIA10).
 */
export function buildTranscriptChunkKey(
  documentId: string,
  versionId: string,
  segmentStart: number,
  segmentEnd: number,
  startMs: number,
  endMs: number,
  strategy: string,
  strategyVersion: string,
): string {
  const raw = `${documentId}::${versionId}::seg${segmentStart}-${segmentEnd}::ms${startMs}-${endMs}::${strategy}@${strategyVersion}`;
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32);
}

/**
 * buildTranscriptChunkHash — content hash for transcript chunk text.
 * Same normalized text + same strategy produces same hash (INV-MEDIA10).
 */
export function buildTranscriptChunkHash(
  normalizedText: string,
  strategy: string,
  strategyVersion: string,
): string {
  const raw = `${strategy}@${strategyVersion}::${normalizedText}`;
  return createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 32);
}

// ─── Text normalization ───────────────────────────────────────────────────────

/**
 * normalizeTranscriptChunkText — deterministic text normalization.
 * Collapses whitespace, trims, normalizes line endings.
 */
export function normalizeTranscriptChunkText(text: string): string {
  return text
    .replace(/\r\n/g, " ")
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// ─── Speaker label resolution ─────────────────────────────────────────────────

function resolveSpeakerLabel(segments: TranscriptSegment[]): string | undefined {
  const labels = Array.from(new Set(segments.map((s) => s.speakerLabel).filter(Boolean)));
  if (labels.length === 0) return undefined;
  if (labels.length === 1) return labels[0];
  return `mixed:${labels.join("+")}`;
}

// ─── Main chunking function ───────────────────────────────────────────────────

/**
 * chunkTranscriptDocument — groups transcript segments into chunk candidates.
 *
 * INV-MEDIA10: chunk keys and hashes are deterministic.
 * Preserves segment ordering, timestamp context, speaker grouping.
 * Does NOT create embeddings or set index_state='indexed'.
 */
export function chunkTranscriptDocument(
  parseResult: TranscriptParseResult,
  documentId: string,
  versionId: string,
  config: TranscriptChunkingConfig = {},
): TranscriptChunkCandidate[] {
  const strategy = config.strategy ?? DEFAULT_TRANSCRIPT_CHUNKING_CONFIG.strategy!;
  const stratVersion = config.version ?? DEFAULT_TRANSCRIPT_CHUNKING_CONFIG.version!;
  const windowMs = config.windowMs ?? DEFAULT_TRANSCRIPT_CHUNKING_CONFIG.windowMs!;
  const segmentWindowSize = config.segmentWindowSize ?? DEFAULT_TRANSCRIPT_CHUNKING_CONFIG.segmentWindowSize!;
  const includeTimestamps = config.includeTimestamps ?? DEFAULT_TRANSCRIPT_CHUNKING_CONFIG.includeTimestamps!;
  const includeSpeakerLabel = config.includeSpeakerLabel ?? DEFAULT_TRANSCRIPT_CHUNKING_CONFIG.includeSpeakerLabel!;

  const sortedSegments = [...parseResult.segments].sort((a, b) => a.segmentIndex - b.segmentIndex);
  const candidates: TranscriptChunkCandidate[] = [];
  let chunkIndex = 0;

  if (strategy === "time_windows") {
    let windowStart = 0;

    while (windowStart < sortedSegments.length) {
      const group: TranscriptSegment[] = [];
      const groupStartMs = sortedSegments[windowStart].startMs;

      for (let j = windowStart; j < sortedSegments.length; j++) {
        const seg = sortedSegments[j];
        if (group.length > 0 && seg.startMs >= groupStartMs + windowMs) break;
        group.push(seg);
      }

      if (group.length === 0) break;
      windowStart += group.length;

      const rawParts = group.map((s) => {
        let part = s.text.trim();
        if (includeSpeakerLabel && s.speakerLabel) part = `[${s.speakerLabel}] ${part}`;
        if (includeTimestamps) part = `[${formatMs(s.startMs)}-${formatMs(s.endMs)}] ${part}`;
        return part;
      });

      const rawText = rawParts.join(" ");
      const normalizedText = normalizeTranscriptChunkText(rawText);
      if (!normalizedText) continue;

      const segmentStart = group[0].segmentIndex;
      const segmentEnd = group[group.length - 1].segmentIndex;
      const chunkStartMs = group[0].startMs;
      const chunkEndMs = group[group.length - 1].endMs;
      const avgConf = group.reduce((acc, s) => acc + s.confidence, 0) / group.length;
      const speakerLabel = includeSpeakerLabel ? resolveSpeakerLabel(group) : undefined;

      const chunkKey = buildTranscriptChunkKey(
        documentId,
        versionId,
        segmentStart,
        segmentEnd,
        chunkStartMs,
        chunkEndMs,
        strategy,
        stratVersion,
      );
      const chunkHash = buildTranscriptChunkHash(normalizedText, strategy, stratVersion);

      candidates.push({
        chunkIndex,
        chunkKey,
        chunkHash,
        chunkText: normalizedText,
        transcriptChunkStrategy: strategy,
        transcriptChunkVersion: stratVersion,
        segmentStartMs: chunkStartMs,
        segmentEndMs: chunkEndMs,
        transcriptSegmentIndex: segmentStart,
        segmentEndIndex: segmentEnd,
        speakerLabel,
        transcriptConfidence: Math.round(avgConf * 1000) / 1000,
        sourceTrack: parseResult.metadata.sourceTrack as string | undefined,
        tokenEstimate: Math.ceil(normalizedText.length / 4),
      });
      chunkIndex++;
    }
  } else {
    for (let i = 0; i < sortedSegments.length; i += segmentWindowSize) {
      const group = sortedSegments.slice(i, i + segmentWindowSize);
      const rawText = group.map((s) => s.text.trim()).join(" ");
      const normalizedText = normalizeTranscriptChunkText(rawText);
      if (!normalizedText) continue;

      const segmentStart = group[0].segmentIndex;
      const segmentEnd = group[group.length - 1].segmentIndex;
      const chunkStartMs = group[0].startMs;
      const chunkEndMs = group[group.length - 1].endMs;
      const avgConf = group.reduce((acc, s) => acc + s.confidence, 0) / group.length;
      const speakerLabel = includeSpeakerLabel ? resolveSpeakerLabel(group) : undefined;

      const chunkKey = buildTranscriptChunkKey(
        documentId,
        versionId,
        segmentStart,
        segmentEnd,
        chunkStartMs,
        chunkEndMs,
        strategy,
        stratVersion,
      );
      const chunkHash = buildTranscriptChunkHash(normalizedText, strategy, stratVersion);

      candidates.push({
        chunkIndex,
        chunkKey,
        chunkHash,
        chunkText: normalizedText,
        transcriptChunkStrategy: strategy,
        transcriptChunkVersion: stratVersion,
        segmentStartMs: chunkStartMs,
        segmentEndMs: chunkEndMs,
        transcriptSegmentIndex: segmentStart,
        segmentEndIndex: segmentEnd,
        speakerLabel,
        transcriptConfidence: Math.round(avgConf * 1000) / 1000,
        sourceTrack: parseResult.metadata.sourceTrack as string | undefined,
        tokenEstimate: Math.ceil(normalizedText.length / 4),
      });
      chunkIndex++;
    }
  }

  return candidates;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

/**
 * summarizeTranscriptChunks — short summary for job result_summary and inspection.
 */
export function summarizeTranscriptChunks(candidates: TranscriptChunkCandidate[]): string {
  if (candidates.length === 0) return "chunks=0";
  const totalMs = candidates[candidates.length - 1].segmentEndMs - candidates[0].segmentStartMs;
  const avgConf = candidates.reduce((acc, c) => acc + (c.transcriptConfidence ?? 0), 0) / candidates.length;
  const speakers = Array.from(new Set(candidates.map((c) => c.speakerLabel).filter(Boolean)));
  return `chunks=${candidates.length} totalMs=${totalMs} avgConf=${avgConf.toFixed(3)} speakers=${speakers.length}`;
}
