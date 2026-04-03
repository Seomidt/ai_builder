/**
 * partial-safeguard.ts
 *
 * Server-side deterministic safety layer for partial-OCR answers.
 *
 * ARCHITECTURE CONTRACT:
 *  - Called BEFORE any text is sent to the client
 *  - Runs on the FULL generated buffer, never on token-by-token output
 *  - In partial mode: generate → safeguard → emit (never emit → safeguard)
 *  - In complete mode: not called at all
 *
 * DETECTION STRATEGY:
 *  Intent-based, not phrase-specific.
 *  We match the SEMANTIC INTENT of "this information is absent from the full document",
 *  which is an invalid claim when only partial text has been extracted.
 *
 *  Patterns are grouped by communicative intent:
 *   A. Cannot-find claims        ("kan ikke finde", "finder ingen", …)
 *   B. Absence-in-document       ("fremgår ikke", "indeholder ikke", …)
 *   C. Not-mentioned/described   ("nævnes ikke", "ikke nævnt", …)
 *   D. No-information claims     ("ingen information", "ingen oplysninger", …)
 *   E. Denial of existence       ("eksisterer ikke i", "er ikke at finde", …)
 *   F. English fallbacks         (model occasionally code-switches)
 */

export const PARTIAL_NEGATIVE_PATTERNS: readonly RegExp[] = [
  // ── A. Cannot-find claims ────────────────────────────────────────────────
  /kan ikke finde/i,
  /\bfinder\s+(?:ingen|ikke)\b/i,
  /\b(?:ikke|ej)\s+(?:at\s+)?finde\b/i,
  /\bkunne\s+(?:ikke|heller\s+ikke)\s+finde\b/i,
  /\bsøgte?\s+(?:men\s+)?(?:ikke|forgæves)\b/i,

  // ── B. Absence-in-document claims ────────────────────────────────────────
  /fremgår\s+ikke/i,
  /fremkommer\s+ikke/i,
  /optræder\s+ikke/i,
  /forekommer\s+ikke\b/i,
  // "ingenting/intet fremgår..." or "ingenting ... dokument"
  /\b(?:ingenting|intet)\s+(?:herom\s+)?fremgår\b/i,
  /\b(?:ingenting|intet)\b.{0,80}\bdokument(?:et|en|s)?\b/i,
  /(?:dokumentet|teksten|filen)\s+(?:indeholder|nævner|omtaler|beskriver|angiver|oplyser)\s+ikke/i,
  /(?:indeholder|nævner|omtaler|beskriver|angiver|oplyser)\s+ikke.{0,60}(?:dokumentet|teksten|filen)/i,
  /ikke\s+(?:tilstede|til\s+stede)\s+i\s+(?:dokumentet|teksten)/i,
  /(?:dokumentet|teksten)\s+(?:har|indeholder)\s+ingen/i,

  // ── C. Not-mentioned / not-described ─────────────────────────────────────
  /(?:ikke|aldrig)\s+(?:nævnt|nævnes|omtalt|omtales|beskrevet|beskrives|angivet|angives|oplyst|oplyses)\b/i,
  /\b(?:nævnes|omtales|beskrives|angives|oplyses)\s+(?:heller\s+)?ikke\b/i,
  /(?:ingen|intet)\s+(?:nævnelse|omtale|beskrivelse|angivelse)\b/i,

  // ── D. No-information claims ──────────────────────────────────────────────
  /ingen\s+(?:information|oplysninger|data|detaljer|indhold)\b/i,
  /\b(?:mangler|savner)\s+(?:information|oplysninger|data)\b/i,
  /\b(?:ikke\s+nok|utilstrækkelig)\s+information\b/i,

  // ── E. Denial of existence ────────────────────────────────────────────────
  /\beksisterer\s+ikke\b/i,
  /\bfindes\s+ikke\s+i\b/i,
  /\ber\s+ikke\s+(?:at\s+finde|tilgængelig(?:t)?)\s+i\b/i,
  /\bingensteds\b/i,

  // ── F. English fallbacks ──────────────────────────────────────────────────
  /\bcannot\s+find\b/i,
  /\b(?:is\s+)?not\s+(?:mentioned|described|found|present)\s+in\s+(?:the\s+)?document/i,
  /\bdocument\s+does\s+not\s+(?:contain|mention|include)\b/i,
  /\bno\s+(?:information|data|mention)\s+(?:about|regarding|in\s+the\s+document)\b/i,
] as const;

/** Canonical provisional response for partial-mode rewrite */
export const PARTIAL_PROVISIONAL_ANSWER =
  "Jeg har kun analyseret den første del af dokumentet indtil videre.\n\n" +
  "Jeg kan endnu ikke afgøre det endeligt — svaret kan fremgå af den resterende del, " +
  "som stadig behandles.\n\n" +
  "⏳ Svaret opdateres automatisk, når hele dokumentet er analyseret.";

/**
 * Returns true if `text` contains a definitive absence/negative claim
 * that is invalid to make when the document is only partially extracted.
 */
export function isDefinitiveNegative(text: string): boolean {
  return PARTIAL_NEGATIVE_PATTERNS.some(p => p.test(text));
}

/**
 * If `text` is a definitive negative, returns the canonical provisional answer.
 * Otherwise returns `text` unchanged.
 *
 * Must be called on the FULL generated buffer, before any bytes are sent to the client.
 */
export function applyPartialSafeguard(text: string): string {
  if (!text?.trim()) return text;
  if (isDefinitiveNegative(text)) {
    return PARTIAL_PROVISIONAL_ANSWER;
  }
  return text;
}
