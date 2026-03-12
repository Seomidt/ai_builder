/**
 * AI Billing Engine
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Computes and persists customer-facing billing rows after confirmed successful
 * ai_usage writes. Each billing row is immutable — pricing changes never mutate
 * past rows.
 *
 * Design rules:
 *   - Only called after a confirmed successful ai_usage insert (status = "success")
 *   - One billing row per ai_usage row max (UNIQUE on usage_id)
 *   - Billing write failures must never break AI runtime (fire-and-forget safe)
 *   - No negative customer_price_usd allowed
 *   - margin_usd = customer_price_usd - provider_cost_usd (may be 0)
 *
 * Config resolution: tenant → global → code default
 * Code default: cost_plus_multiplier with multiplier = 3.0
 *
 * Phase 4A: billing foundation only. No Stripe sync, no invoices.
 * Phase 4B: wallet debit triggered after confirmed billing insert.
 *
 * Wallet failure policy:
 *   ai_billing_usage is the canonical billing ledger.
 *   Wallet debit is downstream. If the wallet write fails, the billing row is
 *   still intact and the debit can be replayed later via billing_usage_id idempotency.
 *   Wallet failure must never break AI runtime or billing success.
 */

import { eq, and, sql } from "drizzle-orm";
import { db } from "../../db";
import { aiCustomerPricingConfigs, aiBillingUsage } from "@shared/schema";
import { attemptWalletDebitReturningResult } from "./wallet";
import {
  recordBillingUsageCreatedEvent,
  recordWalletDebitAttemptedEvent,
  recordWalletDebitSucceededEvent,
  recordWalletDebitFailedEvent,
} from "./billing-events";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ResolvedCustomerPricingConfig {
  pricingMode: "cost_plus_multiplier" | "fixed_markup" | "per_1k_tokens";
  multiplier: number;
  fixedMarkupUsd: number;
  pricePer1kInputTokensUsd: number;
  pricePer1kOutputTokensUsd: number;
  minimumChargeUsd: number;
  source: "tenant_config" | "global_config" | "code_default";
  version: string | null;
}

export interface BillingUsageInput {
  usageId: string;
  tenantId: string;
  requestId?: string | null;
  feature?: string | null;
  routeKey?: string | null;
  provider?: string | null;
  model?: string | null;
  inputTokensBillable: number;
  outputTokensBillable: number;
  totalTokensBillable: number;
  providerCostUsd: number;
}

export interface BillingCalculation {
  customerPriceUsd: number;
  marginUsd: number;
  pricingSource: string;
  pricingVersion: string | null;
  pricingMode: string;
}

// ─── Code Default ─────────────────────────────────────────────────────────────

const CODE_DEFAULT_PRICING: ResolvedCustomerPricingConfig = {
  pricingMode: "cost_plus_multiplier",
  multiplier: 3.0,
  fixedMarkupUsd: 0,
  pricePer1kInputTokensUsd: 0,
  pricePer1kOutputTokensUsd: 0,
  minimumChargeUsd: 0,
  source: "code_default",
  version: null,
};

// ─── Config Resolution ────────────────────────────────────────────────────────

/**
 * Load effective customer pricing config for a tenant.
 *
 * Resolution order:
 *   1. Active tenant-specific config (scope = "tenant", tenant_id = tenantId)
 *   2. Active global config (scope = "global")
 *   3. Code default (cost_plus_multiplier × 3.0)
 *
 * Fails open: DB errors return code default so billing always has a value.
 */
export async function loadEffectiveCustomerPricingConfig(
  tenantId: string,
): Promise<ResolvedCustomerPricingConfig> {
  try {
    // 1. Try tenant-specific config
    const tenantRows = await db
      .select()
      .from(aiCustomerPricingConfigs)
      .where(
        and(
          eq(aiCustomerPricingConfigs.tenantId, tenantId),
          eq(aiCustomerPricingConfigs.scope, "tenant"),
          eq(aiCustomerPricingConfigs.isActive, true),
        ),
      )
      .limit(1);

    if (tenantRows.length > 0) {
      return mapConfigRow(tenantRows[0], "tenant_config");
    }

    // 2. Try global config
    const globalRows = await db
      .select()
      .from(aiCustomerPricingConfigs)
      .where(
        and(
          eq(aiCustomerPricingConfigs.scope, "global"),
          eq(aiCustomerPricingConfigs.isActive, true),
        ),
      )
      .limit(1);

    if (globalRows.length > 0) {
      return mapConfigRow(globalRows[0], "global_config");
    }
  } catch (err) {
    console.error(
      "[ai/billing] Failed to load customer pricing config (using code default):",
      err instanceof Error ? err.message : err,
    );
  }

  // 3. Code default
  return CODE_DEFAULT_PRICING;
}

function mapConfigRow(
  row: typeof aiCustomerPricingConfigs.$inferSelect,
  source: "tenant_config" | "global_config",
): ResolvedCustomerPricingConfig {
  const mode = row.pricingMode as ResolvedCustomerPricingConfig["pricingMode"];
  return {
    pricingMode: mode,
    multiplier: Number(row.multiplier ?? 0),
    fixedMarkupUsd: Number(row.fixedMarkupUsd ?? 0),
    pricePer1kInputTokensUsd: Number(row.pricePer1kInputTokensUsd ?? 0),
    pricePer1kOutputTokensUsd: Number(row.pricePer1kOutputTokensUsd ?? 0),
    minimumChargeUsd: Number(row.minimumChargeUsd ?? 0),
    source,
    version: row.id,
  };
}

// ─── Price Calculation ────────────────────────────────────────────────────────

/**
 * Calculate customer_price_usd from provider_cost_usd using the resolved config.
 *
 * Modes:
 *   cost_plus_multiplier: max(minimum_charge, provider_cost × multiplier)
 *   fixed_markup:         max(minimum_charge, provider_cost + fixed_markup)
 *   per_1k_tokens:        (input/1000 × rate) + (output/1000 × rate), then apply floor
 *
 * Guarantees:
 *   - customer_price_usd is always >= 0
 *   - nulls treated as 0
 *   - margin_usd = customer_price_usd - provider_cost_usd (can be 0 or positive)
 */
export function calculateCustomerPrice(
  config: ResolvedCustomerPricingConfig,
  input: {
    providerCostUsd: number;
    inputTokensBillable: number;
    outputTokensBillable: number;
  },
): BillingCalculation {
  const providerCost = Math.max(0, input.providerCostUsd);
  const minCharge = Math.max(0, config.minimumChargeUsd);
  let rawPrice = 0;

  switch (config.pricingMode) {
    case "cost_plus_multiplier": {
      rawPrice = providerCost * Math.max(0, config.multiplier);
      break;
    }
    case "fixed_markup": {
      rawPrice = providerCost + Math.max(0, config.fixedMarkupUsd);
      break;
    }
    case "per_1k_tokens": {
      const inputCost = (input.inputTokensBillable / 1000) * config.pricePer1kInputTokensUsd;
      const outputCost = (input.outputTokensBillable / 1000) * config.pricePer1kOutputTokensUsd;
      rawPrice = Math.max(0, inputCost) + Math.max(0, outputCost);
      break;
    }
    default: {
      // Unknown mode — fall back to multiplier 1× (pass-through)
      rawPrice = providerCost;
    }
  }

  const customerPriceUsd = Math.max(minCharge, Math.max(0, rawPrice));
  const marginUsd = Math.max(0, customerPriceUsd - providerCost);

  return {
    customerPriceUsd,
    marginUsd,
    pricingSource: config.source,
    pricingVersion: config.version,
    pricingMode: config.pricingMode,
  };
}

// ─── Billing Write ─────────────────────────────────────────────────────────────

/**
 * Return type for recordAiBillingUsage:
 *   id                — the newly created billing row id (for wallet debit reference)
 *   customerPriceUsd  — computed customer price (for wallet debit amount)
 * Returns null if the row was a no-op (duplicate) or if the write failed.
 */
export interface BillingWriteResult {
  id: string;
  customerPriceUsd: number;
}

/**
 * Insert one immutable billing row for the given ai_usage row.
 *
 * Uses ON CONFLICT DO NOTHING on usage_id to prevent duplicate billing rows.
 * Billing write failures are caught and logged — never thrown to callers.
 *
 * Returns a BillingWriteResult if a new row was created, null if suppressed or failed.
 */
export async function recordAiBillingUsage(
  input: BillingUsageInput,
  config: ResolvedCustomerPricingConfig,
): Promise<BillingWriteResult | null> {
  const calc = calculateCustomerPrice(config, {
    providerCostUsd: input.providerCostUsd,
    inputTokensBillable: input.inputTokensBillable,
    outputTokensBillable: input.outputTokensBillable,
  });

  try {
    const inserted = await db
      .insert(aiBillingUsage)
      .values({
        tenantId: input.tenantId,
        usageId: input.usageId,
        requestId: input.requestId ?? null,
        feature: input.feature ?? null,
        routeKey: input.routeKey ?? null,
        provider: input.provider ?? null,
        model: input.model ?? null,
        inputTokensBillable: input.inputTokensBillable,
        outputTokensBillable: input.outputTokensBillable,
        totalTokensBillable: input.totalTokensBillable,
        providerCostUsd: String(input.providerCostUsd),
        customerPriceUsd: String(calc.customerPriceUsd),
        marginUsd: String(calc.marginUsd),
        pricingSource: calc.pricingSource,
        pricingVersion: calc.pricingVersion ?? null,
        pricingMode: calc.pricingMode,
      })
      .onConflictDoNothing()
      .returning({ id: aiBillingUsage.id });

    if (inserted.length === 0) {
      console.warn(
        "[ai/billing] Duplicate billing attempt suppressed for usage_id:",
        input.usageId,
      );
      return null;
    }

    return { id: inserted[0].id, customerPriceUsd: calc.customerPriceUsd };
  } catch (err) {
    console.error(
      "[ai/billing] Failed to write billing row (suppressed):",
      err instanceof Error ? err.message : err,
      "usage_id:", input.usageId,
    );
    return null;
  }
}

// ─── Wallet Status Update ─────────────────────────────────────────────────────

/**
 * Update wallet delivery status fields on an existing billing row.
 *
 * ONLY the three wallet-delivery metadata fields are updated:
 *   wallet_status, wallet_error_message, wallet_debited_at
 *
 * Financial value columns are NEVER updated. This function is the only
 * permitted mutating operation on ai_billing_usage rows post-insert.
 *
 * Fails silently — billing row audit integrity is more important than
 * enforcing wallet status propagation. Callers must log failures.
 */
export async function updateBillingWalletStatus(
  billingId: string,
  status: "debited" | "failed",
  errorMessage: string | null,
  debitedAt: Date | null,
): Promise<void> {
  try {
    await db
      .update(aiBillingUsage)
      .set({
        walletStatus: status,
        walletErrorMessage: errorMessage,
        walletDebitedAt: debitedAt,
      })
      .where(eq(aiBillingUsage.id, billingId));
  } catch (err) {
    console.error(
      "[ai/billing] Failed to update wallet_status on billing row (suppressed):",
      err instanceof Error ? err.message : err,
      "billing_id:", billingId,
    );
  }
}

/**
 * Load pricing config, write billing row, attempt wallet debit, update wallet status.
 *
 * This is the main entry point called from usage.ts after confirmed ai_usage success.
 * Fire-and-forget safe: never throws. Billing or wallet failure does not affect runtime.
 *
 * Flow:
 *   1. Load effective pricing config (fails open → code default)
 *   2. Insert ai_billing_usage row (ON CONFLICT DO NOTHING) — wallet_status='pending' by default
 *   3. If billing row was newly created:
 *      a. Attempt wallet debit via attemptWalletDebitReturningResult
 *      b. On success → update wallet_status='debited', wallet_debited_at=now()
 *      c. On failure → update wallet_status='failed', wallet_error_message=err
 *   4. Duplicate/replay billing rows (result=null) are skipped entirely
 *
 * Immutability guarantee:
 *   Financial columns (amounts, pricing, tokens) are set at insert and never touched again.
 *   Only wallet delivery metadata fields are updated post-insert.
 */
export async function maybeRecordAiBillingUsage(input: BillingUsageInput): Promise<void> {
  try {
    const config = await loadEffectiveCustomerPricingConfig(input.tenantId);
    const result = await recordAiBillingUsage(input, config);

    // Only attempt wallet debit when a new billing row was actually created.
    // Duplicate/replay paths return null — no second debit attempt, no status update.
    if (result !== null) {
      // Phase 4F: billing_usage_created event after confirmed ai_billing_usage insert.
      recordBillingUsageCreatedEvent({
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        usageId: input.usageId,
        billingUsageId: result.id,
        customerPriceUsd: result.customerPriceUsd,
        providerCostUsd: input.providerCostUsd,
        marginUsd: Math.max(0, result.customerPriceUsd - input.providerCostUsd),
      });

      // Phase 4F: wallet_debit_attempted event before debit write.
      recordWalletDebitAttemptedEvent({
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        billingUsageId: result.id,
        amountUsd: result.customerPriceUsd,
      });

      const walletResult = await attemptWalletDebitReturningResult({
        tenantId: input.tenantId,
        billingUsageId: result.id,
        amountUsd: result.customerPriceUsd,
        requestId: input.requestId ?? null,
      });

      if (walletResult.debited) {
        await updateBillingWalletStatus(result.id, "debited", null, new Date());
        // Phase 4F: wallet_debit_succeeded event.
        recordWalletDebitSucceededEvent({
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          billingUsageId: result.id,
          amountUsd: result.customerPriceUsd,
          alreadyExisted: walletResult.alreadyExisted ?? false,
        });
      } else {
        await updateBillingWalletStatus(
          result.id,
          "failed",
          walletResult.error ?? "unknown wallet error",
          null,
        );
        // Phase 4F: wallet_debit_failed event.
        recordWalletDebitFailedEvent({
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          billingUsageId: result.id,
          amountUsd: result.customerPriceUsd,
          error: walletResult.error ?? "unknown wallet error",
        });
        console.error(
          "[ai/billing] Wallet debit failed — billing row intact, wallet_status=failed:",
          walletResult.error,
          "billing_id:", result.id,
          "tenant:", input.tenantId,
        );
      }
    }
  } catch (err) {
    // Belt-and-suspenders: should never reach here due to internal catches, but just in case.
    console.error(
      "[ai/billing] Unexpected error in maybeRecordAiBillingUsage (suppressed):",
      err instanceof Error ? err.message : err,
    );
  }
}
