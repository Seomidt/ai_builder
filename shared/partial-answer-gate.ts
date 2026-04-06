/**
 * Partial Answer Readiness Gate
 *
 * Determines whether a partial_ready OCR text is sufficiently relevant to
 * the user's question to warrant generating an early provisional answer.
 *
 * Design goals:
 *  - Deterministic (no AI calls, no async) — safe to run in browser
 *  - Fast (string operations only)
 *  - Conservative: false positives (wrong block) are preferable to
 *    false negatives (wrong provisional shown)
 *
 * Called when `partial_ready` fires in the SSE/polling OCR flow,
 * before the first chat mutation is dispatched.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PartialAnswerGateInput {
  questionText:   string;
  partialOcrText: string;
  filename?:      string;
  mimeType?:      string;
}

export interface PartialAnswerGateResult {
  allowed: boolean;
  reason:  string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Minimum number of characters the partial OCR text must contain.
 * 1 200 chars ≈ 180-240 words — allows earlier provisional answers for large
 * OCR jobs while still filtering very short/noisy fragments. Texts smaller than this (cover pages,
 * short introductions, first-page only) are blocked and the system waits for
 * the completed OCR instead.
 */
const MIN_TEXT_CHARS = 1_200;

/**
 * Intro/cover-page signals.
 * These indicate the partial text is from a non-substantive front page
 * (company cover, welcome text, table of contents, etc.) that is unlikely
 * to contain the information needed to answer the user's question.
 */
const INTRO_SIGNALS: RegExp[] = [
  /\bvelkommen\b/i,
  /\bom os\b/i,
  /\bvores (løsning|virksomhed|erfaring|mission|vision|værdier|kultur)\b/i,
  /\bpræsentation af\b/i,
  /\bkernekompetence[r]?\b/i,
  /\bvision\b.*\bmission\b/i,
  /\bindholdsfortegnelse\b/i,
  /\bforside\b/i,
  /\bhvem er vi\b/i,
  /\bvi er en\b/i,
  /\bvi tilbyder\b/i,
  /\bkontaktoplysninger?\b/i,
  /\bvirksomhedsprofil\b/i,
  /\bom virksomheden\b/i,
  /\bvores kerneydelse\b/i,
  /\bkvalitets(politik|ledelse|certificering)\b/i,
  /\biso\s*9001\b/i,
  /\bmiljøpolitik\b/i,
  /\bmiljøcertificering\b/i,
];

/** Minimum number of distinct intro signals required to trigger suppression. */
const INTRO_SUPPRESS_THRESHOLD = 3;

/**
 * Question topic detection + required OCR text signals.
 *
 * If a question is detected to be about a topic, the partial OCR text
 * must contain at least one of the OCR signals for that topic.
 */
type QuestionTopic = "price" | "builder" | "risk" | "timeline" | "scope";

const QUESTION_TOPIC_TRIGGERS: Record<QuestionTopic, RegExp[]> = {
  price: [
    /\bpris\b/i,
    /\bpriserne?\b/i,
    /\bomkostning[er]?\b/i,
    /\bbudget\b/i,
    /\btilbudssum\b/i,
    /\bkontraktsum\b/i,
    /\bentreprisesum\b/i,
    /\bhvor (meget|dyr|billig)\b/i,
    /\bbetalingsbetingelse[r]?\b/i,
    /\bhonorare?\b/i,
    /\bkr\.?\s*[\d.,]/i,
  ],
  builder: [
    /\bhvem (bygger|er|udfører|leverer)\b/i,
    /\bbygherre\b/i,
    /\bentreprenør\b/i,
    /\btotalentreprenør\b/i,
    /\bleverandør\b/i,
    /\bhåndværker\b/i,
    /\brådgiver\b/i,
    /\bunderentreprenør\b/i,
    /\bfirma\b/i,
  ],
  risk: [
    /\brisiko\b/i,
    /\bdagbod\b/i,
    /\bforsinkelse[r]?\b/i,
    /\bansvar(lighed)?\b/i,
    /\bgaranti\b/i,
    /\bmangel[r]?\b/i,
    /\bselvrisiko\b/i,
    /\berstatning\b/i,
    /\bbod\b/i,
    /\bvilkår\b/i,
    /\bbetingelse[r]?\b/i,
  ],
  timeline: [
    /\bfrist[er]?\b/i,
    /\btidsfrist\b/i,
    /\baflevering\b/i,
    /\blevering\b/i,
    /\btidsplan\b/i,
    /\bhvornår\b/i,
    /\bdeadline\b/i,
    /\bfærdig\b/i,
  ],
  scope: [
    /\bomfang\b/i,
    /\barbejde[r]?\b/i,
    /\bydelse[r]?\b/i,
    /\bleverance[r]?\b/i,
    /\binkludere[dt]?\b/i,
    /\bekskludere[dt]?\b/i,
    /\bspecifikation\b/i,
  ],
};

const OCR_TOPIC_SIGNALS: Record<QuestionTopic, RegExp[]> = {
  price: [
    /\bkr\.?\s*[\d.,]{2,}/i,
    /[\d.,]{4,}\s*kr\b/i,
    /\bentreprisesum\b/i,
    /\bkontraktsum\b/i,
    /\btilbudssum\b/i,
    /\baftalesum\b/i,
    /\bbudget\b/i,
    /\bfaktura\b/i,
    /\bbetalingsbetingelse[r]?\b/i,
    /\bøkonomisk\b/i,
    /\bpris(liste|oversigt|regulering)?\b/i,
  ],
  builder: [
    /\btotalentreprenør\b/i,
    /\bentreprenør\b/i,
    /\beverandør\b/i,
    /\bbygherre\b/i,
    /\bcvr[\s\-\.nr]*\d{8}/i,
    /\ba\/s\b/i,
    /\baps\b/i,
    /\bi\/s\b/i,
    /\brådgiver\b/i,
    /\bunderentreprenør\b/i,
  ],
  risk: [
    /\bdagbod\b/i,
    /\bforsinkelsesansvar\b/i,
    /\bansvarsbegrænsning\b/i,
    /\bgarantiperiode?\b/i,
    /\bmangelansvar\b/i,
    /\bselvrisiko\b/i,
    /\berstatning\b/i,
    /\bforsikring\b/i,
    /\bbetaler\b.*\bdagbod\b/i,
  ],
  timeline: [
    /\bafleverings(dato|frist)\b/i,
    /\baftalte?\s+frist\b/i,
    /\b20\d{2}\b/,
    /\bdag(?:e|en|enes)\b.*\bfrist\b/i,
    /\btidsplan\b/i,
    /\bbyggeperiode\b/i,
  ],
  scope: [
    /\bydelsesomfang\b/i,
    /\bydelsesbeskrivelse\b/i,
    /\bteknisk\s+beskrivelse\b/i,
    /\bspecifikation\b/i,
    /\bomfatter\b/i,
    /\binkludere[dt]\b/i,
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countIntroSignals(text: string): number {
  return INTRO_SIGNALS.filter(p => p.test(text)).length;
}

function detectTopics(question: string): QuestionTopic[] {
  return (Object.keys(QUESTION_TOPIC_TRIGGERS) as QuestionTopic[]).filter(topic =>
    QUESTION_TOPIC_TRIGGERS[topic].some(p => p.test(question)),
  );
}

function hasTopicSignals(topic: QuestionTopic, ocrText: string): boolean {
  return OCR_TOPIC_SIGNALS[topic].some(p => p.test(ocrText));
}

// ─── Main gate function ───────────────────────────────────────────────────────

/**
 * Determines whether to generate an early provisional answer from partial OCR text.
 *
 * Returns `{ allowed: true }` if the partial answer should proceed,
 * or `{ allowed: false, reason: string }` if it should be suppressed
 * (keep waiting for completed OCR instead).
 */
export function shouldStartPartialAnswer(input: PartialAnswerGateInput): PartialAnswerGateResult {
  const { questionText, partialOcrText } = input;

  // 1. Minimum text length
  if (partialOcrText.trim().length < MIN_TEXT_CHARS) {
    return { allowed: false, reason: "text_too_short" };
  }

  // 2. Intro/cover-page suppression
  // If the partial text contains many intro/marketing signals, it is likely
  // from a non-substantive cover page — not useful for answering questions.
  const introHits = countIntroSignals(partialOcrText);
  if (introHits >= INTRO_SUPPRESS_THRESHOLD) {
    return { allowed: false, reason: `intro_content(${introHits}_signals)` };
  }

  // 3. Question-topic relevance gate
  // If the question has a detectable topic, the partial OCR text must contain
  // signals suggesting that topic's information is present in the text.
  const topics = detectTopics(questionText);
  if (topics.length > 0) {
    const relevantTopic = topics.find(topic => hasTopicSignals(topic, partialOcrText));
    if (!relevantTopic) {
      // Fail-open for long partial OCR snippets: even when topic signals are not
      // matched exactly, a substantial partial often still contains enough context
      // for a useful provisional answer.
      if (partialOcrText.trim().length >= 2_500) {
        return { allowed: true, reason: "long_partial_fallback" };
      }
      return {
        allowed: false,
        reason: `no_ocr_signals_for_topics:${topics.join(",")}`,
      };
    }
  }

  // All checks passed — partial answer is relevant and useful
  return { allowed: true, reason: "ok" };
}
