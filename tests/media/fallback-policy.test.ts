import { describe, it, expect } from "vitest";
import { getFallbackChain, getNextFallback } from "../../server/lib/media/fallback-policy";

describe("fallback-policy", () => {
  describe("getFallbackChain", () => {
    it("returns a chain for pdf/ocr", () => {
      const chain = getFallbackChain("pdf", "ocr", "extract_text");
      expect(chain.length).toBeGreaterThan(0);
      expect(chain[0].provider).toBeDefined();
      expect(chain[0].model).toBeDefined();
      expect(chain[0].timeoutMs).toBeGreaterThan(0);
    });

    it("returns a chain for image/vision", () => {
      const chain = getFallbackChain("image", "vision", "analyze_image");
      expect(chain.length).toBeGreaterThan(0);
    });

    it("returns a chain for audio/transcription", () => {
      const chain = getFallbackChain("audio", "transcription", "transcribe_audio");
      expect(chain.length).toBeGreaterThan(0);
    });

    it("first model in pdf chain has shorter timeout than fallback", () => {
      const chain = getFallbackChain("pdf", "ocr", "extract_text");
      if (chain.length >= 2) {
        expect(chain[0].timeoutMs).toBeLessThanOrEqual(chain[1].timeoutMs);
      }
    });
  });

  describe("getNextFallback", () => {
    it("returns next provider on timeout", () => {
      const chain = getFallbackChain("pdf", "ocr", "extract_text");
      if (chain.length >= 2) {
        const next = getNextFallback("pdf", "ocr", "extract_text", 0, "timeout");
        expect(next).not.toBeNull();
        expect(next?.model).toBe(chain[1].model);
      }
    });

    it("returns null when no more fallbacks", () => {
      const chain = getFallbackChain("pdf", "ocr", "extract_text");
      const next = getNextFallback("pdf", "ocr", "extract_text", chain.length - 1, "timeout");
      expect(next).toBeNull();
    });

    it("returns null for non-retryable failures", () => {
      const next = getNextFallback("pdf", "ocr", "extract_text", 0, "file_too_large");
      expect(next).toBeNull();
    });
  });
});
