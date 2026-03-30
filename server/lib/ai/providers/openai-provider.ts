/**
 * OpenAI Provider Adapter
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Implements the AiProvider interface using the OpenAI Responses API.
 * This is the only fully-wired provider in Phase 3C.
 * All OpenAI-specific logic is encapsulated here — no other module
 * should import the OpenAI SDK directly for text generation.
 *
 * Token extraction:
 *   cached_input_tokens — usage.input_token_details.cached_tokens (0 if absent)
 *   reasoning_tokens    — usage.output_token_details.reasoning_tokens (0 if absent)
 */

import { getOpenAIClient } from "../../openai-client.ts";
import type { AiProvider, AiProviderGenerateInput, AiProviderGenerateResult } from "./provider.ts";

export class OpenAiProvider implements AiProvider {
  readonly key = "openai";

  async generateText(input: AiProviderGenerateInput): Promise<AiProviderGenerateResult> {
    const { model, systemPrompt, userInput, timeoutMs, maxOutputTokens } = input;

    const client = getOpenAIClient();

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    }

    try {
      const response = await client.responses.create(
        {
          model,
          instructions: systemPrompt,
          input: userInput,
          ...(maxOutputTokens !== undefined ? { max_output_tokens: maxOutputTokens } : {}),
        },
        { signal: controller.signal },
      );

      const text = response.output_text ?? "";

      let usage: AiProviderGenerateResult["usage"] = null;
      if (response.usage) {
        const raw = response.usage as {
          input_tokens?: number;
          output_tokens?: number;
          total_tokens?: number;
          input_token_details?: { cached_tokens?: number };
          output_token_details?: { reasoning_tokens?: number };
        };

        usage = {
          input_tokens: raw.input_tokens ?? 0,
          output_tokens: raw.output_tokens ?? 0,
          total_tokens: raw.total_tokens ?? 0,
          cached_input_tokens: raw.input_token_details?.cached_tokens ?? 0,
          reasoning_tokens: raw.output_token_details?.reasoning_tokens ?? 0,
        };
      }

      return { text, usage, raw: response };
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }
}
