/**
 * AI Runner — Central Orchestration Entry Point
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * runAiCall() is the single function all future AI features should call.
 * It resolves provider + model via the router, enforces request safety,
 * runs usage guardrails, invokes the provider adapter, estimates cost,
 * logs usage, and normalises errors.
 *
 * Features never need to know which provider, model, pricing, safety limit,
 * or budget state is used. No business logic, no prompts, no retries.
 *
 * Phase 3C: routes through router.ts → providers/registry.ts → provider adapter
 * Phase 3E: async routing with tenant/global DB overrides
 * Phase 3F: cost estimation via loadPricing() + estimateAiCost()
 * Phase 3G: AI usage guardrails — budget_mode policy + hard stop via guards.ts
 * Final hardening: cost basis fields, blocked status, pricing source/version
 * Phase 3H: request safety — token cap, rate limit, concurrency guard
 *
 * Request flow:
 *   1. Resolve route (provider + model)
 *   2. Get provider adapter
 *   3. Resolve effective safety config (tenant DB override → global defaults)
 *   4. Token cap precheck (blocks oversized input before provider call)
 *   5. Rate limit check (RPM + RPH)
 *   6. Concurrency guard acquire (process-local slot)
 *   7. Budget/usage guard (existing per-period cost guardrail)
 *   8. Budget mode policy (verbosity reduction)
 *   9. Provider call with centrally enforced maxOutputTokens
 *  10. Usage logging + threshold events
 *  11. Concurrency slot release (in finally — always runs)
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
  resolveEffectiveSafetyConfig,
  checkTokenCap,
  checkRateLimit,
  acquireConcurrencySlot,
  releaseConcurrencySlot,
} from "./request-safety";
import {
  AiUnavailableError,
  AiTimeoutError,
  AiQuotaError,
  AiServiceError,
  AiBudgetExceededError,
  AiTokenCapError,
  AiRateLimitError,
  AiConcurrencyError,
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
 * Safety guarantees:
 *   - No provider call is made if token cap, rate limit, or concurrency check fails
 *   - Concurrency slot is always released (success, error, or safety block)
 *   - Provider/model is NEVER switched by safety logic — same route always used
 *   - All safety blocks are recorded in request_safety_events for traceability
 *   - Existing ai_usage and aggregate accounting is not affected by safety blocks
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

  // ── Step 1: Resolve route ────────────────────────────────────────────────────
  const route = await resolveRoute(modelKey, tenantId);
  const inputPreview = input.userInput.slice(0, AI_INPUT_PREVIEW_MAX_CHARS);

  // ── Step 2: Get provider adapter ─────────────────────────────────────────────
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

  // ── Step 3: Resolve effective safety config ───────────────────────────────────
  // Loads tenant DB override if present, falls back to AI_SAFETY_DEFAULTS.
  // Fail-open on DB error — returns global defaults.
  const safetyConfig = await resolveEffectiveSafetyConfig(tenantId);

  // Shared meta for all safety errors (latency will be ~0ms — checks are pre-flight)
  const safetyMeta: AiErrorMeta = { feature, model: route.model, latencyMs: Date.now() - startMs };
  const safetyContext = {
    tenantId: tenantId ?? "anonymous",
    requestId: context.requestId,
    feature,
    routeKey: modelKey,
    provider: route.provider,
    model: route.model,
    meta: safetyMeta,
  };

  // ── Step 4: Token cap precheck ───────────────────────────────────────────────
  // Rejects oversized inputs before any API spend.
  // Uses chars/4 approximation. Never silently trims.
  if (tenantId) {
    await checkTokenCap({
      userInput: input.userInput,
      maxInputTokens: safetyConfig.maxInputTokens,
      ...safetyContext,
    });
  }

  // ── Step 5: Rate limit check ─────────────────────────────────────────────────
  // Checks requests_per_minute and requests_per_hour.
  // Both windows use rolling counts from ai_usage. Fail-open on DB error.
  if (tenantId) {
    await checkRateLimit({
      safetyConfig,
      ...safetyContext,
    });
  }

  // ── Step 6: Concurrency guard acquire ────────────────────────────────────────
  // Process-local in-flight counter per tenant.
  // MUST be released in the finally block below.
  let concurrencyAcquired = false;
  if (tenantId) {
    await acquireConcurrencySlot({
      maxConcurrentRequests: safetyConfig.maxConcurrentRequests,
      ...safetyContext,
    });
    concurrencyAcquired = true;
  }

  try {
    // ── Step 7: Budget/usage guardrail ─────────────────────────────────────────
    // If tenantId is absent, guardrails are skipped entirely.
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

    // Hard stop — log status="blocked" and throw. No provider call.
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

    // ── Step 8: Budget mode policy ──────────────────────────────────────────────
    const effectiveSystemPrompt =
      guardState === "budget_mode"
        ? `${BUDGET_MODE_POLICY.systemPromptPrefix}${input.systemPrompt}`
        : input.systemPrompt;

    // Enforce output token cap centrally.
    // Safety cap (from config/DB) applies always.
    // Budget mode further restricts to 512 tokens (more conservative wins).
    const effectiveMaxOutputTokens =
      guardState === "budget_mode"
        ? Math.min(BUDGET_MODE_POLICY.maxOutputTokens, safetyConfig.maxOutputTokens)
        : safetyConfig.maxOutputTokens;

    // ── Step 9: Provider call ───────────────────────────────────────────────────
    const result = await provider.generateText({
      model: route.model,
      systemPrompt: effectiveSystemPrompt,
      userInput: input.userInput,
      timeoutMs: AI_TIMEOUT_MS,
      maxOutputTokens: effectiveMaxOutputTokens,
    });

    const latencyMs = Date.now() - startMs;

    const pricingResult = await loadPricing(route.provider, route.model);
    const estimatedCostUsd = estimateAiCost({ usage: result.usage ?? null, pricing: pricingResult.pricing });

    const inputTokensBillable = result.usage?.input_tokens ?? null;
    const outputTokensBillable = result.usage?.output_tokens ?? null;

    // ── Step 10: Usage logging + threshold events ───────────────────────────────
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
    // Re-throw typed safety/budget errors without wrapping them in a generic error
    if (
      err instanceof AiTokenCapError ||
      err instanceof AiRateLimitError ||
      err instanceof AiConcurrencyError ||
      err instanceof AiBudgetExceededError
    ) {
      throw err;
    }

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

  } finally {
    // ── Step 11: Always release concurrency slot ────────────────────────────────
    // Runs on success, error, safety block, and budget block.
    // No slot leak possible — if acquire succeeded, release always runs.
    if (concurrencyAcquired && tenantId) {
      releaseConcurrencySlot(tenantId);
    }
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
