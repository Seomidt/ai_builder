/**
 * Invoice Retention & Lifecycle — Phase 4J
 *
 * SERVER-ONLY: Retention policy, lifecycle explanations, and preview helpers.
 *
 * RETENTION POLICY:
 *   Invoices are financial artifacts that may be required for:
 *   - Customer dispute resolution
 *   - Finance team reconciliation
 *   - Regulatory compliance / audit trails
 *   - Future Stripe sync verification
 *
 *   Finalized invoices must NOT be deleted in this phase.
 *   The default policy is long-lived retention — indefinite for finalized invoices.
 *
 *   Void invoices may be deleted after a retention window (not enforced in this phase).
 *   Draft invoices without finalization represent incomplete generation runs
 *   and may be pruned after a safe window (not enforced in this phase).
 *
 * IMMUTABILITY REMINDER:
 *   This module does not expose any destructive helpers for finalized invoices.
 *   Any deletion or mutation of finalized invoices requires explicit finance approval
 *   outside this automated system.
 */

import { eq, and, lt, isNull } from "drizzle-orm";
import { db } from "../../db";
import { invoices } from "@shared/schema";
import type { Invoice } from "@shared/schema";

// ─── Policy Explanation ───────────────────────────────────────────────────────

export interface InvoiceRetentionPolicy {
  finalizedInvoices: string;
  voidInvoices: string;
  draftInvoices: string;
  minimumRetentionDays: number;
  destructiveOpsAllowed: boolean;
  rationale: string;
}

/**
 * Return the canonical invoice retention policy for this platform.
 * Not enforced via cron in this phase — for documentation and admin tooling.
 */
export function explainInvoiceRetentionPolicy(): InvoiceRetentionPolicy {
  return {
    finalizedInvoices:
      "Indefinite retention. Finalized invoices are immutable financial artifacts and must not be deleted. Required for dispute resolution, audit, and future Stripe sync.",
    voidInvoices:
      "Retain for minimum 90 days after voiding. Void invoices remain as audit evidence. Future phases may implement archival after extended retention.",
    draftInvoices:
      "Draft invoices older than 30 days without finalization may indicate incomplete generation runs. Safe to prune after manual review, but not automated in this phase.",
    minimumRetentionDays: 90,
    destructiveOpsAllowed: false,
    rationale:
      "Invoices represent binding financial records between the platform and its tenants. Premature deletion creates unrecoverable audit gaps and violates SaaS accounting best practices. Retention is conservative by design.",
  };
}

// ─── Lifecycle Preview Helpers ────────────────────────────────────────────────

export interface VoidableInvoicePreview {
  invoiceId: string;
  invoiceNumber: string;
  tenantId: string;
  billingPeriodId: string;
  status: string;
  totalUsd: string;
  createdAt: Date;
  reason: string;
}

/**
 * Preview invoices that could safely be voided (draft invoices only).
 * Finalized invoices are excluded — they cannot be voided without explicit review.
 * This is a preview-only helper: no mutations are performed.
 */
export async function previewVoidableInvoices(): Promise<VoidableInvoicePreview[]> {
  const rows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.status, "draft"))
    .orderBy(invoices.createdAt)
    .limit(200);

  return rows.map((inv) => ({
    invoiceId: inv.id,
    invoiceNumber: inv.invoiceNumber,
    tenantId: inv.tenantId,
    billingPeriodId: inv.billingPeriodId,
    status: inv.status,
    totalUsd: String(inv.totalUsd),
    createdAt: inv.createdAt,
    reason:
      "Draft invoice has not been finalized. Can be voided if the billing period is being corrected or the invoice was generated in error.",
  }));
}

export interface DraftInvoiceWithoutFinalizationPreview {
  invoiceId: string;
  invoiceNumber: string;
  tenantId: string;
  billingPeriodId: string;
  totalUsd: string;
  createdAt: Date;
  daysSinceCreation: number;
  recommendation: string;
}

/**
 * Preview draft invoices that have not been finalized.
 * These represent incomplete generation runs or invoices pending review.
 * Returned sorted by age (oldest first). Preview-only — no mutations.
 */
export async function previewDraftInvoicesWithoutFinalization(): Promise<
  DraftInvoiceWithoutFinalizationPreview[]
> {
  const rows = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.status, "draft"), isNull(invoices.finalizedAt)))
    .orderBy(invoices.createdAt)
    .limit(200);

  const now = Date.now();
  return rows.map((inv) => {
    const daysSinceCreation = Math.floor(
      (now - inv.createdAt.getTime()) / (1000 * 60 * 60 * 24),
    );
    return {
      invoiceId: inv.id,
      invoiceNumber: inv.invoiceNumber,
      tenantId: inv.tenantId,
      billingPeriodId: inv.billingPeriodId,
      totalUsd: String(inv.totalUsd),
      createdAt: inv.createdAt,
      daysSinceCreation,
      recommendation:
        daysSinceCreation > 30
          ? "Stale draft (>30 days) — review and either finalize or void."
          : "Pending finalization — review and finalize if period is confirmed closed.",
    };
  });
}
