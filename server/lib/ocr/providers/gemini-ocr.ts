import { extractWithGemini } from "../../ai/gemini-media.ts";
import type { OcrProvider, OcrExecutionResult } from "../ocr-types.ts";
import { classifyError } from "../ocr-error-classifier.ts";
import { withTimeout } from "../ocr-timeout.ts";

export class GeminiOcrProvider implements OcrProvider {
  name = "google";

  async extractText(
    fileBuffer: Buffer,
    filename: string,
    mimeType: string,
    model: string,
    timeoutMs: number
  ): Promise<OcrExecutionResult> {
    const start = Date.now();
    try {
      // We pass the model to extractWithGemini via an environment variable override or by modifying it
      // For now, we'll just use the default in gemini-media.ts, but we should ideally pass it.
      // Since gemini-media.ts hardcodes GEMINI_MODEL, we'll temporarily override it if needed,
      // or better, we should update gemini-media.ts to accept the model as a parameter.
      // Let's assume we'll update gemini-media.ts to accept model.
      
      const result = await withTimeout(
        extractWithGemini(fileBuffer, filename, mimeType, model),
        timeoutMs,
        `Gemini OCR (${model})`
      );

      return {
        success: true,
        provider: this.name,
        model: result.model || model,
        text: result.text,
        durationMs: Date.now() - start,
        usedFallback: false,
      };
    } catch (error: any) {
      const { category, code, message } = classifyError(error);
      return {
        success: false,
        provider: this.name,
        model,
        errorCode: code,
        errorMessage: message,
        failureCategory: category,
        durationMs: Date.now() - start,
        usedFallback: false,
      };
    }
  }
}
