/**
 * Gemini 2.5 Flash multimodal extraction for media files.
 *
 * Supports: application/pdf, image/*, audio/*, video/*
 *
 * WHY NO SDK:
 *   @google/generative-ai SDK's generateContent() and generateContentStream()
 *   both buffer the FULL HTTP response body before returning — causing 40-50s
 *   delays for large PDFs. PERF logs confirmed T7→T8 gap of ~38,000ms.
 *
 *   Solution: Direct REST fetch to Gemini API with SSE line-by-line parsing.
 *   fetch() returns as soon as HTTP headers arrive (~200ms), and we stream
 *   response body in real-time without any SDK buffering.
 *
 * Env resolution: GEMINI_API_KEY → GOOGLE_GENERATIVE_AI_API_KEY
 */

// ── Key resolution ─────────────────────────────────────────────────────────────

function getGeminiKey(): string {
  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? "";
}

export function isGeminiAvailable(): boolean {
  return getGeminiKey().length > 0;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_REST_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

// ── Result types ───────────────────────────────────────────────────────────────

export interface GeminiExtractionResult {
  text:       string;
  charCount:  number;
  model:      string;
  /** Estimated quality: 0.0–1.0 based on length heuristics. */
  quality:    number;
}

/**
 * Structured stream chunk emitted by extractWithGeminiStream().
 */
export interface OcrStreamChunk {
  /** Incremental text token from Gemini (may be a few chars or a sentence). */
  textDelta:  string;
  /** 0-based page index within the document (-1 for non-PDF/single-file). */
  pageIndex:  number;
  /** Monotonically-increasing sequence number, per-page from 0. */
  streamSeq:  number;
  /** Provider name — always "gemini" for this extractor. */
  provider:   "gemini";
  /** Model name used for this call. */
  model:      string;
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

// ── REST helpers ──────────────────────────────────────────────────────────────

/**
 * Build the Gemini REST request body for multimodal content.
 */
function buildRequestBody(base64data: string, mimeType: string, prompt: string): object {
  return {
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { data: base64data, mimeType } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      temperature:     0.1,
      maxOutputTokens: 8192,
      thinkingConfig: {
        thinkingBudget: 0,  // DISABLE thinking → fast TTFT
      },
    },
  };
}

/**
 * Parse a single Gemini SSE data line and extract the text delta.
 * Returns null if the line has no text content.
 */
function parseGeminiSseLine(raw: string): string | null {
  if (!raw || raw === "[DONE]") return null;
  try {
    const parsed = JSON.parse(raw) as {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
    };
    const parts = parsed.candidates?.[0]?.content?.parts;
    if (!parts) return null;
    return parts.map(p => p.text ?? "").join("") || null;
  } catch {
    return null;
  }
}

// ── Vision chat: multimodal streaming chat from base64 images ─────────────────

/**
 * Stream a Gemini multimodal chat response from base64 JPEG images.
 * Used for scanned PDF vision preview — answers ONLY from visible page images.
 *
 * @param systemPrompt Dedicated vision system prompt.
 * @param userMessage  User's question.
 * @param base64Images Array of base64-encoded JPEG images (page renders).
 * @yields             Text deltas streamed from Gemini.
 */
export async function* streamGeminiVisionChat(
  systemPrompt: string,
  userMessage:  string,
  base64Images: string[],
): AsyncGenerator<string> {
  const key = getGeminiKey();
  if (!key) {
    throw new Error("GEMINI_API_KEY is not configured — cannot run Gemini vision chat");
  }

  const imageParts = base64Images.map(b64 => ({
    inlineData: { data: b64, mimeType: "image/jpeg" },
  }));

  const requestBody = {
    system_instruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [
          ...imageParts,
          { text: userMessage },
        ],
      },
    ],
    generationConfig: {
      temperature:     0.2,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const VISION_MODEL = "gemini-2.0-flash";
  const url = `${GEMINI_REST_BASE}/${VISION_MODEL}:streamGenerateContent?alt=sse`;

  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Content-Type":   "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Gemini vision REST ${res.status}: ${errText}`);
  }

  const reader  = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const raw   = trimmed.slice(5).trim();
        const delta = parseGeminiSseLine(raw);
        if (delta) yield delta;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── PDF vision chat: native PDF inline data (no page rendering required) ──────

/**
 * Stream a Gemini chat response from a raw PDF buffer.
 * Sends the PDF as application/pdf inlineData — Gemini reads all pages natively.
 * Used server-side for scanned PDFs when vision_images are not in the request body.
 *
 * @param systemPrompt System instruction for the model.
 * @param userMessage  User's question.
 * @param pdfBuffer    Raw PDF bytes fetched from R2.
 * @yields             Text deltas streamed from Gemini.
 */
export async function* streamGeminiVisionChatFromPdf(
  systemPrompt: string,
  userMessage:  string,
  pdfBuffer:    Buffer,
): AsyncGenerator<string> {
  const key = getGeminiKey();
  if (!key) {
    throw new Error("GEMINI_API_KEY is not configured — cannot run Gemini PDF vision chat");
  }

  const base64data = pdfBuffer.toString("base64");

  const requestBody = {
    system_instruction: {
      parts: [{ text: systemPrompt }],
    },
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { data: base64data, mimeType: "application/pdf" } },
          { text: userMessage },
        ],
      },
    ],
    generationConfig: {
      temperature:     0.2,
      maxOutputTokens: 2048,
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const VISION_MODEL = "gemini-2.0-flash";
  const url = `${GEMINI_REST_BASE}/${VISION_MODEL}:streamGenerateContent?alt=sse`;

  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Content-Type":   "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify(requestBody),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Gemini PDF vision REST ${res.status}: ${errText}`);
  }

  const reader  = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const raw   = trimmed.slice(5).trim();
        const delta = parseGeminiSseLine(raw);
        if (delta) yield delta;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ── Main export: non-streaming (collects full text) ───────────────────────────

/**
 * Extract text/content from a file buffer using Gemini multimodal.
 * Uses streaming REST API internally for fast response, collects full text.
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

  const base64data = buffer.toString("base64");
  const prompt     = buildPrompt(mimeType, filename);
  const url        = `${GEMINI_REST_BASE}/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;

  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Content-Type":   "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify(buildRequestBody(base64data, mimeType, prompt)),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Gemini REST ${res.status}: ${errText}`);
  }

  // Collect full text from SSE stream
  const reader  = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let fullText  = "";

  const EMPTY_SIGNALS = ["[NO_TEXT_FOUND]", "[NO_SPEECH_FOUND]", "[NO_CONTENT_FOUND]"];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const raw = trimmed.slice(5).trim();
        const delta = parseGeminiSseLine(raw);
        if (delta) fullText += delta;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const raw = fullText.trim();
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
 * True streaming variant — yields structured OcrStreamChunk values
 * as Gemini produces them. Uses direct REST + SSE parsing (no SDK).
 *
 * @param buffer    Raw file bytes (single page recommended for lowest first-token latency).
 * @param filename  Original filename.
 * @param mimeType  MIME type string.
 * @param pageIndex 0-based page index within the document (-1 for non-paginated).
 * @yields OcrStreamChunk — incremental text delta + metadata. Never yields empty deltas.
 */
export async function* extractWithGeminiStream(
  buffer:    Buffer,
  filename:  string,
  mimeType:  string,
  pageIndex  = 0,
): AsyncGenerator<OcrStreamChunk> {
  const key = getGeminiKey();
  if (!key) {
    throw new Error("GEMINI_API_KEY is not configured — cannot run Gemini streaming OCR");
  }

  const base64data = buffer.toString("base64");
  const prompt     = buildPrompt(mimeType, filename);
  const url        = `${GEMINI_REST_BASE}/${GEMINI_MODEL}:streamGenerateContent?alt=sse`;

  // Direct fetch — returns immediately when HTTP headers arrive (no SDK buffering)
  const res = await fetch(url, {
    method:  "POST",
    headers: {
      "Content-Type":   "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify(buildRequestBody(base64data, mimeType, prompt)),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => res.statusText);
    throw new Error(`Gemini REST ${res.status}: ${errText}`);
  }

  const reader  = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let sseBuffer = "";
  let streamSeq = 0;

  const EMPTY_SIGNALS = ["[NO_TEXT_FOUND]", "[NO_SPEECH_FOUND]", "[NO_CONTENT_FOUND]"];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split("\n");
      sseBuffer = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const raw = trimmed.slice(5).trim();
        const delta = parseGeminiSseLine(raw);
        if (!delta || EMPTY_SIGNALS.includes(delta.trim())) continue;
        yield {
          textDelta: delta,
          pageIndex,
          streamSeq: streamSeq++,
          provider:  "gemini",
          model:     GEMINI_MODEL,
        };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
