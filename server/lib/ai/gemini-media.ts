/**
 * Gemini 2.5 Flash multimodal extraction for media files.
 *
 * Supports: application/pdf, image/*, audio/*, video/*
 * Runs synchronously — no async queue needed for typical documents.
 *
 * Quality: Gemini reads PDF bytes directly (including embedded text AND
 * renders scanned pages via Vision), so native and scanned PDFs both work.
 *
 * Env resolution: GEMINI_API_KEY → GOOGLE_GENERATIVE_AI_API_KEY
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

// ── Key resolution ─────────────────────────────────────────────────────────────

function getGeminiKey(): string {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "";
}

export function isGeminiAvailable(): boolean {
  return getGeminiKey().length > 0;
}

// ── Result type ────────────────────────────────────────────────────────────────

export interface GeminiExtractionResult {
  text:       string;
  charCount:  number;
  model:      string;
  /** Estimated quality: 0.0–1.0 based on length heuristics. */
  quality:    number;
}

// ── MIME grouping helpers ─────────────────────────────────────────────────────

function isImageMime(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

function isAudioMime(mimeType: string): boolean {
  return mimeType.startsWith("audio/");
}

function isVideoMime(mimeType: string): boolean {
  return mimeType.startsWith("video/");
}

function isPdfMime(mimeType: string, filename: string): boolean {
  return mimeType === "application/pdf" || filename.toLowerCase().endsWith(".pdf");
}

// ── Prompt selection ───────────────────────────────────────────────────────────

function buildPrompt(mimeType: string, filename: string): string {
  if (isPdfMime(mimeType, filename) || isImageMime(mimeType)) {
    return (
      "Extract all text from this document verbatim. " +
      "Preserve structure (headings, tables, lists, paragraphs). " +
      "If there is no readable text, return exactly: [NO_TEXT_FOUND]"
    );
  }
  if (isAudioMime(mimeType)) {
    return (
      "Transcribe all speech in this audio file. " +
      "Include speaker labels if multiple speakers are identifiable. " +
      "If the audio contains no speech, return exactly: [NO_SPEECH_FOUND]"
    );
  }
  if (isVideoMime(mimeType)) {
    return (
      "Transcribe all speech and describe any key visual content in this video. " +
      "Format as a structured transcript with timestamps if available. " +
      "If there is no speech or meaningful visual content, return exactly: [NO_CONTENT_FOUND]"
    );
  }
  return "Extract all text and meaningful content from this file verbatim.";
}

// ── Quality estimator ─────────────────────────────────────────────────────────

function estimateQuality(text: string): number {
  const len = text.trim().length;
  if (len === 0) return 0;
  if (len < 50)  return 0.3;
  if (len < 500) return 0.7;
  return 0.95;
}

// ── Main export ────────────────────────────────────────────────────────────────

const GEMINI_MODEL = "gemini-2.0-flash";

/**
 * Extract text/content from a file buffer using Gemini multimodal.
 *
 * @param buffer   Raw file bytes.
 * @param filename Original filename (used for MIME inference fallback).
 * @param mimeType MIME type string.
 * @throws Error if Gemini key is not configured or the API call fails.
 */
export async function extractWithGemini(
  buffer:   Buffer,
  filename: string,
  mimeType: string,
): Promise<GeminiExtractionResult> {
  const key = getGeminiKey();
  if (!key) {
    throw new Error("GEMINI_API_KEY is not configured — cannot run Gemini OCR");
  }

  const genAI = new GoogleGenerativeAI(key);
  const model = genAI.getGenerativeModel({ model: GEMINI_MODEL });

  const base64data = buffer.toString("base64");
  const prompt     = buildPrompt(mimeType, filename);

  const result = await model.generateContent([
    {
      inlineData: {
        data:     base64data,
        mimeType: mimeType,
      },
    },
    { text: prompt },
  ]);

  const raw = result.response.text()?.trim() ?? "";

  const EMPTY_SIGNALS = ["[NO_TEXT_FOUND]", "[NO_SPEECH_FOUND]", "[NO_CONTENT_FOUND]"];
  if (!raw || EMPTY_SIGNALS.includes(raw)) {
    return { text: "", charCount: 0, model: GEMINI_MODEL, quality: 0 };
  }

  const capped = raw.slice(0, 200_000);
  return {
    text:      capped,
    charCount: capped.length,
    model:     GEMINI_MODEL,
    quality:   estimateQuality(capped),
  };
}

/**
 * Streaming variant — yields text chunks as Gemini produces them.
 * Use for single-page buffers where partial tokens improve perceived latency.
 *
 * @param buffer   Raw file bytes (single page recommended for low first-token latency).
 * @param filename Original filename.
 * @param mimeType MIME type string.
 * @yields Partial text strings as they arrive from Gemini.
 */
export async function* extractWithGeminiStream(
  buffer:   Buffer,
  filename: string,
  mimeType: string,
): AsyncGenerator<string> {
  const key = getGeminiKey();
  if (!key) {
    throw new Error("GEMINI_API_KEY is not configured — cannot run Gemini streaming OCR");
  }

  const genAI      = new GoogleGenerativeAI(key);
  const model      = genAI.getGenerativeModel({ model: GEMINI_MODEL });
  const base64data = buffer.toString("base64");
  const prompt     = buildPrompt(mimeType, filename);

  const EMPTY_SIGNALS = ["[NO_TEXT_FOUND]", "[NO_SPEECH_FOUND]", "[NO_CONTENT_FOUND]"];

  const streamResult = await model.generateContentStream([
    { inlineData: { data: base64data, mimeType } },
    { text: prompt },
  ]);

  for await (const chunk of streamResult.stream) {
    const text = chunk.text()?.trim() ?? "";
    if (text && !EMPTY_SIGNALS.includes(text)) {
      yield text;
    }
  }
}
