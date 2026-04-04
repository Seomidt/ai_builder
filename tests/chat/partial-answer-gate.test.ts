import { describe, it, expect } from "vitest";
import { shouldStartPartialAnswer } from "../../shared/partial-answer-gate";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Pads `base` by repeating it until the total length is >= MIN_TEXT_CHARS (4 000).
 * Required because the gate now requires substantial OCR text to avoid triggering
 * provisional answers from short cover pages.
 */
function pad(base: string): string {
  const target = 4_100;
  let result = base;
  while (result.length < target) result += "\n" + base;
  return result;
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** Realistic intro/front-page OCR text — company cover, TOC, welcome language. */
const INTRO_TEXT_SHORT = `
Velkomst og præsentation af vores virksomhed
Hvem er vi: Vi er en erfaren entreprisevirksomhed med fokus på kvalitet.
Vores vision og mission er at levere de bedste løsninger til markedet.
Vi tilbyder et bredt spektrum af ydelser inden for byggeri og anlæg.
Om virksomheden: Grundlagt i 1987, ISO 9001 certificeret, miljøpolitik godkendt.
Indholdsfortegnelse:
  1. Introduktion
  2. Projektbeskrivelse
  3. Økonomi
Kernekompetencer og organisation: Vi har over 200 ansatte fordelt på tværs af landet.
Kontaktoplysninger: info@byggefirma.dk, tlf. 88 88 88 88
`.trim();

/** Padded to >= 4 000 chars — still contains intro signals so intro_content fires. */
const INTRO_TEXT = pad(INTRO_TEXT_SHORT);

/** Realistic contract section OCR text — with price, builder, risk, etc. */
const CONTRACT_PRICE_TEXT_SHORT = `
Entrepriseaftale — Totalentreprise
Entreprisesum: kr. 14.750.000 ekskl. moms
Betalingsbetingelser: 30 dage netto fra faktura
Tilbudssum inkl. materialer og arbejdsløn: 14.750.000 kr.
Budget forbeholder sig ret til regulering jf. § 14.
Faktura udstedes månedligt i takt med fremdrift.
Bygherre: Andersen Holding A/S, CVR 12345678
Totalentreprenør: Bygma Entreprise ApS, CVR 87654321
`.trim();

/** Padded to >= 4 000 chars — still has price + builder signals. */
const CONTRACT_PRICE_TEXT = pad(CONTRACT_PRICE_TEXT_SHORT);

const CONTRACT_BUILDER_TEXT_SHORT = `
Aftalens parter — entreprisekontrakt nr. 2024-087
Bygherre: Niels Jensen Ejendomme A/S, CVR 11223344, Industrivej 4, 8000 Aarhus C
Totalentreprenør: Hansen & Sønner Entreprise ApS, CVR 55667788, Byggervej 12, 9000 Aalborg
Rådgiver og byggeleder: Arkitektfirma Nord A/S, ansvarlig arkitekt: Lars Christensen
Underentreprenørerne fremgår af bilag C til nærværende kontrakt.
Entreprisen udføres i henhold til AB 18 og nærværende særlige betingelser.
Parterne er enige om at opfylde samtlige forpligtelser i henhold til kontrakten.
Eventuelle tvister afgøres ved voldgift i henhold til reglerne i Voldgiftsnævnet for Bygge og Anlæg.
`.trim();

/** Padded to >= 4 000 chars — has builder signals, NO price/risk signals. */
const CONTRACT_BUILDER_TEXT = pad(CONTRACT_BUILDER_TEXT_SHORT);

const CONTRACT_RISK_TEXT_SHORT = `
Aftalens betingelser og ansvar
§ 8 Forsinkelse og dagbod
Såfremt aflevering sker efter aftalt frist, betaler Totalentreprenøren dagbod
på 0,1 % af entreprisesummen pr. påbegyndt arbejdsdag.
Forsinkelsesansvar er begrænset til 10 % af kontraktsummen.
Garanti og mangelansvar gælder i 5 år fra aflevering.
Selvrisiko ved forsikringsskader: 50.000 kr.
`.trim();

/** Padded to >= 4 000 chars — has risk/dagbod signals. */
const CONTRACT_RISK_TEXT = pad(CONTRACT_RISK_TEXT_SHORT);

/** Short text — below minimum length threshold (< 4 000 chars). */
const SHORT_TEXT = "Her er lidt tekst.";

/** Non-intro, non-contract text with no specific signals — padded to >= 4 000. */
const GENERIC_LONG_TEXT = pad(`
Dette er en lang tekst om et byggeprojekt i Aarhus. Projektet omfatter etablering
af nye kontorbygninger med moderne faciliteter. Byggeriet forventes at starte i
foråret og afsluttes inden udgangen af næste år. Der vil blive anvendt bæredygtige
materialer og energibesparende løsninger. Alle faser er planlagt i samarbejde med
de relevante myndigheder. Projektet er godkendt af kommunen og vil skabe ca. 50
nye arbejdspladser i regionen. Detaljerede tegninger er udarbejdet af arkitektfirmaet.
`.trim());

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("shouldStartPartialAnswer — intro/front-page suppression", () => {
  it("blocks intro/front-page OCR + price question", () => {
    const result = shouldStartPartialAnswer({
      questionText:   "Hvad er pris og hvem bygger?",
      partialOcrText: INTRO_TEXT,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/intro_content/);
  });

  it("blocks intro/front-page OCR + who-builds question", () => {
    const result = shouldStartPartialAnswer({
      questionText:   "Hvem er totalentreprenøren på projektet?",
      partialOcrText: INTRO_TEXT,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/intro_content/);
  });

  it("blocks intro/front-page OCR + risk question", () => {
    const result = shouldStartPartialAnswer({
      questionText:   "Hvad er dagbod og selvrisiko?",
      partialOcrText: INTRO_TEXT,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/intro_content/);
  });

  it("blocks intro text even for an unrelated generic question", () => {
    const result = shouldStartPartialAnswer({
      questionText:   "Fortæl mig om projektet",
      partialOcrText: INTRO_TEXT,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/intro_content/);
  });
});

describe("shouldStartPartialAnswer — text-too-short gate", () => {
  it("blocks short OCR text regardless of question", () => {
    const result = shouldStartPartialAnswer({
      questionText:   "Hvad er prisen?",
      partialOcrText: SHORT_TEXT,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe("text_too_short");
  });
});

describe("shouldStartPartialAnswer — question-relevance gate", () => {
  it("blocks: price question + no price signals in OCR text", () => {
    const result = shouldStartPartialAnswer({
      questionText:   "Hvad er pris og entreprisesum?",
      partialOcrText: CONTRACT_BUILDER_TEXT, // builder text only — no price signals
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no_ocr_signals_for_topics/);
    expect(result.reason).toMatch(/price/);
  });

  it("blocks: risk/dagbod question + builder-only OCR text", () => {
    const result = shouldStartPartialAnswer({
      questionText:   "Hvad er dagbod og selvrisiko?",
      partialOcrText: CONTRACT_BUILDER_TEXT,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no_ocr_signals_for_topics/);
    expect(result.reason).toMatch(/risk/);
  });

  it("blocks: who-builds question + no builder identity in intro-free generic text", () => {
    const noBuilderText = GENERIC_LONG_TEXT; // no CVR, no A/S, no entrepreneur
    const result = shouldStartPartialAnswer({
      questionText:   "Hvem bygger og hvem er bygherre?",
      partialOcrText: noBuilderText,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no_ocr_signals_for_topics/);
  });
});

describe("shouldStartPartialAnswer — allowed (contract content + relevant question)", () => {
  it("allows: price question + contract section with price signals", () => {
    const result = shouldStartPartialAnswer({
      questionText:   "Hvad er pris og hvem bygger?",
      partialOcrText: CONTRACT_PRICE_TEXT,
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("ok");
  });

  it("allows: risk/dagbod question + contract risk section", () => {
    const result = shouldStartPartialAnswer({
      questionText:   "Hvad er dagbod og selvrisiko i kontrakten?",
      partialOcrText: CONTRACT_RISK_TEXT,
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("ok");
  });

  it("allows: who-builds question + contract with explicit builder identity", () => {
    const result = shouldStartPartialAnswer({
      questionText:   "Hvem er totalentreprenøren og bygherre?",
      partialOcrText: CONTRACT_BUILDER_TEXT,
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("ok");
  });

  it("allows: price question + combined contract text (price + builder)", () => {
    const result = shouldStartPartialAnswer({
      questionText:   "Hvad er prisen?",
      partialOcrText: CONTRACT_PRICE_TEXT,
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("ok");
  });

  it("allows: generic question (no detectable topic) + substantive non-intro text", () => {
    const result = shouldStartPartialAnswer({
      questionText:   "Fortæl mig om dette projekt",
      partialOcrText: GENERIC_LONG_TEXT,
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("ok");
  });
});

describe("shouldStartPartialAnswer — multi-topic questions", () => {
  it("allows when at least one topic has OCR signals (price+builder question, price text)", () => {
    const result = shouldStartPartialAnswer({
      questionText:   "Hvad er pris og hvem er totalentreprenøren?",
      partialOcrText: CONTRACT_PRICE_TEXT, // price signals present, builder too
    });
    expect(result.allowed).toBe(true);
  });

  it("blocks when question covers multiple topics but OCR has none of them", () => {
    // price+risk question, but OCR is builder-only
    const result = shouldStartPartialAnswer({
      questionText:   "Hvad er entreprisesum og dagbod?",
      partialOcrText: CONTRACT_BUILDER_TEXT, // CVR/totalentreprenør only
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no_ocr_signals_for_topics/);
  });
});

describe("shouldStartPartialAnswer — completed chain unchanged", () => {
  it("gate is not invoked on completed OCR — simulate by passing completed text (always allows)", () => {
    // When OCR is 'completed', ai-chat.tsx does NOT call shouldStartPartialAnswer.
    // This test confirms the gate does not interfere with completed-only text
    // (i.e., a completed text with full contract content passes the gate trivially).
    const fullContractText = [CONTRACT_PRICE_TEXT, CONTRACT_BUILDER_TEXT, CONTRACT_RISK_TEXT].join("\n\n");
    const result = shouldStartPartialAnswer({
      questionText:   "Hvad er pris og dagbod?",
      partialOcrText: fullContractText,
    });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("ok");
  });
});
