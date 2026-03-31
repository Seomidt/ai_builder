import { describe, it, expect } from "vitest";
import { evaluateRetry } from "../../server/lib/media/retry-policy";

describe("retry-policy", () => {
  it("retries timeout errors on first attempt", () => {
    const result = evaluateRetry("timeout", 1, 3);
    expect(result.shouldRetry).toBe(true);
    expect(result.deadLetter).toBe(false);
    expect(result.nextRetryAt).toBeDefined();
  });

  it("retries rate_limited errors with backoff", () => {
    const firstAttempt = evaluateRetry("rate_limited", 1, 3);
    const secondAttempt = evaluateRetry("rate_limited", 2, 3);
    expect(firstAttempt.shouldRetry).toBe(true);
    expect(secondAttempt.shouldRetry).toBe(true);
    // Second attempt should have longer delay than first
    expect(secondAttempt.nextRetryAt!.getTime()).toBeGreaterThan(firstAttempt.nextRetryAt!.getTime());
  });

  it("dead-letters after max attempts", () => {
    const result = evaluateRetry("timeout", 3, 3);
    expect(result.shouldRetry).toBe(false);
    expect(result.deadLetter).toBe(true);
  });

  it("never retries provider_permanent errors", () => {
    const result = evaluateRetry("provider_permanent", 1, 3);
    expect(result.shouldRetry).toBe(false);
    expect(result.deadLetter).toBe(false);
  });

  it("never retries unsupported_media errors", () => {
    const result = evaluateRetry("unsupported_media", 1, 3);
    expect(result.shouldRetry).toBe(false);
    expect(result.deadLetter).toBe(false);
  });

  it("never retries invalid_input errors", () => {
    const result = evaluateRetry("invalid_input", 1, 3);
    expect(result.shouldRetry).toBe(false);
    expect(result.deadLetter).toBe(false);
  });

  it("retries network errors", () => {
    const result = evaluateRetry("network", 1, 3);
    expect(result.shouldRetry).toBe(true);
  });

  it("retries provider_transient errors", () => {
    const result = evaluateRetry("provider_transient", 1, 3);
    expect(result.shouldRetry).toBe(true);
  });

  it("retries unknown errors", () => {
    const result = evaluateRetry("unknown", 1, 3);
    expect(result.shouldRetry).toBe(true);
  });

  it("includes a reason in all decisions", () => {
    const retryResult = evaluateRetry("timeout", 1, 3);
    const deadResult = evaluateRetry("timeout", 3, 3);
    const failResult = evaluateRetry("provider_permanent", 1, 3);
    expect(retryResult.reason).toBeTruthy();
    expect(deadResult.reason).toBeTruthy();
    expect(failResult.reason).toBeTruthy();
  });
});
