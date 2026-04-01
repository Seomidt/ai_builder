// ============================================================
// PHASE 5Y — Unified Media Processing Platform
// failure-classifier.ts — Central, deterministic failure taxonomy
// ============================================================

import type { FailureCategory } from "./media-types.ts";

export interface ClassifiedFailure {
  category: FailureCategory;
  code: string;
  message: string;
  retryable: boolean;
}

// ── Classification rules (ordered by specificity) ────────────────────────────

export function classifyFailure(error: unknown): ClassifiedFailure {
  const err = error as any;
  const message: string = err?.message || String(error) || "Unknown error";
  const name: string = err?.name || "";
  const code: string = err?.code || name || "UNKNOWN_ERROR";
  const status: number = err?.status || err?.statusCode || 0;

  // ── Hard timeout (AbortController / Promise.race) ─────────────────────────
  if (
    name === "TimeoutError" ||
    name === "AbortError" ||
    message.includes("timed out") ||
    message.includes("AbortError")
  ) {
    return { category: "timeout", code: "TIMEOUT", message, retryable: true };
  }

  // ── Rate limited ──────────────────────────────────────────────────────────
  if (
    status === 429 ||
    message.includes("429") ||
    message.includes("Too Many Requests") ||
    message.includes("quota") ||
    message.includes("RESOURCE_EXHAUSTED")
  ) {
    return { category: "rate_limited", code: "RATE_LIMITED", message, retryable: true };
  }

  // ── Provider transient (5xx) ──────────────────────────────────────────────
  if (
    status >= 500 ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("UNAVAILABLE") ||
    message.includes("INTERNAL")
  ) {
    return { category: "provider_transient", code: "PROVIDER_TRANSIENT", message, retryable: true };
  }

  // ── Network / connectivity ────────────────────────────────────────────────
  if (
    code === "ECONNREFUSED" ||
    code === "ENOTFOUND" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    message.includes("fetch failed") ||
    message.includes("network") ||
    message.includes("ECONNREFUSED") ||
    message.includes("ENOTFOUND")
  ) {
    return { category: "network", code: "NETWORK_ERROR", message, retryable: true };
  }

  // ── Unsupported media type ────────────────────────────────────────────────
  if (
    message.includes("Unsupported media type") ||
    message.includes("UNSUPPORTED_MEDIA") ||
    message.includes("unsupported mime") ||
    message.includes("MEDIA_TOO_LARGE") ||
    message.includes("VIDEO_TOO_LONG") ||
    message.includes("COST_LIMIT_EXCEEDED")
  ) {
    return { category: "unsupported_media", code: "UNSUPPORTED_MEDIA", message, retryable: false };
  }

  // ── Invalid input (corrupted file, bad content) ───────────────────────────
  if (
    message.includes("corrupted") ||
    message.includes("invalid PDF") ||
    message.includes("malformed") ||
    message.includes("INVALID_ARGUMENT") ||
    message.includes("File too large") ||
    message.includes("INVALID_INPUT") ||
    message.includes("cannot parse")
  ) {
    return { category: "invalid_input", code: "INVALID_INPUT", message, retryable: false };
  }

  // ── Invalid output (empty, junk, simulated) ───────────────────────────────
  if (
    code === "EMPTY_OUTPUT" ||
    code === "OUTPUT_TOO_SHORT" ||
    code === "INSUFFICIENT_WORD_COUNT" ||
    code === "JUNK_OUTPUT" ||
    code === "SIMULATED_OUTPUT_DETECTED" ||
    code === "EMPTY_PROVIDER_RESPONSE" ||
    code === "MALFORMED_PROVIDER_RESPONSE" ||
    message.includes("invalid_output")
  ) {
    return { category: "invalid_output", code: code || "INVALID_OUTPUT", message, retryable: false };
  }

  // ── Provider permanent (4xx excluding 429) ────────────────────────────────
  if (
    status === 400 ||
    status === 401 ||
    status === 403 ||
    status === 404 ||
    message.includes("PERMISSION_DENIED") ||
    message.includes("UNAUTHENTICATED") ||
    message.includes("NOT_FOUND") ||
    message.includes("400 Bad Request") ||
    message.includes("401") ||
    message.includes("403")
  ) {
    return { category: "provider_permanent", code: "PROVIDER_PERMANENT", message, retryable: false };
  }

  // ── Storage (R2 / Supabase Storage) ──────────────────────────────────────
  if (
    message.includes("R2") ||
    message.includes("storage") ||
    message.includes("NoSuchKey") ||
    message.includes("S3") ||
    message.includes("bucket")
  ) {
    return { category: "storage", code: "STORAGE_ERROR", message, retryable: true };
  }

  // ── Database ──────────────────────────────────────────────────────────────
  if (
    message.includes("database") ||
    message.includes("postgres") ||
    message.includes("supabase") ||
    message.includes("PGRST") ||
    code.startsWith("PG")
  ) {
    return { category: "db", code: "DB_ERROR", message, retryable: true };
  }

  // ── Internal / programming error ─────────────────────────────────────────
  if (
    message.includes("Cannot read") ||
    message.includes("is not a function") ||
    message.includes("undefined") ||
    name === "TypeError" ||
    name === "ReferenceError"
  ) {
    return { category: "internal", code: "INTERNAL_ERROR", message, retryable: false };
  }

  // ── Fallback: unknown ─────────────────────────────────────────────────────
  return { category: "unknown", code: code || "UNKNOWN_ERROR", message, retryable: true };
}

// ── Convenience: is this category retryable? ─────────────────────────────────
export function isCategoryRetryable(category: FailureCategory): boolean {
  const retryableCategories: FailureCategory[] = [
    "timeout",
    "provider_transient",
    "network",
    "rate_limited",
    "storage",
    "db",
    "unknown",
  ];
  return retryableCategories.includes(category);
}
