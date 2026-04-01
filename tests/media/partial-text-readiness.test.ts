/**
 * Phase 5Z.5 — Tests: Partial Text Readiness Policy
 *
 * Validates:
 *  - Short fragments are rejected (below MIN_NON_WS_CHARS / MIN_WORDS)
 *  - Sufficient text is accepted
 *  - Subsequent pages have lower thresholds
 *  - Empty text is always rejected
 *  - Quality score increases with text length
 *  - failReason is descriptive on rejection
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isPartialTextUsable,
  evaluatePartialReadiness,
  computeQualityScore,
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

// ── Unit tests ─────────────────────────────────────────────────────────────────

describe("isPartialTextUsable (page 0 — first page)", () => {
  it("rejects empty string", () => {
    assert.equal(isPartialTextUsable("", 0), false);
  });

  it("rejects whitespace-only string", () => {
    assert.equal(isPartialTextUsable("   \n\t   ", 0), false);
  });

  it(`rejects text with fewer than ${MIN_NON_WS_CHARS} non-ws chars`, () => {
    const short = "a ".repeat(10); // 10 non-ws chars
    assert.equal(isPartialTextUsable(short, 0), false);
  });

  it(`rejects text with enough chars but fewer than ${MIN_WORDS} words`, () => {
    // 200 non-ws chars but only 1 word
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
    const text = makeText(20, 3); // below both thresholds
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
    const chars = "abcde"; // 5 non-ws
    const result = evaluatePartialReadiness(chars, 0);
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
