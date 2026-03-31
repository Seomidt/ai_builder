/**
 * OpenAI Provider Adapter
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Implements the AiProvider interface using the OpenAI Chat Completions API.
 * Uses OPENAI_API_KEY directly against api.openai.com — no proxy.
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
      const completion = await client.chat.completions.create(
        {
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user",   content: userInput },
          ],
          ...(maxOutputTokens !== undefined ? { max_tokens: maxOutputTokens } : {}),
        },
        { signal: controller.signal },
      );

      const text = completion.choices[0]?.message?.content ?? "";

      let usage: AiProviderGenerateResult["usage"] = null;
      if (completion.usage) {
        usage = {
          input_tokens:        completion.usage.prompt_tokens     ?? 0,
          output_tokens:       completion.usage.completion_tokens ?? 0,
          total_tokens:        completion.usage.total_tokens      ?? 0,
          cached_input_tokens: 0,
          reasoning_tokens:    0,
        };
      }

      return { text, usage, raw: completion };
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }
}
