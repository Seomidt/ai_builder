// ============================================================
// PHASE 5Y — Unified Media Processing Platform
// providers/gemini-provider.ts — Unified Gemini provider for all step types
// ============================================================

import type { MediaProvider, StepType, StepExecutionResult } from "../media-types.ts";
import { extractWithGemini } from "../../ai/gemini-media.ts";
import { classifyFailure } from "../failure-classifier.ts";
import { withTimeout } from "../../ocr/ocr-timeout.ts";

export class GeminiProvider implements MediaProvider {
  name = "google";

  supportedStepTypes: StepType[] = [
    "ocr",
    "vision_caption",
    "transcribe_audio",
    "extract_text",
  ];

  async execute(
    fileBuffer: Buffer,
    filename: string,
    mimeType: string,
    model: string,
    timeoutMs: number,
    _metadata?: Record<string, unknown>
  ): Promise<StepExecutionResult> {
    const start = Date.now();

    try {
      const result = await withTimeout(
        extractWithGemini(fileBuffer, filename, mimeType, model),
        timeoutMs,
        `Gemini (${model}) for ${filename}`
      );

      return {
        success: true,
        provider: this.name,
        model: result.model || model,
        outputText: result.text,
        charCount: result.charCount,
        durationMs: Date.now() - start,
      };
    } catch (error: unknown) {
      const { category, code, message, retryable } = classifyFailure(error);
      return {
        success: false,
        provider: this.name,
        model,
        errorCode: code,
        errorMessage: message,
        failureCategory: category,
        retryable,
        durationMs: Date.now() - start,
      };
    }
  }
}

// ── Internal provider for non-AI steps ───────────────────────────────────────

export class InternalProvider implements MediaProvider {
  name = "internal";

  supportedStepTypes: StepType[] = [
    "preprocess",
    "normalize_text",
    "chunk_text",
    "persist_output",
    "merge_multimodal_output",
    "finalize",
  ];

  async execute(
    _fileBuffer: Buffer,
    _filename: string,
    _mimeType: string,
    model: string,
    _timeoutMs: number,
    metadata?: Record<string, unknown>
  ): Promise<StepExecutionResult> {
    const start = Date.now();

    // Internal steps are lightweight transformations — they use the
    // output_text from the previous step (passed via metadata).
    const inputText = (metadata?.previousOutputText as string) ?? "";

    switch (model) {
      case "text-normalizer": {
        // Normalize whitespace, remove null bytes, trim
        const normalized = inputText
          .replace(/\0/g, "")
          .replace(/\r\n/g, "\n")
          .replace(/\r/g, "\n")
          .replace(/[ \t]+\n/g, "\n")
          .replace(/\n{4,}/g, "\n\n\n")
          .trim();

        return {
          success: true,
          provider: this.name,
          model,
          outputText: normalized,
          charCount: normalized.length,
          durationMs: Date.now() - start,
        };
      }

      case "text-chunker": {
        // Simple chunking: count characters and report chunk count
        // Actual chunking happens in persist_output / embedding pipeline
        const CHUNK_SIZE = 2000;
        const chunkCount = Math.ceil(inputText.length / CHUNK_SIZE);
        return {
          success: true,
          provider: this.name,
          model,
          outputText: inputText,
          charCount: inputText.length,
          durationMs: Date.now() - start,
          metadata: { chunkCount },
        };
      }

      case "text-parser": {
        // For plain text files — just pass through
        return {
          success: true,
          provider: this.name,
          model,
          outputText: inputText,
          charCount: inputText.length,
          durationMs: Date.now() - start,
        };
      }

      case "merger": {
        // Merge multimodal outputs (transcription + vision)
        const transcription = (metadata?.transcriptionText as string) ?? "";
        const vision = (metadata?.visionText as string) ?? "";
        const merged = [
          transcription ? `=== TRANSSKRIPTION ===\n${transcription}` : "",
          vision ? `=== VISUEL BESKRIVELSE ===\n${vision}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");

        return {
          success: true,
          provider: this.name,
          model,
          outputText: merged,
          charCount: merged.length,
          durationMs: Date.now() - start,
        };
      }

      case "db-writer": {
        // DB write is handled by the worker — this step just signals readiness
        return {
          success: true,
          provider: this.name,
          model,
          outputText: inputText,
          charCount: inputText.length,
          durationMs: Date.now() - start,
        };
      }

      default:
        return {
          success: false,
          provider: this.name,
          model,
          errorCode: "UNKNOWN_INTERNAL_MODEL",
          errorMessage: `Unknown internal model: ${model}`,
          failureCategory: "internal",
          retryable: false,
          durationMs: Date.now() - start,
        };
    }
  }
}

// ── Provider registry ─────────────────────────────────────────────────────────

const PROVIDER_REGISTRY: Record<string, MediaProvider> = {
  google: new GeminiProvider(),
  internal: new InternalProvider(),
};

export function getProvider(providerName: string): MediaProvider {
  const provider = PROVIDER_REGISTRY[providerName];
  if (!provider) {
    throw new Error(`Provider '${providerName}' not found in registry`);
  }
  return provider;
}
