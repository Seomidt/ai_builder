/**
 * Phase 16 — Runaway Protection
 * Detects and aborts runaway agent runs to prevent infinite loops
 * and excessive token/cost consumption.
 *
 * INV-GOV-1: Never throws — fail open (allow on error).
 * INV-GOV-2: Exceeding hard limits results in abort.
 * INV-GOV-5: All runaway events are recorded for audit trail.
 * INV-GOV-6: Runaway protection is a secondary layer to step-budget.
 */

import { recordAnomalyEvent } from "./anomaly-detector";

// Per-run limits
export const MAX_STEPS_PER_RUN = 50;
export const MAX_TOKENS_PER_RUN = 100_000;
export const MAX_COST_PER_RUN_USD = 5.0;
export const MAX_ITERATIONS_PER_RUN = 25;

export interface RunawayCheckResult {
  abort: boolean;
  reason?: string;
  violatedLimit?: "steps" | "tokens" | "cost" | "iterations";
}

export interface RunContext {
  tenantId?: string | null;
  runId?: string | null;
  steps?: number;
  iterations?: number;
  tokensUsed?: number;
  costUsd?: number;
}

/**
 * Check whether an agent run should be aborted due to runaway conditions.
 * INV-GOV-1: Returns {abort: false} on error (fail open).
 * INV-GOV-2: Returns abort=true when any hard limit is exceeded.
 */
export function checkRunawayProtection(ctx: RunContext): RunawayCheckResult {
  try {
    const steps = ctx.steps ?? 0;
    const iterations = ctx.iterations ?? 0;
    const tokens = ctx.tokensUsed ?? 0;
    const cost = ctx.costUsd ?? 0;

    if (steps >= MAX_STEPS_PER_RUN) {
      return {
        abort: true,
        violatedLimit: "steps",
        reason: `Runaway protection: step limit reached (${steps}/${MAX_STEPS_PER_RUN})`,
      };
    }

    if (iterations >= MAX_ITERATIONS_PER_RUN) {
      return {
        abort: true,
        violatedLimit: "iterations",
        reason: `Runaway protection: iteration limit reached (${iterations}/${MAX_ITERATIONS_PER_RUN})`,
      };
    }

    if (tokens >= MAX_TOKENS_PER_RUN) {
      return {
        abort: true,
        violatedLimit: "tokens",
        reason: `Runaway protection: token limit reached (${tokens}/${MAX_TOKENS_PER_RUN})`,
      };
    }

    if (cost >= MAX_COST_PER_RUN_USD) {
      return {
        abort: true,
        violatedLimit: "cost",
        reason: `Runaway protection: cost limit reached ($${cost.toFixed(4)}/$${MAX_COST_PER_RUN_USD})`,
      };
    }

    return { abort: false };
  } catch {
    return { abort: false }; // INV-GOV-1: fail open
  }
}

/**
 * Record a runaway event to the anomaly events table.
 * INV-GOV-1: Never throws.
 * INV-GOV-5: Runaway event persisted for audit trail.
 */
export async function recordRunawayEvent(params: {
  tenantId: string;
  runId?: string | null;
  violatedLimit: "steps" | "tokens" | "cost" | "iterations";
  value: number;
  reason?: string;
}): Promise<{ id: string } | null> {
  return recordAnomalyEvent({
    tenantId: params.tenantId,
    eventType: "runaway_agent",
    usageSpikePercent: undefined,
    metadata: {
      runId: params.runId ?? null,
      violatedLimit: params.violatedLimit,
      value: params.value,
      reason: params.reason ?? null,
      recordedAt: new Date().toISOString(),
    },
  });
}

/**
 * Check and auto-record runaway event if limit exceeded.
 * INV-GOV-1: Never throws.
 * INV-GOV-5: Automatically records anomaly event on runaway detection.
 */
export async function checkAndRecordRunaway(
  tenantId: string,
  ctx: RunContext,
): Promise<RunawayCheckResult> {
  try {
    const check = checkRunawayProtection(ctx);
    if (check.abort && check.violatedLimit) {
      const value =
        check.violatedLimit === "steps" ? (ctx.steps ?? 0)
        : check.violatedLimit === "iterations" ? (ctx.iterations ?? 0)
        : check.violatedLimit === "tokens" ? (ctx.tokensUsed ?? 0)
        : (ctx.costUsd ?? 0);

      void recordRunawayEvent({
        tenantId,
        runId: ctx.runId,
        violatedLimit: check.violatedLimit,
        value,
        reason: check.reason,
      }).catch(() => {});
    }
    return check;
  } catch {
    return { abort: false };
  }
}

/**
 * Return the current runaway protection config (for documentation/introspection).
 */
export function getRunawayConfig() {
  return {
    maxStepsPerRun: MAX_STEPS_PER_RUN,
    maxIterationsPerRun: MAX_ITERATIONS_PER_RUN,
    maxTokensPerRun: MAX_TOKENS_PER_RUN,
    maxCostPerRunUsd: MAX_COST_PER_RUN_USD,
    inv: ["INV-GOV-1", "INV-GOV-2", "INV-GOV-5", "INV-GOV-6"],
  };
}
