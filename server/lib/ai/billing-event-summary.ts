/**
 * Billing Event Summary — Phase 4F
 *
 * SERVER-ONLY: Read helpers for the billing_events table.
 * Used for debugging, auditing, and forensic investigation.
 * No UI — backend-only access.
 *
 * All queries are tenant-scoped where a tenantId is available.
 */

import { eq, and, desc } from "drizzle-orm";
import { db } from "../../db";
import { billingEvents } from "@shared/schema";
import type { BillingEvent } from "@shared/schema";

// ─── List by Request ID ───────────────────────────────────────────────────────

/**
 * Return all billing events for a specific request_id, ordered by creation time.
 * Provides the full monetization lifecycle for one logical AI request.
 */
export async function listBillingEventsByRequestId(
  requestId: string,
): Promise<BillingEvent[]> {
  return db
    .select()
    .from(billingEvents)
    .where(eq(billingEvents.requestId, requestId))
    .orderBy(billingEvents.createdAt);
}

// ─── List by Billing Usage ID ─────────────────────────────────────────────────

/**
 * Return all billing events linked to a specific ai_billing_usage row.
 * Useful for tracing the wallet lifecycle of a single billing record.
 */
export async function listBillingEventsByBillingUsageId(
  billingUsageId: string,
): Promise<BillingEvent[]> {
  return db
    .select()
    .from(billingEvents)
    .where(eq(billingEvents.billingUsageId, billingUsageId))
    .orderBy(billingEvents.createdAt);
}

// ─── List by Tenant ───────────────────────────────────────────────────────────

/**
 * Return recent billing events for a tenant, newest first.
 * Limit defaults to 100. Use for debugging and audit inspection.
 */
export async function listBillingEventsByTenant(
  tenantId: string,
  limit = 100,
): Promise<BillingEvent[]> {
  return db
    .select()
    .from(billingEvents)
    .where(eq(billingEvents.tenantId, tenantId))
    .orderBy(desc(billingEvents.createdAt))
    .limit(limit);
}

// ─── Summary for Request ──────────────────────────────────────────────────────

export interface BillingEventSummaryForRequest {
  requestId: string;
  tenantId: string | null;
  eventCount: number;
  eventTypes: string[];
  hasRequestStarted: boolean;
  hasProviderCallStarted: boolean;
  hasUsageRecorded: boolean;
  hasBillingUsageCreated: boolean;
  hasWalletDebitAttempted: boolean;
  hasWalletDebitSucceeded: boolean;
  hasWalletDebitFailed: boolean;
  hasRequestCompleted: boolean;
  hasRequestReplayed: boolean;
  firstEventAt: Date | null;
  lastEventAt: Date | null;
}

/**
 * Return a structured summary of the billing event timeline for a request.
 * Shows which lifecycle stages completed and which are missing.
 */
export async function getBillingEventSummaryForRequest(
  requestId: string,
): Promise<BillingEventSummaryForRequest> {
  const events = await listBillingEventsByRequestId(requestId);

  const types = events.map((e) => e.eventType);
  const has = (t: string) => types.includes(t);

  return {
    requestId,
    tenantId: events[0]?.tenantId ?? null,
    eventCount: events.length,
    eventTypes: Array.from(new Set(types)),
    hasRequestStarted: has("request_started"),
    hasProviderCallStarted: has("provider_call_started"),
    hasUsageRecorded: has("usage_recorded"),
    hasBillingUsageCreated: has("billing_usage_created"),
    hasWalletDebitAttempted: has("wallet_debit_attempted"),
    hasWalletDebitSucceeded: has("wallet_debit_succeeded"),
    hasWalletDebitFailed: has("wallet_debit_failed"),
    hasRequestCompleted: has("request_completed"),
    hasRequestReplayed: has("request_replayed"),
    firstEventAt: events.at(0)?.createdAt ?? null,
    lastEventAt: events.at(-1)?.createdAt ?? null,
  };
}
