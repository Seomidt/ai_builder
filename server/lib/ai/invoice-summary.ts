/**
 * Invoice Summary Helpers — Phase 4J
 *
 * SERVER-ONLY: Read helpers for invoices and invoice_line_items.
 * Designed for admin tooling, finance workflows, and dispute resolution.
 *
 * All summary functions derive from stored invoice data and
 * billing_period_tenant_snapshots — never from live mutable billing rows.
 */

import { eq, desc } from "drizzle-orm";
import { db } from "../../db";
import {
  invoices,
  invoiceLineItems,
  billingPeriods,
  billingPeriodTenantSnapshots,
} from "@shared/schema";
import type { Invoice, InvoiceLineItem } from "@shared/schema";

// ─── Invoice Summary Types ────────────────────────────────────────────────────

export interface InvoiceSummary {
  invoice: Invoice;
  lineItems: InvoiceLineItem[];
  lineCount: number;
  primaryChargeLine: InvoiceLineItem | null;
}

export interface InvoiceSourceExplanation {
  invoiceId: string;
  invoiceNumber: string;
  status: string;
  currency: string;
  subtotalUsd: number;
  totalUsd: number;
  billingPeriod: {
    id: string;
    periodStart: Date;
    periodEnd: Date;
    status: string;
  } | null;
  tenantSnapshot: {
    id: string;
    tenantId: string;
    requestCount: number;
    providerCostUsd: number;
    customerPriceUsd: number;
    marginUsd: number;
    debitedAmountUsd: number;
    marginPct: number | null;
  } | null;
  lineItemBreakdown: {
    lineType: string;
    description: string;
    quantity: number;
    unitAmountUsd: number;
    lineTotalUsd: number;
    informationalOnly: boolean;
  }[];
  sourceSummary: string;
}

// ─── Read Helpers ─────────────────────────────────────────────────────────────

/**
 * Full invoice summary: invoice row + all line items.
 */
export async function getInvoiceSummary(
  invoiceId: string,
): Promise<InvoiceSummary | null> {
  const invoiceRows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (invoiceRows.length === 0) return null;
  const invoice = invoiceRows[0];

  const lineItems = await db
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, invoiceId))
    .orderBy(invoiceLineItems.createdAt);

  const primaryChargeLine =
    lineItems.find((li) => li.lineType === "ai_usage_summary") ?? null;

  return {
    invoice,
    lineItems,
    lineCount: lineItems.length,
    primaryChargeLine,
  };
}

/**
 * List all invoices for a billing period across all tenants.
 */
export async function listInvoicesByBillingPeriod(
  billingPeriodId: string,
  limit = 100,
): Promise<Invoice[]> {
  return db
    .select()
    .from(invoices)
    .where(eq(invoices.billingPeriodId, billingPeriodId))
    .orderBy(desc(invoices.createdAt))
    .limit(limit);
}

/**
 * Most recent invoice for a tenant (by created_at).
 */
export async function getTenantLatestInvoiceSummary(
  tenantId: string,
): Promise<InvoiceSummary | null> {
  const rows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.tenantId, tenantId))
    .orderBy(desc(invoices.createdAt))
    .limit(1);
  if (rows.length === 0) return null;
  return getInvoiceSummary(rows[0].id);
}

/**
 * Explain an invoice's source: billing period, tenant snapshot, line item breakdown.
 * Designed for admin tooling and dispute resolution.
 */
export async function explainInvoiceSource(
  invoiceId: string,
): Promise<InvoiceSourceExplanation | null> {
  const invoiceRows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (invoiceRows.length === 0) return null;
  const invoice = invoiceRows[0];

  // Load billing period
  const periodRows = await db
    .select()
    .from(billingPeriods)
    .where(eq(billingPeriods.id, invoice.billingPeriodId))
    .limit(1);
  const period = periodRows[0] ?? null;

  // Load tenant snapshot (accounting source)
  const { and, eq: deq } = await import("drizzle-orm");
  const snapshotRows = await db
    .select()
    .from(billingPeriodTenantSnapshots)
    .where(
      and(
        deq(billingPeriodTenantSnapshots.billingPeriodId, invoice.billingPeriodId),
        deq(billingPeriodTenantSnapshots.tenantId, invoice.tenantId),
      ),
    )
    .limit(1);
  const snapshot = snapshotRows[0] ?? null;

  // Load line items
  const lineItems = await db
    .select()
    .from(invoiceLineItems)
    .where(eq(invoiceLineItems.invoiceId, invoiceId))
    .orderBy(invoiceLineItems.createdAt);

  const lineItemBreakdown = lineItems.map((li) => {
    const meta = li.metadata as Record<string, unknown> | null;
    return {
      lineType: li.lineType,
      description: li.description,
      quantity: Number(li.quantity),
      unitAmountUsd: Number(li.unitAmountUsd),
      lineTotalUsd: Number(li.lineTotalUsd),
      informationalOnly: meta?.informationalOnly === true,
    };
  });

  const customerPrice = snapshot ? Number(snapshot.customerPriceUsd) : 0;
  const marginUsd = snapshot ? Number(snapshot.marginUsd) : 0;

  return {
    invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    status: invoice.status,
    currency: invoice.currency,
    subtotalUsd: Number(invoice.subtotalUsd),
    totalUsd: Number(invoice.totalUsd),
    billingPeriod: period
      ? {
          id: period.id,
          periodStart: period.periodStart,
          periodEnd: period.periodEnd,
          status: period.status,
        }
      : null,
    tenantSnapshot: snapshot
      ? {
          id: snapshot.id,
          tenantId: snapshot.tenantId,
          requestCount: snapshot.requestCount,
          providerCostUsd: Number(snapshot.providerCostUsd),
          customerPriceUsd: customerPrice,
          marginUsd: marginUsd,
          debitedAmountUsd: Number(snapshot.debitedAmountUsd),
          marginPct:
            customerPrice > 0 ? Number((marginUsd / customerPrice).toFixed(6)) : null,
        }
      : null,
    lineItemBreakdown,
    sourceSummary: snapshot
      ? `Invoice total of ${invoice.totalUsd} USD is derived from billing_period_tenant_snapshots row ${snapshot.id} (customer_price_usd=${snapshot.customerPriceUsd}). Source billing period: ${invoice.billingPeriodId} (status=${period?.status ?? "unknown"}). Historical amounts are immutable.`
      : `Invoice ${invoiceId} has no matching tenant snapshot — totals may be unverifiable.`,
  };
}
