/**
 * partial-text-readiness.ts — Deterministic policy for minimum usable OCR text.
 *
 * PHASE 5Z.5 — Guards against triggering answers from microscopic/noisy fragments.
 * Pure function — no DB access, no side effects.
 *
 * Rules (deterministic, testable):
 *  - MIN_NON_WS_CHARS characters of non-whitespace required for usability
 *  - MIN_WORDS words required (space-split) for semantic usefulness
 *  - Pages after the first have a lower threshold (context already established)
 *  - Quality score ∈ [0..1] can be used to rank competing partial answers
 */

// ── Thresholds ────────────────────────────────────────────────────────────────

/** Minimum non-whitespace characters for a text fragment to be usable. */
export const MIN_NON_WS_CHARS = 150;

/** Minimum word count for a text fragment to be usable. */
export const MIN_WORDS = 20;

/**
 * Lower threshold for pages after the first (context already exists).
 * Allows refinement from even a small improvement on subsequent pages.
 */
export const MIN_NON_WS_CHARS_SUBSEQUENT = 80;
export const MIN_WORDS_SUBSEQUENT        = 10;

// ── Result type ───────────────────────────────────────────────────────────────

export interface PartialReadinessResult {
  usable:         boolean;
  nonWsChars:     number;
  wordCount:      number;
  qualityScore:   number;
  failReason:     string | null;
}

// ── Core policy ───────────────────────────────────────────────────────────────

/**
 * Returns true if the given text fragment has enough content to serve
 * as a basis for an early partial AI answer.
 *
 * @param text       OCR text fragment (may be partial/streaming)
 * @param pageIndex  0-based page index (0 = first page, higher = subsequent)
 */
export function isPartialTextUsable(text: string, pageIndex = 0): boolean {
  return evaluatePartialReadiness(text, pageIndex).usable;
}

/**
 * Full evaluation — returns usability result plus diagnostic fields.
 */
export function evaluatePartialReadiness(
  text:      string,
  pageIndex = 0,
): PartialReadinessResult {
  const nonWsChars = text.replace(/\s+/g, "").length;
  const words      = text.trim().split(/\s+/).filter(Boolean).length;

  const minNonWs = pageIndex === 0 ? MIN_NON_WS_CHARS : MIN_NON_WS_CHARS_SUBSEQUENT;
  const minWords = pageIndex === 0 ? MIN_WORDS        : MIN_WORDS_SUBSEQUENT;

  if (nonWsChars < minNonWs) {
    return {
      usable:       false,
      nonWsChars,
      wordCount:    words,
      qualityScore: 0,
      failReason:   `nonWsChars=${nonWsChars} < required=${minNonWs}`,
    };
  }

  if (words < minWords) {
    return {
      usable:       false,
      nonWsChars,
      wordCount:    words,
      qualityScore: 0,
      failReason:   `wordCount=${words} < required=${minWords}`,
    };
  }

  const qualityScore = computeQualityScore(nonWsChars, words);
  return { usable: true, nonWsChars, wordCount: words, qualityScore, failReason: null };
}

// ── Quality score ─────────────────────────────────────────────────────────────

/**
 * Returns a quality score [0..1] for ranking competing partial answers.
 * Higher is better.
 */
export function computeQualityScore(nonWsChars: number, wordCount: number): number {
  if (nonWsChars === 0) return 0;
  if (nonWsChars <  150) return 0.2;
  if (nonWsChars <  500) return 0.4;
  if (nonWsChars < 2000) return 0.65;
  if (nonWsChars < 5000) return 0.8;
  return 0.95;
}
