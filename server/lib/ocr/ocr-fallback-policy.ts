import type { OcrFailureCategory } from "./ocr-types.ts";

export interface FallbackStrategy {
  provider: string;
  model: string;
  timeoutMs: number;
}

export const OCR_FALLBACK_CHAIN: FallbackStrategy[] = [
  { provider: "google", model: "gemini-2.5-flash", timeoutMs: 30000 }, // Fast, cheap, primary
  { provider: "google", model: "gemini-1.5-pro", timeoutMs: 60000 },   // Slower, more robust, secondary
];

export function shouldFallback(category: OcrFailureCategory): boolean {
  // We fallback on timeouts, transient errors, or network issues.
  // We DO NOT fallback on invalid input (e.g., corrupted file) or permanent provider errors (e.g., auth failure).
  return ["timeout", "provider_transient", "network", "unknown"].includes(category);
}
