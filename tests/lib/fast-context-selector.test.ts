import { describe, it, expect } from "vitest";
import { selectFastContext } from "../../server/lib/chat/fast-context-selector";

// ── Helper ───────────────────────────────────────────────────────────────────

/** Create a string of N characters (repeating pattern). */
function makeText(chars: number, pattern = "Lorem ipsum dolor sit amet. "): string {
  let s = "";
  while (s.length < chars) s += pattern;
  return s.slice(0, chars);
}

// ── full_fit ──────────────────────────────────────────────────────────────────

describe("full_fit: text shorter than maxChars", () => {
  it("returns the full text unchanged", () => {
    const text = "Kontrakten er underskrevet den 1. januar 2024.";
    const result = selectFastContext(text, "Hvornår er kontrakten underskrevet?");
    expect(result.method).toBe("full_fit");
    expect(result.selectedText).toBe(text);
    expect(result.trimmed).toBe(false);
    expect(result.selectedChars).toBe(text.length);
    expect(result.totalChars).toBe(text.length);
  });

  it("returns full text when text is exactly at maxChars boundary", () => {
    const text = makeText(15_000);
    const result = selectFastContext(text, "test", { maxChars: 15_000 });
    expect(result.method).toBe("full_fit");
    expect(result.trimmed).toBe(false);
  });
});

// ── head_truncation ───────────────────────────────────────────────────────────

describe("head_truncation: fallback when no keyword match", () => {
  it("falls back to head-truncation when question has no matching terms", () => {
    const text = makeText(30_000, "XYZXYZ abc def ghi. ");
    // Question uses words that don't appear in the junk text
    const result = selectFastContext(text, "kontrakt underskrift dato", { maxChars: 10_000 });
    expect(result.method).toBe("head_truncation");
    expect(result.trimmed).toBe(true);
    expect(result.selectedChars).toBeLessThanOrEqual(10_000);
    expect(result.selectedText.length).toBeLessThanOrEqual(10_000);
  });

  it("head-truncation result starts at the beginning of the text", () => {
    const text = makeText(25_000, "Ingen relevante ord her. ");
    const result = selectFastContext(text, "blahblah xyznomatch", { maxChars: 5_000 });
    expect(result.selectedText).toBe(text.slice(0, 5_000));
  });
});

// ── keyword_relevance ─────────────────────────────────────────────────────────

describe("keyword_relevance: selecting relevant chunks", () => {
  it("selects chunks containing question keywords", () => {
    const relevantChunk =
      "Kontrakten er underskrevet den 15. marts 2024 af begge parter. " +
      "Opsigelsesfristen er på tre måneder. Garantiperioden er to år.";
    const filler = makeText(20_000, "Generisk tekst uden relevans. Ingenting interessant her. ");
    const text = filler + "\n\n" + relevantChunk;

    const result = selectFastContext(text, "hvornår er kontrakten underskrevet", { maxChars: 5_000 });
    expect(result.method).toBe("keyword_relevance");
    expect(result.trimmed).toBe(true);
    expect(result.selectedText).toContain("underskrevet");
    expect(result.topScore).toBeGreaterThan(0);
  });

  it("stays within maxChars budget", () => {
    const text = makeText(50_000, "kontrakt aftale pris dato leverance. ");
    const result = selectFastContext(text, "kontrakt pris", { maxChars: 8_000 });
    expect(result.selectedChars).toBeLessThanOrEqual(8_000);
    expect(result.selectedText.length).toBeLessThanOrEqual(8_000);
  });

  it("returns fewer chunks when budget is tight", () => {
    const text = makeText(30_000, "relevant ord her. ");
    const result = selectFastContext(text, "relevant ord", { maxChars: 2_000, chunkSize: 400 });
    expect(result.selectedChars).toBeLessThanOrEqual(2_000);
    expect(result.chunkCount).toBeGreaterThan(0);
  });

  it("preserves topN limit", () => {
    const text = makeText(50_000, "keyword match test. ");
    const result = selectFastContext(text, "keyword match", { maxChars: 100_000, topN: 5 });
    expect(result.chunkCount).toBeLessThanOrEqual(5);
  });
});

// ── default maxChars (15,000) prevents heavy tier ────────────────────────────

describe("default maxChars keeps docChars below heavy-tier threshold (20k)", () => {
  it("default trim stays under 15k chars", () => {
    const text = makeText(80_000, "Dette er en lang kontrakt med mange klausuler. ");
    const result = selectFastContext(text, "hvad er opsigelsesfristen");
    expect(result.selectedChars).toBeLessThanOrEqual(15_000);
    expect(result.trimmed).toBe(true);
  });

  it("never exceeds maxChars even with huge input", () => {
    const text = makeText(200_000, "kontrakt aftale pris dato moms. ");
    const result = selectFastContext(text, "hvad er prisen", { maxChars: 15_000 });
    expect(result.selectedChars).toBeLessThanOrEqual(15_000);
  });

  it("reports correct totalChars for full document", () => {
    const text = makeText(60_000);
    const result = selectFastContext(text, "test spørgsmål");
    expect(result.totalChars).toBe(60_000);
  });
});

// ── edge cases ────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("handles empty text gracefully", () => {
    const result = selectFastContext("", "hvad sker der?");
    expect(result.method).toBe("full_fit");
    expect(result.selectedText).toBe("");
    expect(result.trimmed).toBe(false);
  });

  it("handles empty question (no terms)", () => {
    const text = makeText(30_000);
    const result = selectFastContext(text, "");
    expect(result.trimmed).toBe(true);
    expect(result.selectedChars).toBeLessThanOrEqual(15_000);
  });

  it("handles very short text with no trimming needed", () => {
    const text = "Kort tekst.";
    const result = selectFastContext(text, "hvad er teksten?");
    expect(result.method).toBe("full_fit");
    expect(result.selectedText).toBe(text);
  });

  it("handles unicode and Danish characters in keywords", () => {
    const text = "Aftalen indeholder en klausul om opsigelse inden for tre måneder. " +
      makeText(20_000, "Generisk tekst. ");
    const result = selectFastContext(text, "opsigelse måneder", { maxChars: 5_000 });
    expect(result.selectedText).toContain("opsigelse");
  });

  it("custom chunkSize and overlap are respected", () => {
    const text = makeText(20_000, "alpha beta gamma. ");
    const result = selectFastContext(text, "alpha beta", {
      maxChars:  5_000,
      chunkSize: 200,
      overlap:   40,
    });
    expect(result.selectedChars).toBeLessThanOrEqual(5_000);
    expect(result.chunkCount).toBeGreaterThan(0);
  });
});
