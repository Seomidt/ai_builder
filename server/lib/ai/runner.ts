/**
 * AI Runner — Central Orchestration Entry Point
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * runAiCall() is the single function all future AI features should call.
 * It resolves provider + model via the router, enforces idempotency,
 * enforces request safety, runs usage guardrails, checks the response cache,
 * invokes the provider adapter, estimates cost, logs usage, writes to cache,
 * and normalises errors.
 *
 * Phase 3C: routes through router.ts → providers/registry.ts → provider adapter
 * Phase 3E: async routing with tenant/global DB overrides
 * Phase 3F: cost estimation via loadPricing() + estimateAiCost()
 * Phase 3G: AI usage guardrails — budget_mode policy + hard stop via guards.ts
 * Final hardening: cost basis fields, blocked status, pricing source/version
 * Phase 3H: request safety — token cap, rate limit, concurrency guard
 * Phase 3H.1: correct HTTP status codes + Retry-After support
 * Phase 3I: tenant-safe response cache — hit/miss/write observability
 * Phase 3J: idempotency + retry-storm protection
 *
 * Request flow:
 *   1.  Resolve route (provider + model)
 *   2.  Get provider adapter
 *   3.  Idempotency check (when request_id present):
 *       └─ duplicate_inflight → 409 Conflict (no provider call)
 *       └─ duplicate_replay   → return stored result (no provider call, no cost row)
 *       └─ owned              → proceed; release in finally
 *   4.  Resolve effective safety config (tenant DB override → global defaults)
 *   5.  Token cap precheck (blocks oversized input before provider call)
 *   6.  Rate limit check (RPM + RPH)
 *   7.  Concurrency guard acquire (process-local slot)
 *   8.  Budget/usage guard (existing per-period cost guardrail)
 *   9.  Budget mode policy (verbosity reduction)
 *  10.  Cache policy resolve + lookup
 *       └─ HIT  → record cache_hit event → return cached result (no provider call)
 *       └─ MISS → record cache_miss event → continue to step 11
 *  11.  Provider call with centrally enforced maxOutputTokens
 *  12.  Usage logging + threshold events
 *  13.  Cache write (success only, if route is cacheable)
 *  14.  Mark request completed (idempotency state update)
 *  15.  Concurrency slot release + idempotency ownership release (in finally)
 *
 * Idempotency accounting (Phase 3J):
 *   - duplicate_inflight:  no provider call, no ai_usage row, 409 returned
 *   - duplicate_replay:    no provider call, no ai_usage row, stored result returned
 *   - First execution:     normal ai_usage row written; idempotency state = completed
 *
 * Cache accounting decision (Phase 3I):
 *   - Cache HIT:  NO ai_usage row written (zero provider cost). Observable via ai_cache_events.
 *   - Cache MISS: Normal ai_usage success row written (provider cost applies).
 *   - Cache WRITE: ai_cache_events cache_write row written after successful provider call.
 */

import OpenAI from "openai";
import { AI_TIMEOUT_MS, AI_INPUT_PREVIEW_MAX_CHARS, getRouteCachePolicy } from "./config";
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
  lookupCachedResponse,
  storeCachedResponse,
} from "./response-cache";
import {
  beginAiRequest,
  markAiRequestCompleted,
  markAiRequestFailed,
  releaseAiRequestOwnership,
} from "./idempotency";
import {
  AiUnavailableError,
  AiTimeoutError,
  AiQuotaError,
  AiServiceError,
  AiBudgetExceededError,
  AiTokenCapError,
  AiRateLimitError,
  AiConcurrencyError,
  AiDuplicateInflightError,
  AiStepBudgetExceededError,
  AiWalletLimitError,
  type AiErrorMeta,
} from "./errors";
import { checkWalletHardLimit } from "./wallet";
import { acquireAiStep, recordStepCompleted } from "./step-budget";
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
 *   - No provider call is made if request is a known duplicate (inflight or completed)
 *   - No provider call is made if token cap, rate limit, or concurrency check fails
 *   - No provider call is made on a cache hit
 *   - Concurrency slot is always released (success, cache hit, error, or safety block)
 *   - Idempotency ownership is always released (success, replay, error, safety block)
 *   - Provider/model is NEVER switched by safety, cache, or idempotency logic
 *   - All safety blocks are recorded in request_safety_events for traceability
 *   - Cache hits are recorded in ai_cache_events — not in ai_usage (no cost row)
 *   - Duplicate replays do NOT create new ai_usage provider-cost rows
 *   - Only successful, non-empty provider responses are written to cache
 *
 * @param context  Identity, routing, and tracing metadata from the caller
 * @param input    System prompt and user input for the model
 * @returns        Normalised AiCallResult on success (provider, cache, or replay)
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

  // ── Step 3: Idempotency check ─────────────────────────────────────────────────
  // Only when tenantId + requestId are both present.
  // No request_id → proceed normally (Case A in spec).
  let idpOwned = false;
  let idpStateId = "";
  let idpInflightKey = "";

  if (tenantId && context.requestId) {
    const idpResult = await beginAiRequest({
      tenantId,
      requestId: context.requestId,
      routeKey: modelKey,
      provider: route.provider,
      model: route.model,
    });

    if (idpResult.outcome === "duplicate_inflight") {
      // Case C — another execution of this request_id is in progress
      const latencyMs = Date.now() - startMs;
      const meta: AiErrorMeta = { feature, model: route.model, latencyMs };
      emitRunnerLog({
        feature, model: route.model, latencyMs, guardState: "normal",
        success: false, error: "duplicate_inflight",
      });
      throw new AiDuplicateInflightError({ ...meta, requestId: context.requestId });
    }

    if (idpResult.outcome === "duplicate_replay") {
      // Case D — prior completed result available; return it without any provider call
      const latencyMs = Date.now() - startMs;
      emitRunnerLog({
        feature, model: route.model, latencyMs, guardState: "normal",
        success: true, duplicateReplay: true,
      });
      return idpResult.payload;
    }

    // outcome = "owned" — we have exclusive execution rights
    idpOwned = true;
    idpStateId = idpResult.stateId;
    idpInflightKey = idpResult.inflightKey;
  }

  // ── Step 4: Resolve effective safety config ───────────────────────────────────
  const safetyConfig = await resolveEffectiveSafetyConfig(tenantId);

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

  // ── Step 5: Token cap precheck ───────────────────────────────────────────────
  if (tenantId) {
    await checkTokenCap({
      userInput: input.userInput,
      maxInputTokens: safetyConfig.maxInputTokens,
      ...safetyContext,
    });
  }

  // ── Step 6: Rate limit check ─────────────────────────────────────────────────
  if (tenantId) {
    await checkRateLimit({
      safetyConfig,
      ...safetyContext,
    });
  }

  // ── Step 7: Concurrency guard acquire ────────────────────────────────────────
  let concurrencyAcquired = false;
  if (tenantId) {
    await acquireConcurrencySlot({
      maxConcurrentRequests: safetyConfig.maxConcurrentRequests,
      ...safetyContext,
    });
    concurrencyAcquired = true;
  }

  // Phase 3L: tracks the step number acquired for the current provider call.
  // null = no step was acquired (cache hit, replay, pre-flight block, or no request_id).
  let acquiredStepNumber: number | null = null;

  try {
    // ── Step 8: Budget/usage guardrail ─────────────────────────────────────────
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

    // ── Step 8.5: Wallet hard-limit check (Phase 4C) ────────────────────────────
    // Placement: after budget guard (step 8), before provider call path.
    // Only runs for tenant-scoped calls. Anonymous calls skip wallet enforcement.
    //
    // If available_balance_usd <= hard_limit_usd on tenant_credit_accounts,
    // throws AiWalletLimitError (402). No provider call, no billing row, no debit.
    //
    // Fail-open: DB errors on the check allow the call through (see wallet.ts).
    // Hard limit default is 0 — tenant with no credits account is blocked by default.
    if (tenantId) {
      const walletMeta: AiErrorMeta = { feature, model: route.model, latencyMs: Date.now() - startMs };
      await checkWalletHardLimit({ tenantId, meta: walletMeta });
    }

    // ── Step 9: Budget mode policy ──────────────────────────────────────────────
    const effectiveSystemPrompt =
      guardState === "budget_mode"
        ? `${BUDGET_MODE_POLICY.systemPromptPrefix}${input.systemPrompt}`
        : input.systemPrompt;

    const effectiveMaxOutputTokens =
      guardState === "budget_mode"
        ? Math.min(BUDGET_MODE_POLICY.maxOutputTokens, safetyConfig.maxOutputTokens)
        : safetyConfig.maxOutputTokens;

    // ── Step 10: Cache policy resolve + lookup ───────────────────────────────────
    // Only tenant-scoped calls use the cache. Anonymous calls skip caching entirely.
    // Cache lookup uses the effective system prompt (post-budget-mode adjustment)
    // so budget_mode and normal responses are keyed separately.
    const cachePolicy = getRouteCachePolicy(modelKey);

    if (cachePolicy.enabled && tenantId) {
      const cacheCtx = {
        tenantId,
        routeKey: modelKey,
        provider: route.provider,
        model: route.model,
        maxOutputTokens: effectiveMaxOutputTokens,
        systemPrompt: effectiveSystemPrompt,
        userInput: input.userInput,
        requestId: context.requestId,
        feature,
      };

      const lookup = await lookupCachedResponse(cacheCtx);

      if (lookup.hit) {
        // Cache HIT — return without any provider call or usage cost row.
        // Idempotency + concurrency slots released in finally block.
        //
        // Phase 4E.2 fix — cache hit idempotency finalization:
        // Before returning, mark the idempotency state as completed so that
        // future requests with the same request_id receive duplicate_replay
        // instead of duplicate_inflight (which would happen if the state
        // remained in_progress indefinitely after a cache hit).
        if (idpOwned && idpStateId && tenantId && context.requestId) {
          void markAiRequestCompleted({
            stateId: idpStateId,
            tenantId,
            requestId: context.requestId,
            routeKey: modelKey,
            provider: route.provider,
            model: route.model,
            responsePayload: lookup.result,
          });
        }
        emitRunnerLog({
          feature,
          model: route.model,
          latencyMs: Date.now() - startMs,
          guardState,
          success: true,
          cacheHit: true,
        });
        return lookup.result;
      }
      // Cache MISS — cache_miss event already recorded inside lookupCachedResponse.
    }

    // ── Step 10.5 (Phase 3L): Step budget acquire ────────────────────────────────
    // Runs ONLY on the provider-call path (after cache miss or cache-disabled).
    // Cache hits, duplicate replays, and pre-flight blocks never reach this point.
    // If over the per-request step limit, throws AiStepBudgetExceededError.
    if (tenantId && context.requestId) {
      acquiredStepNumber = await acquireAiStep({
        tenantId,
        requestId: context.requestId,
        feature,
        routeKey: modelKey,
        provider: route.provider,
        model: route.model,
        meta: { feature, model: route.model, latencyMs: Date.now() - startMs },
      });
    }

    // ── Step 11: Provider call ───────────────────────────────────────────────────
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

    // ── Step 12: Usage logging + threshold events ───────────────────────────────
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

    // Phase 3L: Record step completed for a successful provider call.
    if (tenantId && context.requestId && acquiredStepNumber !== null) {
      recordStepCompleted({
        tenantId,
        requestId: context.requestId,
        stepNumber: acquiredStepNumber,
        routeKey: modelKey,
        feature,
        provider: route.provider,
        model: route.model,
      });
    }

    const finalResult: AiCallResult = {
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

    // ── Step 13: Cache write (success only, cacheable routes only) ───────────────
    // Only runs on cache miss + successful provider call + non-empty response.
    // Blocked/error outcomes never reach this point.
    // storeCachedResponse is fail-open — errors are swallowed internally.
    if (cachePolicy.enabled && tenantId) {
      void storeCachedResponse(
        {
          tenantId,
          routeKey: modelKey,
          provider: route.provider,
          model: route.model,
          maxOutputTokens: effectiveMaxOutputTokens,
          systemPrompt: effectiveSystemPrompt,
          userInput: input.userInput,
          requestId: context.requestId,
          feature,
        },
        finalResult,
      );
    }

    // ── Step 14: Mark request completed (idempotency state → completed) ──────────
    // Stores normalised response for future duplicate replay.
    // No ai_usage row on replay — cost is zero for subsequent identical requests.
    if (idpOwned && idpStateId && tenantId && context.requestId) {
      void markAiRequestCompleted({
        stateId: idpStateId,
        tenantId,
        requestId: context.requestId,
        routeKey: modelKey,
        provider: route.provider,
        model: route.model,
        responsePayload: finalResult,
      });
    }

    emitRunnerLog({ feature, model: route.model, latencyMs, guardState, success: true, estimatedCostUsd });

    return finalResult;

  } catch (err) {
    if (
      err instanceof AiTokenCapError ||
      err instanceof AiRateLimitError ||
      err instanceof AiConcurrencyError ||
      err instanceof AiBudgetExceededError ||
      err instanceof AiDuplicateInflightError ||
      // Phase 3L: step budget exceeded is a pre-flight block — no provider call made.
      err instanceof AiStepBudgetExceededError ||
      // Phase 4C: wallet hard-limit block — no provider call, no billing row, no debit.
      err instanceof AiWalletLimitError
    ) {
      // Safety/idempotency blocks — mark failed if we own a state row
      if (idpOwned && idpStateId && tenantId && context.requestId) {
        void markAiRequestFailed({
          stateId: idpStateId,
          tenantId,
          requestId: context.requestId,
          routeKey: modelKey,
          provider: route.provider,
          model: route.model,
          errorCode: (err as { errorCode?: string }).errorCode ?? "safety_block",
        });
      }
      throw err;
    }

    const latencyMs = Date.now() - startMs;
    const meta: AiErrorMeta = { feature, model: route.model, latencyMs };
    const aiErr = normalizeError(err, meta);

    // Phase 3L: provider call was attempted (step was acquired) but failed.
    // Count this as a completed step — the provider attempt consumed a slot.
    if (tenantId && context.requestId && acquiredStepNumber !== null) {
      recordStepCompleted({
        tenantId,
        requestId: context.requestId,
        stepNumber: acquiredStepNumber,
        routeKey: modelKey,
        feature,
        provider: route.provider,
        model: route.model,
      });
    }

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

    // Mark idempotency state as failed — allows safe retry
    if (idpOwned && idpStateId && tenantId && context.requestId) {
      void markAiRequestFailed({
        stateId: idpStateId,
        tenantId,
        requestId: context.requestId,
        routeKey: modelKey,
        provider: route.provider,
        model: route.model,
        errorCode: aiErr.errorCode,
      });
    }

    emitRunnerLog({ feature, model: route.model, latencyMs, guardState: "normal", success: false, error: aiErr.message });
    throw aiErr;

  } finally {
    // ── Step 15: Always release slots ───────────────────────────────────────────
    // Runs on success, cache hit, replay, error, safety block, and budget block.
    if (concurrencyAcquired && tenantId) {
      releaseConcurrencySlot(tenantId);
    }
    // Release idempotency inflight ownership.
    // Must run even on throw — prevents stale in-process registry entries.
    if (idpOwned && idpInflightKey) {
      releaseAiRequestOwnership(idpInflightKey);
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
  cacheHit?: boolean;
  duplicateReplay?: boolean;
}): void {
  const status = entry.success ? "✓" : "✗";
  const guardSuffix = entry.guardState !== "normal" ? ` | guard=${entry.guardState}` : "";
  const cacheSuffix = entry.cacheHit ? " | cache=HIT" : "";
  const replaySuffix = entry.duplicateReplay ? " | idp=REPLAY" : "";
  const errSuffix = entry.error ? ` | error="${entry.error.slice(0, 120)}"` : "";
  const costSuffix =
    entry.estimatedCostUsd != null
      ? ` | cost=$${entry.estimatedCostUsd.toFixed(8)}`
      : "";
  console.log(
    `[ai:runner] ${status} feature=${entry.feature} model=${entry.model} latency=${entry.latencyMs}ms${costSuffix}${cacheSuffix}${replaySuffix}${guardSuffix}${errSuffix}`,
  );
}
