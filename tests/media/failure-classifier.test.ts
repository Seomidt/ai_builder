import { describe, it, expect } from "vitest";
import { classifyFailure } from "../../server/lib/media/failure-classifier";

describe("failure-classifier", () => {
  it("classifies timeout errors", () => {
    const result = classifyFailure(new Error("Request timed out after 30000ms"));
    expect(result.category).toBe("timeout");
    expect(result.retryable).toBe(true);
  });

  it("classifies AbortError as timeout", () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    const result = classifyFailure(err);
    expect(result.category).toBe("timeout");
    expect(result.retryable).toBe(true);
  });

  it("classifies rate limit errors (429 status)", () => {
    const result = classifyFailure({ status: 429, message: "Too Many Requests" });
    expect(result.category).toBe("rate_limited");
    expect(result.retryable).toBe(true);
  });

  it("classifies rate limit errors (quota message)", () => {
    const result = classifyFailure(new Error("quota exceeded: RESOURCE_EXHAUSTED"));
    expect(result.category).toBe("rate_limited");
    expect(result.retryable).toBe(true);
  });

  it("classifies 5xx server errors as provider_transient", () => {
    const result = classifyFailure({ status: 500, message: "Internal server error" });
    expect(result.category).toBe("provider_transient");
    expect(result.retryable).toBe(true);
  });

  it("classifies network ECONNRESET as network error", () => {
    const err = new Error("ECONNRESET: Connection reset by peer");
    (err as any).code = "ECONNRESET";
    const result = classifyFailure(err);
    expect(result.category).toBe("network");
    expect(result.retryable).toBe(true);
  });

  it("classifies 400 bad request as provider_permanent", () => {
    const result = classifyFailure({ status: 400, message: "400 Bad Request" });
    expect(result.category).toBe("provider_permanent");
    expect(result.retryable).toBe(false);
  });

  it("classifies 403 as provider_permanent", () => {
    const result = classifyFailure({ status: 403, message: "PERMISSION_DENIED" });
    expect(result.category).toBe("provider_permanent");
    expect(result.retryable).toBe(false);
  });

  it("classifies unsupported media type errors", () => {
    const result = classifyFailure(new Error("Unsupported media type: application/x-rar"));
    expect(result.category).toBe("unsupported_media");
    expect(result.retryable).toBe(false);
  });

  it("classifies invalid PDF as invalid_input", () => {
    const result = classifyFailure(new Error("invalid PDF: corrupted file header"));
    expect(result.category).toBe("invalid_input");
    expect(result.retryable).toBe(false);
  });

  it("classifies storage errors as retryable", () => {
    const result = classifyFailure(new Error("R2 NoSuchKey: file not found in bucket"));
    expect(result.category).toBe("storage");
    expect(result.retryable).toBe(true);
  });

  it("classifies database errors as retryable", () => {
    const result = classifyFailure(new Error("database connection failed: postgres error"));
    expect(result.category).toBe("db");
    expect(result.retryable).toBe(true);
  });

  it("returns unknown for unrecognised errors with a code", () => {
    const result = classifyFailure(new Error("Something completely unexpected xyz123"));
    expect(result.category).toBe("unknown");
    expect(result.code).toBeDefined();
    expect(result.message).toBeTruthy();
  });

  it("returns all required fields in ClassifiedFailure", () => {
    const result = classifyFailure(new Error("test error"));
    expect(result).toHaveProperty("category");
    expect(result).toHaveProperty("code");
    expect(result).toHaveProperty("message");
    expect(result).toHaveProperty("retryable");
  });
});
