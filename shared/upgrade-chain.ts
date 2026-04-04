/**
 * upgrade-chain.ts
 *
 * Shared, environment-agnostic polling logic for the scanned-PDF upgrade chain.
 *
 * After a partial OCR answer is served, the client must wait for the full OCR
 * to complete and then trigger a second "upgrade" chat mutation with the complete text.
 *
 * This module contains the polling algorithm that waits for status=completed on
 * /api/ocr-status and returns the full OCR text.  It is extracted here (rather than
 * inline in the React component) so that it can be unit-tested without browser globals.
 *
 * ARCHITECTURE CONTRACT:
 *  - No React imports — pure TypeScript
 *  - No direct fetch calls — all HTTP is done via the injected `fetchStatus` function
 *  - Deterministic, easy to test by mocking `fetchStatus`
 *  - Used by:   client/src/pages/ai-chat.tsx (upgrade IIFE in onSuccess)
 *  - Tested by: tests/chat/upgrade-chain.test.ts
 */

export interface OcrStatusResponse {
  status: "completed" | "running" | "pending" | "failed" | "dead_letter" | "dead" | string;
  taskId?: string;
  ocrText?: string | null;
  ocr_text?: string | null;   // some server paths snake_case the field
  charCount?: number;
  errorReason?: string;
  stage?: string | null;
  /** Number of document chunks processed so far (server-reported). */
  chunksProcessed?: number;
  /** Total number of chunks expected (server-reported, may be absent). */
  totalChunks?: number;
}

export interface UpgradePollOptions {
  /** How long to poll before giving up (ms). Default: 8 minutes. */
  deadlineMs?: number;
  /** Initial poll interval (ms). Default: 3 000. */
  initialPollMs?: number;
  /** Maximum poll interval (ms). Default: 10 000. */
  maxPollMs?: number;
  /** Backoff multiplier per iteration. Default: 1.4. */
  backoffFactor?: number;
  /** How many times to retry after completed+empty before giving up. Default: 5. */
  emptyTextRetries?: number;
  /** Delay between empty-text retries (ms). Default: 2 000. */
  emptyTextRetryMs?: number;
  /** Optional logger — receives structured log entries. */
  logger?: (entry: UpgradeLogEntry) => void;
  /**
   * Optional progress callback — called on every "running/pending" poll.
   * Receives the current status response and elapsed time (ms) so the caller
   * can update a progress label without coupling UI code into this module.
   */
  onProgress?: (statusData: OcrStatusResponse, elapsedMs: number) => void;
}

export interface UpgradeLogEntry {
  level: "info" | "warn" | "error";
  label: string;
  message: string;
  data?: Record<string, unknown>;
}

/**
 * Polls /api/ocr-status until the task is completed and ocrText is available.
 *
 * @param taskId     — The OCR task ID to poll.
 * @param fetchStatus — Async function that calls /api/ocr-status and returns parsed JSON
 *                      (or throws on network error).  Injected for testability.
 * @param opts       — Tuning options.
 * @returns          — The full OCR text (non-empty, trimmed), or "" if upgrade failed.
 */
export async function pollForCompletedOcr(
  taskId: string,
  fetchStatus: (taskId: string) => Promise<OcrStatusResponse>,
  opts: UpgradePollOptions = {},
): Promise<string> {
  const {
    deadlineMs       = 8 * 60 * 1_000,
    initialPollMs    = 3_000,
    maxPollMs        = 10_000,
    backoffFactor    = 1.4,
    emptyTextRetries = 5,
    emptyTextRetryMs = 2_000,
    logger,
    onProgress,
  } = opts;

  const label = `[upgrade:${taskId.slice(-8)}]`;
  const deadline = Date.now() + deadlineMs;

  const log = (level: UpgradeLogEntry["level"], message: string, data?: Record<string, unknown>) => {
    logger?.({ level, label, message, data });
  };

  log("info", "upgrade polling started", { deadlineMs });

  let pollMs = initialPollMs;
  let emptyRetryCount = 0;

  while (Date.now() < deadline) {
    let statusData: OcrStatusResponse | null = null;

    try {
      statusData = await fetchStatus(taskId);
    } catch (fetchErr) {
      log("warn", "status fetch error — retrying", { error: String(fetchErr) });
      await sleep(pollMs);
      continue;
    }

    const s = statusData.status;

    if (s === "completed") {
      const rawText = statusData.ocrText ?? statusData.ocr_text ?? "";
      log("info", `completed — ocrText chars=${rawText?.length ?? 0}`, { hasText: !!rawText?.trim() });

      if (rawText?.trim()) {
        return rawText.slice(0, 80_000);
      }

      // completed but empty text — can happen if DB write is slightly delayed
      emptyRetryCount += 1;
      log("warn", `completed with empty ocrText — retry ${emptyRetryCount}/${emptyTextRetries}`);
      if (emptyRetryCount >= emptyTextRetries) {
        log("error", "completed but ocrText always empty — upgrade aborted");
        return "";
      }
      await sleep(emptyTextRetryMs);
      continue;
    }

    if (s === "failed" || s === "dead_letter" || s === "dead") {
      log("error", "terminal OCR failure — upgrade aborted", { status: s });
      return "";
    }

    // Still running / pending — notify caller and backoff
    const elapsedMs = Date.now() - (deadline - deadlineMs);
    log("info", `status=${s} stage=${statusData.stage ?? "-"} chunks=${statusData.chunksProcessed ?? "-"} — polling in ${pollMs}ms`);
    onProgress?.(statusData, elapsedMs);
    await sleep(pollMs);
    pollMs = Math.min(Math.floor(pollMs * backoffFactor), maxPollMs);
  }

  log("error", "upgrade aborted — deadline reached without completed OCR");
  return "";
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
