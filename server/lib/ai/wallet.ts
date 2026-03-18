/**
 * Tenant Wallet / Credit Ledger
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Manages the tenant credit wallet built on top of ai_billing_usage.
 * All wallet state is derived from immutable ledger rows in tenant_credit_ledger.
 *
 * Architecture:
 *   tenant_credit_accounts — account metadata (one per tenant, no balance stored here)
 *   tenant_credit_ledger   — immutable event ledger, source of truth for balance
 *
 * Balance model:
 *   gross_balance_usd     = SUM(all credit entries) - SUM(all debit entries)
 *   available_balance_usd = SUM(non-expired credits) - SUM(all debit entries)
 *
 * Flow:
 *   provider call → ai_usage → ai_billing_usage → wallet debit
 *
 * Failure policy:
 *   ai_billing_usage is the canonical billing ledger.
 *   Wallet debit is downstream and fail-open — billing success is not contingent on wallet write.
 *   Failures are logged and the system is repairable via replay using billing_usage_id idempotency.
 *
 * Phase 4B: foundation only. No Stripe sync, no subscription plans, no invoice generation.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { tenantCreditAccounts, tenantCreditLedger } from "@shared/schema";
import type { AiErrorMeta } from "./errors";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CreditGrantInput {
  tenantId: string;
  amountUsd: number;
  description?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  expiresAt?: Date | null;
  createdBy?: string | null;
}

export interface WalletBalance {
  tenantId: string;
  grossBalanceUsd: number;
  availableBalanceUsd: number;
  totalGrantedUsd: number;
  totalDebitedUsd: number;
}

// ─── Account Management ───────────────────────────────────────────────────────

/**
 * Ensure a credit account exists for the tenant.
 *
 * Uses INSERT ON CONFLICT DO NOTHING then SELECT, so it is safe to call
 * repeatedly without creating duplicate rows.
 *
 * Returns the account id. Throws on DB error — callers decide whether to suppress.
 */
export async function ensureTenantCreditAccount(tenantId: string): Promise<string> {
  // Upsert: insert if missing, do nothing if already exists
  await db
    .insert(tenantCreditAccounts)
    .values({
      tenantId,
      currency: "USD",
      isActive: true,
    })
    .onConflictDoNothing();

  const rows = await db
    .select({ id: tenantCreditAccounts.id })
    .from(tenantCreditAccounts)
    .where(eq(tenantCreditAccounts.tenantId, tenantId))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(`[ai/wallet] Failed to create or find credit account for tenant: ${tenantId}`);
  }

  return rows[0].id;
}

// ─── Credit Grant ─────────────────────────────────────────────────────────────

/**
 * Grant credits to a tenant.
 *
 * Creates an immutable credit_grant ledger entry.
 * Ensures the credit account exists first.
 *
 * Returns the new ledger entry id.
 * Throws on DB error.
 */
export async function grantTenantCredits(input: CreditGrantInput): Promise<string> {
  if (input.amountUsd < 0) {
    throw new Error(`[ai/wallet] Credit grant amount must be >= 0, got: ${input.amountUsd}`);
  }

  const accountId = await ensureTenantCreditAccount(input.tenantId);

  const inserted = await db
    .insert(tenantCreditLedger)
    .values({
      tenantId: input.tenantId,
      accountId,
      entryType: "credit_grant",
      direction: "credit",
      amountUsd: String(input.amountUsd),
      billingUsageId: null,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      requestId: null,
      expiresAt: input.expiresAt ?? null,
      description: input.description ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning({ id: tenantCreditLedger.id });

  return inserted[0].id;
}

// ─── Credit Debit ─────────────────────────────────────────────────────────────

/**
 * Debit credits for a billing usage event.
 *
 * Creates an immutable credit_debit ledger entry tied to billing_usage_id.
 * Uses ON CONFLICT DO NOTHING on the partial unique index to enforce
 * one debit row per billing_usage_id.
 *
 * Returns true if a new debit was created, false if suppressed as duplicate.
 * Throws on DB error.
 */
export async function debitTenantCreditsForBillingUsage(input: {
  tenantId: string;
  accountId: string;
  billingUsageId: string;
  amountUsd: number;
  requestId?: string | null;
  description?: string | null;
}): Promise<boolean> {
  if (input.amountUsd < 0) {
    throw new Error(`[ai/wallet] Debit amount must be >= 0, got: ${input.amountUsd}`);
  }

  const inserted = await db
    .insert(tenantCreditLedger)
    .values({
      tenantId: input.tenantId,
      accountId: input.accountId,
      entryType: "credit_debit",
      direction: "debit",
      amountUsd: String(input.amountUsd),
      billingUsageId: input.billingUsageId,
      referenceType: "ai_billing_usage",
      referenceId: input.billingUsageId,
      requestId: input.requestId ?? null,
      expiresAt: null,
      description: input.description ?? "AI usage debit",
      createdBy: null,
    })
    .onConflictDoNothing()
    .returning({ id: tenantCreditLedger.id });

  if (inserted.length === 0) {
    console.warn(
      "[ai/wallet] Duplicate debit suppressed for billing_usage_id:",
      input.billingUsageId,
    );
    return false;
  }

  return true;
}

// ─── Balance Calculation ───────────────────────────────────────────────────────

/**
 * Calculate the tenant's current credit balance from ledger rows.
 *
 * gross_balance_usd:
 *   SUM of all credit entries minus SUM of all debit entries.
 *   Ignores expiration — reflects all historical activity.
 *
 * available_balance_usd:
 *   SUM of non-expired credit entries (expires_at IS NULL OR expires_at > NOW())
 *   minus SUM of all debit entries.
 *   This is the amount the tenant can actually use for AI calls.
 *
 * Both values are floored at 0 to prevent negative display values.
 * Negative ledger balances are possible if debits exceed grants — this is an
 * overage situation that must be handled by the billing layer separately.
 */
export async function getTenantCreditBalance(tenantId: string): Promise<WalletBalance> {
  const rows = await db
    .select({
      totalCreditsGross: sql<string>`
        COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_usd ELSE 0 END), 0)
      `,
      totalCreditsAvailable: sql<string>`
        COALESCE(SUM(CASE
          WHEN direction = 'credit'
            AND (expires_at IS NULL OR expires_at > NOW())
          THEN amount_usd
          ELSE 0
        END), 0)
      `,
      totalDebits: sql<string>`
        COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_usd ELSE 0 END), 0)
      `,
    })
    .from(tenantCreditLedger)
    .where(eq(tenantCreditLedger.tenantId, tenantId));

  const row = rows[0];
  const creditsGross = Number(row?.totalCreditsGross ?? 0);
  const creditsAvailable = Number(row?.totalCreditsAvailable ?? 0);
  const debits = Number(row?.totalDebits ?? 0);

  return {
    tenantId,
    grossBalanceUsd: creditsGross - debits,
    availableBalanceUsd: creditsAvailable - debits,
    totalGrantedUsd: creditsGross,
    totalDebitedUsd: debits,
  };
}

/**
 * Convenience alias — returns available balance only.
 * Used in guards and pre-flight checks.
 */
export async function getTenantAvailableCredits(tenantId: string): Promise<number> {
  const balance = await getTenantCreditBalance(tenantId);
  return balance.availableBalanceUsd;
}

// ─── Fire-and-Forget Debit ────────────────────────────────────────────────────

/**
 * Attempt a wallet debit for a billing usage row.
 *
 * Fire-and-forget safe:
 *   - Ensures account exists
 *   - Writes debit ledger row idempotently (tied to billing_usage_id)
 *   - Catches and logs all errors — never throws
 *   - Wallet failure does NOT break AI runtime or billing success
 *
 * Called from billing.ts after confirmed ai_billing_usage insert.
 * The system is repairable: missed debits can be replayed because
 * billing_usage_id uniqueness prevents double-debits on replay.
 */
export async function maybeRecordWalletDebit(input: {
  tenantId: string;
  billingUsageId: string;
  amountUsd: number;
  requestId?: string | null;
}): Promise<void> {
  try {
    const accountId = await ensureTenantCreditAccount(input.tenantId);
    await debitTenantCreditsForBillingUsage({
      tenantId: input.tenantId,
      accountId,
      billingUsageId: input.billingUsageId,
      amountUsd: input.amountUsd,
      requestId: input.requestId ?? null,
    });
  } catch (err) {
    console.error(
      "[ai/wallet] Wallet debit failed (suppressed — billing row intact):",
      err instanceof Error ? err.message : err,
      "billing_usage_id:", input.billingUsageId,
      "tenant:", input.tenantId,
    );
  }
}

// ─── Debit With Status Result ─────────────────────────────────────────────────

export interface WalletDebitResult {
  debited: boolean;
  alreadyExisted?: boolean;
  error?: string;
}

/**
 * Attempt a wallet debit and return the result — does NOT swallow errors.
 *
 * Unlike maybeRecordWalletDebit, this version returns a structured result so
 * the caller (billing.ts) can update wallet_status on the billing row.
 *
 * Returns:
 *   { debited: true }                   — new debit row created
 *   { debited: true, alreadyExisted: true } — debit row already existed (idempotent replay)
 *   { debited: false, error: "..." }    — write failed
 */
export async function attemptWalletDebitReturningResult(input: {
  tenantId: string;
  billingUsageId: string;
  amountUsd: number;
  requestId?: string | null;
}): Promise<WalletDebitResult> {
  try {
    const accountId = await ensureTenantCreditAccount(input.tenantId);

    const isNew = await debitTenantCreditsForBillingUsage({
      tenantId: input.tenantId,
      accountId,
      billingUsageId: input.billingUsageId,
      amountUsd: input.amountUsd,
      requestId: input.requestId ?? null,
    });

    // isNew = false means the row already existed (ON CONFLICT DO NOTHING suppressed it)
    return isNew ? { debited: true } : { debited: true, alreadyExisted: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(
      "[ai/wallet] attemptWalletDebitReturningResult failed:",
      error,
      "billing_usage_id:", input.billingUsageId,
    );
    return { debited: false, error };
  }
}

// ─── Hard-Limit Check ─────────────────────────────────────────────────────────

/**
 * Check if a tenant's wallet balance is at or below their configured hard limit.
 *
 * Called by runner.ts (step 8.5) before any provider call.
 * If available_balance_usd <= hard_limit_usd → throws AiWalletLimitError (402).
 *
 * Behavior when no credit account exists:
 *   No account row means the tenant has never been granted credits.
 *   Hard limit defaults to 0, available balance is 0.
 *   0 <= 0 → blocked. This is safe: a fresh tenant without credits
 *   cannot make billable AI calls without first being granted credits.
 *
 *   Callers may override this by granting credits first, or by setting
 *   hard_limit_usd < 0 on the account to allow PAYG-style overage.
 *
 * Fail-open on DB errors: if the check itself fails, we allow the call through
 * and log the error — a DB error on the hard-limit check must not silently block
 * valid tenant calls. This is the explicit policy for Phase 4C.
 */
export async function checkWalletHardLimit(input: {
  tenantId: string;
  meta: AiErrorMeta;
}): Promise<void> {
  const { AiWalletLimitError } = await import("./errors");

  try {
    // Read account for hard_limit_usd — if no account, use default 0
    const accountRows = await db
      .select({ hardLimitUsd: tenantCreditAccounts.hardLimitUsd })
      .from(tenantCreditAccounts)
      .where(eq(tenantCreditAccounts.tenantId, input.tenantId))
      .limit(1);

    const hardLimit = Number(accountRows[0]?.hardLimitUsd ?? 0);

    // Calculate available balance from ledger
    const balance = await getTenantCreditBalance(input.tenantId);

    if (balance.availableBalanceUsd <= hardLimit) {
      throw new AiWalletLimitError({
        ...input.meta,
        availableBalance: balance.availableBalanceUsd,
        hardLimit,
      });
    }
  } catch (err) {
    // Re-throw AiWalletLimitError (this is an intentional block)
    const { AiWalletLimitError: WalletLimitErr } = await import("./errors");
    if (err instanceof WalletLimitErr) throw err;

    // DB errors on the hard-limit check are fail-open — log and allow through
    console.error(
      "[ai/wallet] checkWalletHardLimit DB error (fail-open — call allowed through):",
      err instanceof Error ? err.message : err,
      "tenant:", input.tenantId,
    );
  }
}
