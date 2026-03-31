import type { OcrExecutionResult, OcrProvider } from "./ocr-types.ts";
import { OCR_FALLBACK_CHAIN, shouldFallback } from "./ocr-fallback-policy.ts";
import { GeminiOcrProvider } from "./providers/gemini-ocr.ts";

// Registry of available providers
const providers: Record<string, OcrProvider> = {
  "google": new GeminiOcrProvider(),
};

export async function executeOcrWithFallback(
  fileBuffer: Buffer,
  filename: string,
  mimeType: string,
  onAttempt: (attempt: number, provider: string, model: string) => void
): Promise<OcrExecutionResult> {
  let lastResult: OcrExecutionResult | null = null;
  let usedFallback = false;

  for (let i = 0; i < OCR_FALLBACK_CHAIN.length; i++) {
    const strategy = OCR_FALLBACK_CHAIN[i];
    const provider = providers[strategy.provider];

    if (!provider) {
      throw new Error(`Provider '${strategy.provider}' not found in registry.`);
    }

    onAttempt(i + 1, strategy.provider, strategy.model);

    const result = await provider.extractText(
      fileBuffer,
      filename,
      mimeType,
      strategy.model,
      strategy.timeoutMs
    );

    result.usedFallback = usedFallback;

    if (result.success) {
      return result;
    }

    lastResult = result;

    // Check if we should fallback based on the error category
    if (result.failureCategory && shouldFallback(result.failureCategory)) {
      usedFallback = true;
      continue; // Try next strategy
    } else {
      break; // Non-recoverable error (e.g., invalid input), stop fallback chain
    }
  }

  // If we exhaust the chain or hit a non-recoverable error, return the last failure
  return lastResult!;
}
