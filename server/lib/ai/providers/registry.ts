/**
 * AI Provider Registry
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Central registry of available provider adapters.
 * - openai:     fully implemented and active
 * - anthropic:  not yet implemented (Phase 3C placeholder)
 * - google:     not yet implemented (Phase 3C placeholder)
 *
 * The registry fails explicitly if a route selects an unavailable provider.
 * Never silently fall back to a different provider.
 */

import type { AiProviderKey } from "../config";
import type { AiProvider } from "./provider";
import { OpenAiProvider } from "./openai-provider";

const ACTIVE_PROVIDERS: Partial<Record<AiProviderKey, AiProvider>> = {
  openai: new OpenAiProvider(),
  // anthropic: not yet implemented — requires @anthropic-ai/sdk
  // google:    not yet implemented — requires @google/generative-ai
};

/**
 * Retrieve a registered and active provider by key.
 *
 * @throws Error if the provider is not yet implemented or not configured.
 *         The error message is explicit enough to be caught and wrapped
 *         by the caller into a typed AiError.
 */
export function getProvider(key: AiProviderKey): AiProvider {
  const provider = ACTIVE_PROVIDERS[key];
  if (!provider) {
    throw new Error(
      `AI provider '${key}' is not yet implemented. ` +
        `Available providers: ${Object.keys(ACTIVE_PROVIDERS).join(", ")}`,
    );
  }
  return provider;
}

/** Returns all currently active provider keys — for diagnostics only */
export function getActiveProviderKeys(): AiProviderKey[] {
  return Object.keys(ACTIVE_PROVIDERS) as AiProviderKey[];
}
