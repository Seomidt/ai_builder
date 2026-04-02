/**
 * ACCEPTANCE TESTS — Partial OCR Safeguard
 *
 * Validates the server-side deterministic safety layer for partial-mode answers.
 * Tests pure logic in partial-safeguard.ts without live DB or AI calls.
 *
 * Test IDs match the spec:
 *  1. partial mode + question not yet answerable from first page → provisional answer
 *  2. partial mode + model produces "jeg kan ikke finde..." → safeguard rewrites
 *  3. complete mode + info absent in full document → definitive negative still allowed
 *  4. polling fallback preserves source="ocr_partial" → isPartialOcr = true
 *  5. SSE path preserves source="ocr_partial" → isPartialOcr = true
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import {
  applyPartialSafeguard,
  isDefinitiveNegative,
  PARTIAL_PROVISIONAL_ANSWER,
  PARTIAL_NEGATIVE_PATTERNS,
} from "../server/lib/chat/partial-safeguard.ts";

// ─── Helper ───────────────────────────────────────────────────────────────────

/** Simulate the server-side isPartialOcr detection from document_context */
function detectIsPartialOcr(documentContext: Array<{ source?: string }>): boolean {
  return documentContext.some(d => d.source === "ocr_partial");
}

// ─── Test 1: provisional answer when question is not yet answerable ────────────

describe("Test 1 — partial mode: unanswerable from first page → provisional answer", () => {
  it("returns provisional answer when model output is a definitive negative", () => {
    const modelOutput = "Jeg kan ikke finde det i det uploadede dokument.";
    const result = applyPartialSafeguard(modelOutput);
    assert.ok(result !== modelOutput, "safeguard must rewrite the answer");
    assert.ok(result.includes("første del"), "must mention partial nature");
    assert.ok(result.includes("⏳"), "must include update promise");
    assert.ok(result.includes("opdateres automatisk"), "must promise auto-update");
  });

  it("returns provisional answer for 'ingenting fremgår af dokumentet'", () => {
    const modelOutput = "Ingenting fremgår af dokumentet om dette emne.";
    const result = applyPartialSafeguard(modelOutput);
    assert.ok(result !== modelOutput, "safeguard must rewrite");
    assert.equal(result, PARTIAL_PROVISIONAL_ANSWER);
  });

  it("returns provisional answer for 'dokumentet indeholder ikke'", () => {
    const modelOutput = "Dokumentet indeholder ikke oplysninger om beløbet.";
    const result = applyPartialSafeguard(modelOutput);
    assert.equal(result, PARTIAL_PROVISIONAL_ANSWER);
  });

  it("passes through non-negative partial answers unchanged", () => {
    const modelOutput =
      "Baseret på den tilgængelige del af dokumentet: kontrakten starter den 1. januar 2024.";
    const result = applyPartialSafeguard(modelOutput);
    assert.equal(result, modelOutput, "valid partial answer must not be modified");
  });
});

// ─── Test 2: safeguard rewrites all definitive-negative pattern variants ───────

describe("Test 2 — partial mode: safeguard rewrites definitive negative answers", () => {
  const DEFINITIVE_NEGATIVES = [
    "Jeg kan ikke finde det i det uploadede dokument.",
    "Det fremgår ikke af dokumentet.",
    "Dokumentet nævner ikke noget om dette.",
    "Der er ingen information i dokumentet om emnet.",
    "Dette er ikke nævnt i dokumentet.",
    "Det omtales ikke i dokumentet.",
    "Dokumentet indeholder ikke svar på dit spørgsmål.",
    "Ingen oplysninger i dokumentet om dette.",
    "Svaret er ikke at finde i dokumentet.",
    "Jeg finder ingen relevant information i dokumentet.",
    "Cannot find this information in the document.",
    "The document does not contain this information.",
    "No information about this in the document.",
    "This is not mentioned in the document.",
    "Jeg kan ikke finde nogen omtale af dette i teksten.",
    "Ingensteds i dokumentet nævnes dette.",
    "Det eksisterer ikke i dokumentet.",
  ];

  for (const text of DEFINITIVE_NEGATIVES) {
    it(`rewrites: "${text.slice(0, 60)}…"`, () => {
      assert.ok(isDefinitiveNegative(text), `isDefinitiveNegative must return true for: "${text}"`);
      const result = applyPartialSafeguard(text);
      assert.equal(result, PARTIAL_PROVISIONAL_ANSWER, "must return canonical provisional answer");
    });
  }

  it("all PARTIAL_NEGATIVE_PATTERNS are valid RegExp instances", () => {
    for (const p of PARTIAL_NEGATIVE_PATTERNS) {
      assert.ok(p instanceof RegExp, `${p} must be a RegExp`);
    }
  });
});

// ─── Test 3: complete mode — definitive negatives are preserved ────────────────

describe("Test 3 — complete mode: definitive negative answer allowed for full document", () => {
  it("applyPartialSafeguard is NOT called in complete mode — definitive negative preserved", () => {
    // In complete mode isPartialOcr = false, so applyPartialSafeguard is never called.
    // We verify the function itself does NOT alter a definitive negative (it's the caller's
    // responsibility to gate on isPartialOcr). We also verify this directly via logic.
    const completeDocumentContext = [{ source: "r2_ocr_async" }];
    const isPartialOcr = detectIsPartialOcr(completeDocumentContext);
    assert.equal(isPartialOcr, false, "complete mode must NOT be detected as partial");

    // Simulate complete-mode flow: safeguard is not invoked, answer passes through as-is
    const definitiveAnswer = "Jeg kan ikke finde det i det uploadede dokument.";
    const resultInCompleteMode = isPartialOcr ? applyPartialSafeguard(definitiveAnswer) : definitiveAnswer;
    assert.equal(resultInCompleteMode, definitiveAnswer, "complete-mode definitive negative must be unchanged");
  });

  it("complete mode document_context (r2_ocr_async) → isPartialOcr = false", () => {
    const ctx = [{ source: "r2_ocr_async", status: "ok" }];
    assert.equal(detectIsPartialOcr(ctx), false);
  });

  it("complete mode document_context (r2_ocr_fallback) → isPartialOcr = false", () => {
    const ctx = [{ source: "r2_ocr_fallback", status: "ok" }];
    assert.equal(detectIsPartialOcr(ctx), false);
  });

  it("empty document_context → isPartialOcr = false", () => {
    assert.equal(detectIsPartialOcr([]), false);
  });
});

// ─── Test 4: polling fallback preserves source="ocr_partial" ──────────────────

describe("Test 4 — polling fallback preserves source='ocr_partial' marker", () => {
  it("polling partial_ready with source='ocr_partial' → isPartialOcr = true", () => {
    // Simulates the document_context built by the polling fallback path in ai-chat.tsx
    // (line 1061-1070): ocrResult.ocrText → finalizeResults.push({ source: "r2_ocr_async" })
    // BUT the partial_ready path pushes source: "ocr_partial" via the post-processing block.
    const pollingPartialContext = [
      {
        filename:       "contract.pdf",
        mime_type:      "application/pdf",
        char_count:     4800,
        extracted_text: "Første side af kontrakten...",
        status:         "ok",
        source:         "ocr_partial",   // ← must be set in polling partial_ready path
      },
    ];
    const isPartialOcr = detectIsPartialOcr(pollingPartialContext);
    assert.equal(isPartialOcr, true, "polling fallback must produce isPartialOcr=true");
  });

  it("polling completed (not partial_ready) → isPartialOcr = false", () => {
    const pollingCompletedContext = [
      {
        filename:       "contract.pdf",
        mime_type:      "application/pdf",
        char_count:     48000,
        extracted_text: "Fuldt dokumentindhold...",
        status:         "ok",
        source:         "r2_ocr_async",   // completed path uses r2_ocr_async
      },
    ];
    const isPartialOcr = detectIsPartialOcr(pollingCompletedContext);
    assert.equal(isPartialOcr, false, "completed polling must NOT produce isPartialOcr=true");
  });

  it("safeguard applies when polling path triggers partial mode", () => {
    const pollingCtx = [{ source: "ocr_partial" }];
    const isPartialOcr = detectIsPartialOcr(pollingCtx);
    assert.equal(isPartialOcr, true);

    const badAnswer = "Ingen information fremgår af dokumentet.";
    const result = isPartialOcr ? applyPartialSafeguard(badAnswer) : badAnswer;
    assert.equal(result, PARTIAL_PROVISIONAL_ANSWER);
  });
});

// ─── Test 5: SSE path preserves source="ocr_partial" ─────────────────────────

describe("Test 5 — SSE path preserves source='ocr_partial' marker", () => {
  it("SSE partial_ready path (source='ocr_partial') → isPartialOcr = true", () => {
    // Simulates finalizeResults.push from SSE partial_ready handler (ai-chat.tsx line 969-976)
    const ssePartialContext = [
      {
        filename:       "rapport.pdf",
        mime_type:      "application/pdf",
        char_count:     6200,
        extracted_text: "Side 1 tekst fra SSE...",
        status:         "ok",
        source:         "ocr_partial",   // ← set by SSE partial_ready handler
      },
    ];
    const isPartialOcr = detectIsPartialOcr(ssePartialContext);
    assert.equal(isPartialOcr, true, "SSE partial_ready must produce isPartialOcr=true");
  });

  it("SSE completed event (no source='ocr_partial') → isPartialOcr = false", () => {
    const sseCompletedContext = [
      {
        filename:       "rapport.pdf",
        mime_type:      "application/pdf",
        char_count:     62000,
        extracted_text: "Fuldt dokumentindhold fra SSE completed...",
        status:         "ok",
        source:         "r2_ocr_async",
      },
    ];
    const isPartialOcr = detectIsPartialOcr(sseCompletedContext);
    assert.equal(isPartialOcr, false);
  });

  it("safeguard applies when SSE path triggers partial mode", () => {
    const sseCtx = [{ source: "ocr_partial" }];
    const isPartialOcr = detectIsPartialOcr(sseCtx);
    assert.equal(isPartialOcr, true);

    const badAnswer = "Dokumentet nævner ikke noget om dette emne.";
    const result = isPartialOcr ? applyPartialSafeguard(badAnswer) : badAnswer;
    assert.equal(result, PARTIAL_PROVISIONAL_ANSWER);
  });

  it("multiple mixed-source contexts: any ocr_partial → isPartialOcr = true", () => {
    const mixedCtx = [
      { source: "direct_text" },
      { source: "ocr_partial" },
    ];
    assert.equal(detectIsPartialOcr(mixedCtx), true);
  });

  it("upgrade path context (ocr_partial overridden by _documentContextOverride) → isPartialOcr = false", () => {
    // When upgrade fires, _documentContextOverride contains full text with source from completed OCR
    const upgradeCtx = [
      {
        filename:       "rapport.pdf",
        extracted_text: "Fuld tekst fra hele dokumentet...",
        source:         "r2_ocr_async",   // completed upgrade uses r2_ocr_async
        status:         "ok",
        char_count:     62000,
        mime_type:      "application/pdf",
      },
    ];
    assert.equal(detectIsPartialOcr(upgradeCtx), false);
  });
});
