/**
 * OpenAI Provider Adapter
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Implements the AiProvider interface using the OpenAI Responses API.
 * This is the only fully-wired provider in Phase 3C.
 * All OpenAI-specific logic is encapsulated here — no other module
 * should import the OpenAI SDK directly for text generation.
 */

import OpenAI from "openai";
import { getOpenAIClient } from "../../openai-client";
import type { AiProvider, AiProviderGenerateInput, AiProviderGenerateResult } from "./provider";

export class OpenAiProvider implements AiProvider {
  readonly key = "openai";

  async generateText(input: AiProviderGenerateInput): Promise<AiProviderGenerateResult> {
    const { model, systemPrompt, userInput, timeoutMs } = input;

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
        },
        { signal: controller.signal },
      );

      const text = response.output_text ?? "";

      let usage: AiProviderGenerateResult["usage"] = null;
      if (response.usage) {
        usage = {
          input_tokens: response.usage.input_tokens ?? 0,
          output_tokens: response.usage.output_tokens ?? 0,
          total_tokens: response.usage.total_tokens ?? 0,
        };
      }

      return { text, usage, raw: response };
    } catch (err) {
      if (err instanceof OpenAI.APIError && err.status === 429) throw err;
      throw err;
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }
}
