/**
 * Wallet Summary Foundation
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Returns a backend-only wallet summary for a given tenant.
 * Used for admin dashboards, internal reporting, and future credit-aware guardrails.
 *
 * Phase 4B: foundation only. No public route exposed here.
 */

import { eq, desc } from "drizzle-orm";
import { db } from "../../db";
import { tenantCreditLedger } from "@shared/schema";
import { getTenantCreditBalance } from "./wallet";

export interface TenantWalletSummary {
  tenantId: string;
  grossBalanceUsd: number;
  availableBalanceUsd: number;
  totalGrantedUsd: number;
  totalDebitedUsd: number;
  lastLedgerEntryAt: string | null;
}

/**
 * Return a full wallet summary for the given tenant.
 *
 * Derives balance from live ledger rows on every call — no cached state.
 * Callers should add caching at a higher layer if this becomes a hot path.
 *
 * Throws on DB error.
 */
export async function getTenantWalletSummary(tenantId: string): Promise<TenantWalletSummary> {
  const [balance, lastEntry] = await Promise.all([
    getTenantCreditBalance(tenantId),
    db
      .select({ createdAt: tenantCreditLedger.createdAt })
      .from(tenantCreditLedger)
      .where(eq(tenantCreditLedger.tenantId, tenantId))
      .orderBy(desc(tenantCreditLedger.createdAt))
      .limit(1),
  ]);

  return {
    tenantId,
    grossBalanceUsd: balance.grossBalanceUsd,
    availableBalanceUsd: balance.availableBalanceUsd,
    totalGrantedUsd: balance.totalGrantedUsd,
    totalDebitedUsd: balance.totalDebitedUsd,
    lastLedgerEntryAt: lastEntry[0]?.createdAt?.toISOString() ?? null,
  };
}
