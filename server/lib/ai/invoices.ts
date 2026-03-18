/**
 * Invoice Generation Engine — Phase 4J
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Generates immutable tenant invoices from closed billing periods.
 *
 * Source of truth hierarchy:
 *   - billing_period_tenant_snapshots → invoice totals (accounting source)
 *   - billing_periods → period status + window
 *   - ai_billing_usage → NOT used for invoice totals after period close
 *   - wallet ledger → NOT the invoice source of truth
 *   - current pricing versions → NOT used for historical invoice derivation
 *
 * Invoice numbering format: INV-{YYYYMM}-{TENANT8}-{PERIOD8}
 *   YYYYMM  = billing period start year+month (UTC)
 *   TENANT8 = tenantId.replace(/-/g,'').slice(0,8).toUpperCase()
 *   PERIOD8 = billingPeriodId.replace(/-/g,'').slice(0,8).toUpperCase()
 *   Example: INV-202603-VALIDATEP-A1B2C3D4
 *   Properties: deterministic, stable, human-readable, no mutable counter dependency.
 *
 * Immutability enforcement:
 *   - Service-level: finalizeInvoice() and mutating helpers throw if invoice is finalized/void
 *   - DB-level: UNIQUE(tenant_id, billing_period_id) prevents duplicate generation
 *   - DB-level: CHECK constraints on status values prevent invalid states
 *   - Finalized invoices and their line items must not be edited; callers must treat them
 *     as append-only financial artifacts.
 */

import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import {
  invoices,
  invoiceLineItems,
  billingPeriods,
  billingPeriodTenantSnapshots,
} from "@shared/schema";
import type { Invoice, InvoiceLineItem } from "@shared/schema";

// ─── Invoice Numbering ────────────────────────────────────────────────────────

/**
 * Generate deterministic invoice number.
 * Format: INV-{YYYYMM}-{TENANT8}-{PERIOD8}
 * Deterministic given (tenantId, billingPeriodId, periodStart).
 */
function buildInvoiceNumber(
  tenantId: string,
  billingPeriodId: string,
  periodStart: Date,
): string {
  const year = periodStart.getUTCFullYear();
  const month = String(periodStart.getUTCMonth() + 1).padStart(2, "0");
  const tenant8 = tenantId.replace(/-/g, "").slice(0, 8).toUpperCase();
  const period8 = billingPeriodId.replace(/-/g, "").slice(0, 8).toUpperCase();
  return `INV-${year}${month}-${tenant8}-${period8}`;
}

// ─── Core Generation ──────────────────────────────────────────────────────────

/**
 * Create a draft invoice for a tenant + closed billing period.
 *
 * Rules:
 * 1. Billing period must exist.
 * 2. Billing period must be closed (status='closed').
 * 3. Tenant snapshot must exist for that tenant + period.
 * 4. Invoice totals derive from tenant snapshot.customer_price_usd.
 * 5. Idempotent: if invoice already exists for tenant+period, return it.
 * 6. One invoice per (tenant_id, billing_period_id).
 */
export async function createDraftInvoiceForTenantPeriod(
  tenantId: string,
  billingPeriodId: string,
): Promise<Invoice> {
  // 1) Check for existing invoice (idempotency)
  const existing = await getInvoiceByTenantPeriod(tenantId, billingPeriodId);
  if (existing) {
    console.log(
      `[ai/invoices] Invoice already exists for tenant=${tenantId} period=${billingPeriodId}: ${existing.id}`,
    );
    return existing;
  }

  // 2) Load billing period — must exist and be closed
  const periodRows = await db
    .select()
    .from(billingPeriods)
    .where(eq(billingPeriods.id, billingPeriodId))
    .limit(1);
  if (periodRows.length === 0) {
    throw new Error(
      `[ai/invoices] Billing period not found: ${billingPeriodId}`,
    );
  }
  const period = periodRows[0];
  if (period.status !== "closed") {
    throw new Error(
      `[ai/invoices] Cannot generate invoice for non-closed billing period ${billingPeriodId} (status='${period.status}'). Only closed periods are invoiceable.`,
    );
  }

  // 3) Load tenant snapshot — accounting source for invoice totals
  const snapshotRows = await db
    .select()
    .from(billingPeriodTenantSnapshots)
    .where(
      and(
        eq(billingPeriodTenantSnapshots.billingPeriodId, billingPeriodId),
        eq(billingPeriodTenantSnapshots.tenantId, tenantId),
      ),
    )
    .limit(1);
  if (snapshotRows.length === 0) {
    throw new Error(
      `[ai/invoices] No billing snapshot found for tenant=${tenantId} period=${billingPeriodId}. Cannot generate invoice without accounting source.`,
    );
  }
  const snapshot = snapshotRows[0];

  // 4) Build deterministic invoice number
  const invoiceNumber = buildInvoiceNumber(
    tenantId,
    billingPeriodId,
    period.periodStart,
  );

  // 5) Derive invoice totals from snapshot (canonical accounting source)
  // Phase 4K: include storage charges from snapshot if present
  const aiPrice = Number(snapshot.customerPriceUsd);
  const storagePrice = Number((snapshot as any).storageCustomerPriceUsd ?? 0);
  const combinedTotal = (aiPrice + storagePrice).toFixed(8);
  const subtotalUsd = combinedTotal;
  const totalUsd = combinedTotal;

  // 6) Insert invoice row
  const inserted = await db
    .insert(invoices)
    .values({
      tenantId,
      billingPeriodId,
      invoiceNumber,
      status: "draft",
      currency: "USD",
      subtotalUsd,
      totalUsd,
      issuedAt: new Date(),
      metadata: {
        sourceSnapshotId: snapshot.id,
        requestCount: snapshot.requestCount,
        providerCostUsd: String(snapshot.providerCostUsd),
        customerPriceUsd: String(snapshot.customerPriceUsd),
        marginUsd: String(snapshot.marginUsd),
        debitedAmountUsd: String(snapshot.debitedAmountUsd),
        storageCustomerPriceUsd: String(storagePrice),
        periodStart: period.periodStart.toISOString(),
        periodEnd: period.periodEnd.toISOString(),
      },
    })
    .returning();
  const invoice = inserted[0];

  // 7) Generate summary line items (AI + storage if applicable)
  await generateLineItems(invoice.id, snapshot, billingPeriodId, storagePrice);

  console.log(
    `[ai/invoices] Draft invoice created: ${invoice.invoiceNumber} (id=${invoice.id})`,
  );
  return invoice;
}

// ─── Line Item Generation ─────────────────────────────────────────────────────

async function generateLineItems(
  invoiceId: string,
  snapshot: {
    id: string;
    requestCount: number;
    customerPriceUsd: string | number;
    debitedAmountUsd: string | number;
    marginUsd: string | number;
    providerCostUsd: string | number;
  },
  billingPeriodId: string,
  storageCustomerPriceUsd = 0,
): Promise<void> {
  const requestCount = Number(snapshot.requestCount);
  const customerPrice = Number(snapshot.customerPriceUsd);
  const debitedAmount = Number(snapshot.debitedAmountUsd);
  const marginUsd = Number(snapshot.marginUsd);
  const providerCost = Number(snapshot.providerCostUsd);

  // Line 1: ai_usage_summary — primary charge (drives invoice total)
  const unitAmount =
    requestCount > 0 ? customerPrice / requestCount : customerPrice;
  await db.insert(invoiceLineItems).values({
    invoiceId,
    lineType: "ai_usage_summary",
    description: "AI usage charges for closed billing period",
    quantity: String(Math.max(requestCount, 1)),
    unitAmountUsd: String(unitAmount.toFixed(8)),
    lineTotalUsd: String(customerPrice.toFixed(8)),
    metadata: {
      sourceSnapshotId: snapshot.id,
      billingPeriodId,
      requestCount,
      customerPriceUsd: customerPrice,
    },
  });

  // Line 2: wallet_debit_summary — informational only (does not change invoice total)
  if (debitedAmount > 0) {
    await db.insert(invoiceLineItems).values({
      invoiceId,
      lineType: "wallet_debit_summary",
      description: "Wallet debits applied during period (informational)",
      quantity: "1",
      unitAmountUsd: "0",
      lineTotalUsd: "0",
      metadata: {
        debitedAmountUsd: debitedAmount,
        informationalOnly: true,
        note: "Wallet debits are recorded here for visibility only and do not affect invoice total.",
      },
    });
  }

  // Line 3: margin_summary — informational only (does not change invoice total)
  await db.insert(invoiceLineItems).values({
    invoiceId,
    lineType: "margin_summary",
    description: "Platform margin (informational)",
    quantity: "1",
    unitAmountUsd: "0",
    lineTotalUsd: "0",
    metadata: {
      providerCostUsd: providerCost,
      customerPriceUsd: customerPrice,
      marginUsd: marginUsd,
      marginPct:
        customerPrice > 0
          ? Number((marginUsd / customerPrice).toFixed(6))
          : null,
      informationalOnly: true,
      note: "Platform margin is recorded here for analytics only and does not affect invoice total.",
    },
  });

  // Line 4: storage_usage — storage charges from closed period snapshot (Phase 4K)
  // Only added when storage_customer_price_usd > 0 in the period snapshot.
  // line_total_usd contributes to invoice total (included in combinedTotal above).
  if (storageCustomerPriceUsd > 0) {
    await db.insert(invoiceLineItems).values({
      invoiceId,
      lineType: "storage_usage",
      description: "Cloud storage usage (Cloudflare R2)",
      quantity: "1",
      unitAmountUsd: String(storageCustomerPriceUsd.toFixed(8)),
      lineTotalUsd: String(storageCustomerPriceUsd.toFixed(8)),
      metadata: {
        sourceSnapshotId: snapshot.id,
        billingPeriodId,
        storageCustomerPriceUsd,
        note: "Storage charges derived from closed period snapshot storage_customer_price_usd. Not re-derived from live storage usage.",
      },
    });
  }
}

// ─── Finalization ─────────────────────────────────────────────────────────────

/**
 * Finalize a draft invoice. Sets status='finalized' and finalized_at=now().
 *
 * Immutability rule: finalized invoices cannot be re-finalized or mutated.
 * Void invoices cannot be finalized.
 */
export async function finalizeInvoice(invoiceId: string): Promise<Invoice> {
  const invoice = await getInvoiceById(invoiceId);
  if (!invoice) {
    throw new Error(`[ai/invoices] Invoice not found: ${invoiceId}`);
  }
  if (invoice.status === "finalized") {
    // Already finalized — return idempotently
    console.log(`[ai/invoices] Invoice ${invoiceId} already finalized`);
    return invoice;
  }
  if (invoice.status === "void") {
    throw new Error(
      `[ai/invoices] Cannot finalize void invoice ${invoiceId}. Void is terminal.`,
    );
  }

  const updated = await db
    .update(invoices)
    .set({ status: "finalized", finalizedAt: new Date() })
    .where(
      and(eq(invoices.id, invoiceId), eq(invoices.status, "draft")),
    )
    .returning();

  if (updated.length === 0) {
    throw new Error(
      `[ai/invoices] finalizeInvoice: could not update invoice ${invoiceId} — status may have changed concurrently`,
    );
  }

  console.log(
    `[ai/invoices] Invoice finalized: ${updated[0].invoiceNumber} (id=${invoiceId})`,
  );
  return updated[0];
}

// ─── Read Helpers ─────────────────────────────────────────────────────────────

export async function getInvoiceById(
  invoiceId: string,
): Promise<Invoice | null> {
  const rows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getInvoiceByTenantPeriod(
  tenantId: string,
  billingPeriodId: string,
): Promise<Invoice | null> {
  const rows = await db
    .select()
    .from(invoices)
    .where(
      and(
        eq(invoices.tenantId, tenantId),
        eq(invoices.billingPeriodId, billingPeriodId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listInvoicesByTenant(
  tenantId: string,
  limit = 50,
): Promise<Invoice[]> {
  return db
    .select()
    .from(invoices)
    .where(eq(invoices.tenantId, tenantId))
    .orderBy(invoices.createdAt)
    .limit(limit);
}

export async function listInvoiceLineItems(
  invoiceId: string,
): Promise<InvoiceLineItem[]> {
  return db
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, invoiceId))
    .orderBy(invoiceLineItems.createdAt);
}

// ─── Immutability Guard ───────────────────────────────────────────────────────

/**
 * Guard: throw if invoice is in a terminal state that blocks mutation.
 * Call this before any update to an invoice or its line items.
 */
export function assertInvoiceMutable(invoice: Invoice, operation: string): void {
  if (invoice.status === "finalized") {
    throw new Error(
      `[ai/invoices] ${operation}: Invoice ${invoice.id} (${invoice.invoiceNumber}) is finalized. Finalized invoices are immutable financial artifacts and cannot be modified.`,
    );
  }
  if (invoice.status === "void") {
    throw new Error(
      `[ai/invoices] ${operation}: Invoice ${invoice.id} (${invoice.invoiceNumber}) is void. Void invoices cannot be modified.`,
    );
  }
}
