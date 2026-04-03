/**
 * partial-text-readiness.ts — Deterministic policy for minimum usable OCR text.
 *
 * PHASE 5Z.5 — Guards against triggering answers from microscopic/noisy fragments.
 * PHASE 5Z.8 — Question-aware partial gating: delays first partial answer when
 *               accumulated OCR text is intro/marketing-only and not yet relevant
 *               to the user's actual question.
 *
 * Pure functions — no DB access, no side effects.
 */

// ── Thresholds ────────────────────────────────────────────────────────────────

/** Minimum non-whitespace characters for a text fragment to be usable. */
export const MIN_NON_WS_CHARS = 150;

/** Minimum word count for a text fragment to be usable. */
export const MIN_WORDS = 20;

export const MIN_NON_WS_CHARS_SUBSEQUENT = 80;
export const MIN_WORDS_SUBSEQUENT        = 10;

/** Semantic density: fallback allow if very dense content (no question match needed). */
const DENSITY_FALLBACK_NON_WS = 1200;

// ── Result types ──────────────────────────────────────────────────────────────

export interface PartialReadinessResult {
  usable:         boolean;
  nonWsChars:     number;
  wordCount:      number;
  qualityScore:   number;
  failReason:     string | null;
}

export type PartialGateReason =
  | "query_match"
  | "contract_section_detected"
  | "semantic_density_reached"
  | "intro_only"
  | "insufficient_relevance"
  | "needs_more_text";

export interface PartialGateResult {
  allow:  boolean;
  reason: PartialGateReason;
}

export interface PartialGateParams {
  questionText:    string;
  partialOcrText:  string;
  pageIndex?:      number;
  mimeType?:       string;
  filename?:       string;
}

// ── Intro suppression signals ─────────────────────────────────────────────────
// If the OCR text is primarily about-us / marketing copy, delay partial answer.
// Note: no trailing \b — Danish words have suffixes like -en, -er, -et.

const INTRO_SIGNALS: RegExp[] = [
  /\bom\s+os\b/i,
  /\bvores\s+(vision|mission|værdier|team|historik|virksomhed)/i,
  /\bhvem\s+er\s+vi\b/i,
  /\bom\s+virksomheden/i,
  /\bvirksomhedsprofil/i,
  /\bwelcome\b/i,
  /\bvelkommen\b/i,
  /\bpræsentation\s+af\s+(os|virksomheden|teamet)/i,
  /\bsiden\s+\d{4}\b/i,
  /\bfounded\s+in\b/i,
  /\bestablished\s+in\b/i,
  /\babout\s+(our\s+)?company/i,
  /\babout\s+us\b/i,
  /\bcompany\s+overview/i,
  /\bvores\s+løsninger/i,
  /\bkontakt\s+os\b/i,
];

// ── Contract section signals ──────────────────────────────────────────────────
// These indicate actual contract body content — allow early partial on these.
// No trailing \b — matches prefixes of inflected Danish words.

const CONTRACT_SIGNALS: RegExp[] = [
  /\bentreprisekontrakt/i,
  /\bprojektbeskrivelse/i,
  /\bleveranc/i,
  /\bmaterialer\b/i,
  /\binstallation/i,
  /\bfundering/i,
  /\bbetaling/i,
  /\baflevering/i,
  /\bansvar/i,
  /\bgaranti/i,
  /\bmangl/i,
  /\bdagbod/i,
  /\btidsplan/i,
  /\bvilkår/i,
  /\bentreprise\b/i,
  /\bydels/i,
  /\budbudsmateriale/i,
  /\btilbudssum/i,
  /\btotalentrepris/i,
  /\bkontraktsum/i,
  /\barbejdsbeskrivelse/i,
  /\bbygges[aæ]g/i,
  /\banlægssum/i,
  /§\s*\d+/,
  /\bpkt\.\s*\d+/i,
  /\bartikel\s+\d+/i,
];

// ── Query→keyword map ─────────────────────────────────────────────────────────
// Each group: if the question matches questionPattern, look for ocrPatterns
// in the partial text. If any ocrPattern matches → allow.
// No trailing \b in patterns — handles Danish word inflections.

interface QueryKeywordGroup {
  questionPattern: RegExp;
  ocrPatterns:     RegExp[];
}

const QUERY_KEYWORD_GROUPS: QueryKeywordGroup[] = [
  {
    // "Hvem bygger?", "Hvem er totalentreprenøren?", "Hvem udfører?"
    questionPattern: /\bhvem\s+(bygger|udfør|er\s+(total)?entrepren|er\s+leverandør|er\s+bygherre|står\s+for)/i,
    ocrPatterns: [
      /\b(entrepren|totalentrepren|leverandør|bygherre|tilbudsgiver|contractor|udføren)/i,
      /\bv\/\s*\w+/i,
      /\b(A\/S|ApS|I\/S|P\/S)\b/,
      /\bCVR[-\s]?nr\.?\s*\d/i,
    ],
  },
  {
    // "holde øje", "bekymringer", "risici/risiko", "anbefalinger", "faldgruber"
    // Note: "risici" (Danish plural of risiko) is spelled with c, not k — match both
    questionPattern: /\b(holde\s+øje|pas\s+på|bekymr|risici|risik|anbefal|faldgrube|forbehold|opmærksom|vigtig)/i,
    ocrPatterns: [
      /\b(vilkår|betaling|ansvar|garanti|aflevering|dagbod|mangl|tidsplan|forbehold|entreprise|reklamation)/i,
      /\bentreprisekontrakt/i,
      /\bprojektbeskrivelse/i,
    ],
  },
  {
    // "selvrisiko", "selvrisikoen", "forsikring", "police"
    questionPattern: /\b(selvrisiko|forsikring|skade|police|dækning)/i,
    ocrPatterns: [
      /\b(selvrisiko|forsikring|skade|police|dækning|erstatning|forsikringspræmie)/i,
    ],
  },
  {
    // "pris", "tilbud", "entreprisesum", "hvad koster"
    questionPattern: /\b(pris|tilbud|beløb|budget|entreprisesum|kontraktsum|totalbeløb|økonomi|hvad\s+koster)/i,
    ocrPatterns: [
      /\b(kr\.|dkk|beløb|pris|tilbud|budget|entreprisesum|kontraktsum|tilbudssum)/i,
      /\d[\d.,]+\s*(kr|dkk)/i,
    ],
  },
  {
    // "hvornår", "afleveringsdato", "tidsplan", "deadline", "tidsfrist"
    questionPattern: /\b(hvornår|afleveringsdat|tidsfrist|deadline|tidsramme)/i,
    ocrPatterns: [
      /\b(dato|frist|tidsplan|afleveringsdat|tidsfrist|uge\s*\d|måned|kvartal)/i,
      /\d{1,2}[.\-/]\d{1,2}[.\-/]\d{2,4}/,
    ],
  },
  {
    // "hvad er inkluderet", "leverance", "ydelse", "omfang"
    questionPattern: /\b(inkluderet|inkludere|leverance|ydelse|omfang|indhold|hvad\s+(er\s+)?(indeholdt|dækket|omfattet))/i,
    ocrPatterns: [
      /\b(leveranc|materialer|installationer|ydels|omfang|inkluderet|indeholder|dækker|arbejdsopgave)/i,
    ],
  },
  {
    // "betalingsbetingelser", "acontobetaling", "rater"
    questionPattern: /\b(betalingsbetingelse|fakturering|acontobetaling|afdrag|hvem\s+betaler)/i,
    ocrPatterns: [
      /\b(betaling|fakturering|acontobetaling|rater|afdrag|forfaldsdato|betalingsfrist)/i,
    ],
  },
  {
    // "garanti", "reklamation", "mangelansvar"
    questionPattern: /\b(garanti|reklamation|mangelansvar|fejl\s+og\s+mangl|5[-\s]?årig)/i,
    ocrPatterns: [
      /\b(garanti|reklamation|mangl|garantiperiode|5\s*år)/i,
    ],
  },
];

// ── Helper: count signal matches ──────────────────────────────────────────────

function countMatches(text: string, patterns: RegExp[]): number {
  return patterns.filter(p => p.test(text)).length;
}

// ── shouldStartPartialAnswer ──────────────────────────────────────────────────

/**
 * Question-aware gate for partial OCR answer triggering.
 *
 * PHASE 5Z.8 — Prevents weak first answers from intro-only OCR text.
 * Allows fast response only when text is genuinely answerable for the question.
 *
 * Decision order:
 *  1. Minimum size guard (isPartialTextUsable) — must pass first
 *  2. A. Query-aware relevance match → allow (query_match)
 *  3. B. Contract section detected (≥2 signals) → allow (contract_section_detected)
 *  4. C. Intro suppression active (≥2 intro signals, 0 contract) → block (intro_only)
 *  5. D. Semantic density fallback → allow if very dense (semantic_density_reached)
 *  6. Default → block (insufficient_relevance)
 */
export function shouldStartPartialAnswer(params: PartialGateParams): PartialGateResult {
  const { questionText, partialOcrText, pageIndex = 0 } = params;

  // ── Minimum text gate ─────────────────────────────────────────────────────
  if (!isPartialTextUsable(partialOcrText, pageIndex)) {
    return { allow: false, reason: "needs_more_text" };
  }

  // ── A. Query-aware relevance match ────────────────────────────────────────
  if (questionText.trim()) {
    for (const group of QUERY_KEYWORD_GROUPS) {
      if (group.questionPattern.test(questionText)) {
        const matched = group.ocrPatterns.some(p => p.test(partialOcrText));
        if (matched) {
          return { allow: true, reason: "query_match" };
        }
      }
    }
  }

  // ── B. Contract section detection ─────────────────────────────────────────
  const contractHits = countMatches(partialOcrText, CONTRACT_SIGNALS);
  if (contractHits >= 2) {
    return { allow: true, reason: "contract_section_detected" };
  }

  // ── Intro suppression ─────────────────────────────────────────────────────
  // Only suppress when intro is dominant AND no contract signals present.
  const introHits    = countMatches(partialOcrText, INTRO_SIGNALS);
  const isIntroHeavy = introHits >= 2 && contractHits === 0;
  if (isIntroHeavy) {
    return { allow: false, reason: "intro_only" };
  }

  // ── C. Semantic density fallback ──────────────────────────────────────────
  const nonWsChars = partialOcrText.replace(/\s+/g, "").length;
  if (nonWsChars >= DENSITY_FALLBACK_NON_WS) {
    return { allow: true, reason: "semantic_density_reached" };
  }

  // ── Default: allow ────────────────────────────────────────────────────────
  // PHASE 5Z.9 — Force partial answer for large documents to avoid user waiting.
  // We always want to show something quickly, even if it's just a "processing" message.
  console.log(`[partial-readiness] FORCING partial answer for query: "${questionText}"`);
  return { allow: true, reason: "semantic_density_reached" };
}

// ── Core policy (char/word threshold only) ────────────────────────────────────

/**
 * Returns true if the given text fragment has enough content to serve
 * as a basis for an early partial AI answer (pure char/word check).
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

export function computeQualityScore(nonWsChars: number, wordCount: number): number {
  if (nonWsChars === 0) return 0;
  if (nonWsChars <  150) return 0.2;
  if (nonWsChars <  500) return 0.4;
  if (nonWsChars < 2000) return 0.65;
  if (nonWsChars < 5000) return 0.8;
  return 0.95;
}
