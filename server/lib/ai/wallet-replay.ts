/**
 * Wallet Debit Replay / Repair
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides functions to replay failed or pending wallet debit attempts.
 *
 * Design:
 *   - ai_billing_usage is the source of truth — replay reads billing rows
 *   - Replay is idempotent via billing_usage_id partial unique index on tenant_credit_ledger
 *   - One billing row can never produce more than one effective ledger debit row
 *   - On successful replay → wallet_status='debited', wallet_debited_at=now()
 *   - On repeated failure  → wallet_status stays 'failed', wallet_error_message updated
 *
 * Phase 4C: foundation only. No cron scheduler. Call manually or from admin tooling.
 *
 * Replay safety:
 *   If the debit ledger row already exists (from a prior partial success or race),
 *   debitTenantCreditsForBillingUsage returns false (suppressed by ON CONFLICT DO NOTHING).
 *   Replay correctly recognises this as "already debited" and marks the billing row debited.
 */

import { eq, inArray, and } from "drizzle-orm";
import { db } from "../../db";
import { aiBillingUsage } from "@shared/schema";
import { ensureTenantCreditAccount, debitTenantCreditsForBillingUsage } from "./wallet";
import { updateBillingWalletStatus } from "./billing";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReplayResult {
  billingUsageId: string;
  tenantId: string;
  outcome: "debited" | "already_debited" | "failed";
  error?: string;
}

export interface ReplayBatchResult {
  processed: number;
  debited: number;
  alreadyDebited: number;
  failed: number;
  results: ReplayResult[];
}

// ─── Query Helpers ────────────────────────────────────────────────────────────

/**
 * Return billing rows in 'pending' or 'failed' wallet_status, ordered oldest first.
 *
 * These are candidates for wallet debit replay.
 * Limit defaults to 100 to keep replay batches bounded.
 */
export async function getPendingOrFailedWalletDebits(
  limit = 100,
): Promise<Array<{ id: string; tenantId: string; customerPriceUsd: string; requestId: string | null }>> {
  return db
    .select({
      id: aiBillingUsage.id,
      tenantId: aiBillingUsage.tenantId,
      customerPriceUsd: aiBillingUsage.customerPriceUsd,
      requestId: aiBillingUsage.requestId,
    })
    .from(aiBillingUsage)
    .where(inArray(aiBillingUsage.walletStatus, ["pending", "failed"]))
    .orderBy(aiBillingUsage.createdAt)
    .limit(limit);
}

// ─── Single Row Replay ────────────────────────────────────────────────────────

/**
 * Replay the wallet debit for a single billing_usage_id.
 *
 * Idempotency guarantee:
 *   debitTenantCreditsForBillingUsage uses ON CONFLICT DO NOTHING on the
 *   partial unique index (billing_usage_id WHERE entry_type='credit_debit').
 *   If a debit row already exists, it returns false and we mark the billing
 *   row as debited without creating a duplicate ledger entry.
 *
 * Returns a ReplayResult describing the outcome.
 * Never throws — all errors are captured in the result.
 */
export async function replayWalletDebitForBillingUsage(
  billingUsageId: string,
): Promise<ReplayResult> {
  // Read the billing row
  const rows = await db
    .select({
      id: aiBillingUsage.id,
      tenantId: aiBillingUsage.tenantId,
      customerPriceUsd: aiBillingUsage.customerPriceUsd,
      requestId: aiBillingUsage.requestId,
      walletStatus: aiBillingUsage.walletStatus,
    })
    .from(aiBillingUsage)
    .where(eq(aiBillingUsage.id, billingUsageId))
    .limit(1);

  if (rows.length === 0) {
    return {
      billingUsageId,
      tenantId: "unknown",
      outcome: "failed",
      error: `Billing row not found: ${billingUsageId}`,
    };
  }

  const row = rows[0];

  // If already debited, nothing to do
  if (row.walletStatus === "debited") {
    return {
      billingUsageId,
      tenantId: row.tenantId,
      outcome: "already_debited",
    };
  }

  try {
    const accountId = await ensureTenantCreditAccount(row.tenantId);

    const isNew = await debitTenantCreditsForBillingUsage({
      tenantId: row.tenantId,
      accountId,
      billingUsageId: row.id,
      amountUsd: Number(row.customerPriceUsd),
      requestId: row.requestId ?? null,
    });

    // isNew = false means debit row already existed — still correct, mark debited
    await updateBillingWalletStatus(row.id, "debited", null, new Date());

    return {
      billingUsageId,
      tenantId: row.tenantId,
      outcome: isNew ? "debited" : "already_debited",
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    // Update wallet_status='failed' with new error message for observability
    await updateBillingWalletStatus(row.id, "failed", error, null);

    console.error(
      "[ai/wallet-replay] Replay failed:",
      error,
      "billing_usage_id:", billingUsageId,
      "tenant:", row.tenantId,
    );

    return {
      billingUsageId,
      tenantId: row.tenantId,
      outcome: "failed",
      error,
    };
  }
}

// ─── Batch Replay ─────────────────────────────────────────────────────────────

/**
 * Replay wallet debits for all pending/failed billing rows, up to `limit` rows.
 *
 * Processes rows sequentially (not concurrently) to avoid DB contention.
 * Returns a summary of outcomes.
 *
 * Recommended use: admin tooling, manual repair scripts, future cron job.
 * Not safe to run concurrently with itself — use a distributed lock if scheduling.
 */
export async function replayWalletDebitsBatch(limit = 100): Promise<ReplayBatchResult> {
  const candidates = await getPendingOrFailedWalletDebits(limit);

  const results: ReplayResult[] = [];
  let debited = 0;
  let alreadyDebited = 0;
  let failed = 0;

  for (const candidate of candidates) {
    const result = await replayWalletDebitForBillingUsage(candidate.id);
    results.push(result);

    if (result.outcome === "debited") debited++;
    else if (result.outcome === "already_debited") alreadyDebited++;
    else failed++;
  }

  console.info(
    `[ai/wallet-replay] Batch complete: ${candidates.length} candidates,`,
    `${debited} debited, ${alreadyDebited} already_debited, ${failed} failed`,
  );

  return {
    processed: candidates.length,
    debited,
    alreadyDebited,
    failed,
    results,
  };
}
