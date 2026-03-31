import { describe, it, expect } from "vitest";
import { estimateStepCost, checkGuardrails } from "../../server/lib/media/cost-policy";

const MB = 1024 * 1024;

describe("cost-policy", () => {
  describe("estimateStepCost", () => {
    it("estimates cost for a PDF OCR step", () => {
      const cost = estimateStepCost({
        provider: "google",
        model: "gemini-2.5-flash",
        stepType: "extract_text",
        fileSizeBytes: 7 * MB,
      });
      expect(cost).toBeGreaterThan(0);
      expect(cost).toBeLessThan(1); // Should be cheap
    });

    it("estimates higher cost for video than image", () => {
      const imageCost = estimateStepCost({
        provider: "google",
        model: "gemini-2.5-flash",
        stepType: "analyze_image",
        fileSizeBytes: 2 * MB,
      });
      const videoCost = estimateStepCost({
        provider: "google",
        model: "gemini-2.5-flash",
        stepType: "transcribe_audio",
        fileSizeBytes: 10 * MB,
        durationSec: 120,
      });
      expect(videoCost).toBeGreaterThanOrEqual(imageCost);
    });

    it("returns a numeric cost value", () => {
      const cost = estimateStepCost({
        provider: "google",
        model: "gemini-2.5-flash",
        stepType: "extract_text",
        fileSizeBytes: 7 * MB,
      });
      expect(typeof cost).toBe("number");
      expect(isNaN(cost)).toBe(false);
    });
  });

  describe("checkGuardrails", () => {
    it("allows processing within budget", () => {
      const result = checkGuardrails({ mediaType: "pdf", fileSizeBytes: 7 * MB });
      expect(result.blocked).toBe(false);
    });

    it("blocks files over 25MB upload limit", () => {
      const result = checkGuardrails({ mediaType: "pdf", fileSizeBytes: 30 * MB });
      expect(result.blocked).toBe(true);
      expect(result.errorCode).toBe("MEDIA_TOO_LARGE");
    });

    it("blocks files over 18MB AI limit for non-text types", () => {
      const result = checkGuardrails({ mediaType: "video", fileSizeBytes: 20 * MB });
      expect(result.blocked).toBe(true);
      expect(result.errorCode).toBe("MEDIA_TOO_LARGE_FOR_AI");
    });

    it("returns not blocked for small image", () => {
      const result = checkGuardrails({ mediaType: "image", fileSizeBytes: 2 * MB });
      expect(result.blocked).toBe(false);
    });
  });
});
