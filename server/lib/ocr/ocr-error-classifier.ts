import type { OcrFailureCategory } from "./ocr-types.ts";

export function classifyError(error: any): { category: OcrFailureCategory; code: string; message: string } {
  const message = error?.message || String(error);
  const code = error?.code || error?.name || "UNKNOWN_ERROR";

  // Timeout
  if (message.includes("timeout") || message.includes("AbortError") || code === "AbortError") {
    return { category: "timeout", code: "TIMEOUT", message };
  }

  // Network
  if (message.includes("fetch failed") || message.includes("ECONNREFUSED") || message.includes("ENOTFOUND")) {
    return { category: "network", code: "NETWORK_ERROR", message };
  }

  // Provider Transient (5xx, Rate Limit)
  if (message.includes("429") || message.includes("Too Many Requests") || message.includes("500") || message.includes("502") || message.includes("503") || message.includes("504")) {
    return { category: "provider_transient", code: "PROVIDER_TRANSIENT", message };
  }

  // Provider Permanent (4xx other than 429)
  if (message.includes("400") || message.includes("401") || message.includes("403") || message.includes("404")) {
    return { category: "provider_permanent", code: "PROVIDER_PERMANENT", message };
  }

  // Invalid Input
  if (message.includes("Unsupported media type") || message.includes("File too large") || message.includes("corrupted")) {
    return { category: "invalid_input", code: "INVALID_INPUT", message };
  }

  // Default
  return { category: "unknown", code, message };
}
