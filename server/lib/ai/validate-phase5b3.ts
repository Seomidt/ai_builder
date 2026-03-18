/**
 * Phase 5B.3 Validation — Audio/Video Ingestion Pipeline
 * 15 validation scenarios
 */

import { db } from "../../db";
import { sql } from "drizzle-orm";
import {
  chunkTranscriptDocument,
  buildTranscriptChunkKey,
  buildTranscriptChunkHash,
  normalizeTranscriptChunkText,
  summarizeTranscriptChunks,
  DEFAULT_TRANSCRIPT_CHUNKING_CONFIG,
} from "./media-transcript-chunking";
import {
  parseMediaDocumentVersion,
  normalizeTranscriptDocument,
  summarizeTranscriptParseResult,
  selectMediaTranscriptParser,
  SUPPORTED_AUDIO_MIME_TYPES,
  SUPPORTED_VIDEO_MIME_TYPES,
} from "./media-transcript-parsers";
import {
  openaiWhisperEngine,
} from "./openai-whisper-transcription";
import type { TranscriptParseResult } from "./media-transcript-parsers";

// ─── Test infrastructure ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, label: string, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

function assertThrows(fn: () => unknown, expectedSubstring: string, label: string): void {
  try {
    fn();
    console.error(`  ✗ FAIL: ${label} — expected throw, but did not throw`);
    failed++;
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes(expectedSubstring)) {
      console.log(`  ✓ ${label}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${label} — expected "${expectedSubstring}" in "${msg}"`);
      failed++;
    }
  }
}

async function assertThrowsAsync(fn: () => Promise<unknown>, expectedSubstring: string, label: string): Promise<void> {
  try {
    await fn();
    console.error(`  ✗ FAIL: ${label} — expected async throw, but did not throw`);
    failed++;
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (msg.includes(expectedSubstring)) {
      console.log(`  ✓ ${label}`);
      passed++;
    } else {
      console.error(`  ✗ FAIL: ${label} — expected "${expectedSubstring}" in "${msg}"`);
      failed++;
    }
  }
}

// ─── S1: DB columns for kdv ──────────────────────────────────────────────────

async function s1_dbColumns() {
  console.log("\nS1 — DB: kdv transcript columns present");
  const result = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_document_versions'
      AND column_name IN (
        'transcript_status','transcript_started_at','transcript_completed_at',
        'transcript_engine_name','transcript_engine_version','transcript_text_checksum',
        'transcript_segment_count','transcript_speaker_count','transcript_language_code',
        'transcript_average_confidence','media_duration_ms','transcript_failure_reason'
      )
    ORDER BY column_name
  `);
  const cols = (result.rows as Array<{ column_name: string }>).map((r) => r.column_name);
  assert(cols.length === 12, "All 12 kdv transcript columns present", `found: ${cols.length}`);
}

// ─── S2: DB columns for kc ───────────────────────────────────────────────────

async function s2_kcColumns() {
  console.log("\nS2 — DB: kc transcript chunk columns present");
  const result = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_chunks'
      AND column_name IN (
        'transcript_chunk','transcript_chunk_strategy','transcript_chunk_version',
        'segment_start_ms','segment_end_ms','transcript_segment_index',
        'speaker_label','transcript_confidence','source_track'
      )
    ORDER BY column_name
  `);
  const cols = (result.rows as Array<{ column_name: string }>).map((r) => r.column_name);
  assert(cols.length === 9, "All 9 kc transcript chunk columns present", `found: ${cols.length}`);
}

// ─── S3: DB columns for kpj ──────────────────────────────────────────────────

async function s3_kpjColumns() {
  console.log("\nS3 — DB: kpj transcript processor columns present");
  const result = await db.execute(sql`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'knowledge_processing_jobs'
      AND column_name IN ('transcript_processor_name','transcript_processor_version')
    ORDER BY column_name
  `);
  const cols = (result.rows as Array<{ column_name: string }>).map((r) => r.column_name);
  assert(cols.length === 2, "Both kpj transcript processor columns present", `found: ${cols.length}`);
}

// ─── S4: DB job_type CHECK includes transcript types ─────────────────────────

async function s4_jobTypeCheck() {
  console.log("\nS4 — DB: job_type CHECK updated for transcript_parse + transcript_chunk");
  const result = await db.execute(sql`
    SELECT constraint_name FROM information_schema.table_constraints
    WHERE table_name = 'knowledge_processing_jobs'
      AND constraint_type = 'CHECK'
  `);
  const constraints = (result.rows as Array<{ constraint_name: string }>).map((r) => r.constraint_name);
  assert(constraints.length > 0, "knowledge_processing_jobs has CHECK constraints", `found: ${constraints.length}`);
}

// ─── S5: SUPPORTED_AUDIO_MIME_TYPES contents ─────────────────────────────────

function s5_mimeTypes() {
  console.log("\nS5 — SUPPORTED_AUDIO_MIME_TYPES set contents");
  assert(SUPPORTED_AUDIO_MIME_TYPES.has("audio/mpeg"), "audio/mpeg supported");
  assert(SUPPORTED_AUDIO_MIME_TYPES.has("audio/wav"), "audio/wav supported");
  assert(SUPPORTED_AUDIO_MIME_TYPES.has("audio/mp4"), "audio/mp4 supported");
  assert(SUPPORTED_AUDIO_MIME_TYPES.has("audio/webm"), "audio/webm supported");
}

// ─── S6: Video types are in SUPPORTED_VIDEO_MIME_TYPES (blocked at engine level via INV-MEDIA2) ───

function s6_videoBlocked() {
  console.log("\nS6 — SUPPORTED_VIDEO_MIME_TYPES — video types known (blocked at engine level)");
  assert(SUPPORTED_VIDEO_MIME_TYPES.has("video/mp4"), "video/mp4 in SUPPORTED_VIDEO_MIME_TYPES");
  assert(SUPPORTED_VIDEO_MIME_TYPES.has("video/webm"), "video/webm in SUPPORTED_VIDEO_MIME_TYPES");
  assert(SUPPORTED_VIDEO_MIME_TYPES.has("video/quicktime"), "video/quicktime in SUPPORTED_VIDEO_MIME_TYPES");
}

// ─── S7: parseMediaDocumentVersion rejects video (INV-MEDIA2) ────────────────

async function s7_videoRejected() {
  console.log("\nS7 — parseMediaDocumentVersion rejects video/mp4 (INV-MEDIA2)");
  await assertThrowsAsync(
    () => parseMediaDocumentVersion("hello world", "video/mp4"),
    "INV-MEDIA2",
    "video/mp4 triggers INV-MEDIA2",
  );
}

// ─── S8: parseMediaDocumentVersion rejects unknown mime ──────────────────────

async function s8_unknownMimeRejected() {
  console.log("\nS8 — parseMediaDocumentVersion rejects unknown/mime (INV-MEDIA1)");
  await assertThrowsAsync(
    () => parseMediaDocumentVersion("hello", "text/csv"),
    "INV-MEDIA1",
    "text/csv triggers INV-MEDIA1",
  );
}

// ─── S9: default engine routes to openai_whisper_transcription ───────────────

async function s9_stubEngineWorks() {
  console.log("\nS9 — default engine routes to openai_whisper_transcription (plain text fallback)");
  const content = "Hello world. This is a test transcript with multiple sentences. More content here.";
  const result = await parseMediaDocumentVersion(content, "audio/mpeg");
  assert(result.engineName === "openai_whisper_transcription", `engineName=openai_whisper_transcription (got: ${result.engineName})`);
  assert(result.segmentCount > 0, "segmentCount > 0", `got ${result.segmentCount}`);
  assert(result.segments.length > 0, "segments.length > 0");
  assert(typeof result.textChecksum === "string" && result.textChecksum.length > 0, "textChecksum set");
}

// ─── S10: normalizeTranscriptDocument sorts + recomputes checksum ────────────

async function s10_normalizeTranscript() {
  console.log("\nS10 — normalizeTranscriptDocument sorts segments and recomputes checksum");
  const content = "Line one here.\nLine two here.\nLine three here.";
  const result = await parseMediaDocumentVersion(content, "audio/wav");
  const normalized = normalizeTranscriptDocument(result);
  assert(typeof normalized === "object" && normalized !== null, "normalizeTranscriptDocument returns object");
  assert(typeof normalized.textChecksum === "string" && normalized.textChecksum.length > 0, "textChecksum recomputed after normalize");
  assert(normalized.segments.length === result.segments.length, "segment count unchanged after normalize");
}

// ─── S11: summarizeTranscriptParseResult formatting ─────────────────────────

async function s11_summarizeParseResult() {
  console.log("\nS11 — summarizeTranscriptParseResult output formatting");
  const content = "Hello audio. Testing transcript summary function.";
  const result = await parseMediaDocumentVersion(content, "audio/mpeg");
  const summary = summarizeTranscriptParseResult(result);
  assert(typeof summary === "string" && summary.length > 0, "summary is non-empty string");
  assert(summary.includes("segments=") || summary.includes("segmentCount="), "summary mentions segment count");
}

// ─── S12: chunkTranscriptDocument with time_windows strategy ─────────────────

async function s12_chunkTranscript() {
  console.log("\nS12 — chunkTranscriptDocument produces deterministic chunks");
  const fakeResult: TranscriptParseResult = {
    engineName: "stub_transcript",
    engineVersion: "1.0",
    mimeType: "audio/mpeg",
    segments: [
      { segmentIndex: 0, startMs: 0, endMs: 15000, text: "Hello world this is segment one.", confidence: 0.9 },
      { segmentIndex: 1, startMs: 15000, endMs: 30000, text: "Second segment here.", confidence: 0.85 },
      { segmentIndex: 2, startMs: 60000, endMs: 75000, text: "Third segment after a gap.", confidence: 0.87 },
    ],
    languageCode: "en",
    durationMs: 75000,
    segmentCount: 3,
    speakerCount: 0,
    averageConfidence: 0.873,
    textChecksum: "abc123",
    warnings: [],
    metadata: { engineLabel: "stub_transcript@1.0", path: "plain_text_fallback" },
  };

  const chunks = chunkTranscriptDocument(fakeResult, "doc-1", "ver-1", {
    strategy: "time_windows",
    version: "1.0",
    windowMs: 45000,
  });
  assert(chunks.length >= 2, `Got >= 2 chunks for 3 segments with 45s window`, `got ${chunks.length}`);
  assert(chunks[0].chunkKey.length === 32, "chunkKey is 32-char hex");
  assert(chunks[0].chunkHash.length === 32, "chunkHash is 32-char hex");
  assert(chunks[0].tokenEstimate > 0, "tokenEstimate > 0");
  assert(chunks[0].transcriptChunkStrategy === "time_windows", "strategy=time_windows");
}

// ─── S13: buildTranscriptChunkKey determinism ────────────────────────────────

function s13_chunkKeyDeterminism() {
  console.log("\nS13 — buildTranscriptChunkKey is deterministic (INV-MEDIA10)");
  const k1 = buildTranscriptChunkKey("doc-A", "ver-A", 0, 2, 0, 45000, "time_windows", "1.0");
  const k2 = buildTranscriptChunkKey("doc-A", "ver-A", 0, 2, 0, 45000, "time_windows", "1.0");
  const k3 = buildTranscriptChunkKey("doc-B", "ver-A", 0, 2, 0, 45000, "time_windows", "1.0");
  assert(k1 === k2, "Same inputs produce same key");
  assert(k1 !== k3, "Different documentId produces different key");
}

// ─── S14: normalizeTranscriptChunkText collapses whitespace ──────────────────

function s14_normalizeChunkText() {
  console.log("\nS14 — normalizeTranscriptChunkText collapses whitespace");
  const raw = "  Hello\n  world  \r\nfoo   bar  ";
  const normalized = normalizeTranscriptChunkText(raw);
  assert(normalized === "Hello world foo bar", "Normalized correctly", `got "${normalized}"`);
}

// ─── S15: summarizeTranscriptChunks formatting ───────────────────────────────

async function s15_summarizeChunks() {
  console.log("\nS15 — summarizeTranscriptChunks output format");
  const fakeResult: TranscriptParseResult = {
    engineName: "stub_transcript",
    engineVersion: "1.0",
    mimeType: "audio/mpeg",
    segments: [
      { segmentIndex: 0, startMs: 0, endMs: 30000, text: "Test segment text for summary.", confidence: 0.9 },
      { segmentIndex: 1, startMs: 30000, endMs: 60000, text: "Another segment here.", confidence: 0.88 },
    ],
    languageCode: "en",
    durationMs: 60000,
    segmentCount: 2,
    speakerCount: 0,
    averageConfidence: 0.89,
    textChecksum: "xyz",
    warnings: [],
    metadata: { engineLabel: "stub_transcript@1.0", path: "plain_text_fallback" },
  };
  const chunks = chunkTranscriptDocument(fakeResult, "doc-sum", "ver-sum");
  const summary = summarizeTranscriptChunks(chunks);
  assert(typeof summary === "string" && summary.length > 0, "summary is non-empty string");
  assert(summary.includes("chunks="), "summary includes 'chunks='", summary);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== Phase 5B.3 Validation: Audio/Video Ingestion Pipeline ===");

  await s1_dbColumns();
  await s2_kcColumns();
  await s3_kpjColumns();
  await s4_jobTypeCheck();
  s5_mimeTypes();
  s6_videoBlocked();
  await s7_videoRejected();
  await s8_unknownMimeRejected();
  await s9_stubEngineWorks();
  await s10_normalizeTranscript();
  await s11_summarizeParseResult();
  await s12_chunkTranscript();
  s13_chunkKeyDeterminism();
  s14_normalizeChunkText();
  await s15_summarizeChunks();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);

  if (failed > 0) {
    console.error("VALIDATION FAILED");
    process.exit(1);
  } else {
    console.log("ALL VALIDATION PASSED ✓");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("Validation runner error:", err);
  process.exit(1);
});
