/**
 * AI Runner — Central Orchestration Entry Point
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * runAiCall() is the single function all future AI features should call.
 * It resolves provider + model via the router, runs usage guardrails,
 * invokes the provider adapter, estimates cost, logs usage, and normalises errors.
 *
 * Features never need to know which provider, model, pricing, or budget state is used.
 * No business logic, no prompts, no retries, no streaming.
 *
 * Phase 3C: routes through router.ts → providers/registry.ts → provider adapter
 * Phase 3E: async routing with tenant/global DB overrides
 * Phase 3F: cost estimation via loadPricing() + estimateAiCost()
 * Phase 3G: AI usage guardrails — budget_mode policy + hard stop via guards.ts
 * Final hardening:
 *   - Cost basis logging: pricing_source, pricing_version, billable token fields,
 *     cached_input_tokens, reasoning_tokens written to ai_usage
 *   - status="blocked" for guardrail hard-stop (distinct from provider errors)
 */

import OpenAI from "openai";
import { AI_TIMEOUT_MS, AI_INPUT_PREVIEW_MAX_CHARS } from "./config";
import { resolveRoute } from "./router";
import { getProvider } from "./providers/registry";
import { logAiUsage } from "./usage";
import { loadPricing } from "./pricing";
import { estimateAiCost } from "./costs";
import {
  loadUsageLimit,
  getCurrentAiUsageForPeriod,
  evaluateAiUsageState,
  maybeRecordThresholdEvent,
  BUDGET_MODE_POLICY,
  type AiUsageState,
} from "./guards";
import {
  AiUnavailableError,
  AiTimeoutError,
  AiQuotaError,
  AiServiceError,
  AiBudgetExceededError,
  type AiErrorMeta,
} from "./errors";
import type { AiCallContext, AiCallResult } from "./types";
import type { AiUsageLimit } from "@shared/schema";

export interface AiCallInput {
  systemPrompt: string;
  userInput: string;
}

/**
 * Execute a single AI call with full lifecycle management.
 *
 * Flow:
 *   1. Resolve provider + model (route overrides aware)
 *   2. Get provider adapter
 *   3. Evaluate tenant usage guardrail state (skipped if no tenantId)
 *   4. Hard stop if state === "blocked" → log status="blocked", throw AiBudgetExceededError
 *   5. Apply budget mode policy if state === "budget_mode"
 *   6. Execute provider call
 *   7. Estimate cost, log usage with full cost basis, record threshold events
 *
 * Guard failure safe behavior:
 *   DB errors inside guards.ts are caught internally and return null/0.
 *   If that happens, guardState stays "normal" — we prefer running the call
 *   over blocking it due to a DB failure.
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

  const route = await resolveRoute(modelKey, tenantId);
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
      provider: route.provider,
      tenantId: tenantId ?? null,
      userId: userId ?? null,
      requestId: context.requestId ?? null,
      model: route.model,
      status: "error",
      errorMessage: aiErr.message,
      latencyMs,
      estimatedCostUsd: null,
    });
    emitRunnerLog({ feature, model: route.model, latencyMs, guardState: "normal", success: false, error: aiErr.message });
    throw aiErr;
  }

  // ── Guardrail evaluation ─────────────────────────────────────────────────────
  // If tenantId is absent, guardrails are skipped entirely (no tenant to check).
  // Guard DB failures are caught inside guards.ts — they return null/0 safely.

  let guardState: AiUsageState = "normal";
  let guardLimit: AiUsageLimit | null = null;
  let guardCurrentUsageUsd = 0;

  if (tenantId) {
    const [limit, currentUsageUsd] = await Promise.all([
      loadUsageLimit(tenantId),
      getCurrentAiUsageForPeriod(tenantId),
    ]);
    guardLimit = limit;
    guardCurrentUsageUsd = currentUsageUsd;
    if (limit) {
      guardState = evaluateAiUsageState({ currentUsageUsd, limit });
    }
  }

  // ── Hard stop ────────────────────────────────────────────────────────────────
  // Log status="blocked" — analytically distinct from provider errors.
  // No aggregate increment: no provider call was made, no tokens consumed.
  if (guardState === "blocked") {
    const latencyMs = Date.now() - startMs;
    const meta: AiErrorMeta = { feature, model: route.model, latencyMs };

    void logAiUsage({
      feature,
      provider: route.provider,
      tenantId: tenantId ?? null,
      userId: userId ?? null,
      requestId: context.requestId ?? null,
      model: route.model,
      status: "blocked",
      errorMessage: "AI budget exceeded: included usage exhausted",
      latencyMs,
      estimatedCostUsd: null,
    });

    if (tenantId && guardLimit) {
      void maybeRecordThresholdEvent({
        tenantId,
        state: guardState,
        currentUsageUsd: guardCurrentUsageUsd,
        limit: guardLimit,
        requestId: context.requestId,
      });
    }

    emitRunnerLog({ feature, model: route.model, latencyMs, guardState, success: false, error: "budget_exceeded" });
    throw new AiBudgetExceededError(meta);
  }

  // ── Budget mode policy ───────────────────────────────────────────────────────
  // No provider/model switch. Same route, reduced output tokens + concise prefix.
  const effectiveSystemPrompt =
    guardState === "budget_mode"
      ? `${BUDGET_MODE_POLICY.systemPromptPrefix}${input.systemPrompt}`
      : input.systemPrompt;

  const maxOutputTokens =
    guardState === "budget_mode" ? BUDGET_MODE_POLICY.maxOutputTokens : undefined;

  // ── Provider call ────────────────────────────────────────────────────────────
  try {
    const result = await provider.generateText({
      model: route.model,
      systemPrompt: effectiveSystemPrompt,
      userInput: input.userInput,
      timeoutMs: AI_TIMEOUT_MS,
      maxOutputTokens,
    });

    const latencyMs = Date.now() - startMs;

    const pricingResult = await loadPricing(route.provider, route.model);
    const estimatedCostUsd = estimateAiCost({ usage: result.usage ?? null, pricing: pricingResult.pricing });

    // Cost basis: billable tokens = same as raw tokens in current formula.
    // Stored explicitly so future billing can reconstruct the cost calculation.
    const inputTokensBillable = result.usage?.input_tokens ?? null;
    const outputTokensBillable = result.usage?.output_tokens ?? null;

    void logAiUsage({
      feature,
      provider: route.provider,
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
      estimatedCostUsd,
      pricingSource: pricingResult.source,
      pricingVersion: pricingResult.version,
      inputTokensBillable,
      outputTokensBillable,
      cachedInputTokens: result.usage?.cached_input_tokens ?? 0,
      reasoningTokens: result.usage?.reasoning_tokens ?? 0,
    });

    if (tenantId && guardLimit && guardState !== "normal") {
      void maybeRecordThresholdEvent({
        tenantId,
        state: guardState,
        currentUsageUsd: guardCurrentUsageUsd,
        limit: guardLimit,
        requestId: context.requestId,
      });
    }

    emitRunnerLog({ feature, model: route.model, latencyMs, guardState, success: true, estimatedCostUsd });

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
      provider: route.provider,
      tenantId: tenantId ?? null,
      userId: userId ?? null,
      requestId: context.requestId ?? null,
      model: route.model,
      status: "error",
      errorMessage: aiErr.message,
      latencyMs,
      estimatedCostUsd: null,
    });

    emitRunnerLog({ feature, model: route.model, latencyMs, guardState, success: false, error: aiErr.message });

    throw aiErr;
  }
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function normalizeError(err: unknown, meta: AiErrorMeta) {
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
  guardState: AiUsageState;
  success: boolean;
  error?: string;
  estimatedCostUsd?: number | null;
}): void {
  const status = entry.success ? "✓" : "✗";
  const guardSuffix = entry.guardState !== "normal" ? ` | guard=${entry.guardState}` : "";
  const errSuffix = entry.error ? ` | error="${entry.error.slice(0, 120)}"` : "";
  const costSuffix =
    entry.estimatedCostUsd != null
      ? ` | cost=$${entry.estimatedCostUsd.toFixed(8)}`
      : "";
  console.log(
    `[ai:runner] ${status} feature=${entry.feature} model=${entry.model} latency=${entry.latencyMs}ms${costSuffix}${guardSuffix}${errSuffix}`,
  );
}
