import { describe, it, expect } from "vitest";
import { validateOutput, validateProviderResponse } from "../../server/lib/media/output-validator";

describe("output-validator", () => {
  describe("validateProviderResponse", () => {
    it("rejects null or undefined", () => {
      expect(validateProviderResponse(null).isValid).toBe(false);
      expect(validateProviderResponse(undefined).isValid).toBe(false);
    });

    it("rejects empty string", () => {
      expect(validateProviderResponse("").isValid).toBe(false);
      expect(validateProviderResponse("   ").isValid).toBe(false);
    });

    it("accepts valid string", () => {
      expect(validateProviderResponse("Valid response").isValid).toBe(true);
    });

    it("accepts object (for future-proofing)", () => {
      expect(validateProviderResponse({ text: "Valid" }).isValid).toBe(true);
    });
  });

  describe("validateOutput", () => {
    it("rejects empty output", () => {
      const result = validateOutput({
        mediaType: "pdf",
        pipelineType: "ocr",
        text: "   ",
      });
      expect(result.isValid).toBe(false);
      expect(result.failureCode).toBe("EMPTY_OUTPUT");
    });

    it("rejects simulated/placeholder output", () => {
      const result = validateOutput({
        mediaType: "pdf",
        pipelineType: "ocr",
        text: "Dette er en simuleret test.",
      });
      expect(result.isValid).toBe(false);
      expect(result.failureCode).toBe("SIMULATED_OUTPUT_DETECTED");
    });

    it("rejects output that is too short for PDF", () => {
      const result = validateOutput({
        mediaType: "pdf",
        pipelineType: "ocr",
        text: "Kort",
      });
      expect(result.isValid).toBe(false);
      expect(result.failureCode).toBe("OUTPUT_TOO_SHORT");
    });

    it("rejects output with insufficient words for PDF", () => {
      const result = validateOutput({
        mediaType: "pdf",
        pipelineType: "ocr",
        text: "Dette er kort.", // 3 words, but length > 10. Wait, 3 words is accepted. Let's use 2 words.
      });
      // Actually "Dette er" is 2 words, length 8.
      const result2 = validateOutput({
        mediaType: "pdf",
        pipelineType: "ocr",
        text: "Megetlangtord udenmellemrum", // 2 words, length > 10
      });
      expect(result2.isValid).toBe(false);
      expect(result2.failureCode).toBe("INSUFFICIENT_WORD_COUNT");
    });

    it("accepts short output for image/vision", () => {
      const result = validateOutput({
        mediaType: "image",
        pipelineType: "vision",
        text: "Kort", // 1 word, length 4
      });
      expect(result.isValid).toBe(true);
    });

    it("rejects junk output (low unique word ratio)", () => {
      // Create a string with 30 words, all the same
      const text = Array(30).fill("junk").join(" ");
      const result = validateOutput({
        mediaType: "pdf",
        pipelineType: "ocr",
        text,
      });
      expect(result.isValid).toBe(false);
      expect(result.failureCode).toBe("JUNK_OUTPUT");
    });

    it("rejects junk output (repeated lines)", () => {
      // Create a string with 10 lines, all the same
      const text = Array(10).fill("This is a repeated line.").join("\n");
      const result = validateOutput({
        mediaType: "pdf",
        pipelineType: "ocr",
        text,
      });
      expect(result.isValid).toBe(false);
      expect(result.failureCode).toBe("JUNK_OUTPUT");
    });

    it("accepts valid, realistic output", () => {
      const text = `
        Dette er en gyldig kontrakt.
        Den indeholder flere afsnit og forskellige ord.
        Dato: 1. januar 2024.
        Underskrift: Jens Jensen.
        Beløb: 10.000 kr.
      `;
      const result = validateOutput({
        mediaType: "pdf",
        pipelineType: "ocr",
        text,
      });
      expect(result.isValid).toBe(true);
      expect(result.metrics.wordCount).toBeGreaterThan(10);
    });
  });
});
