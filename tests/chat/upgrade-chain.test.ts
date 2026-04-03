/**
 * UPGRADE CHAIN TESTS — pollForCompletedOcr
 *
 * Tests the scanned-PDF upgrade chain:
 *   partial_ready → first partial answer → poll until completed → final full answer
 *
 * All tests use a mocked fetchStatus so no DB or network calls are made.
 *
 * Per the bug report (2026-04-03):
 *   "For scanned/image-generated PDFs, the app never produces the final full answer
 *    even after 5 minutes."
 * Root cause: the old SSE-based upgrade used AbortSignal.timeout(90_000) which
 * killed the connection before completed arrived for large PDFs (OCR takes 3-10 min).
 * Fix: replaced SSE with pollForCompletedOcr which polls for up to 8 minutes.
 */

import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { pollForCompletedOcr, type OcrStatusResponse, type UpgradeLogEntry } from "../../shared/upgrade-chain.ts";

// ─── Helpers ────────────────────────────────────────────────────────────────────

/** Build a fetchStatus mock that returns the given responses in order, then loops. */
function buildFetcher(responses: OcrStatusResponse[]): (taskId: string) => Promise<OcrStatusResponse> {
  let i = 0;
  return async (_taskId: string): Promise<OcrStatusResponse> => {
    const res = responses[i];
    i = Math.min(i + 1, responses.length - 1);
    return res;
  };
}

/** Collect log entries into an array for assertion. */
function makeLogger(): { entries: UpgradeLogEntry[]; fn: (e: UpgradeLogEntry) => void } {
  const entries: UpgradeLogEntry[] = [];
  return { entries, fn: (e) => entries.push(e) };
}

// Use very short poll intervals for tests — don't want 3s waits in CI
const FAST_OPTS = { initialPollMs: 1, maxPollMs: 5, backoffFactor: 1, emptyTextRetryMs: 1 };

// ─── Test 1: Already-completed (fast-path) ────────────────────────────────────

describe("Test 1 — scanned PDF already completed when upgrade starts", () => {
  it("returns ocrText immediately if status=completed on first poll", async () => {
    const fetcher = buildFetcher([
      { status: "completed", ocrText: "Dette er det fulde OCR-dokument.", charCount: 100 },
    ]);
    const logger = makeLogger();
    const result = await pollForCompletedOcr("task-001", fetcher, { ...FAST_OPTS, logger: logger.fn });
    assert.equal(result, "Dette er det fulde OCR-dokument.");
    assert.ok(logger.entries.some(e => e.message.includes("completed")), "must log completed");
    assert.ok(!logger.entries.some(e => e.level === "error"), "must have no errors");
  });

  it("returns ocrText if status=completed and ocrText is in ocr_text (snake_case field)", async () => {
    const fetcher = buildFetcher([
      { status: "completed", ocr_text: "Indhold fra snake_case felt.", ocrText: undefined },
    ]);
    const result = await pollForCompletedOcr("task-002", fetcher, { ...FAST_OPTS });
    assert.equal(result, "Indhold fra snake_case felt.");
  });
});

// ─── Test 2: Scanned PDF partial first, completed later ───────────────────────

describe("Test 2 — scanned PDF partial first, completed later → final answer mutation runs", () => {
  it("returns fullText after a few running→completed polls", async () => {
    const fetcher = buildFetcher([
      { status: "running", stage: "partial_ready" },
      { status: "running", stage: "chunking" },
      { status: "completed", ocrText: "Fuldt indhold af det scannede dokument.", charCount: 38 },
    ]);
    const logger = makeLogger();
    const result = await pollForCompletedOcr("task-003", fetcher, { ...FAST_OPTS, logger: logger.fn });
    assert.equal(result, "Fuldt indhold af det scannede dokument.");
    assert.ok(logger.entries.some(e => e.level === "info" && e.message.includes("completed")),
      "must log completed with ocrText info");
  });

  it("polls multiple times before getting completed — correct backoff sequence", async () => {
    const pollCounts: string[] = [];
    let call = 0;
    const fetcher = async (_: string): Promise<OcrStatusResponse> => {
      call++;
      pollCounts.push(`call-${call}`);
      if (call < 5) return { status: "running", stage: "processing" };
      return { status: "completed", ocrText: "Færdig tekst efter 5 kald.", charCount: 26 };
    };
    const result = await pollForCompletedOcr("task-004", fetcher, { ...FAST_OPTS });
    assert.equal(result, "Færdig tekst efter 5 kald.");
    assert.equal(call, 5, "must have made exactly 5 fetchStatus calls");
  });
});

// ─── Test 3: Completed without ocrText → fallback retries ─────────────────────

describe("Test 3 — completed without ocrText → retries and gets text", () => {
  it("retries empty ocrText after completed and eventually gets text", async () => {
    const fetcher = buildFetcher([
      { status: "completed", ocrText: "" },         // empty on first completed check
      { status: "completed", ocrText: "" },         // still empty
      { status: "completed", ocrText: "Nu er teksten her!", charCount: 18 },  // text arrives
    ]);
    const logger = makeLogger();
    const result = await pollForCompletedOcr("task-005", fetcher, { ...FAST_OPTS, logger: logger.fn });
    assert.equal(result, "Nu er teksten her!");
    const warnEntries = logger.entries.filter(e => e.level === "warn");
    assert.ok(warnEntries.some(e => e.message.includes("empty ocrText")),
      "must warn about empty ocrText retries");
  });

  it("returns '' after emptyTextRetries exhausted — no silent no-op (logs error)", async () => {
    const fetcher = buildFetcher([
      { status: "completed", ocrText: "" },
    ]);
    const logger = makeLogger();
    const result = await pollForCompletedOcr("task-006", fetcher, {
      ...FAST_OPTS,
      emptyTextRetries: 3,
      logger: logger.fn,
    });
    assert.equal(result, "", "must return empty string after exhausted retries");
    const errEntries = logger.entries.filter(e => e.level === "error");
    assert.ok(errEntries.length > 0, "must log an error — no silent no-op");
    assert.ok(errEntries.some(e => e.message.includes("always empty")),
      "error must mention ocrText is always empty");
  });
});

// ─── Test 4: Final state must NOT be provisional after completed OCR ──────────

describe("Test 4 — final state is not provisional after completed OCR exists", () => {
  it("returns the full text, not the provisional placeholder", async () => {
    const PROVISIONAL = "Jeg har kun analyseret den første del af dokumentet";
    const fetcher = buildFetcher([
      { status: "running", stage: "partial_ready" },
      { status: "completed", ocrText: "Komplet juridisk kontrakt — 45 sider.", charCount: 500 },
    ]);
    const result = await pollForCompletedOcr("task-007", fetcher, { ...FAST_OPTS });
    assert.ok(!result.includes(PROVISIONAL), "result must not be the provisional placeholder");
    assert.ok(result.trim().length > 0, "result must be non-empty full text");
    assert.ok(result.includes("Komplet juridisk kontrakt"), "result must be the actual full text");
  });
});

// ─── Test 5: No silent no-op — errors are always logged ──────────────────────

describe("Test 5 — no silent no-op on any failure path", () => {
  it("logs error and returns '' on terminal job failure (failed)", async () => {
    const fetcher = buildFetcher([
      { status: "failed", errorReason: "OCR engine crashed" },
    ]);
    const logger = makeLogger();
    const result = await pollForCompletedOcr("task-008", fetcher, { ...FAST_OPTS, logger: logger.fn });
    assert.equal(result, "");
    assert.ok(logger.entries.some(e => e.level === "error" && e.message.includes("terminal")),
      "must log terminal failure error — no silent no-op");
  });

  it("logs error and returns '' on dead_letter", async () => {
    const fetcher = buildFetcher([
      { status: "dead_letter", errorReason: "Max retries exceeded" },
    ]);
    const logger = makeLogger();
    const result = await pollForCompletedOcr("task-009", fetcher, { ...FAST_OPTS, logger: logger.fn });
    assert.equal(result, "");
    assert.ok(logger.entries.some(e => e.level === "error"), "must log error for dead_letter");
  });

  it("logs error and returns '' when deadline expires without completed", async () => {
    const fetcher = buildFetcher([
      { status: "running", stage: "processing" },
    ]);
    const logger = makeLogger();
    const result = await pollForCompletedOcr("task-010", fetcher, {
      ...FAST_OPTS,
      deadlineMs: 5,   // 5ms deadline — will expire immediately
      logger: logger.fn,
    });
    assert.equal(result, "");
    assert.ok(logger.entries.some(e => e.level === "error" && e.message.includes("deadline")),
      "must log deadline-expired error — not a silent no-op");
  });

  it("recovers from fetch errors and retries successfully", async () => {
    let call = 0;
    const fetcher = async (_: string): Promise<OcrStatusResponse> => {
      call++;
      if (call <= 2) throw new Error("Network timeout");
      return { status: "completed", ocrText: "Tekst hentet efter netværksfejl.", charCount: 32 };
    };
    const logger = makeLogger();
    const result = await pollForCompletedOcr("task-011", fetcher, { ...FAST_OPTS, logger: logger.fn });
    assert.equal(result, "Tekst hentet efter netværksfejl.");
    assert.ok(logger.entries.some(e => e.level === "warn" && e.message.includes("fetch error")),
      "must warn on fetch errors (not silently ignore)");
  });
});

// ─── Test 6: ocrText length limit ─────────────────────────────────────────────

describe("Test 6 — ocrText is clamped to 80,000 chars", () => {
  it("returns at most 80,000 chars even if ocrText is larger", async () => {
    const bigText = "A".repeat(120_000);
    const fetcher = buildFetcher([
      { status: "completed", ocrText: bigText, charCount: 120_000 },
    ]);
    const result = await pollForCompletedOcr("task-012", fetcher, { ...FAST_OPTS });
    assert.equal(result.length, 80_000, "result must be clamped to 80,000 chars");
  });
});

// ─── Test 7: pending status ────────────────────────────────────────────────────

describe("Test 7 — pending status is treated as not-yet-ready", () => {
  it("polls through pending → running → completed", async () => {
    const fetcher = buildFetcher([
      { status: "pending" },
      { status: "running", stage: "uploading" },
      { status: "completed", ocrText: "Færdig.", charCount: 7 },
    ]);
    const result = await pollForCompletedOcr("task-013", fetcher, { ...FAST_OPTS });
    assert.equal(result, "Færdig.");
  });
});

// ─── Test 8: full chain — partial_ready then completed ─────────────────────────
// Bug scenario: scanned PDF → partial_ready fires early → later completed arrives.
// pollForCompletedOcr is called AFTER partial answer is shown, so it starts polling
// from a "still running" state and must detect completed and return full OCR text.

describe("Test 8 — full upgrade chain: running (partial_ready) → completed", () => {
  it("returns full OCR text after partial_ready sentinel followed by completed", async () => {
    // Simulates the state at the start of polling:
    // job was in partial_ready (still running OCR) when polling starts
    const fetcher = buildFetcher([
      { status: "running", stage: "partial_ready" },   // job still running at poll start
      { status: "running", stage: "chunking" },
      { status: "running", stage: "embedding" },
      { status: "completed", ocrText: "Fuldstændigt dokument — alle 87 sider.", charCount: 1200 },
    ]);
    const logger = makeLogger();
    const result = await pollForCompletedOcr("task-014", fetcher, { ...FAST_OPTS, logger: logger.fn });
    assert.ok(result.includes("Fuldstændigt dokument"), "must return the full completed text");
    assert.ok(result.trim().length > 0, "result must be non-empty");
    assert.ok(!logger.entries.some(e => e.level === "error"), "no errors expected on normal completion");
  });

  it("handles transition: partial_ready → brief completed-but-empty → completed-with-text", async () => {
    const fetcher = buildFetcher([
      { status: "running", stage: "partial_ready" },
      { status: "completed", ocrText: "" },            // briefly completed but text not written yet
      { status: "completed", ocrText: "Nu er teksten klar.", charCount: 18 },
    ]);
    const logger = makeLogger();
    const result = await pollForCompletedOcr("task-015", fetcher, { ...FAST_OPTS, emptyTextRetries: 3, logger: logger.fn });
    assert.equal(result, "Nu er teksten klar.", "must return text after empty-then-populated sequence");
    assert.ok(logger.entries.some(e => e.level === "warn" && e.message.includes("empty ocrText")),
      "must warn about the briefly empty ocrText");
  });
});

// ─── Test 9: mutation-retry precondition — poll returns non-empty before caller retries ──
// Verifies that pollForCompletedOcr returns a non-empty string in conditions where
// the mutation retry loop would be triggered. The actual mutation retry is in the
// React component (not testable in vitest), but we verify the polling contract.

describe("Test 9 — polling contract: non-empty text is always returned if completed is reachable", () => {
  it("returns non-empty text even after multiple fetch errors before completion", async () => {
    let calls = 0;
    const fetcher = async (_: string): Promise<OcrStatusResponse> => {
      calls++;
      if (calls === 1) throw new Error("Connection refused");       // network error
      if (calls === 2) throw new Error("Gateway timeout");          // another error
      if (calls === 3) return { status: "running", stage: "ocr" }; // back to normal
      return { status: "completed", ocrText: "Endelig — fuld tekst.", charCount: 20 };
    };
    const logger = makeLogger();
    const result = await pollForCompletedOcr("task-016", fetcher, { ...FAST_OPTS, logger: logger.fn });
    assert.equal(result, "Endelig — fuld tekst.");
    assert.ok(logger.entries.filter(e => e.level === "warn").length >= 2,
      "must warn at least twice about fetch errors");
    assert.ok(!logger.entries.some(e => e.level === "error"),
      "no error logged when recovery was possible");
  });

  it("emptyTextRetries=5 exhausted → returns '' and logs error — caller must show fallback UI", async () => {
    // Simulates completed with DB lag that never resolves (text stays empty forever).
    // This is the case where the retry loop in the upgrade IIFE shows the fallback message.
    const fetcher = buildFetcher([
      { status: "completed", ocrText: "" },
    ]);
    const logger = makeLogger();
    const result = await pollForCompletedOcr("task-017", fetcher, {
      ...FAST_OPTS, emptyTextRetries: 5, emptyTextRetryMs: 1, logger: logger.fn,
    });
    assert.equal(result, "", "must return empty string when text never arrives");
    const errors = logger.entries.filter(e => e.level === "error");
    assert.ok(errors.length > 0, "must log at least one error — no silent no-op");
    assert.ok(errors.some(e => e.message.includes("always empty") || e.message.includes("empty")),
      "error must reference the empty ocrText problem");
  });
});
