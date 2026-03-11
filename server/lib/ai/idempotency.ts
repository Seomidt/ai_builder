/**
 * AI Idempotency Layer — Phase 3J
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Implements two-layer duplicate request suppression:
 *
 *   Layer 1 — In-process inflight registry (Set<string>)
 *     Protects against concurrent duplicates within the same process before the
 *     DB row has been committed. Keyed by "{tenantId}:{requestId}".
 *     Released in runner.ts finally block — always runs even on throw/error.
 *
 *   Layer 2 — Persisted ai_request_states (DB)
 *     Protects across requests, process restarts, and later replay attempts.
 *     One row per (tenant_id, request_id) — unique constraint at DB level.
 *     TTL: 24 hours from creation (see schema.ts for rationale).
 *
 * Idempotency is scoped to: tenant_id + request_id.
 * No cross-tenant deduplication ever occurs.
 *
 * Duplicate behavior (see beginAiRequest return type):
 *   "owned"              — first request; execution proceeds normally
 *   "duplicate_inflight" — same request already executing; return 409
 *   "duplicate_replay"   — prior completed result available; replay it
 *
 * Failed request policy:
 *   A failed request_id is retryable. When status = "failed" is found,
 *   the row is reset to "in_progress" and new execution proceeds.
 *   Rationale: provider failures (502/503/504) are transient — permanently
 *   blocking a request_id would deny clients a safe retry path.
 *
 * Phase 3J.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import { aiRequestStates, aiRequestStateEvents } from "@shared/schema";
import type { AiCallResult } from "./types";

// ── Constants ─────────────────────────────────────────────────────────────────

/** Row lifetime in seconds. 24 hours — covers all realistic retry windows. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

// ── In-process inflight registry ─────────────────────────────────────────────
// Simple Set keyed by "{tenantId}:{requestId}".
// Protects against same-process concurrent duplicates before the DB write commits.
// Released in runner.ts finally block — always released, even on throw.

const inflightRegistry = new Set<string>();

/** Build the inflight registry key for a request */
export function buildInflightKey(tenantId: string, requestId: string): string {
  return `${tenantId}:${requestId}`;
}

/** Remove a request from the in-process inflight registry */
export function releaseAiRequestOwnership(key: string): void {
  inflightRegistry.delete(key);
}

// ── Public types ──────────────────────────────────────────────────────────────

export interface BeginAiRequestParams {
  tenantId: string;
  requestId: string;
  routeKey: string;
  provider: string;
  model: string;
}

export type BeginAiRequestResult =
  | { outcome: "owned"; stateId: string; inflightKey: string }
  | { outcome: "duplicate_inflight" }
  | { outcome: "duplicate_replay"; payload: AiCallResult };

// ── Core: begin request execution ─────────────────────────────────────────────

/**
 * Attempt to acquire exclusive ownership of a request identified by
 * tenant_id + request_id.
 *
 * Returns one of three outcomes:
 *   "owned"              — caller has exclusive ownership; provider call allowed
 *   "duplicate_inflight" — same request is actively executing; block caller
 *   "duplicate_replay"   — prior completed result available; return it to caller
 *
 * Registers "request_started" event on "owned".
 * Registers "duplicate_inflight" event on in-flight conflict.
 * Registers "duplicate_replayed" event on replay.
 *
 * For "failed" prior state: row is reset to "in_progress" and "owned" returned.
 * This allows safe retry after transient provider failure.
 */
export async function beginAiRequest(
  params: BeginAiRequestParams,
): Promise<BeginAiRequestResult> {
  const { tenantId, requestId, routeKey, provider, model } = params;
  const key = buildInflightKey(tenantId, requestId);

  // Layer 1 — in-process check (fast path, no DB round-trip)
  if (inflightRegistry.has(key)) {
    void recordAiRequestStateEvent({
      tenantId,
      requestId,
      eventType: "duplicate_inflight",
      routeKey,
      provider,
      model,
      reason: "in_process_registry_hit",
    });
    return { outcome: "duplicate_inflight" };
  }

  const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_SECONDS * 1000);

  // Layer 2 — DB insert attempt
  try {
    const inserted = await db
      .insert(aiRequestStates)
      .values({
        tenantId,
        requestId,
        routeKey,
        provider,
        model,
        status: "in_progress",
        expiresAt,
      })
      .onConflictDoNothing()
      .returning({ id: aiRequestStates.id });

    if (inserted.length > 0) {
      // Clean insert — we own this request
      inflightRegistry.add(key);
      void recordAiRequestStateEvent({
        tenantId,
        requestId,
        eventType: "request_started",
        routeKey,
        provider,
        model,
      });
      return { outcome: "owned", stateId: inserted[0].id, inflightKey: key };
    }
  } catch (err) {
    // Unexpected DB error — fail open (allow execution to proceed without idempotency)
    console.error("[ai:idempotency] insert failed — failing open:", err);
    inflightRegistry.add(key);
    return { outcome: "owned", stateId: "", inflightKey: key };
  }

  // Conflict — load existing state to determine what happened
  const existing = await getExistingAiRequestState(tenantId, requestId);

  if (!existing) {
    // Race: row was deleted between our insert conflict and our SELECT
    // Safe to treat as a new request
    inflightRegistry.add(key);
    return { outcome: "owned", stateId: "", inflightKey: key };
  }

  if (existing.status === "completed" && existing.responsePayload) {
    // Prior completed result available — replay it
    const payload = existing.responsePayload as unknown as AiCallResult;
    void recordAiRequestStateEvent({
      tenantId,
      requestId,
      eventType: "duplicate_replayed",
      routeKey,
      provider,
      model,
      reason: `replaying state_id=${existing.id}`,
    });
    return { outcome: "duplicate_replay", payload };
  }

  if (existing.status === "in_progress") {
    // Another execution is already in flight
    void recordAiRequestStateEvent({
      tenantId,
      requestId,
      eventType: "duplicate_inflight",
      routeKey,
      provider,
      model,
      reason: `state_id=${existing.id} status=in_progress`,
    });
    return { outcome: "duplicate_inflight" };
  }

  // status = "failed" — reset and allow retry
  // UPDATE in place so the stateId (PK) remains stable for event linking
  const reset = await db
    .update(aiRequestStates)
    .set({
      status: "in_progress",
      startedAt: new Date(),
      completedAt: null,
      responsePayload: null,
      responseStatusCode: null,
      errorCode: null,
      expiresAt,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(aiRequestStates.tenantId, tenantId),
        eq(aiRequestStates.requestId, requestId),
        eq(aiRequestStates.status, "failed"),
      ),
    )
    .returning({ id: aiRequestStates.id });

  const stateId = reset.length > 0 ? reset[0].id : existing.id;
  inflightRegistry.add(key);
  void recordAiRequestStateEvent({
    tenantId,
    requestId,
    eventType: "request_started",
    routeKey,
    provider,
    model,
    reason: "retry_after_failed",
  });
  return { outcome: "owned", stateId, inflightKey: key };
}

// ── Load existing state ───────────────────────────────────────────────────────

export async function getExistingAiRequestState(
  tenantId: string,
  requestId: string,
) {
  const rows = await db
    .select()
    .from(aiRequestStates)
    .where(
      and(
        eq(aiRequestStates.tenantId, tenantId),
        eq(aiRequestStates.requestId, requestId),
      ),
    )
    .limit(1);

  return rows[0] ?? null;
}

// ── Mark completed ────────────────────────────────────────────────────────────

/**
 * Persist the successful response payload and mark the request completed.
 * Called after provider call succeeds, before returning to the caller.
 * Fail-open — DB errors are logged but never thrown to the caller.
 */
export async function markAiRequestCompleted(params: {
  stateId: string;
  tenantId: string;
  requestId: string;
  routeKey: string;
  provider: string;
  model: string;
  responsePayload: AiCallResult;
}): Promise<void> {
  const { stateId, tenantId, requestId, routeKey, provider, model, responsePayload } = params;
  if (!stateId) return; // fail-open row (DB error on insert)

  try {
    await db
      .update(aiRequestStates)
      .set({
        status: "completed",
        responsePayload: responsePayload as unknown as Record<string, unknown>,
        responseStatusCode: 200,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(aiRequestStates.id, stateId));

    void recordAiRequestStateEvent({
      tenantId,
      requestId,
      eventType: "request_completed",
      routeKey,
      provider,
      model,
    });
  } catch (err) {
    console.error("[ai:idempotency] markAiRequestCompleted failed:", err);
  }
}

// ── Mark failed ───────────────────────────────────────────────────────────────

/**
 * Mark the request as failed.
 * Allows a future retry — the failed state is treated as retryable by beginAiRequest().
 * Fail-open — DB errors are logged but never thrown.
 */
export async function markAiRequestFailed(params: {
  stateId: string;
  tenantId: string;
  requestId: string;
  routeKey: string;
  provider: string;
  model: string;
  errorCode: string;
}): Promise<void> {
  const { stateId, tenantId, requestId, routeKey, provider, model, errorCode } = params;
  if (!stateId) return;

  try {
    await db
      .update(aiRequestStates)
      .set({
        status: "failed",
        errorCode,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(aiRequestStates.id, stateId));

    void recordAiRequestStateEvent({
      tenantId,
      requestId,
      eventType: "request_failed",
      routeKey,
      provider,
      model,
      reason: errorCode,
    });
  } catch (err) {
    console.error("[ai:idempotency] markAiRequestFailed failed:", err);
  }
}

// ── Record event ──────────────────────────────────────────────────────────────

/**
 * Append an observability event to ai_request_state_events.
 * Always fire-and-forget — never awaited in the hot path.
 * Fail-open — DB errors are caught and logged.
 */
export async function recordAiRequestStateEvent(params: {
  tenantId: string;
  requestId: string;
  eventType: string;
  routeKey?: string;
  provider?: string;
  model?: string;
  reason?: string;
}): Promise<void> {
  try {
    await db.insert(aiRequestStateEvents).values({
      tenantId: params.tenantId,
      requestId: params.requestId,
      eventType: params.eventType,
      routeKey: params.routeKey ?? null,
      provider: params.provider ?? null,
      model: params.model ?? null,
      reason: params.reason ?? null,
    });
  } catch (err) {
    console.error("[ai:idempotency] recordAiRequestStateEvent failed:", err);
  }
}
