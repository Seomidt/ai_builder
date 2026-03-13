/**
 * Admin Pricing Helpers — Phase 4P
 *
 * SERVER-ONLY: This module must never be imported from client/ code.
 *
 * Provides safe admin operations for pricing version management:
 *   - Preview (dry-run) before applying any version creation
 *   - Apply creates a new version row only — never mutates existing rows
 *   - Every operation records admin_change_requests + admin_change_events
 *
 * Design rules enforced:
 *   A) No edit-in-place for active or historical pricing versions
 *   B) Overlap detection before every insert
 *   C) All operations are auditable via admin_change_requests/events
 *   D) Preview never writes pricing rows
 */

import { eq, and, or, isNull, lte, gt, desc } from "drizzle-orm";
import { db } from "../../db";
import {
  providerPricingVersions,
  customerPricingVersions,
  storagePricingVersions,
  customerStoragePricingVersions,
  adminChangeRequests,
  adminChangeEvents,
} from "@shared/schema";
import type {
  ProviderPricingVersion,
  CustomerPricingVersion,
  StoragePricingVersion,
  CustomerStoragePricingVersion,
} from "@shared/schema";

// ─── Internal Admin Change Helpers ───────────────────────────────────────────

async function createAdminChangeRequest(
  changeType: string,
  targetScope: string,
  targetId: string | null,
  requestPayload: Record<string, unknown>,
  requestedBy: string | null,
): Promise<string> {
  const rows = await db
    .insert(adminChangeRequests)
    .values({
      changeType,
      targetScope,
      targetId,
      requestedBy,
      status: "pending",
      requestPayload,
    })
    .returning({ id: adminChangeRequests.id });
  return rows[0].id;
}

async function recordAdminChangeEvent(
  adminChangeRequestId: string,
  eventType: string,
  metadata: Record<string, unknown> | null = null,
): Promise<void> {
  await db.insert(adminChangeEvents).values({
    adminChangeRequestId,
    eventType,
    metadata,
  });
}

async function markAdminChangeApplied(
  id: string,
  appliedResult: Record<string, unknown>,
): Promise<void> {
  await db
    .update(adminChangeRequests)
    .set({ status: "applied", appliedResult, appliedAt: new Date() })
    .where(eq(adminChangeRequests.id, id));
}

async function markAdminChangeFailed(
  id: string,
  errorMessage: string,
): Promise<void> {
  await db
    .update(adminChangeRequests)
    .set({ status: "failed", errorMessage })
    .where(eq(adminChangeRequests.id, id));
}

// ─── Overlap Detection ────────────────────────────────────────────────────────

function windowsOverlap(
  aFrom: Date,
  aTo: Date | null,
  bFrom: Date,
  bTo: Date | null,
): boolean {
  const aEnd = aTo ? aTo.getTime() : Infinity;
  const bEnd = bTo ? bTo.getTime() : Infinity;
  return aFrom.getTime() < bEnd && bFrom.getTime() < aEnd;
}

// ─── Provider Pricing Version ─────────────────────────────────────────────────

export interface CreateProviderPricingVersionInput {
  provider: string;
  model: string;
  pricingVersion: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  inputTokenPriceUsd: string;
  outputTokenPriceUsd: string;
  cachedInputTokenPriceUsd?: string;
  reasoningTokenPriceUsd?: string;
  metadata?: Record<string, unknown> | null;
  requestedBy?: string | null;
}

export interface PricingVersionPreviewResult {
  valid: boolean;
  overlapConflicts: { id: string; effectiveFrom: string; effectiveTo: string | null; pricingVersion: string }[];
  proposedWindow: { effectiveFrom: string; effectiveTo: string | null };
  message: string;
}

export async function previewCreateProviderPricingVersion(
  input: CreateProviderPricingVersionInput,
): Promise<PricingVersionPreviewResult> {
  const existing = await db
    .select()
    .from(providerPricingVersions)
    .where(
      and(
        eq(providerPricingVersions.provider, input.provider),
        eq(providerPricingVersions.model, input.model),
      ),
    );

  const proposedFrom = new Date(input.effectiveFrom);
  const proposedTo = input.effectiveTo ? new Date(input.effectiveTo) : null;

  const conflicts = existing.filter((row) =>
    windowsOverlap(
      proposedFrom,
      proposedTo,
      new Date(row.effectiveFrom),
      row.effectiveTo ? new Date(row.effectiveTo) : null,
    ),
  );

  return {
    valid: conflicts.length === 0,
    overlapConflicts: conflicts.map((r) => ({
      id: r.id,
      effectiveFrom: new Date(r.effectiveFrom).toISOString(),
      effectiveTo: r.effectiveTo ? new Date(r.effectiveTo).toISOString() : null,
      pricingVersion: r.pricingVersion,
    })),
    proposedWindow: {
      effectiveFrom: proposedFrom.toISOString(),
      effectiveTo: proposedTo?.toISOString() ?? null,
    },
    message:
      conflicts.length === 0
        ? "No overlap detected. Safe to apply."
        : `${conflicts.length} overlapping version(s) detected. Apply blocked.`,
  };
}

export async function applyCreateProviderPricingVersion(
  input: CreateProviderPricingVersionInput,
): Promise<{ changeRequestId: string; versionId: string }> {
  const payload = { ...input, effectiveFrom: input.effectiveFrom.toISOString() };
  const changeRequestId = await createAdminChangeRequest(
    "provider_pricing_version_create",
    "global",
    null,
    payload,
    input.requestedBy ?? null,
  );

  await recordAdminChangeEvent(changeRequestId, "request_created", { provider: input.provider, model: input.model });
  await recordAdminChangeEvent(changeRequestId, "apply_started", null);

  try {
    const preview = await previewCreateProviderPricingVersion(input);
    if (!preview.valid) {
      await markAdminChangeFailed(changeRequestId, preview.message);
      await recordAdminChangeEvent(changeRequestId, "apply_failed", { reason: preview.message, conflicts: preview.overlapConflicts });
      throw new Error(`[admin-pricing] Provider pricing version apply blocked: ${preview.message}`);
    }

    const rows = await db
      .insert(providerPricingVersions)
      .values({
        provider: input.provider,
        model: input.model,
        pricingVersion: input.pricingVersion,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        inputTokenPriceUsd: input.inputTokenPriceUsd,
        outputTokenPriceUsd: input.outputTokenPriceUsd,
        cachedInputTokenPriceUsd: input.cachedInputTokenPriceUsd ?? "0",
        reasoningTokenPriceUsd: input.reasoningTokenPriceUsd ?? "0",
        metadata: input.metadata ?? null,
      })
      .returning({ id: providerPricingVersions.id });

    const versionId = rows[0].id;
    await markAdminChangeApplied(changeRequestId, { versionId, provider: input.provider, model: input.model, pricingVersion: input.pricingVersion });
    await recordAdminChangeEvent(changeRequestId, "apply_succeeded", { versionId });

    return { changeRequestId, versionId };
  } catch (err) {
    if ((err as Error).message.includes("apply_blocked") || (err as Error).message.includes("admin-pricing")) throw err;
    await markAdminChangeFailed(changeRequestId, (err as Error).message);
    await recordAdminChangeEvent(changeRequestId, "apply_failed", { error: (err as Error).message });
    throw err;
  }
}

// ─── Customer Pricing Version ─────────────────────────────────────────────────

export interface CreateCustomerPricingVersionInput {
  tenantId: string;
  feature: string;
  provider: string;
  model?: string | null;
  pricingVersion: string;
  pricingMode: string;
  pricingSource?: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  multiplier?: string | null;
  flatMarkupUsd?: string | null;
  perRequestMarkupUsd?: string | null;
  metadata?: Record<string, unknown> | null;
  requestedBy?: string | null;
}

export async function previewCreateCustomerPricingVersion(
  input: CreateCustomerPricingVersionInput,
): Promise<PricingVersionPreviewResult> {
  const existing = await db
    .select()
    .from(customerPricingVersions)
    .where(
      and(
        eq(customerPricingVersions.tenantId, input.tenantId),
        eq(customerPricingVersions.feature, input.feature),
        eq(customerPricingVersions.provider, input.provider),
      ),
    );

  const proposedFrom = new Date(input.effectiveFrom);
  const proposedTo = input.effectiveTo ? new Date(input.effectiveTo) : null;

  const conflicts = existing.filter((row) =>
    windowsOverlap(
      proposedFrom,
      proposedTo,
      new Date(row.effectiveFrom),
      row.effectiveTo ? new Date(row.effectiveTo) : null,
    ),
  );

  return {
    valid: conflicts.length === 0,
    overlapConflicts: conflicts.map((r) => ({
      id: r.id,
      effectiveFrom: new Date(r.effectiveFrom).toISOString(),
      effectiveTo: r.effectiveTo ? new Date(r.effectiveTo).toISOString() : null,
      pricingVersion: r.pricingVersion,
    })),
    proposedWindow: {
      effectiveFrom: proposedFrom.toISOString(),
      effectiveTo: proposedTo?.toISOString() ?? null,
    },
    message:
      conflicts.length === 0
        ? "No overlap detected. Safe to apply."
        : `${conflicts.length} overlapping version(s) detected. Apply blocked.`,
  };
}

export async function applyCreateCustomerPricingVersion(
  input: CreateCustomerPricingVersionInput,
): Promise<{ changeRequestId: string; versionId: string }> {
  const payload = { ...input, effectiveFrom: input.effectiveFrom.toISOString() };
  const changeRequestId = await createAdminChangeRequest(
    "customer_pricing_version_create",
    "tenant",
    input.tenantId,
    payload,
    input.requestedBy ?? null,
  );

  await recordAdminChangeEvent(changeRequestId, "request_created", { tenantId: input.tenantId, feature: input.feature });
  await recordAdminChangeEvent(changeRequestId, "apply_started", null);

  try {
    const preview = await previewCreateCustomerPricingVersion(input);
    if (!preview.valid) {
      await markAdminChangeFailed(changeRequestId, preview.message);
      await recordAdminChangeEvent(changeRequestId, "apply_failed", { reason: preview.message });
      throw new Error(`[admin-pricing] Customer pricing version apply blocked: ${preview.message}`);
    }

    const rows = await db
      .insert(customerPricingVersions)
      .values({
        tenantId: input.tenantId,
        feature: input.feature,
        provider: input.provider,
        model: input.model ?? null,
        pricingVersion: input.pricingVersion,
        pricingMode: input.pricingMode,
        pricingSource: input.pricingSource ?? "tenant_config",
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        multiplier: input.multiplier ?? null,
        flatMarkupUsd: input.flatMarkupUsd ?? null,
        perRequestMarkupUsd: input.perRequestMarkupUsd ?? null,
        metadata: input.metadata ?? null,
      })
      .returning({ id: customerPricingVersions.id });

    const versionId = rows[0].id;
    await markAdminChangeApplied(changeRequestId, { versionId, tenantId: input.tenantId });
    await recordAdminChangeEvent(changeRequestId, "apply_succeeded", { versionId });

    return { changeRequestId, versionId };
  } catch (err) {
    if ((err as Error).message.includes("admin-pricing")) throw err;
    await markAdminChangeFailed(changeRequestId, (err as Error).message);
    await recordAdminChangeEvent(changeRequestId, "apply_failed", { error: (err as Error).message });
    throw err;
  }
}

// ─── Storage Pricing Version ──────────────────────────────────────────────────

export interface CreateStoragePricingVersionInput {
  storageProvider?: string;
  storageProduct?: string;
  metricType: string;
  pricingVersion: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  includedUsage?: string | null;
  unitPriceUsd: string;
  metadata?: Record<string, unknown> | null;
  requestedBy?: string | null;
}

export async function previewCreateStoragePricingVersion(
  input: CreateStoragePricingVersionInput,
): Promise<PricingVersionPreviewResult> {
  const existing = await db
    .select()
    .from(storagePricingVersions)
    .where(
      and(
        eq(storagePricingVersions.storageProvider, input.storageProvider ?? "cloudflare"),
        eq(storagePricingVersions.storageProduct, input.storageProduct ?? "r2"),
        eq(storagePricingVersions.metricType, input.metricType),
      ),
    );

  const proposedFrom = new Date(input.effectiveFrom);
  const proposedTo = input.effectiveTo ? new Date(input.effectiveTo) : null;

  const conflicts = existing.filter((row) =>
    windowsOverlap(
      proposedFrom,
      proposedTo,
      new Date(row.effectiveFrom),
      row.effectiveTo ? new Date(row.effectiveTo) : null,
    ),
  );

  return {
    valid: conflicts.length === 0,
    overlapConflicts: conflicts.map((r) => ({
      id: r.id,
      effectiveFrom: new Date(r.effectiveFrom).toISOString(),
      effectiveTo: r.effectiveTo ? new Date(r.effectiveTo).toISOString() : null,
      pricingVersion: r.pricingVersion,
    })),
    proposedWindow: {
      effectiveFrom: proposedFrom.toISOString(),
      effectiveTo: proposedTo?.toISOString() ?? null,
    },
    message:
      conflicts.length === 0
        ? "No overlap detected. Safe to apply."
        : `${conflicts.length} overlapping version(s) detected. Apply blocked.`,
  };
}

export async function applyCreateStoragePricingVersion(
  input: CreateStoragePricingVersionInput,
): Promise<{ changeRequestId: string; versionId: string }> {
  const payload = { ...input, effectiveFrom: input.effectiveFrom.toISOString() };
  const changeRequestId = await createAdminChangeRequest(
    "storage_pricing_version_create",
    "global",
    null,
    payload,
    input.requestedBy ?? null,
  );

  await recordAdminChangeEvent(changeRequestId, "request_created", { metricType: input.metricType });
  await recordAdminChangeEvent(changeRequestId, "apply_started", null);

  try {
    const preview = await previewCreateStoragePricingVersion(input);
    if (!preview.valid) {
      await markAdminChangeFailed(changeRequestId, preview.message);
      await recordAdminChangeEvent(changeRequestId, "apply_failed", { reason: preview.message });
      throw new Error(`[admin-pricing] Storage pricing version apply blocked: ${preview.message}`);
    }

    const rows = await db
      .insert(storagePricingVersions)
      .values({
        storageProvider: input.storageProvider ?? "cloudflare",
        storageProduct: input.storageProduct ?? "r2",
        metricType: input.metricType,
        pricingVersion: input.pricingVersion,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        includedUsage: input.includedUsage ?? null,
        unitPriceUsd: input.unitPriceUsd,
        metadata: input.metadata ?? null,
      })
      .returning({ id: storagePricingVersions.id });

    const versionId = rows[0].id;
    await markAdminChangeApplied(changeRequestId, { versionId, metricType: input.metricType });
    await recordAdminChangeEvent(changeRequestId, "apply_succeeded", { versionId });

    return { changeRequestId, versionId };
  } catch (err) {
    if ((err as Error).message.includes("admin-pricing")) throw err;
    await markAdminChangeFailed(changeRequestId, (err as Error).message);
    await recordAdminChangeEvent(changeRequestId, "apply_failed", { error: (err as Error).message });
    throw err;
  }
}

// ─── Customer Storage Pricing Version ────────────────────────────────────────

export interface CreateCustomerStoragePricingVersionInput {
  tenantId: string;
  storageProvider?: string;
  storageProduct?: string;
  metricType: string;
  pricingVersion: string;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  metadata?: Record<string, unknown> | null;
  requestedBy?: string | null;
}

export async function previewCreateCustomerStoragePricingVersion(
  input: CreateCustomerStoragePricingVersionInput,
): Promise<PricingVersionPreviewResult> {
  const existing = await db
    .select()
    .from(customerStoragePricingVersions)
    .where(
      and(
        eq(customerStoragePricingVersions.tenantId, input.tenantId),
        eq(customerStoragePricingVersions.storageProvider, input.storageProvider ?? "cloudflare"),
        eq(customerStoragePricingVersions.storageProduct, input.storageProduct ?? "r2"),
        eq(customerStoragePricingVersions.metricType, input.metricType),
      ),
    );

  const proposedFrom = new Date(input.effectiveFrom);
  const proposedTo = input.effectiveTo ? new Date(input.effectiveTo) : null;

  const conflicts = existing.filter((row) =>
    windowsOverlap(
      proposedFrom,
      proposedTo,
      new Date(row.effectiveFrom),
      row.effectiveTo ? new Date(row.effectiveTo) : null,
    ),
  );

  return {
    valid: conflicts.length === 0,
    overlapConflicts: conflicts.map((r) => ({
      id: r.id,
      effectiveFrom: new Date(r.effectiveFrom).toISOString(),
      effectiveTo: r.effectiveTo ? new Date(r.effectiveTo).toISOString() : null,
      pricingVersion: r.pricingVersion,
    })),
    proposedWindow: {
      effectiveFrom: proposedFrom.toISOString(),
      effectiveTo: proposedTo?.toISOString() ?? null,
    },
    message:
      conflicts.length === 0
        ? "No overlap detected. Safe to apply."
        : `${conflicts.length} overlapping version(s) detected. Apply blocked.`,
  };
}

export async function applyCreateCustomerStoragePricingVersion(
  input: CreateCustomerStoragePricingVersionInput,
): Promise<{ changeRequestId: string; versionId: string }> {
  const payload = { ...input, effectiveFrom: input.effectiveFrom.toISOString() };
  const changeRequestId = await createAdminChangeRequest(
    "customer_storage_pricing_version_create",
    "tenant",
    input.tenantId,
    payload,
    input.requestedBy ?? null,
  );

  await recordAdminChangeEvent(changeRequestId, "request_created", { tenantId: input.tenantId, metricType: input.metricType });
  await recordAdminChangeEvent(changeRequestId, "apply_started", null);

  try {
    const preview = await previewCreateCustomerStoragePricingVersion(input);
    if (!preview.valid) {
      await markAdminChangeFailed(changeRequestId, preview.message);
      await recordAdminChangeEvent(changeRequestId, "apply_failed", { reason: preview.message });
      throw new Error(`[admin-pricing] Customer storage pricing version apply blocked: ${preview.message}`);
    }

    const rows = await db
      .insert(customerStoragePricingVersions)
      .values({
        tenantId: input.tenantId,
        storageProvider: input.storageProvider ?? "cloudflare",
        storageProduct: input.storageProduct ?? "r2",
        metricType: input.metricType,
        pricingVersion: input.pricingVersion,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: input.effectiveTo ?? null,
        metadata: input.metadata ?? null,
      })
      .returning({ id: customerStoragePricingVersions.id });

    const versionId = rows[0].id;
    await markAdminChangeApplied(changeRequestId, { versionId, tenantId: input.tenantId });
    await recordAdminChangeEvent(changeRequestId, "apply_succeeded", { versionId });

    return { changeRequestId, versionId };
  } catch (err) {
    if ((err as Error).message.includes("admin-pricing")) throw err;
    await markAdminChangeFailed(changeRequestId, (err as Error).message);
    await recordAdminChangeEvent(changeRequestId, "apply_failed", { error: (err as Error).message });
    throw err;
  }
}
