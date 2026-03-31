import { describe, it, expect } from "vitest";
import { validateInput, inferMediaType } from "../../server/lib/media/input-validator";

const MB = 1024 * 1024;

describe("input-validator", () => {
  it("accepts valid PDF under 18MB with ocr pipeline", () => {
    const result = validateInput({
      mimeType: "application/pdf",
      fileSizeBytes: 7 * MB,
      requestedPipeline: "ocr",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects PDF over 18MB", () => {
    const result = validateInput({
      mimeType: "application/pdf",
      fileSizeBytes: 20 * MB,
      requestedPipeline: "ocr",
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("MEDIA_TOO_LARGE_FOR_AI");
  });

  it("accepts valid JPEG image with vision pipeline", () => {
    const result = validateInput({
      mimeType: "image/jpeg",
      fileSizeBytes: 2 * MB,
      requestedPipeline: "vision",
    });
    expect(result.valid).toBe(true);
  });

  it("accepts valid MP4 video under 18MB", () => {
    const result = validateInput({
      mimeType: "video/mp4",
      fileSizeBytes: 15 * MB,
      requestedPipeline: "multimodal_extract",
    });
    expect(result.valid).toBe(true);
  });

  it("accepts valid MP3 audio with transcription pipeline", () => {
    const result = validateInput({
      mimeType: "audio/mpeg",
      fileSizeBytes: 5 * MB,
      requestedPipeline: "transcription",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects unsupported MIME type", () => {
    const result = validateInput({
      mimeType: "application/x-rar-compressed",
      fileSizeBytes: 1 * MB,
      requestedPipeline: "ocr",
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("UNSUPPORTED_MIME_TYPE");
  });

  it("rejects illegal pipeline for media type", () => {
    const result = validateInput({
      mimeType: "audio/mpeg",
      fileSizeBytes: 5 * MB,
      requestedPipeline: "ocr",
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("ILLEGAL_PIPELINE");
  });

  it("rejects file not found in storage", () => {
    const result = validateInput({
      mimeType: "application/pdf",
      fileSizeBytes: 1 * MB,
      requestedPipeline: "ocr",
      r2KeyExists: false,
    });
    expect(result.valid).toBe(false);
    expect(result.errorCode).toBe("FILE_NOT_FOUND");
    expect(result.retryable).toBe(true);
  });

  it("accepts plain text file with parsing pipeline", () => {
    const result = validateInput({
      mimeType: "text/plain",
      fileSizeBytes: 50 * 1024,
      requestedPipeline: "parsing",
    });
    expect(result.valid).toBe(true);
  });

  describe("inferMediaType", () => {
    it("infers pdf from application/pdf", () => {
      expect(inferMediaType("application/pdf")).toBe("pdf");
    });

    it("infers image from image/jpeg", () => {
      expect(inferMediaType("image/jpeg")).toBe("image");
    });

    it("infers audio from audio/mpeg", () => {
      expect(inferMediaType("audio/mpeg")).toBe("audio");
    });

    it("infers video from video/mp4", () => {
      expect(inferMediaType("video/mp4")).toBe("video");
    });

    it("returns null for unknown MIME type", () => {
      expect(inferMediaType("application/x-unknown")).toBeNull();
    });
  });
});
