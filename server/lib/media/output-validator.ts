// ============================================================
// PHASE 5Y.1 — Output Validation Layer
// output-validator.ts — Central validation for provider outputs
// ============================================================

import type { MediaType, PipelineType } from "./media-types.ts";

export type ValidateProcessingOutputInput = {
  mediaType: MediaType;
  pipelineType: PipelineType;
  stepType?: string;
  text?: string | null;
  rawProviderResponse?: unknown;
  metadata?: Record<string, unknown>;
};

export type OutputValidationResult = {
  isValid: boolean;
  failureCode?: string;
  failureCategory?: string;
  reason?: string;
  metrics: {
    textLength: number;
    wordCount: number;
    lineCount: number;
    uniqueWordRatio?: number;
    repeatedLineRatio?: number;
  };
};

// Known fake/simulated output patterns to reject
const SIMULATED_PATTERNS = [
  "Analysen er gennemført",
  "simulated",
  "placeholder",
  "Dette er en simuleret",
  "Mock OCR",
  "Test OCR",
];

export function validateProviderResponse(rawResponse: unknown): { isValid: boolean; failureCode?: string; reason?: string } {
  if (!rawResponse) {
    return { isValid: false, failureCode: "EMPTY_PROVIDER_RESPONSE", reason: "Provider response is null or undefined" };
  }

  // If it's a string, it might be a direct text return (like our current Gemini wrapper does)
  if (typeof rawResponse === "string") {
    if (rawResponse.trim().length === 0) {
      return { isValid: false, failureCode: "EMPTY_PROVIDER_RESPONSE", reason: "Provider returned empty string" };
    }
    return { isValid: true };
  }

  // If it's an object, do basic sanity checks
  if (typeof rawResponse === "object") {
    // This is a very basic check, as different providers have different structures.
    // Our current Gemini wrapper just returns the extracted string, so this is mostly for future-proofing
    // or if we change the wrapper to return the raw response.
    return { isValid: true };
  }

  return { isValid: false, failureCode: "MALFORMED_PROVIDER_RESPONSE", reason: "Provider response is of unknown type" };
}

export function validateOutput(input: ValidateProcessingOutputInput): OutputValidationResult {
  const text = input.text || "";
  const trimmedText = text.trim();
  
  const metrics = calculateMetrics(trimmedText);

  // 1. Empty check
  if (!trimmedText) {
    return {
      isValid: false,
      failureCode: "EMPTY_OUTPUT",
      failureCategory: "invalid_output",
      reason: "Extracted text is empty or whitespace only",
      metrics,
    };
  }

  // 2. Simulated/Placeholder detection
  const lowerText = trimmedText.toLowerCase();
  for (const pattern of SIMULATED_PATTERNS) {
    if (lowerText.includes(pattern.toLowerCase())) {
      return {
        isValid: false,
        failureCode: "SIMULATED_OUTPUT_DETECTED",
        failureCategory: "invalid_output",
        reason: `Detected simulated/placeholder pattern: "${pattern}"`,
        metrics,
      };
    }
  }

  // 3. Media-aware length and word count checks
  if (input.mediaType === "pdf" || input.pipelineType === "ocr") {
    // PDFs and OCR generally should have more than just a few characters
    if (metrics.textLength < 10) {
      return {
        isValid: false,
        failureCode: "OUTPUT_TOO_SHORT",
        failureCategory: "invalid_output",
        reason: `Output too short for ${input.mediaType}/${input.pipelineType} (${metrics.textLength} chars)`,
        metrics,
      };
    }
    // A valid document usually has at least a few words
    if (metrics.wordCount < 3) {
      return {
        isValid: false,
        failureCode: "INSUFFICIENT_WORD_COUNT",
        failureCategory: "invalid_output",
        reason: `Insufficient word count for ${input.mediaType}/${input.pipelineType} (${metrics.wordCount} words)`,
        metrics,
      };
    }
  } else if (input.mediaType === "image" || input.pipelineType === "vision") {
    // Images might just have a single word or short caption
    if (metrics.textLength < 2) {
      return {
        isValid: false,
        failureCode: "OUTPUT_TOO_SHORT",
        failureCategory: "invalid_output",
        reason: `Output too short for image/vision (${metrics.textLength} chars)`,
        metrics,
      };
    }
  }

  // 4. Junk / Repetition detection
  // If we have enough words to analyze
  if (metrics.wordCount > 20) {
    if (metrics.uniqueWordRatio !== undefined && metrics.uniqueWordRatio < 0.1) {
      return {
        isValid: false,
        failureCode: "JUNK_OUTPUT",
        failureCategory: "invalid_output",
        reason: `Extremely low unique word ratio (${metrics.uniqueWordRatio.toFixed(2)}), likely junk/repetition`,
        metrics,
      };
    }
  }

  if (metrics.lineCount > 5) {
    if (metrics.repeatedLineRatio !== undefined && metrics.repeatedLineRatio > 0.8) {
      return {
        isValid: false,
        failureCode: "JUNK_OUTPUT",
        failureCategory: "invalid_output",
        reason: `High repeated line ratio (${metrics.repeatedLineRatio.toFixed(2)}), likely junk/repetition`,
        metrics,
      };
    }
  }

  // Passed all checks
  return {
    isValid: true,
    metrics,
  };
}

function calculateMetrics(text: string) {
  const textLength = text.length;
  if (textLength === 0) {
    return { textLength: 0, wordCount: 0, lineCount: 0 };
  }

  const words = text.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  
  const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
  const lineCount = lines.length;

  let uniqueWordRatio: number | undefined;
  if (wordCount > 0) {
    const uniqueWords = new Set(words.map(w => w.toLowerCase()));
    uniqueWordRatio = uniqueWords.size / wordCount;
  }

  let repeatedLineRatio: number | undefined;
  if (lineCount > 0) {
    const lineCounts = new Map<string, number>();
    let maxRepeats = 0;
    for (const line of lines) {
      const normalized = line.trim().toLowerCase();
      const count = (lineCounts.get(normalized) || 0) + 1;
      lineCounts.set(normalized, count);
      if (count > maxRepeats) maxRepeats = count;
    }
    // If the most common line appears many times, calculate ratio
    // For simplicity, we just look at the most repeated line's ratio
    repeatedLineRatio = maxRepeats / lineCount;
  }

  return {
    textLength,
    wordCount,
    lineCount,
    uniqueWordRatio,
    repeatedLineRatio,
  };
}
