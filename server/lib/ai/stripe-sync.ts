/**
 * Stripe Sync Foundation — Phase 4L
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides the synchronization layer between internal invoices and
 * downstream Stripe objects. This is foundation-only — no live Stripe
 * API calls are made in this phase.
 *
 * Source of truth rules:
 *   - Internal invoices remain the canonical source of truth for amounts
 *   - Stripe IDs are linkage only — they do not override totals
 *   - Sync failures must not mutate invoice totals
 *   - Sync state is persisted and auditable
 *
 * Sync lifecycle:
 *   not_synced → (markStripeSyncStarted) → (markStripeSyncSucceeded → synced)
 *                                         → (markStripeSyncFailed → sync_failed)
 */

import { eq, and, desc } from "drizzle-orm";
import { db } from "../../db";
import {
  stripeInvoiceLinks,
  invoices,
  paymentEvents,
} from "@shared/schema";
import type { StripeInvoiceLink } from "@shared/schema";

async function recordSyncEvent(
  invoiceId: string,
  tenantId: string,
  eventType: string,
  metadata?: Record<string, unknown> | null,
): Promise<void> {
  await db.insert(paymentEvents).values({
    invoicePaymentId: null,
    invoiceId,
    tenantId,
    eventType,
    eventSource: "internal",
    eventStatus: "recorded",
    metadata: metadata ?? null,
  });
}

export interface StripeIds {
  stripeCustomerId?: string | null;
  stripeInvoiceId?: string | null;
  stripePaymentIntentId?: string | null;
  stripeCheckoutSessionId?: string | null;
}

export async function createStripeInvoiceLink(
  invoiceId: string,
  stripeIds?: StripeIds | null,
): Promise<StripeInvoiceLink> {
  const invoiceRows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (invoiceRows.length === 0) {
    throw new Error(`[ai/stripe-sync] Invoice not found: ${invoiceId}`);
  }
  const invoice = invoiceRows[0];

  const existing = await db
    .select()
    .from(stripeInvoiceLinks)
    .where(eq(stripeInvoiceLinks.invoiceId, invoiceId))
    .limit(1);
  if (existing.length > 0) {
    console.log(`[ai/stripe-sync] Stripe link already exists for invoice ${invoiceId}`);
    return existing[0];
  }

  const inserted = await db
    .insert(stripeInvoiceLinks)
    .values({
      invoiceId,
      tenantId: invoice.tenantId,
      stripeCustomerId: stripeIds?.stripeCustomerId ?? null,
      stripeInvoiceId: stripeIds?.stripeInvoiceId ?? null,
      stripePaymentIntentId: stripeIds?.stripePaymentIntentId ?? null,
      stripeCheckoutSessionId: stripeIds?.stripeCheckoutSessionId ?? null,
      syncStatus: "not_synced",
    })
    .returning();

  console.log(
    `[ai/stripe-sync] Stripe link created for invoice ${invoice.invoiceNumber}`,
  );
  return inserted[0];
}

export async function markStripeSyncStarted(
  invoiceId: string,
): Promise<StripeInvoiceLink> {
  const link = await getStripeInvoiceLink(invoiceId);
  if (!link) {
    throw new Error(
      `[ai/stripe-sync] No Stripe link found for invoice ${invoiceId}. Create one first.`,
    );
  }

  const updated = await db
    .update(stripeInvoiceLinks)
    .set({ updatedAt: new Date() })
    .where(eq(stripeInvoiceLinks.id, link.id))
    .returning();

  await recordSyncEvent(invoiceId, link.tenantId, "stripe_sync_started");

  return updated[0];
}

export async function markStripeSyncSucceeded(
  invoiceId: string,
  stripeIds?: StripeIds | null,
): Promise<StripeInvoiceLink> {
  const link = await getStripeInvoiceLink(invoiceId);
  if (!link) {
    throw new Error(
      `[ai/stripe-sync] No Stripe link found for invoice ${invoiceId}`,
    );
  }

  const updated = await db
    .update(stripeInvoiceLinks)
    .set({
      syncStatus: "synced",
      lastSyncedAt: new Date(),
      lastSyncError: null,
      stripeCustomerId: stripeIds?.stripeCustomerId ?? link.stripeCustomerId,
      stripeInvoiceId: stripeIds?.stripeInvoiceId ?? link.stripeInvoiceId,
      stripePaymentIntentId: stripeIds?.stripePaymentIntentId ?? link.stripePaymentIntentId,
      stripeCheckoutSessionId: stripeIds?.stripeCheckoutSessionId ?? link.stripeCheckoutSessionId,
      updatedAt: new Date(),
    })
    .where(eq(stripeInvoiceLinks.id, link.id))
    .returning();

  await recordSyncEvent(invoiceId, link.tenantId, "stripe_sync_succeeded", {
    stripeInvoiceId: stripeIds?.stripeInvoiceId ?? link.stripeInvoiceId,
    stripePaymentIntentId: stripeIds?.stripePaymentIntentId ?? link.stripePaymentIntentId,
  });

  return updated[0];
}

export async function markStripeSyncFailed(
  invoiceId: string,
  error: string,
): Promise<StripeInvoiceLink> {
  const link = await getStripeInvoiceLink(invoiceId);
  if (!link) {
    throw new Error(
      `[ai/stripe-sync] No Stripe link found for invoice ${invoiceId}`,
    );
  }

  const updated = await db
    .update(stripeInvoiceLinks)
    .set({
      syncStatus: "sync_failed",
      lastSyncError: error,
      updatedAt: new Date(),
    })
    .where(eq(stripeInvoiceLinks.id, link.id))
    .returning();

  await recordSyncEvent(invoiceId, link.tenantId, "stripe_sync_failed", {
    error,
  });

  return updated[0];
}

export async function getStripeInvoiceLink(
  invoiceId: string,
): Promise<StripeInvoiceLink | null> {
  const rows = await db
    .select()
    .from(stripeInvoiceLinks)
    .where(eq(stripeInvoiceLinks.invoiceId, invoiceId))
    .limit(1);
  return rows[0] ?? null;
}

export interface StripeSyncSourceExplanation {
  invoiceId: string;
  invoiceNumber: string;
  invoiceTotalUsd: string;
  invoiceStatus: string;
  stripeLink: {
    id: string;
    syncStatus: string;
    stripeCustomerId: string | null;
    stripeInvoiceId: string | null;
    stripePaymentIntentId: string | null;
    stripeCheckoutSessionId: string | null;
    lastSyncedAt: Date | null;
    lastSyncError: string | null;
  } | null;
  sourceSummary: string;
}

export async function explainStripeSyncSource(
  invoiceId: string,
): Promise<StripeSyncSourceExplanation | null> {
  const invoiceRows = await db
    .select()
    .from(invoices)
    .where(eq(invoices.id, invoiceId))
    .limit(1);
  if (invoiceRows.length === 0) return null;
  const invoice = invoiceRows[0];

  const link = await getStripeInvoiceLink(invoiceId);

  return {
    invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    invoiceTotalUsd: String(invoice.totalUsd),
    invoiceStatus: invoice.status,
    stripeLink: link
      ? {
          id: link.id,
          syncStatus: link.syncStatus,
          stripeCustomerId: link.stripeCustomerId,
          stripeInvoiceId: link.stripeInvoiceId,
          stripePaymentIntentId: link.stripePaymentIntentId,
          stripeCheckoutSessionId: link.stripeCheckoutSessionId,
          lastSyncedAt: link.lastSyncedAt,
          lastSyncError: link.lastSyncError,
        }
      : null,
    sourceSummary: link
      ? `Invoice ${invoice.invoiceNumber} (total=${invoice.totalUsd} USD) has Stripe link (sync_status=${link.syncStatus}). Internal invoice total is the canonical source of truth — Stripe IDs are downstream linkage only.`
      : `Invoice ${invoice.invoiceNumber} (total=${invoice.totalUsd} USD) has no Stripe link yet.`,
  };
}
