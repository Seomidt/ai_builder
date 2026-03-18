/**
 * Phase 22 — Customer Service
 * Manages Stripe customer records mapped to tenants.
 */

import { db } from "../../db";
import { stripeCustomers } from "@shared/schema";
import { sql as drizzleSql } from "drizzle-orm";
import { stripeIds } from "./stripe-client";

/**
 * Get the Stripe customer record for a tenant.
 */
export async function getStripeCustomer(tenantId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM stripe_customers WHERE tenant_id = ${tenantId} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

/**
 * Get a Stripe customer by their Stripe customer ID.
 */
export async function getStripeCustomerByStripeId(stripeCustomerId: string): Promise<Record<string, unknown> | null> {
  const rows = await db.execute(drizzleSql`
    SELECT * FROM stripe_customers WHERE stripe_customer_id = ${stripeCustomerId} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>) ?? null;
}

/**
 * Create or return existing Stripe customer for a tenant.
 * Idempotent: calling twice for the same tenant returns the same record.
 */
export async function upsertStripeCustomer(params: {
  tenantId: string;
  email?: string;
  stripeCustomerId?: string; // if provided, use this (real Stripe ID); otherwise generate synthetic
  metadata?: Record<string, unknown>;
}): Promise<{ id: string; stripeCustomerId: string; tenantId: string; isNew: boolean }> {
  if (!params.tenantId?.trim()) throw new Error("tenantId is required");

  // Check existing
  const existing = await getStripeCustomer(params.tenantId);
  if (existing) {
    return {
      id: existing.id as string,
      stripeCustomerId: existing.stripe_customer_id as string,
      tenantId: params.tenantId,
      isNew: false,
    };
  }

  const customerId = params.stripeCustomerId ?? stripeIds.customer();
  const rows = await db.insert(stripeCustomers).values({
    tenantId: params.tenantId,
    stripeCustomerId: customerId,
    email: params.email ?? null,
    metadata: params.metadata ?? null,
  }).returning({ id: stripeCustomers.id, stripeCustomerId: stripeCustomers.stripeCustomerId });

  return {
    id: rows[0].id,
    stripeCustomerId: rows[0].stripeCustomerId,
    tenantId: params.tenantId,
    isNew: true,
  };
}

/**
 * Update customer email/metadata.
 */
export async function updateStripeCustomer(tenantId: string, params: {
  email?: string;
  metadata?: Record<string, unknown>;
}): Promise<{ updated: boolean }> {
  await db.execute(drizzleSql`
    UPDATE stripe_customers SET
      email = COALESCE(${params.email ?? null}, email),
      metadata = COALESCE(${JSON.stringify(params.metadata ?? null)}, metadata),
      updated_at = NOW()
    WHERE tenant_id = ${tenantId}
  `);
  return { updated: true };
}

/**
 * List all Stripe customers (observability).
 */
export async function listStripeCustomers(params?: { limit?: number; offset?: number }): Promise<Array<Record<string, unknown>>> {
  const limit = params?.limit ?? 50;
  const offset = params?.offset ?? 0;
  const rows = await db.execute(drizzleSql`
    SELECT * FROM stripe_customers ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
  `);
  return rows.rows as Record<string, unknown>[];
}

/**
 * Delete a Stripe customer mapping (does not delete in Stripe).
 */
export async function deleteStripeCustomer(tenantId: string): Promise<{ deleted: boolean }> {
  await db.execute(drizzleSql`
    DELETE FROM stripe_customers WHERE tenant_id = ${tenantId}
  `);
  return { deleted: true };
}

/**
 * Get tenant ID from a Stripe customer ID.
 */
export async function getTenantFromStripeCustomer(stripeCustomerId: string): Promise<string | null> {
  const rows = await db.execute(drizzleSql`
    SELECT tenant_id FROM stripe_customers WHERE stripe_customer_id = ${stripeCustomerId} LIMIT 1
  `);
  return (rows.rows[0] as Record<string, unknown>)?.tenant_id as string ?? null;
}
