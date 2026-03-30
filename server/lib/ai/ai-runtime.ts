/**
 * AI Runtime — Phase X+1 (hardened X+1.1)
 *
 * Universal wrapper for all AI provider calls.
 *
 * For the Express/local path: delegates to runAiCall() in runner.ts
 * which has the full pipeline (idempotency, cache, rate-limit, etc.).
 *
 * For thin contexts (Vercel handlers, scripts) that cannot import the full
 * runner, use the lightweight runAIRequest() directly here.
 *
 * Phase X+1.1 hardening:
 *   - Idempotency: requestId MUST be generated before the call and passed in.
 *     Duplicate requestIds per tenant are silently ignored by logAiUsage (ON CONFLICT DO NOTHING).
 *   - Atomic budget enforcement: reserveBudget() atomically increments
 *     reserved_cost_usd with a WHERE-guard — safe under concurrent requests.
 *   - Actual cost: stored as actualCostUsd from provider-returned token counts.
 *   - Reservation release: releaseBudgetReservation() always called after the call.
 */

import { runAiCall, type AiCallInput } from "./runner.ts";

// ── Re-export runner API for callers that want full pipeline ──────────────────

export { runAiCall, type AiCallInput };

// ── Lightweight runtime input/output ─────────────────────────────────────────

export interface AiRuntimeInput {
  tenantId:  string;
  userId:    string;
  routeKey:  string;
  provider:  string;
  model:     string;
  /**
   * Stable idempotency key for this request.
   * MUST be generated BEFORE the AI call and be stable across retries.
   * Duplicate requestIds per tenant are silently ignored by logAiUsage.
   */
  requestId: string;
  feature:   string;
  input:     string;
  /**
   * Estimated USD cost for the pre-call reservation.
   * Used for the atomic budget reservation — not stored as actualCostUsd.
   * Defaults to $0.001 if not provided (sufficient for concurrency safety).
   */
  estimateUsd?: number;
  executeCall: () => Promise<{
    text:             string;
    promptTokens:     number;
    completionTokens: number;
    latencyMs:        number;
  }>;
}

export interface AiRuntimeResult {
  text:             string;
  promptTokens:     number;
  completionTokens: number;
  latencyMs:        number;
  costUsd:          number;
  blocked:          boolean;
  blockReason?:     string;
}

/**
 * Lightweight AI call wrapper for Vercel handlers.
 *
 * Unlike runAiCall() which needs Drizzle + the full server context,
 * this version is designed for thin Vercel handlers that already
 * manage their own provider call but want budget enforcement + cost logging.
 *
 * Phase X+1.1: uses atomic reserveBudget() to prevent concurrent requests
 * from jointly exceeding the budget. Always releases the reservation after.
 *
 * Usage:
 *   const requestId = crypto.randomUUID(); // generate BEFORE the call
 *   const result = await runAIRequest({ ...metadata, requestId, executeCall: () => callOpenAI(messages) });
 *   if (result.blocked) return err(res, 402, "BUDGET_EXCEEDED", result.blockReason!);
 */
export async function runAIRequest(input: AiRuntimeInput): Promise<AiRuntimeResult> {
  const { tenantId, userId, routeKey, provider, model, requestId, feature } = input;
  const estimateUsd = input.estimateUsd ?? 0.001;

  // ── 1. Atomic budget reservation BEFORE call ──────────────────────────────
  const { reserveBudget, releaseBudgetReservation } = await import("./budget-guard");
  const reservation = await reserveBudget(tenantId, estimateUsd);

  if (!reservation.allowed) {
    const { logAiUsage } = await import("./usage");
    void logAiUsage({
      tenantId, userId, requestId, feature,
      routeKey, provider, model,
      promptTokens: 0, completionTokens: 0, totalTokens: 0,
      status: "blocked",
      errorMessage: "Budget exceeded — hard limit reached (atomic reservation failed)",
      latencyMs: 0,
      estimatedCostUsd: 0,
      actualCostUsd: 0,
    });

    console.log(JSON.stringify({
      ts: new Date().toISOString(),
      event: "ai_runtime.blocked_atomic",
      tenantId, model, routeKey,
    }));

    return {
      text: "", promptTokens: 0, completionTokens: 0, latencyMs: 0,
      costUsd: 0, blocked: true,
      blockReason: "AI-budgettet er opbrugt. Kontakt din administrator.",
    };
  }

  // ── 2. Execute AI call ────────────────────────────────────────────────────
  let callResult: Awaited<ReturnType<AiRuntimeInput["executeCall"]>>;
  let callStatus: "success" | "error" = "success";
  let callError: string | null = null;

  try {
    callResult = await input.executeCall();
  } catch (e) {
    callStatus = "error";
    callError  = e instanceof Error ? e.message : String(e);
    callResult = { text: "", promptTokens: 0, completionTokens: 0, latencyMs: 0 };
  }

  // ── 3. Calculate actual cost from provider-returned tokens ────────────────
  const { calculateCost } = await import("./cost-calculator");
  const { costUsd: actualCostUsd, pricingSource, pricingVersion } = await calculateCost({
    provider, model,
    inputTokens:  callResult.promptTokens,
    outputTokens: callResult.completionTokens,
  });

  // ── 4. Log usage row (fire-and-forget) ───────────────────────────────────
  const { logAiUsage } = await import("./usage");
  void logAiUsage({
    tenantId, userId, requestId, feature,
    routeKey, provider, model,
    promptTokens:     callResult.promptTokens,
    completionTokens: callResult.completionTokens,
    totalTokens:      callResult.promptTokens + callResult.completionTokens,
    status:           callStatus,
    errorMessage:     callError,
    latencyMs:        callResult.latencyMs,
    estimatedCostUsd: actualCostUsd, // same value — no pre-call estimate in this flow
    actualCostUsd,
    pricingSource,
    pricingVersion,
    inputPreview:     input.input?.slice(0, 200) ?? null,
  });

  // ── 5. Release reservation (fire-and-forget, always) ─────────────────────
  // Release AFTER logAiUsage enqueues the period aggregate increment.
  // Brief overlap (total + reserved both counting) is safe: errs toward blocking.
  void releaseBudgetReservation(tenantId, reservation.reservedAmount);

  // ── 6. Structured observability log ──────────────────────────────────────
  console.log(JSON.stringify({
    ts: new Date().toISOString(),
    event:             "ai_runtime.call",
    tenantId, userId, requestId,
    model, provider, routeKey, feature,
    prompt_tokens:     callResult.promptTokens,
    completion_tokens: callResult.completionTokens,
    actual_cost_usd:   actualCostUsd,
    latency_ms:        callResult.latencyMs,
    status:            callStatus,
    pricing_source:    pricingSource,
    reservation_usd:   reservation.reservedAmount,
    fail_safe:         reservation.failedSafe,
    size_bucket:       callResult.promptTokens < 1000 ? "<1k" : callResult.promptTokens < 4000 ? "1-4k" : callResult.promptTokens < 8000 ? "4-8k" : ">8k",
  }));

  if (callStatus === "error" && callError) {
    throw new Error(callError);
  }

  return {
    text:             callResult.text,
    promptTokens:     callResult.promptTokens,
    completionTokens: callResult.completionTokens,
    latencyMs:        callResult.latencyMs,
    costUsd:          actualCostUsd,
    blocked:          false,
  };
}
