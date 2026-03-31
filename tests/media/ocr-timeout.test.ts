import { describe, it, expect, vi } from "vitest";
import { withTimeout } from "../../server/lib/ocr/ocr-timeout";

describe("withTimeout (via media-types)", () => {
  it("resolves successfully within timeout", async () => {
    const result = await withTimeout(
      Promise.resolve("success"),
      5000
    );
    expect(result).toBe("success");
  });

  it("rejects with timeout error when promise takes too long", async () => {
    const slowPromise = new Promise<string>((resolve) =>
      setTimeout(() => resolve("too late"), 10000)
    );

    await expect(withTimeout(slowPromise, 50)).rejects.toThrow(/timed out/i);
  });

  it("rejects immediately when timeout is 0", async () => {
    const promise = new Promise<string>((resolve) =>
      setTimeout(() => resolve("result"), 100)
    );

    await expect(withTimeout(promise, 0)).rejects.toThrow();
  });

  it("propagates original error if promise rejects before timeout", async () => {
    const failingPromise = Promise.reject(new Error("original error"));

    await expect(withTimeout(failingPromise, 5000)).rejects.toThrow("original error");
  });
});
