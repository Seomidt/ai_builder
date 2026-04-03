/**
 * Phase 5Z.5 — Tests: Partial Text Readiness Policy
 * Phase 5Z.8 — Tests: Question-aware partial gating (shouldStartPartialAnswer)
 *
 * Validates:
 *  - Short fragments are rejected (below MIN_NON_WS_CHARS / MIN_WORDS)
 *  - Sufficient text is accepted
 *  - Subsequent pages have lower thresholds
 *  - Empty text is always rejected
 *  - Quality score increases with text length
 *  - failReason is descriptive on rejection
 *  - shouldStartPartialAnswer: query_match, contract_section_detected,
 *    semantic_density_reached, intro_only, insufficient_relevance, needs_more_text
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  isPartialTextUsable,
  evaluatePartialReadiness,
  computeQualityScore,
  shouldStartPartialAnswer,
  MIN_NON_WS_CHARS,
  MIN_WORDS,
  MIN_NON_WS_CHARS_SUBSEQUENT,
  MIN_WORDS_SUBSEQUENT,
} from "../../server/lib/media/partial-text-readiness.ts";

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Generate a text with exactly n non-whitespace chars and m words. */
function makeText(nonWsChars: number, words: number): string {
  const word = "a".repeat(Math.ceil(nonWsChars / Math.max(words, 1)));
  return Array.from({ length: words }, () => word).join(" ").slice(0, nonWsChars + words);
}

// ── Fixtures for question-aware gate ──────────────────────────────────────────

const INTRO_TEXT = `
  Om os – Vi er en dansk virksomhed med over 30 års erfaring inden for byggebranchen.
  Vores vision er at levere fremtidens løsninger til alle vores kunder.
  Hvem er vi? Vi er et stærkt team af dedikerede specialister og projektledere.
  Vores værdier: Integritet, Innovation, Kvalitet og Kundefokus.
  Kontakt os i dag for at høre mere om vores løsninger og services.
`.repeat(3);

const CONTRACT_TEXT = `
  Entreprisekontrakt — Projektbeskrivelse
  § 1 Parterne
  Totalentreprenør: Bygge & Anlæg A/S, CVR-nr. 12345678
  Bygherre: Boligforening X, CVR-nr. 87654321
  § 2 Ydelse og leverancer
  Entreprisen omfatter fundering, råbygning, installationer og aflevering.
  § 3 Betalingsbetingelser
  Betaling sker i rater iht. tidsplan. Dagbod udgør kr. 5.000 pr. påbegyndt dag.
  § 4 Garanti og mangler
  5 årig garanti på alle leverancer. Reklamation inden 10 dage.
`;

const ENTREPRENEUR_TEXT = `
  Bygherre: Andelsboligforening Bakkehus, CVR-nr. 33445566
  Totalentreprenør: Skanska Danmark A/S, CVR-nr. 10092462
  Entreprisen omfatter opførelse af 48 boliger inkl. fællesarealer og parkeringskælder.
  Udførelse starter 01.03.2025 og afsluttes ved aflevering 15.12.2025.
  Den udførende part er ansvarlig for alle leverancer og installationer iht. projektbeskrivelsen.
`;

const INSURANCE_TEXT = `
  Forsikringspolice nr. 2024-789456 udstedt af Tryg Forsikring A/S.
  Selvrisiko: kr. 10.000 pr. skade på ejendommen.
  Dækning: brand, tyveri, vandskade og ansvarsskader.
  Forsikringspræmien forfalder hvert kvartal.
  Skade skal anmeldes inden for 14 dage efter hændelsen.
  Police er gyldig fra 01.01.2025 til 31.12.2025.
`;

const PRICE_TEXT = `
  Tilbudssum inkl. moms: kr. 4.850.000.
  Entreprisesum ekskl. moms: DKK 3.880.000.
  Betalingsplan: 30% ved kontraktindgåelse, 40% ved råbygning, 30% ved aflevering.
  Budget for uforudsete udgifter: kr. 200.000.
  Acontobetaling kan ske iht. tidsplan og fakturering aftales løbende.
`;

const TIMELINE_TEXT = `
  Tidsplan for projektet:
  Opstart: 01.03.2025
  Aflevering: 15.12.2025
  Tidsfrist for indflytning: Q1 2026
  Ugentlige byggemøder hver onsdag kl. 10.00.
  Afleveringsdato er bindende og dagbod træder i kraft ved overskridelse.
  Tidsplanen vedlægges som bilag og revideres månedligt.
`;

const DELIVERABLES_TEXT = `
  Leverancer og ydelser som indgår i entreprisen:
  - Råbygning inkl. fundering, betonkonstruktioner og tagkonstruktion
  - Installationer: VVS, el, ventilation og fjernvarme
  - Materialer: teglsten, isolering, tagpap og facadebeklædning
  - Omfanget dækker alle arbejdsopgaver iht. projektbeskrivelsen og udbudsmaterialet
  Leverancer sker etapevis iht. tidsplan.
`;

const DENSE_TEXT = "Kontraktvilkår og generelle bestemmelser vedrørende totalentreprisen ".repeat(35);

// ── Group 1: isPartialTextUsable (existing) ───────────────────────────────────

describe("isPartialTextUsable (page 0 — first page)", () => {
  it("rejects empty string", () => {
    assert.equal(isPartialTextUsable("", 0), false);
  });

  it("rejects whitespace-only string", () => {
    assert.equal(isPartialTextUsable("   \n\t   ", 0), false);
  });

  it(`rejects text with fewer than ${MIN_NON_WS_CHARS} non-ws chars`, () => {
    const short = "a ".repeat(10);
    assert.equal(isPartialTextUsable(short, 0), false);
  });

  it(`rejects text with enough chars but fewer than ${MIN_WORDS} words`, () => {
    const text = "x".repeat(200);
    assert.equal(isPartialTextUsable(text, 0), false);
  });

  it("accepts text meeting both thresholds", () => {
    const text = makeText(MIN_NON_WS_CHARS + 10, MIN_WORDS + 5);
    assert.equal(isPartialTextUsable(text, 0), true);
  });

  it("accepts real-world-style invoice text", () => {
    const invoice = `
      INVOICE #12345
      Date: 2025-01-01
      Vendor: Acme Corp ApS
      CVR: 12345678
      Amount: DKK 15,000.00
      VAT (25%): DKK 3,750.00
      Total: DKK 18,750.00
      Payment due: 2025-01-30
      Bank: IBAN DK0012345678901234
      Description: Consulting services January 2025
    `.trim();
    assert.equal(isPartialTextUsable(invoice, 0), true);
  });
});

describe("isPartialTextUsable (page > 0 — subsequent pages)", () => {
  it(`subsequent page accepts text meeting lower threshold (${MIN_NON_WS_CHARS_SUBSEQUENT} non-ws, ${MIN_WORDS_SUBSEQUENT} words)`, () => {
    const text = makeText(MIN_NON_WS_CHARS_SUBSEQUENT + 5, MIN_WORDS_SUBSEQUENT + 2);
    assert.equal(isPartialTextUsable(text, 1), true);
  });

  it("subsequent page still rejects empty string", () => {
    assert.equal(isPartialTextUsable("", 1), false);
  });

  it("subsequent page rejects text below its lower threshold", () => {
    const text = makeText(20, 3);
    assert.equal(isPartialTextUsable(text, 1), false);
  });
});

describe("evaluatePartialReadiness", () => {
  it("returns usable=false with failReason on rejection", () => {
    const result = evaluatePartialReadiness("short", 0);
    assert.equal(result.usable, false);
    assert.ok(result.failReason !== null, "failReason should be non-null on rejection");
  });

  it("returns failReason=null on acceptance", () => {
    const text = makeText(MIN_NON_WS_CHARS + 20, MIN_WORDS + 10);
    const result = evaluatePartialReadiness(text, 0);
    assert.equal(result.usable, true);
    assert.equal(result.failReason, null);
  });

  it("exposes correct nonWsChars count", () => {
    const result = evaluatePartialReadiness("abcde", 0);
    assert.equal(result.nonWsChars, 5);
  });

  it("exposes correct wordCount", () => {
    const text = "hello world foo bar";
    const result = evaluatePartialReadiness(text, 0);
    assert.equal(result.wordCount, 4);
  });
});

describe("computeQualityScore", () => {
  it("returns 0 for zero chars", () => {
    assert.equal(computeQualityScore(0, 0), 0);
  });

  it("returns increasing score as text grows", () => {
    const s100  = computeQualityScore(100, 15);
    const s500  = computeQualityScore(500, 60);
    const s2000 = computeQualityScore(2000, 250);
    const s5000 = computeQualityScore(5000, 600);
    assert.ok(s100 < s500,  "500 chars should score higher than 100");
    assert.ok(s500 < s2000, "2000 chars should score higher than 500");
    assert.ok(s2000 < s5000, "5000 chars should score higher than 2000");
  });

  it("returns score in [0..1] range", () => {
    const scores = [0, 100, 500, 2000, 5000, 20000].map(n => computeQualityScore(n, Math.floor(n / 8)));
    for (const s of scores) {
      assert.ok(s >= 0 && s <= 1, `score ${s} out of range`);
    }
  });
});

// ── Group 2: shouldStartPartialAnswer — minimum guard ────────────────────────

describe("shouldStartPartialAnswer — minimum text guard (needs_more_text)", () => {
  it("blocks empty text", () => {
    const r = shouldStartPartialAnswer({ questionText: "Hvem bygger?", partialOcrText: "" });
    assert.equal(r.allow, false);
    assert.equal(r.reason, "needs_more_text");
  });

  it("blocks text below char threshold", () => {
    const r = shouldStartPartialAnswer({ questionText: "Hvem bygger?", partialOcrText: "Lidt tekst her." });
    assert.equal(r.allow, false);
    assert.equal(r.reason, "needs_more_text");
  });

  it("blocks text with chars but too few words", () => {
    const r = shouldStartPartialAnswer({ questionText: "Hvem bygger?", partialOcrText: "a".repeat(200) });
    assert.equal(r.allow, false);
    assert.equal(r.reason, "needs_more_text");
  });
});

// ── Group 3: shouldStartPartialAnswer — query_match ──────────────────────────

describe("shouldStartPartialAnswer — query_match", () => {
  it("ACCEPT: 'Hvem bygger?' + builder identity present", () => {
    const r = shouldStartPartialAnswer({
      questionText:   "Hvem bygger?",
      partialOcrText: ENTREPRENEUR_TEXT,
    });
    assert.equal(r.allow, true);
    assert.equal(r.reason, "query_match");
  });

  it("ACCEPT: 'Hvem er totalentreprenøren?' + totalentreprenør present", () => {
    const r = shouldStartPartialAnswer({
      questionText:   "Hvem er totalentreprenøren?",
      partialOcrText: ENTREPRENEUR_TEXT,
    });
    assert.equal(r.allow, true);
    assert.equal(r.reason, "query_match");
  });

  it("ACCEPT: selvrisiko question + insurance text", () => {
    const r = shouldStartPartialAnswer({
      questionText:   "Hvad er selvrisikoen?",
      partialOcrText: INSURANCE_TEXT,
    });
    assert.equal(r.allow, true);
    assert.equal(r.reason, "query_match");
  });

  it("ACCEPT: price question + price text with kr./DKK", () => {
    const r = shouldStartPartialAnswer({
      questionText:   "Hvad er prisen og tilbudssummen?",
      partialOcrText: PRICE_TEXT,
    });
    assert.equal(r.allow, true);
    assert.equal(r.reason, "query_match");
  });

  it("ACCEPT: timeline question + tidsplan text", () => {
    const r = shouldStartPartialAnswer({
      questionText:   "Hvornår er afleveringsdatoen?",
      partialOcrText: TIMELINE_TEXT,
    });
    assert.equal(r.allow, true);
    assert.equal(r.reason, "query_match");
  });

  it("ACCEPT: deliverables question + leverancer text", () => {
    const r = shouldStartPartialAnswer({
      questionText:   "Hvad er inkluderet i leverancen?",
      partialOcrText: DELIVERABLES_TEXT,
    });
    assert.equal(r.allow, true);
    assert.equal(r.reason, "query_match");
  });

  it("ACCEPT: 'holde øje' question + contract clauses available", () => {
    const r = shouldStartPartialAnswer({
      questionText:   "Hvad skal jeg holde øje med i kontrakten?",
      partialOcrText: CONTRACT_TEXT,
    });
    assert.equal(r.allow, true);
    assert.equal(r.reason, "query_match");
  });

  it("ACCEPT: 'risici' question + contract clause text", () => {
    const r = shouldStartPartialAnswer({
      questionText:   "Hvilke risici indeholder kontrakten?",
      partialOcrText: CONTRACT_TEXT,
    });
    assert.equal(r.allow, true);
    assert.equal(r.reason, "query_match");
  });

  it("ACCEPT: garanti question + contract with garanti clause", () => {
    const r = shouldStartPartialAnswer({
      questionText:   "Hvad er garantiperioden?",
      partialOcrText: CONTRACT_TEXT,
    });
    assert.equal(r.allow, true);
    assert.equal(r.reason, "query_match");
  });

  it("CRITICAL BLOCK: 'holde øje' question + INTRO-only text → must NOT allow", () => {
    const r = shouldStartPartialAnswer({
      questionText:   "Hvad skal jeg holde øje med i kontrakten?",
      partialOcrText: INTRO_TEXT,
    });
    assert.equal(r.allow, false);
    assert.ok(r.reason === "intro_only" || r.reason === "insufficient_relevance",
      `Expected intro_only or insufficient_relevance, got: ${r.reason}`);
  });

  it("CRITICAL BLOCK: 'Hvem bygger?' + INTRO-only text → no builder identity → must NOT allow", () => {
    const r = shouldStartPartialAnswer({
      questionText:   "Hvem bygger?",
      partialOcrText: INTRO_TEXT,
    });
    assert.equal(r.allow, false);
  });
});

// ── Group 4: shouldStartPartialAnswer — contract_section_detected ─────────────

describe("shouldStartPartialAnswer — contract_section_detected", () => {
  it("ACCEPT: 2+ contract section signals with generic question", () => {
    const text = `
      Entreprisekontrakt for nybyggeri — Aflevering sker iht. tidsplan.
      Betaling sker ved fakturaen efter aftalt betalingsplan.
      Dagbod pr. påbegyndt dag: kr. 3.000.
      Garantiperiode: 5 år på alle leverede arbejder og installationer.
      Parterne er enige om ovenstående vilkår og betingelser for entreprisen.
    `;
    const r = shouldStartPartialAnswer({
      questionText:   "Hvad hedder firmaet?",
      partialOcrText: text,
    });
    assert.equal(r.allow, true);
    assert.ok(
      r.reason === "contract_section_detected" || r.reason === "query_match",
      `Expected contract_section_detected or query_match, got: ${r.reason}`,
    );
  });

  it("ACCEPT: full contract text with 'opsummér kontrakten' question", () => {
    const r = shouldStartPartialAnswer({
      questionText:   "Kan du opsummere kontrakten?",
      partialOcrText: CONTRACT_TEXT,
    });
    assert.equal(r.allow, true);
  });

  it("BLOCK: single contract signal + intro dominant + non-dense → no early answer", () => {
    const text = `
      Entreprisekontrakt — side 1
      Velkommen til vores virksomhed. Vi tilbyder løsninger til alle.
      Om os: Vi har 20 års erfaring inden for branchen og vores team er klar.
      Vores vision er at skabe en bedre fremtid. Hvem er vi? Vi er dedikerede.
    `.repeat(2);
    const r = shouldStartPartialAnswer({
      questionText:   "Hvad koster det?",
      partialOcrText: text,
    });
    assert.equal(r.allow, false);
  });
});

// ── Group 5: shouldStartPartialAnswer — intro_only ───────────────────────────

describe("shouldStartPartialAnswer — intro_only suppression", () => {
  it("CRITICAL: pure intro text + generic question → intro_only", () => {
    const r = shouldStartPartialAnswer({
      questionText:   "Hvad handler dette om?",
      partialOcrText: INTRO_TEXT,
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, "intro_only");
  });

  it("CRITICAL: intro text + betaling question → no betaling signal in intro → blocked", () => {
    const r = shouldStartPartialAnswer({
      questionText:   "Hvad er betalingsbetingelserne?",
      partialOcrText: INTRO_TEXT,
    });
    assert.equal(r.allow, false);
  });

  it("ALLOW: intro + contract mix — contract wins", () => {
    const mixed = INTRO_TEXT + "\n" + CONTRACT_TEXT;
    const r = shouldStartPartialAnswer({
      questionText:   "Hvad skal jeg holde øje med?",
      partialOcrText: mixed,
    });
    assert.equal(r.allow, true);
  });

  it("ALLOW: single intro signal does not trigger suppression alone", () => {
    const text = `
      Om os: Vi fokuserer på kvalitet.
      Entreprisen omfatter totale leverancer og installationer.
      Entreprisesum: kr. 2.000.000.
      Aflevering: 01.01.2026.
      Tidsplan vedlægges som bilag 3.
    `;
    const r = shouldStartPartialAnswer({
      questionText:   "Hvad er entreprisesummen?",
      partialOcrText: text,
    });
    assert.equal(r.allow, true);
  });
});

// ── Group 6: shouldStartPartialAnswer — density fallback ─────────────────────

describe("shouldStartPartialAnswer — semantic_density_reached", () => {
  it("ACCEPT: very dense text with no question match (density fallback)", () => {
    const r = shouldStartPartialAnswer({
      questionText:   "Hvad er det her?",
      partialOcrText: DENSE_TEXT,
    });
    assert.equal(r.allow, true);
    assert.equal(r.reason, "semantic_density_reached");
  });

  it("BLOCK: sparse text with no matches → insufficient_relevance", () => {
    const sparse = "Noget tekst om generelle emner uden nogen specifikke signaler. ".repeat(8);
    const r = shouldStartPartialAnswer({
      questionText:   "Hvad er det her?",
      partialOcrText: sparse,
    });
    assert.equal(r.allow, false);
    assert.equal(r.reason, "insufficient_relevance");
  });

  it("empty questionText falls through to density/contract checks only", () => {
    const r = shouldStartPartialAnswer({
      questionText:   "",
      partialOcrText: CONTRACT_TEXT,
    });
    assert.equal(r.allow, true);
  });
});
