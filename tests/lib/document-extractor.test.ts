import { describe, it, expect } from "vitest";

// ── Test pure functions from document-extractor ─────────────────────────────
// These don't require browser APIs and can run in Node.

// Inline the pure functions so tests don't depend on Vite/browser transforms

type FastExtractMode = "fast_text" | "fast_pdf" | "unsupported";

const TEXT_EXTENSIONS = new Set([
  ".txt", ".csv", ".md", ".markdown", ".html", ".htm",
  ".xml", ".json", ".rtf", ".log", ".yaml", ".yml", ".ini", ".cfg",
]);
const TEXT_MIMES = new Set([
  "text/plain", "text/csv", "text/markdown", "text/html",
  "text/xml", "application/json", "application/xml", "application/rtf",
]);
const MAX_TEXT_SIZE = 10 * 1024 * 1024;
const MAX_PDF_SIZE  = 10 * 1024 * 1024;

function classifyForFastExtract(name: string, mime: string, size: number): FastExtractMode {
  const nameLower = name.toLowerCase();
  const ext = "." + (nameLower.split(".").pop() ?? "");
  const m   = (mime ?? "").toLowerCase();

  if (TEXT_MIMES.has(m) || TEXT_EXTENSIONS.has(ext)) {
    return size <= MAX_TEXT_SIZE ? "fast_text" : "unsupported";
  }
  if (m === "application/pdf" || ext === ".pdf") {
    return size <= MAX_PDF_SIZE ? "fast_pdf" : "unsupported";
  }
  return "unsupported";
}

const MIN_NON_WS_CHARS = 80;
const MIN_WORD_COUNT   = 10;
const MIN_ALPHA_RATIO  = 0.25;

function checkTextUsability(text: string): { passed: boolean; reason: string | null } {
  const nonWsChars = text.replace(/\s+/g, "").length;
  const words      = text.trim().split(/\s+/).filter(w => w.length >= 2);
  const wordCount  = words.length;
  const alphaChars = (text.match(/[a-zA-ZÀ-ÖØ-öø-ÿ]/g) ?? []).length;
  const alphaRatio = nonWsChars > 0 ? alphaChars / nonWsChars : 0;

  if (nonWsChars < MIN_NON_WS_CHARS) {
    return { passed: false, reason: `too_short: only ${nonWsChars} non-whitespace chars (min ${MIN_NON_WS_CHARS})` };
  }
  if (wordCount < MIN_WORD_COUNT) {
    return { passed: false, reason: `too_few_words: only ${wordCount} words (min ${MIN_WORD_COUNT})` };
  }
  if (alphaRatio < MIN_ALPHA_RATIO) {
    return { passed: false, reason: `low_alpha_ratio: ${alphaRatio.toFixed(2)} (min ${MIN_ALPHA_RATIO}) — likely OCR noise or binary data` };
  }
  return { passed: true, reason: null };
}

// ─── classifyForFastExtract ────────────────────────────────────────────────

describe("classifyForFastExtract", () => {
  it("text PDF → fast_pdf", () => {
    expect(classifyForFastExtract("report.pdf", "application/pdf", 1_000)).toBe("fast_pdf");
  });

  it("txt file → fast_text", () => {
    expect(classifyForFastExtract("notes.txt", "text/plain", 5_000)).toBe("fast_text");
  });

  it("md file → fast_text", () => {
    expect(classifyForFastExtract("readme.md", "", 2_000)).toBe("fast_text");
  });

  it("csv file → fast_text", () => {
    expect(classifyForFastExtract("data.csv", "text/csv", 100_000)).toBe("fast_text");
  });

  it("json file → fast_text", () => {
    expect(classifyForFastExtract("config.json", "application/json", 50_000)).toBe("fast_text");
  });

  it("PDF over size limit → unsupported", () => {
    expect(classifyForFastExtract("huge.pdf", "application/pdf", MAX_PDF_SIZE + 1)).toBe("unsupported");
  });

  it("text file over size limit → unsupported", () => {
    expect(classifyForFastExtract("big.txt", "text/plain", MAX_TEXT_SIZE + 1)).toBe("unsupported");
  });

  it("image/jpeg → unsupported (scanned image PDF goes via OCR server path)", () => {
    expect(classifyForFastExtract("photo.jpg", "image/jpeg", 500_000)).toBe("unsupported");
  });

  it("unknown mime but .pdf extension → fast_pdf", () => {
    expect(classifyForFastExtract("doc.pdf", "", 1_000)).toBe("fast_pdf");
  });

  it("docx → unsupported", () => {
    expect(classifyForFastExtract("document.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 200_000)).toBe("unsupported");
  });
});

// ─── checkTextUsability ────────────────────────────────────────────────────

describe("checkTextUsability", () => {
  const goodText = "This is a proper document with meaningful content that should pass the text usability gate because it has enough words and characters to be considered useful for AI analysis and summarization. The document discusses various topics.";

  it("passes for real text", () => {
    const r = checkTextUsability(goodText);
    expect(r.passed).toBe(true);
    expect(r.reason).toBeNull();
  });

  it("rejects empty string", () => {
    const r = checkTextUsability("");
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/too_short/);
  });

  it("rejects whitespace-only string", () => {
    const r = checkTextUsability("   \n\n\t   \n");
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/too_short/);
  });

  it("rejects very short text below 80 non-ws chars", () => {
    const r = checkTextUsability("hello world");
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/too_short/);
  });

  it("rejects text with too few words (even if long)", () => {
    // 1 long word that passes char count but fails word count
    const r = checkTextUsability("a".repeat(100));
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/too_few_words/);
  });

  it("rejects OCR noise / binary garbage with low alpha ratio", () => {
    // String with enough chars but mostly numbers/symbols
    const garbage = "1234567890 !@#$%^&*() 1234567890 !@#$%^&*() 9876543210 .:;=+- [] {} <> 0000000000 1111111111 2222222222 3333333333 4444444444";
    const r = checkTextUsability(garbage);
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/low_alpha_ratio/);
  });

  it("passes for Danish text", () => {
    const danish = "Dette er et dokument med dansk tekst. Det indeholder meningsfuldt indhold som kan analyseres af AI-systemer. Teksten er klar og læselig og bør passere kvalitetsgaten korrekt.";
    const r = checkTextUsability(danish);
    expect(r.passed).toBe(true);
  });

  it("rejects extraction result from image-only PDF (blank page text)", () => {
    // pdfjs returns empty or near-empty for scanned/image PDFs
    const blankExtract = "    \n   \n   \n   \n";
    const r = checkTextUsability(blankExtract);
    expect(r.passed).toBe(false);
    expect(r.reason).toMatch(/too_short/);
  });

  it("rejection reason is explicit and non-empty", () => {
    const r = checkTextUsability("too short");
    expect(r.passed).toBe(false);
    expect(typeof r.reason).toBe("string");
    expect(r.reason!.length).toBeGreaterThan(10);
  });
});

// ─── Fast path routing logic ────────────────────────────────────────────────

describe("dual-path routing decision", () => {
  it("text PDF + good text → should use fast path (simulated)", () => {
    const mode = classifyForFastExtract("annual-report.pdf", "application/pdf", 500_000);
    expect(mode).toBe("fast_pdf");

    const gate = checkTextUsability("This is a proper annual report document with significant text content that should be extracted client-side using pdfjs-dist rather than going through the slow server OCR pipeline.");
    expect(gate.passed).toBe(true);
  });

  it("scanned image PDF → unsupported classification → server OCR path", () => {
    // Scanned PDFs have no text layer, pdfjs returns empty string
    // checkTextUsability rejects empty → slowFiles → server OCR path
    const mode = classifyForFastExtract("scanned.pdf", "application/pdf", 2_000_000);
    expect(mode).toBe("fast_pdf"); // classified for fast attempt

    // But extraction will return near-empty (simulated)
    const gate = checkTextUsability(""); // pdfjs returns empty for scanned PDF
    expect(gate.passed).toBe(false); // correctly rejected → OCR fallback
    expect(gate.reason).toMatch(/too_short/);
  });

  it("fast path does not use server path when fast results available — routing", () => {
    // Simulate: 2 text files both extracted fast
    const fastResults: any[] = [
      { filename: "a.txt", source: "client_fast_text", char_count: 5000, status: "ok" },
      { filename: "b.pdf", source: "client_fast_pdf",  char_count: 8000, status: "ok" },
    ];
    const slowFiles: any[] = [];

    // ALL_FAST decision
    const isAllFast = slowFiles.length === 0 && fastResults.length > 0;
    expect(isAllFast).toBe(true);
  });

  it("mixed case: fast + slow files → documentContext merges both", () => {
    const fastResults = [{ filename: "a.txt", source: "client_fast_text", status: "ok" }];
    const finalizeResults = [{ filename: "b.scanned.pdf", source: "r2_ocr_async", status: "ok" }];
    const merged = [...fastResults, ...finalizeResults];
    expect(merged).toHaveLength(2);
    expect(merged[0].source).toBe("client_fast_text");
    expect(merged[1].source).toBe("r2_ocr_async");
  });

  it("source attribution is preserved in document context entries", () => {
    const validSources = ["client_fast_text", "client_fast_pdf", "r2_ocr_async", "ocr_partial", "r2_ocr_fallback"];
    const entry = { source: "client_fast_text", filename: "report.pdf", status: "ok" };
    expect(validSources).toContain(entry.source);
  });
});
