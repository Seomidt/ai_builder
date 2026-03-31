import type { OcrFailureCategory } from "./ocr-types.ts";

export function isRetryable(category: OcrFailureCategory): boolean {
  return ["timeout", "provider_transient", "network", "db", "storage", "internal", "unknown"].includes(category);
}

export function calculateNextRetryAt(attemptCount: number): Date {
  // Exponential backoff: 1m, 2m, 4m, 8m...
  const backoffMinutes = Math.pow(2, attemptCount - 1);
  const nextRetry = new Date();
  nextRetry.setMinutes(nextRetry.getMinutes() + backoffMinutes);
  return nextRetry;
}
