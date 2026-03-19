/**
 * AI Service — Reusable text generation layer.
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 * All OpenAI calls in the application should go through this layer.
 *
 * Uses the OpenAI Responses API (client.responses.create).
 * For agent-specific JSON-structured calls, see server/lib/openai-client.ts chatJSON().
 */

import { getOpenAIClient } from "../openai-client";
import { AI_MODELS, AI_TIMEOUT_MS, AI_INPUT_PREVIEW_MAX_CHARS } from "./config";

/** Legacy model keys supported by this module — see AI_MODEL_ROUTES in config.ts for the full routing table */
type LegacyModelKey = keyof typeof AI_MODELS;

export interface GenerateTextInput {
  systemPrompt: string;
  userInput: string;
  /** Model key from AI_MODELS — defaults to "default" */
  model?: LegacyModelKey;
}

export interface GenerateTextUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface GenerateTextResult {
  text: string;
  usage: GenerateTextUsage | null;
  /** Raw OpenAI Responses API response object */
  raw: unknown;
  /** Input preview stored for logging (first N chars of userInput) */
  inputPreview: string;
  /** Resolved model identifier used for this call */
  model: string;
  latencyMs: number;
}

/**
 * Generate plain text via the OpenAI Responses API.
 *
 * Responsibilities:
 * - Resolves model from AI_MODELS
 * - Applies AI_TIMEOUT_MS via AbortSignal
 * - Returns typed result with usage metadata
 * - Does NOT log to ai_usage — callers decide whether to log
 *
 * @throws if OPENAI_API_KEY is not set or the API call fails
 */
export async function generateText(input: GenerateTextInput): Promise<GenerateTextResult> {
  const { systemPrompt, userInput, model: modelKey = "default" } = input;
  const resolvedModel = AI_MODELS[modelKey];
  const inputPreview = userInput.slice(0, AI_INPUT_PREVIEW_MAX_CHARS);

  const client = getOpenAIClient();
  const startMs = Date.now();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const response = await client.responses.create(
      {
        model: resolvedModel,
        instructions: systemPrompt,
        input: userInput,
      },
      { signal: controller.signal },
    );

    const latencyMs = Date.now() - startMs;
    clearTimeout(timeoutId);

    const text = response.output_text ?? "";

    let usage: GenerateTextUsage | null = null;
    if (response.usage) {
      usage = {
        input_tokens: response.usage.input_tokens ?? 0,
        output_tokens: response.usage.output_tokens ?? 0,
        total_tokens: response.usage.total_tokens ?? 0,
      };
    }

    return { text, usage, raw: response, inputPreview, model: resolvedModel, latencyMs };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}
