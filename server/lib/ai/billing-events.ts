/**
 * Billing Event Log — Phase 4F
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides append-only write helpers for the billing_events table.
 * Rows are never updated or deleted (within retention window).
 *
 * billing_events is NOT the billing source of truth.
 * Canonical billing truth:   ai_billing_usage
 * Canonical wallet truth:    tenant_credit_ledger
 * Canonical usage truth:     ai_usage
 *
 * Failure policy: ALL event writes are best-effort (fire-and-forget).
 * A billing event write failure must NEVER prevent or corrupt:
 *   - ai_usage writes
 *   - ai_billing_usage writes
 *   - tenant_credit_ledger writes
 * This is the explicit design policy for Phase 4F.
 *
 * Event type vocabulary:
 *   request_started        — idempotency ownership acquired; execution begins
 *   provider_call_started  — about to invoke the AI provider
 *   usage_recorded         — ai_usage row successfully inserted
 *   billing_usage_created  — ai_billing_usage row successfully inserted
 *   wallet_debit_attempted — wallet debit write is starting
 *   wallet_debit_succeeded — wallet debit ledger row committed
 *   wallet_debit_failed    — wallet debit failed (billing row intact, repairable)
 *   request_completed      — request finished successfully (normal path)
 *   request_replayed       — idempotency replay: prior result returned, no provider call
 *   cache_hit_replayed     — cache hit: cached result returned, no provider call
 *   wallet_replay_attempted — replay worker attempting to recover a missed debit
 */

import { db } from "../../db";
import { billingEvents } from "@shared/schema";

// ─── Event Type Vocabulary ────────────────────────────────────────────────────

export const BILLING_EVENT_TYPES = {
  REQUEST_STARTED: "request_started",
  PROVIDER_CALL_STARTED: "provider_call_started",
  USAGE_RECORDED: "usage_recorded",
  BILLING_USAGE_CREATED: "billing_usage_created",
  WALLET_DEBIT_ATTEMPTED: "wallet_debit_attempted",
  WALLET_DEBIT_SUCCEEDED: "wallet_debit_succeeded",
  WALLET_DEBIT_FAILED: "wallet_debit_failed",
  REQUEST_COMPLETED: "request_completed",
  REQUEST_REPLAYED: "request_replayed",
  CACHE_HIT_REPLAYED: "cache_hit_replayed",
  WALLET_REPLAY_ATTEMPTED: "wallet_replay_attempted",
} as const;

export type BillingEventType = (typeof BILLING_EVENT_TYPES)[keyof typeof BILLING_EVENT_TYPES];

// ─── Core Write Helper ────────────────────────────────────────────────────────

export interface RecordBillingEventInput {
  tenantId: string;
  eventType: BillingEventType;
  requestId?: string | null;
  usageId?: string | null;
  billingUsageId?: string | null;
  walletLedgerId?: string | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * Append one billing event row. Best-effort — never throws.
 * All errors are caught and logged. Callers must not await for correctness.
 */
export async function recordBillingEvent(input: RecordBillingEventInput): Promise<void> {
  try {
    await db.insert(billingEvents).values({
      tenantId: input.tenantId,
      eventType: input.eventType,
      requestId: input.requestId ?? null,
      usageId: input.usageId ?? null,
      billingUsageId: input.billingUsageId ?? null,
      walletLedgerId: input.walletLedgerId ?? null,
      status: "recorded",
      metadata: (input.metadata ?? null) as Record<string, unknown> | null,
    });
  } catch (err) {
    console.error(
      "[ai/billing-events] Failed to record billing event (suppressed):",
      input.eventType,
      err instanceof Error ? err.message : err,
    );
  }
}

// ─── Typed Event Helpers ──────────────────────────────────────────────────────

/** request_started: idempotency ownership acquired; execution begins. */
export function recordRequestStartedEvent(params: {
  tenantId: string;
  requestId?: string | null;
  routeKey?: string | null;
  provider?: string | null;
  model?: string | null;
}): void {
  void recordBillingEvent({
    tenantId: params.tenantId,
    eventType: BILLING_EVENT_TYPES.REQUEST_STARTED,
    requestId: params.requestId ?? null,
    metadata: {
      routeKey: params.routeKey ?? null,
      provider: params.provider ?? null,
      model: params.model ?? null,
    },
  });
}

/** provider_call_started: about to invoke the AI provider. */
export function recordProviderCallStartedEvent(params: {
  tenantId: string;
  requestId?: string | null;
  provider: string;
  model: string;
  routeKey?: string | null;
}): void {
  void recordBillingEvent({
    tenantId: params.tenantId,
    eventType: BILLING_EVENT_TYPES.PROVIDER_CALL_STARTED,
    requestId: params.requestId ?? null,
    metadata: {
      provider: params.provider,
      model: params.model,
      routeKey: params.routeKey ?? null,
    },
  });
}

/** usage_recorded: ai_usage row successfully inserted. */
export function recordUsageRecordedEvent(params: {
  tenantId: string;
  requestId?: string | null;
  usageId: string;
  provider?: string | null;
  model?: string | null;
  estimatedCostUsd?: number | null;
}): void {
  void recordBillingEvent({
    tenantId: params.tenantId,
    eventType: BILLING_EVENT_TYPES.USAGE_RECORDED,
    requestId: params.requestId ?? null,
    usageId: params.usageId,
    metadata: {
      provider: params.provider ?? null,
      model: params.model ?? null,
      estimatedCostUsd: params.estimatedCostUsd ?? null,
    },
  });
}

/** billing_usage_created: ai_billing_usage row successfully inserted. */
export function recordBillingUsageCreatedEvent(params: {
  tenantId: string;
  requestId?: string | null;
  usageId: string;
  billingUsageId: string;
  customerPriceUsd: number;
  providerCostUsd: number;
  marginUsd: number;
}): void {
  void recordBillingEvent({
    tenantId: params.tenantId,
    eventType: BILLING_EVENT_TYPES.BILLING_USAGE_CREATED,
    requestId: params.requestId ?? null,
    usageId: params.usageId,
    billingUsageId: params.billingUsageId,
    metadata: {
      customerPriceUsd: params.customerPriceUsd,
      providerCostUsd: params.providerCostUsd,
      marginUsd: params.marginUsd,
    },
  });
}

/** wallet_debit_attempted: wallet debit write is starting. */
export function recordWalletDebitAttemptedEvent(params: {
  tenantId: string;
  requestId?: string | null;
  billingUsageId: string;
  amountUsd: number;
}): void {
  void recordBillingEvent({
    tenantId: params.tenantId,
    eventType: BILLING_EVENT_TYPES.WALLET_DEBIT_ATTEMPTED,
    requestId: params.requestId ?? null,
    billingUsageId: params.billingUsageId,
    metadata: { amountUsd: params.amountUsd },
  });
}

/** wallet_debit_succeeded: wallet debit ledger row committed. */
export function recordWalletDebitSucceededEvent(params: {
  tenantId: string;
  requestId?: string | null;
  billingUsageId: string;
  walletLedgerId?: string | null;
  amountUsd: number;
  alreadyExisted?: boolean;
}): void {
  void recordBillingEvent({
    tenantId: params.tenantId,
    eventType: BILLING_EVENT_TYPES.WALLET_DEBIT_SUCCEEDED,
    requestId: params.requestId ?? null,
    billingUsageId: params.billingUsageId,
    walletLedgerId: params.walletLedgerId ?? null,
    metadata: {
      amountUsd: params.amountUsd,
      alreadyExisted: params.alreadyExisted ?? false,
    },
  });
}

/** wallet_debit_failed: wallet debit failed; billing row intact, repairable. */
export function recordWalletDebitFailedEvent(params: {
  tenantId: string;
  requestId?: string | null;
  billingUsageId: string;
  amountUsd: number;
  error: string;
}): void {
  void recordBillingEvent({
    tenantId: params.tenantId,
    eventType: BILLING_EVENT_TYPES.WALLET_DEBIT_FAILED,
    requestId: params.requestId ?? null,
    billingUsageId: params.billingUsageId,
    metadata: { amountUsd: params.amountUsd, error: params.error },
  });
}

/** request_completed: request finished successfully via normal provider path. */
export function recordRequestCompletedEvent(params: {
  tenantId: string;
  requestId?: string | null;
  usageId?: string | null;
  billingUsageId?: string | null;
  latencyMs?: number | null;
}): void {
  void recordBillingEvent({
    tenantId: params.tenantId,
    eventType: BILLING_EVENT_TYPES.REQUEST_COMPLETED,
    requestId: params.requestId ?? null,
    usageId: params.usageId ?? null,
    billingUsageId: params.billingUsageId ?? null,
    metadata: { latencyMs: params.latencyMs ?? null },
  });
}

/** request_replayed: idempotency replay — prior result returned, no provider call. */
export function recordRequestReplayedEvent(params: {
  tenantId: string;
  requestId?: string | null;
  replaySource: "idempotency" | "cache";
}): void {
  void recordBillingEvent({
    tenantId: params.tenantId,
    eventType: BILLING_EVENT_TYPES.REQUEST_REPLAYED,
    requestId: params.requestId ?? null,
    metadata: { replaySource: params.replaySource },
  });
}

/** cache_hit_replayed: cache hit — cached result returned, no provider call. */
export function recordCacheHitReplayedEvent(params: {
  tenantId: string;
  requestId?: string | null;
  routeKey?: string | null;
}): void {
  void recordBillingEvent({
    tenantId: params.tenantId,
    eventType: BILLING_EVENT_TYPES.CACHE_HIT_REPLAYED,
    requestId: params.requestId ?? null,
    metadata: { routeKey: params.routeKey ?? null },
  });
}

/** wallet_replay_attempted: replay worker attempting to recover a missed debit. */
export function recordWalletReplayAttemptedEvent(params: {
  tenantId: string;
  billingUsageId: string;
  amountUsd: number;
}): void {
  void recordBillingEvent({
    tenantId: params.tenantId,
    eventType: BILLING_EVENT_TYPES.WALLET_REPLAY_ATTEMPTED,
    billingUsageId: params.billingUsageId,
    metadata: { amountUsd: params.amountUsd },
  });
}
