/**
 * AI Runner — Central Orchestration Entry Point
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * runAiCall() is the single function all future AI features should call.
 * It resolves provider + model via the router, invokes the provider adapter,
 * logs usage, normalises errors, and measures latency.
 *
 * Features never need to know which provider or model is used.
 * No business logic, no prompts, no retries, no streaming.
 *
 * Phase 3C: routes through router.ts → providers/registry.ts → provider adapter
 */

import OpenAI from "openai";
import { AI_MODEL_ROUTES, AI_TIMEOUT_MS, AI_INPUT_PREVIEW_MAX_CHARS } from "./config";
import { resolveRoute } from "./router";
import { getProvider } from "./providers/registry";
import { logAiUsage } from "./usage";
import {
  AiUnavailableError,
  AiTimeoutError,
  AiQuotaError,
  AiServiceError,
  type AiErrorMeta,
} from "./errors";
import type { AiCallContext, AiCallResult } from "./types";

export interface AiCallInput {
  systemPrompt: string;
  userInput: string;
}

/**
 * Execute a single AI call with full lifecycle management.
 *
 * Resolves provider + model through the router, delegates to the provider
 * adapter, logs usage to ai_usage, and returns a normalised AiCallResult.
 *
 * @param context  Identity, routing, and tracing metadata from the caller
 * @param input    System prompt and user input for the model
 * @returns        Normalised AiCallResult on success
 * @throws         Typed AiError subclass on failure — always after logging
 */
export async function runAiCall(
  context: AiCallContext,
  input: AiCallInput,
): Promise<AiCallResult> {
  const { feature, tenantId, userId, model: modelKey = "default" } = context;
  const startMs = Date.now();

  const route = resolveRoute(modelKey);
  const inputPreview = input.userInput.slice(0, AI_INPUT_PREVIEW_MAX_CHARS);

  let provider;
  try {
    provider = getProvider(route.provider);
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const meta: AiErrorMeta = { feature, model: route.model, latencyMs };
    const aiErr = normalizeError(err, meta);
    void logAiUsage({
      feature,
      tenantId: tenantId ?? null,
      userId: userId ?? null,
      requestId: context.requestId ?? null,
      model: route.model,
      status: "error",
      errorMessage: aiErr.message,
      latencyMs,
    });
    emitRunnerLog({ feature, model: route.model, latencyMs, success: false, error: aiErr.message });
    throw aiErr;
  }

  try {
    const result = await provider.generateText({
      model: route.model,
      systemPrompt: input.systemPrompt,
      userInput: input.userInput,
      timeoutMs: AI_TIMEOUT_MS,
    });

    const latencyMs = Date.now() - startMs;

    void logAiUsage({
      feature,
      tenantId: tenantId ?? null,
      userId: userId ?? null,
      requestId: context.requestId ?? null,
      model: route.model,
      promptTokens: result.usage?.input_tokens ?? null,
      completionTokens: result.usage?.output_tokens ?? null,
      totalTokens: result.usage?.total_tokens ?? null,
      inputPreview,
      status: "success",
      latencyMs,
    });

    emitRunnerLog({ feature, model: route.model, latencyMs, success: true });

    return {
      text: result.text,
      usage: result.usage
        ? {
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
            total_tokens: result.usage.total_tokens,
          }
        : null,
      latencyMs,
      model: route.model,
      feature,
    };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const meta: AiErrorMeta = { feature, model: route.model, latencyMs };

    const aiErr = normalizeError(err, meta);

    void logAiUsage({
      feature,
      tenantId: tenantId ?? null,
      userId: userId ?? null,
      requestId: context.requestId ?? null,
      model: route.model,
      status: "error",
      errorMessage: aiErr.message,
      latencyMs,
    });

    emitRunnerLog({ feature, model: route.model, latencyMs, success: false, error: aiErr.message });

    throw aiErr;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function normalizeError(
  err: unknown,
  meta: AiErrorMeta,
) {
  if (err instanceof OpenAI.APIError) {
    if (err.status === 429) return new AiQuotaError(meta);
    return new AiServiceError(err.message, meta);
  }

  if (err instanceof Error) {
    if (err.name === "AbortError") return new AiTimeoutError(meta);
    if (
      err.message.includes("OPENAI_API_KEY") ||
      err.message.includes("not yet implemented") ||
      err.message.includes("not configured")
    ) {
      return new AiUnavailableError(meta);
    }
    return new AiServiceError(err.message, meta);
  }

  return new AiServiceError(String(err), meta);
}

function emitRunnerLog(entry: {
  feature: string;
  model: string;
  latencyMs: number;
  success: boolean;
  error?: string;
}): void {
  const status = entry.success ? "✓" : "✗";
  const errSuffix = entry.error ? ` | error="${entry.error.slice(0, 120)}"` : "";
  console.log(
    `[ai:runner] ${status} feature=${entry.feature} model=${entry.model} latency=${entry.latencyMs}ms${errSuffix}`,
  );
}
