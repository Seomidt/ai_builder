/**
 * AI Runner — Central Orchestration Entry Point
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * runAiCall() is the single function all future AI features should call.
 * It handles model resolution, provider invocation, usage logging, and
 * error normalisation in one place so callers never need to touch
 * generateText() or logAiUsage() directly.
 *
 * No business logic, no prompts, no retries, no streaming.
 */

import OpenAI from "openai";
import { AI_MODELS } from "./config";
import { generateText } from "./service";
import { logAiUsage } from "./usage";
import {
  AiUnavailableError,
  AiTimeoutError,
  AiQuotaError,
  AiServiceError,
} from "./errors";
import type { AiCallContext, AiCallResult } from "./types";

export interface AiCallInput {
  systemPrompt: string;
  userInput: string;
}

/**
 * Execute a single AI call with full lifecycle management.
 *
 * @param context  Identity and routing metadata from the caller
 * @param input    System prompt and user input for the model
 * @returns        Normalised AiCallResult on success
 * @throws         Typed AiError subclass on failure — always after logging
 */
export async function runAiCall(
  context: AiCallContext,
  input: AiCallInput,
): Promise<AiCallResult> {
  const { feature, tenantId, userId, model: modelKey = "default" } = context;
  const resolvedModel = AI_MODELS[modelKey];
  const startMs = Date.now();

  if (!process.env.OPENAI_API_KEY) {
    const latencyMs = Date.now() - startMs;
    const err = new AiUnavailableError({ feature, model: resolvedModel, latencyMs });
    void logAiUsage({
      feature,
      tenantId: tenantId ?? null,
      userId: userId ?? null,
      requestId: context.requestId ?? null,
      model: resolvedModel,
      status: "error",
      errorMessage: err.message,
      latencyMs,
    });
    emitRunnerLog({ feature, model: resolvedModel, latencyMs, success: false, error: err.message });
    throw err;
  }

  try {
    const result = await generateText({
      systemPrompt: input.systemPrompt,
      userInput: input.userInput,
      model: modelKey,
    });

    void logAiUsage({
      feature,
      tenantId: tenantId ?? null,
      userId: userId ?? null,
      requestId: context.requestId ?? null,
      model: result.model,
      promptTokens: result.usage?.input_tokens ?? null,
      completionTokens: result.usage?.output_tokens ?? null,
      totalTokens: result.usage?.total_tokens ?? null,
      inputPreview: result.inputPreview,
      status: "success",
      latencyMs: result.latencyMs,
    });

    emitRunnerLog({ feature, model: result.model, latencyMs: result.latencyMs, success: true });

    return {
      text: result.text,
      usage: result.usage
        ? {
            input_tokens: result.usage.input_tokens,
            output_tokens: result.usage.output_tokens,
            total_tokens: result.usage.total_tokens,
          }
        : null,
      latencyMs: result.latencyMs,
      model: result.model,
      feature,
    };
  } catch (err) {
    const latencyMs = Date.now() - startMs;
    const meta = { feature, model: resolvedModel, latencyMs };

    const aiErr = normalizeError(err, meta);

    void logAiUsage({
      feature,
      tenantId: tenantId ?? null,
      userId: userId ?? null,
      requestId: context.requestId ?? null,
      model: resolvedModel,
      status: "error",
      errorMessage: aiErr.message,
      latencyMs,
    });

    emitRunnerLog({ feature, model: resolvedModel, latencyMs, success: false, error: aiErr.message });

    throw aiErr;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function normalizeError(
  err: unknown,
  meta: { feature: string; model: string; latencyMs: number },
) {
  if (err instanceof OpenAI.APIError) {
    if (err.status === 429) return new AiQuotaError(meta);
    return new AiServiceError(err.message, meta);
  }

  if (err instanceof Error) {
    if (err.name === "AbortError") return new AiTimeoutError(meta);
    if (err.message.includes("OPENAI_API_KEY")) return new AiUnavailableError(meta);
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
