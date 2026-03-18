/**
 * AI Step Budget Guard — Phase 3L
 *
 * SERVER-ONLY: Must never be imported from client/ code.
 *
 * Enforces a per-request limit on the number of AI provider calls that
 * one logical request (identified by tenant_id + request_id) may execute.
 *
 * Design rules:
 * - Only real provider execution attempts count as steps.
 * - Cache hits, duplicate replays, and pre-flight blocks do NOT consume a step.
 * - Failed provider calls DO count as steps (provider attempt was made).
 * - When request_id is absent, step budget is not enforced.
 * - All errors are caught internally — must never crash AI runtime.
 *
 * Default limit: MAX_AI_CALLS_PER_REQUEST = 5
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { aiRequestStepStates, aiRequestStepEvents } from "@shared/schema";
import { AiStepBudgetExceededError } from "./errors";
import type { AiErrorMeta } from "./errors";

// ─── Policy ───────────────────────────────────────────────────────────────────

/** Default maximum AI provider calls allowed per logical request. */
export const MAX_AI_CALLS_PER_REQUEST = 5;

/** Step state rows expire after 24 hours — aligned with idempotency retention. */
const STEP_STATE_TTL_HOURS = 24;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StepBudgetContext {
  tenantId: string;
  requestId: string;
  feature: string;
  routeKey: string;
  provider: string;
  model: string;
  meta: AiErrorMeta;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function stepExpiresAt(): Date {
  return new Date(Date.now() + STEP_STATE_TTL_HOURS * 60 * 60 * 1000);
}

/**
 * Ensure a step state row exists for this (tenant_id, request_id).
 * Uses INSERT ... ON CONFLICT DO NOTHING to avoid races.
 * Returns the current row.
 */
async function ensureStepStateRow(
  tenantId: string,
  requestId: string,
  maxAiCalls: number,
): Promise<typeof aiRequestStepStates.$inferSelect> {
  // Try to insert; no-op if already exists
  await db
    .insert(aiRequestStepStates)
    .values({
      tenantId,
      requestId,
      totalAiCalls: 0,
      maxAiCalls,
      status: "active",
      expiresAt: stepExpiresAt(),
    })
    .onConflictDoNothing();

  // Load the (existing or just-created) row
  const rows = await db
    .select()
    .from(aiRequestStepStates)
    .where(
      and(
        eq(aiRequestStepStates.tenantId, tenantId),
        eq(aiRequestStepStates.requestId, requestId),
      ),
    )
    .limit(1);

  if (rows.length === 0) {
    throw new Error(
      `[step-budget] Failed to load step state for request=${requestId} tenant=${tenantId}`,
    );
  }

  return rows[0];
}

async function recordStepEvent(params: {
  tenantId: string;
  requestId: string;
  eventType: string;
  stepNumber?: number | null;
  routeKey?: string | null;
  feature?: string | null;
  provider?: string | null;
  model?: string | null;
}): Promise<void> {
  try {
    await db.insert(aiRequestStepEvents).values({
      tenantId: params.tenantId,
      requestId: params.requestId,
      eventType: params.eventType,
      stepNumber: params.stepNumber ?? null,
      routeKey: params.routeKey ?? null,
      feature: params.feature ?? null,
      provider: params.provider ?? null,
      model: params.model ?? null,
    });
  } catch (err) {
    console.error(
      "[step-budget] Failed to record step event:",
      err instanceof Error ? err.message : err,
    );
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Acquire one AI step for this request.
 *
 * If the step budget has already been exhausted, throws AiStepBudgetExceededError
 * BEFORE any provider call is made and WITHOUT incrementing the counter.
 *
 * If within budget:
 *   - Atomically increments total_ai_calls
 *   - Records a "step_started" event
 *   - Returns the step number (1-indexed)
 *
 * @throws AiStepBudgetExceededError when limit is reached
 */
export async function acquireAiStep(ctx: StepBudgetContext): Promise<number> {
  const maxAiCalls = MAX_AI_CALLS_PER_REQUEST;

  try {
    const stateRow = await ensureStepStateRow(ctx.tenantId, ctx.requestId, maxAiCalls);

    // Phase 4E.2 fix — atomic step-budget increment:
    // The budget predicate (total_ai_calls < max_ai_calls) is enforced INSIDE
    // the UPDATE WHERE clause so the check and increment are a single atomic
    // DB operation. A separate pre-check is still present as a fast-path hint
    // but is NOT relied upon for correctness — the UPDATE is the authority.
    //
    // Before fix: two workers could both read total_ai_calls=4 (< max 5),
    // both pass the pre-check, both increment → counter lands at 6, bypassing
    // the limit.
    //
    // After fix: only one worker's UPDATE matches the WHERE predicate once the
    // limit is reached. The losing worker gets zero rows back and is blocked.

    // Fast-path hint (NOT relied on for correctness):
    if (stateRow.totalAiCalls >= stateRow.maxAiCalls) {
      // Record budget exceeded event (fire-and-forget)
      void recordStepEvent({
        tenantId: ctx.tenantId,
        requestId: ctx.requestId,
        eventType: "step_budget_exceeded",
        stepNumber: stateRow.totalAiCalls + 1,
        routeKey: ctx.routeKey,
        feature: ctx.feature,
        provider: ctx.provider,
        model: ctx.model,
      });
      console.warn(
        `[step-budget] Budget exceeded (pre-check): request=${ctx.requestId} tenant=${ctx.tenantId} ` +
        `calls=${stateRow.totalAiCalls} max=${stateRow.maxAiCalls}`,
      );
      throw new AiStepBudgetExceededError({
        ...ctx.meta,
        requestId: ctx.requestId,
        totalAiCalls: stateRow.totalAiCalls,
        maxAiCalls: stateRow.maxAiCalls,
      });
    }

    // Atomic check-and-increment: budget predicate lives inside the WHERE.
    // If another concurrent worker incremented to the limit between the pre-check
    // above and this UPDATE, the WHERE predicate will not match → zero rows returned.
    const updated = await db
      .update(aiRequestStepStates)
      .set({
        totalAiCalls: sql`${aiRequestStepStates.totalAiCalls} + 1`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiRequestStepStates.tenantId, ctx.tenantId),
          eq(aiRequestStepStates.requestId, ctx.requestId),
          // Atomic budget predicate — this is the enforceable authority:
          sql`${aiRequestStepStates.totalAiCalls} < ${aiRequestStepStates.maxAiCalls}`,
        ),
      )
      .returning({
        totalAiCalls: aiRequestStepStates.totalAiCalls,
        maxAiCalls: aiRequestStepStates.maxAiCalls,
      });

    // Zero rows updated → budget was exhausted at the atomic update level.
    // The pre-check did not catch it (concurrent race). Block the provider call.
    if (!updated[0]) {
      // Re-read current counts for accurate error reporting
      const currentRows = await db
        .select({ totalAiCalls: aiRequestStepStates.totalAiCalls, maxAiCalls: aiRequestStepStates.maxAiCalls })
        .from(aiRequestStepStates)
        .where(
          and(
            eq(aiRequestStepStates.tenantId, ctx.tenantId),
            eq(aiRequestStepStates.requestId, ctx.requestId),
          ),
        )
        .limit(1);

      const totalAiCalls = currentRows[0]?.totalAiCalls ?? stateRow.totalAiCalls;
      const maxAiCalls = currentRows[0]?.maxAiCalls ?? stateRow.maxAiCalls;

      // Mark exhausted
      void db
        .update(aiRequestStepStates)
        .set({ status: "exhausted", updatedAt: new Date() })
        .where(
          and(
            eq(aiRequestStepStates.tenantId, ctx.tenantId),
            eq(aiRequestStepStates.requestId, ctx.requestId),
          ),
        );

      void recordStepEvent({
        tenantId: ctx.tenantId,
        requestId: ctx.requestId,
        eventType: "step_budget_exceeded",
        stepNumber: Number(totalAiCalls) + 1,
        routeKey: ctx.routeKey,
        feature: ctx.feature,
        provider: ctx.provider,
        model: ctx.model,
      });

      console.warn(
        `[step-budget] Budget exceeded (atomic guard): request=${ctx.requestId} tenant=${ctx.tenantId} ` +
        `calls=${totalAiCalls} max=${maxAiCalls}`,
      );

      throw new AiStepBudgetExceededError({
        ...ctx.meta,
        requestId: ctx.requestId,
        totalAiCalls: Number(totalAiCalls),
        maxAiCalls: Number(maxAiCalls),
      });
    }

    const stepNumber = updated[0].totalAiCalls;

    // Record step_started event (fire-and-forget)
    void recordStepEvent({
      tenantId: ctx.tenantId,
      requestId: ctx.requestId,
      eventType: "step_started",
      stepNumber,
      routeKey: ctx.routeKey,
      feature: ctx.feature,
      provider: ctx.provider,
      model: ctx.model,
    });

    console.info(
      `[step-budget] Step ${stepNumber}/${stateRow.maxAiCalls} acquired: request=${ctx.requestId} tenant=${ctx.tenantId}`,
    );

    return stepNumber;
  } catch (err) {
    // Re-throw AiStepBudgetExceededError — it must propagate
    if (err instanceof AiStepBudgetExceededError) throw err;

    // All other errors: log and let the call proceed (fail-open for observability)
    console.error(
      "[step-budget] acquireAiStep error (fail-open):",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

/**
 * Record that an AI step finished (success or provider error).
 * Fire-and-forget — must never throw into AI runtime.
 */
export function recordStepCompleted(params: {
  tenantId: string;
  requestId: string;
  stepNumber: number;
  routeKey?: string | null;
  feature?: string | null;
  provider?: string | null;
  model?: string | null;
}): void {
  void recordStepEvent({
    tenantId: params.tenantId,
    requestId: params.requestId,
    eventType: "step_completed",
    stepNumber: params.stepNumber,
    routeKey: params.routeKey,
    feature: params.feature,
    provider: params.provider,
    model: params.model,
  });
}

/**
 * Mark the step state as "completed" when all AI work for this request is done.
 * Optional — call when the logical request is fully finished.
 * Fire-and-forget — must never throw.
 */
export async function finalizeAiStepBudget(
  tenantId: string,
  requestId: string,
): Promise<void> {
  try {
    await db
      .update(aiRequestStepStates)
      .set({ status: "completed", updatedAt: new Date() })
      .where(
        and(
          eq(aiRequestStepStates.tenantId, tenantId),
          eq(aiRequestStepStates.requestId, requestId),
          eq(aiRequestStepStates.status, "active"),
        ),
      );
  } catch (err) {
    console.error(
      "[step-budget] finalizeAiStepBudget error:",
      err instanceof Error ? err.message : err,
    );
  }
}
